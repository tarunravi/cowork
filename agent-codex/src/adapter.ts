import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";

interface Options {
  binary: string;
  /** Captured before service credentials are removed; never included in child environments. */
  redactionSecrets?: readonly string[];
  adapterPort?: number;
  model?: string;
  timeoutMs: number;
  workspaceRoot: string;
  stateDir: string;
  /** The container's environment. Only the allowlist in `parentEnvironment` reaches Codex. */
  environment: Record<string, string | undefined>;
}

export function threadKey(threadId: string): string {
  return createHash("sha256").update(threadId, "utf16le").digest("hex");
}

// The CLI and all sandbox probes receive only core variables, never service credentials.
/** Replaces every occurrence of the key, so a CLI error or a model reply cannot persist it. */
export function redactSecret(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

export function parentEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "CODEX_HOME",
  ]) {
    const value = source[name]?.trim();
    if (value) environment[name] = value;
  }
  return environment;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "string"
        ? part
        : part && typeof part.text === "string"
          ? part.text
          : "",
    )
    .join("\n");
}

export function lastUserPrompt(input: RunAgentInput): string | null {
  const message = [...(input.messages ?? [])]
    .reverse()
    .find((message) => message.role === "user");
  return message ? textOf(message.content).trim() || null : null;
}

export function standingInstructions(input: RunAgentInput): string {
  return (input.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => textOf(message.content))
    .filter(Boolean)
    .join("\n\n");
}

export function parseCodexLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

