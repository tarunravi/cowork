/**
 * Codex CLI as an OpenBot Bot, over AG-UI.
 *
 * Each conversation thread maps to one Codex session: the first turn runs
 * `codex exec`, later turns `codex exec resume <session id>`, so the model's
 * own context carries across turns the same way the desktop session does. The
 * session id comes from the `thread.started` event and is persisted per thread,
 * so the mapping survives this process restarting.
 *
 * Codex works inside its own per-thread workspace directory under the
 * workspace-write sandbox; no OpenBot computer tools are exposed yet, and the
 * activity stream carries assistant messages only. A harness must not advertise
 * more than it does: `shared/harnesses.json` and the bot profile carry the
 * capability story, this file only has to make true whatever it claims.
 */

import { EventEncoder } from "@ag-ui/encoder";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";
import { listenPort } from "../../shared/listen-port";

const resolvedPort = listenPort(process.env.PORT, 4210);
if (!resolvedPort.ok) {
  console.error(`agent-codex: ${resolvedPort.error}`);
  process.exit(1);
}
const PORT = resolvedPort.port;

/**
 * The token OpenBot's server presents. Checked at startup rather than on the
 * first conversation, because a token noticed missing mid-run is a Bot that
 * accepted a grant and answered nothing.
 */
const AGENT_TOKEN =
  process.env.CODEX_ADAPTER_TOKEN?.trim() ||
  process.env.MANAGED_AGENT_TOKEN?.trim();
if (!AGENT_TOKEN) {
  console.error(
    "agent-codex: set CODEX_ADAPTER_TOKEN (or MANAGED_AGENT_TOKEN) to the secret the server sends.",
  );
  process.exit(1);
}

/** Optional model override; unset means Codex's own configured default. */
const MODEL = process.env.CODEX_MODEL?.trim();
/** Override for the binary, so the pipeline is testable without quota or a real login. */
const CODEX_BIN = process.env.CODEX_BIN?.trim() || "codex";
/** Minutes a turn may run before the process is killed and the run fails. */
const TURN_TIMEOUT_MINUTES = Number(process.env.CODEX_TURN_MINUTES ?? "30");

const WORKSPACE_ROOT =
  process.env.CODEX_WORKSPACE_ROOT?.trim() ||
  join(process.env.HOME ?? ".", ".openbot", "codex-workspaces");
const STATE_DIR =
  process.env.CODEX_STATE_DIR?.trim() ||
  join(process.env.HOME ?? ".", ".openbot", "codex-sessions");