async function saveSession(
  path: string,
  sid: string,
  cancelled: () => boolean,
) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${sid}\n`, { mode: 0o600, flag: "wx" });
    if (!cancelled()) await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function createAdapter(options: Options) {
  if (
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 2_147_483_647
  ) {
    throw new Error(
      "CODEX_TURN_MINUTES must produce a positive, finite timeout of at most 2147483647ms.",
    );
  }
  // One process per thread prevents two turns from forking the persisted history.
  const active = new Set<string>();
  return (input: RunAgentInput, signal?: AbortSignal): Response => {
    const encoder = new EventEncoder();
    const key = threadKey(String(input.threadId ?? "thread"));
    let cancel = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let stopped = false;
        let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
        const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
        let rejectStopped!: (error: Error) => void;
        const interruption = new Promise<never>((_, reject) => {
          rejectStopped = reject;
        });
        const send = (event: object) => {
          if (!closed)
            controller.enqueue(
              new TextEncoder().encode(encoder.encodeSSE(event as BaseEvent)),
            );
        };
        const redact = (text: string) =>
          (options.redactionSecrets ?? []).reduce(
            (value, secret) => redactSecret(value, secret),
            text,
          );
        const finish = (error?: string) => {
          if (closed) return;
          send(
            error !== undefined
              ? { type: "RUN_ERROR", message: redact(error) }
              : {
                  type: "RUN_FINISHED",
                  threadId: input.threadId,
                  runId: input.runId,
                },
          );
          closed = true;
          controller.close();
        };
        const killGroup = () => {
          if (!child) return;
          // Tool children can keep pipes open after the Codex process exits.
          if (process.platform !== "win32") {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* Already exited. */
            }
          }
        };
        const kill = () => {
          if (!child) return;
          killGroup();
          try {
            child.kill("SIGKILL");
          } catch {
            /* Already exited. */
          }
          try {
            child.stdin.end();
          } catch {
            /* Stdin may already be closed. */
          }
          for (const reader of readers) void reader.cancel().catch(() => {});
        };
        const stop = (reason: string) => {
          stopped = true;
          rejectStopped(new Error(reason));
          kill();
        };
        cancel = () => {
          closed = true;
          stop("Codex run cancelled.");
        };
        const abort = () => stop("Codex request disconnected.");
        send({
          type: "RUN_STARTED",
          threadId: input.threadId,
          runId: input.runId,
        });
        if (active.has(key)) {
          finish("A Codex turn is already running for this thread.");
          return;
        }
        const prompt = lastUserPrompt(input);
        if (!prompt) {
          finish("The conversation carried no user message to answer.");
          return;
        }
        active.add(key);
        const timer = setTimeout(
          () => stop("Codex turn timed out."),
          options.timeoutMs,
        );
        signal?.addEventListener("abort", abort, { once: true });
        let completed = false;
        let messageNumber = 0;
        let stderr = "";
        const work = async () => {
          const workspace = join(options.workspaceRoot, key);
          const sessionPath = join(options.stateDir, `${key}.sid`);
          await mkdir(workspace, { recursive: true, mode: 0o700 });
          await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
          let resumed: string | undefined;
          try {
            resumed = (await readFile(sessionPath, "utf8")).trim();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (
            resumed !== undefined &&
            !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(resumed)
          ) {
            throw new Error("Invalid persisted Codex session ID.");
          }
          // Setup can outlast cancellation; never spawn a late process.
          if (stopped || signal?.aborted)
            throw new Error("Codex request disconnected.");
          const environment = parentEnvironment(options.environment);
          // A real sandbox must work before any model request. No namespace/security fallback.
          const probe = Bun.spawn(
            [
              options.binary,
              "sandbox",
              "-C",
              workspace,
              "-c",
              'sandbox_mode="workspace-write"',
              "-c",
              "sandbox_workspace_write.network_access=false",
              "-c",
              "sandbox_workspace_write.exclude_slash_tmp=true",
              "-c",
              "sandbox_workspace_write.exclude_tmpdir_env_var=true",
              "-c",
              "features.use_legacy_landlock=false",
              "--",
              "bun",
              "-e",
              `
              const fs = require("node:fs");
              for (const pid of fs.readdirSync("/proc").filter(p => /^\\d+$/.test(p))) {
                let data;
                try { data = fs.readFileSync("/proc/" + pid + "/environ", "utf8"); } catch { continue; }
                if (/(MANAGED_AGENT_TOKEN|CODEX_ADAPTER_TOKEN|OPENAI_API_KEY)=/.test(data)) process.exit(1);
              }
              for (const port of ${JSON.stringify([options.adapterPort ?? 4215, 60001])}) {
                const socket = require("node:net").connect({ host: "127.0.0.1", port });
                await new Promise(resolve => {
                  socket.once("connect", () => process.exit(1));
                  socket.once("error", resolve);
                  socket.setTimeout(1000, () => { socket.destroy(); resolve(); });
                });
              }
              fs.writeFileSync(".sandbox-probe", "ok");
              fs.unlinkSync(".sandbox-probe");
            `,
            ],
            {
              cwd: workspace,
              env: environment,
              stdout: "ignore",
              stderr: "ignore",
            },
          );
          const probeTimer = setTimeout(() => probe.kill("SIGKILL"), 5000);
          let probeExit: number;
          try {
            probeExit = await probe.exited;
          } finally {
            clearTimeout(probeTimer);
          }
          if (probeExit !== 0)
            throw new Error(
              "Codex workspace-write sandbox unavailable; refusing to run.",
            );
          if (stopped || signal?.aborted)
            throw new Error("Codex request disconnected.");
          const args = [
            "exec",
            "-c",
            'approval_policy="never"',
            "-c",
            'model_provider="openbot-proxy"',
            "-c",
            'model_providers.openbot-proxy={name="OpenBot proxy",base_url="http://127.0.0.1:60001/v1",wire_api="responses"}',
            "-c",
            "features.use_legacy_landlock=false",
            "--json",
            "--skip-git-repo-check",
            "-C",
            workspace,
            // workspace-write restricts writes, not reads outside the workspace. Request no
            // shell network and only core variables; runtime enforcement still needs evidence.
            // Excluding /tmp and $TMPDIR keeps shared temp roots out of the writable set.
            // The proxy has the key mount and shares this container's network namespace.
            "-s",
            "workspace-write",
            "-c",
            "sandbox_workspace_write.network_access=false",
            "-c",
            "sandbox_workspace_write.exclude_slash_tmp=true",
            "-c",
            "sandbox_workspace_write.exclude_tmpdir_env_var=true",
            "-c",
            'shell_environment_policy.inherit="core"',
            "-c",
            'shell_environment_policy.exclude=["*KEY*","*TOKEN*","*SECRET*"]',
          ];
          if (options.model) args.push("-m", options.model);
          if (resumed) args.push("resume", resumed);
          args.push("-");
          child = Bun.spawn([options.binary, ...args], {
            cwd: workspace,
            env: environment,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            detached: true,
          });
          const instructions = resumed ? "" : standingInstructions(input);
          const firstPrompt = instructions
            ? `Bot standing instructions:\n${instructions}\n\nUser message:\n${prompt}`
            : prompt;
          const stdin = child.stdin;
          const writeInput = async () => {
            await stdin.write(`${firstPrompt}\n`);
            await stdin.end();
          };
          let sessionReported = Boolean(resumed);
          const handleLine = async (line: string) => {
            if (stopped) return;
            const event = parseCodexLine(line);
            if (!event) return;
            if (event.type === "thread.started") {
              const sid = event.thread_id;
              if (
                typeof sid !== "string" ||
                !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(sid)
              ) {
                throw new Error("Codex returned an invalid session ID.");
              }
              await saveSession(sessionPath, sid, () => stopped);
              sessionReported = true;
            }
            if (event.type === "turn.failed") {
              const error = event.error as { message?: unknown } | undefined;
              throw new Error(
                typeof error?.message === "string" && error.message.trim()
                  ? error.message
                  : "The Codex turn failed.",
              );
            }
            if (event.type === "turn.completed") completed = true;
            const item = event.item as
              | { type?: string; text?: unknown }
              | undefined;
            if (
              event.type === "item.completed" &&
              item?.type === "agent_message" &&
              typeof item.text === "string" &&
              item.text
            ) {
              const messageId = `${input.runId}_${++messageNumber}`;
              send({
                type: "TEXT_MESSAGE_START",
                messageId,
                role: "assistant",
              });
              send({
                type: "TEXT_MESSAGE_CONTENT",
                messageId,
                delta: redact(item.text),
              });
              send({ type: "TEXT_MESSAGE_END", messageId });
            }
          };
          const read = async (
            source: ReadableStream<Uint8Array>,
            stdout: boolean,
          ) => {
            const reader = source.getReader();
            readers.push(reader);
            const decoder = new TextDecoder();
            let pending = "";
            try {
              while (true) {
                const { done, value } = await reader.read();
                const text = decoder.decode(value, { stream: !done });
                if (stdout) {
                  pending += text;
                  let newline = pending.indexOf("\n");
                  while (newline >= 0) {
                    await handleLine(pending.slice(0, newline));
                    pending = pending.slice(newline + 1);
                    newline = pending.indexOf("\n");
                  }
                  if (pending.length > 8 * 1024 * 1024)
                    throw new Error("Codex JSONL line exceeded 8MiB.");
                } else stderr = (stderr + text).slice(-8192);
                if (done) break;
              }
              if (stdout && pending.trim()) await handleLine(pending);
            } finally {
              reader.releaseLock();
            }
          };
          const [exit] = await Promise.all([
            child.exited.then((exit) => {
              killGroup();
              return exit;
            }),
            read(child.stdout, true),
            read(child.stderr, false),
            writeInput(),
          ]);
          if (exit !== 0)
            throw new Error(
              `Codex exited with code ${exit}.${stderr.trim() ? ` ${stderr.trim()}` : ""}`,
            );
          if (!sessionReported)
            throw new Error("Codex did not report a session ID.");
          if (!completed)
            throw new Error("Codex exited without a turn.completed event.");
        };
        void (async () => {
          let failure: string | undefined;
          try {
            await Promise.race([interruption, work()]);
          } catch (error) {
            failure =
              error instanceof Error ? error.message : "Codex run failed.";
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            kill();
            if (child) await child.exited;
            active.delete(key);
          }
          finish(failure);
        })();
        if (signal?.aborted) abort();
      },
      cancel() {
        cancel();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": encoder.getContentType(),
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  };
}