mkdirSync(WORKSPACE_ROOT, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

function workspaceFor(threadId: string): string {
  const safe = threadId.replace(/[^\w.-]+/g, "_") || "thread";
  const workspace = join(WORKSPACE_ROOT, safe);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

function sessionPath(threadId: string): string {
  return join(STATE_DIR, `${threadId.replace(/[^\w.-]+/g, "_") || "thread"}.sid`);
}

async function loadSession(threadId: string): Promise<string | null> {
  try {
    const sid = (await readFile(sessionPath(threadId), "utf8")).trim();
    return sid.length > 0 ? sid : null;
  } catch {
    return null;
  }
}

async function saveSession(threadId: string, sessionId: string): Promise<void> {
  try {
    await writeFile(sessionPath(threadId), `${sessionId}\n`);
  } catch (error) {
    console.warn(`agent-codex: could not persist session id: ${String(error)}`);
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string" ? part : (part?.text as string | undefined) ?? "",
      )
      .join("\n");
  }
  return content == null ? "" : String(content);
}

/** The final user message is the turn; earlier history lives in the Codex session. */
export function lastUserPrompt(input: RunAgentInput): string | null {
  const messages = input.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const text = textOf((message as { content?: unknown }).content).trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

/** System messages carry the bot's standing instructions; they lead the first turn only. */
export function standingInstructions(input: RunAgentInput): string {
  return (input.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => textOf((message as { content?: unknown }).content))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** One JSONL line of `codex exec --json`, or null when the line is not an event. */
export function parseCodexLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function messageText(event: Record<string, unknown>): string | null {
  if (
    event.type === "item.completed" &&
    typeof event.item === "object" &&
    event.item !== null &&
    "type" in event.item &&
    (event.item as { type?: unknown }).type === "agent_message" &&
    "text" in event.item
  ) {
    const text = (event.item as { text?: unknown }).text;
    return typeof text === "string" && text.length > 0 ? text : null;
  }
  return null;
}

function failureMessage(event: Record<string, unknown>): string | null {
  if (event.type !== "turn.failed") return null;
  if (typeof event.error === "object" && event.error !== null && "message" in event.error) {
    const message = (event.error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The Codex turn failed.";
}

function sessionIdOf(event: Record<string, unknown>): string | null {
  if (event.type !== "thread.started") return null;
  const id = event.thread_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function runTurn(input: RunAgentInput): Promise<Response> {
  const encoder = new EventEncoder();
  const threadId = String(input.threadId ?? "thread");
  const workspace = workspaceFor(threadId);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const utf8 = new TextEncoder();
      let closed = false;
      const send = (event: BaseEvent) => {
        if (closed) return;
        controller.enqueue(utf8.encode(encoder.encodeSSE(event)));
      };
      const finish = (error?: string) => {
        if (closed) return;
        if (error) {
          send({ type: "RUN_ERROR", message: error } as BaseEvent);
        } else {
          send({
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
        }
        closed = true;
        controller.close();
      };

      send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId } as BaseEvent);

      const prompt = lastUserPrompt(input);
      if (!prompt) {
        finish("The conversation carried no user message to answer.");
        return;
      }

      const resumed = await loadSession(threadId);
      const args = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "-C",
        workspace,
        "-s",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=true",
      ];
      if (MODEL) args.push("-m", MODEL);
      if (resumed) args.push("resume", resumed);
      // `-` reads the prompt from stdin, keeping long instructions off the argv limit.
      args.push("-");

      let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
      try {
        child = Bun.spawn([CODEX_BIN, ...args], {
          cwd: workspace,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (error) {
        finish(error instanceof Error ? error.message : "Codex could not start.");
        return;
      }

      const turnTimeout = setTimeout(() => {
        console.warn(`agent-codex: turn on ${threadId} exceeded ${TURN_TIMEOUT_MINUTES}m; killing`);
        child.kill();
      }, TURN_TIMEOUT_MINUTES * 60_000);

      void child.stdin.write(`${prompt}\n`);
      void child.stdin.end();

      const readStdout = async () => {
        const text = await new Response(child.stdout).text();
        for (const line of text.split("\n")) {
          const event = parseCodexLine(line);
          if (!event) continue;
          const sid = sessionIdOf(event);
          if (sid) {
            void saveSession(threadId, sid);
            continue;
          }
          const failure = failureMessage(event);
          if (failure) {
            finish(failure);
            continue;
          }
          const text = messageText(event);
          if (text) {
            const messageId = `msg_${String(input.runId ?? "run")}`;
            send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" } as BaseEvent);
            send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: text } as BaseEvent);
            send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
            continue;
          }
          if (event.type === "error") {
            // Retry notices surface as errors; the turn may still recover, so they
            // are logged rather than ending the run.
            console.warn(`agent-codex: ${String(event.message ?? "")}`);
          }
        }
      };

      const readStderr = async () => new Response(child.stderr).text();
      const [exit, stderr] = await Promise.all([child.exited, readStderr()]);
      await readStdout();
      clearTimeout(turnTimeout);
      if (resumed) void saveSession(threadId, resumed);
      if (!closed) {
        if (exit === 0) {
          finish();
        } else {
          const lastError = stderr
            .trim()
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .at(-1);
          finish(lastError ?? `Codex exited with code ${exit}.`);
        }
      } else {
        console.warn(`agent-codex: stderr on ${threadId}: ${stderr.trim()}`);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": encoder.getContentType(),
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 240,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", harness: "codex" });
    }

    if (url.pathname === "/ag-ui" && request.method === "POST") {
      if (!hasManagedAgentToken(request, AGENT_TOKEN)) {
        return Response.json({ error: "Unauthorized." }, { status: 401 });
      }
      const input = (await request.json()) as RunAgentInput;
      return runTurn(input);
    }

    return Response.json({ error: "Not found." }, { status: 404 });
    },
});

console.info(`agent-codex listening on http://127.0.0.1:${server.port}/ag-ui`);
