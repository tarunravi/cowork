/** Codex CLI over AG-UI: session continuity and assistant messages only. */
import { join } from "node:path";
import type { RunAgentInput } from "@ag-ui/core";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";
import { listenPort } from "../../shared/listen-port";
import { createAdapter } from "./adapter";

// Registered in shared/harnesses.json. 4210 is AG2's.
const resolvedPort = listenPort(process.env.PORT, 4215);
if (!resolvedPort.ok) throw new Error(resolvedPort.reason);
const PORT = resolvedPort.port;
const redactionSecrets = [
  process.env.CODEX_ADAPTER_TOKEN,
  process.env.MANAGED_AGENT_TOKEN,
].flatMap((value) => (value ? [value, value.trim()].filter(Boolean) : []));
const AGENT_TOKEN =
  process.env.CODEX_ADAPTER_TOKEN?.trim() ||
  process.env.MANAGED_AGENT_TOKEN?.trim();
if (!AGENT_TOKEN)
  throw new Error(
    "agent-codex: set CODEX_ADAPTER_TOKEN or MANAGED_AGENT_TOKEN.",
  );
// Remove service credentials from the JS environment after capturing auth in memory.
// Linux /proc can retain the initial environment: the mandatory sandbox probe checks that boundary.
delete process.env.MANAGED_AGENT_TOKEN;
delete process.env.CODEX_ADAPTER_TOKEN;
if (process.env.OPENAI_API_KEY)
  throw new Error("agent-codex must not receive an API key.");
const minutes = Number(process.env.CODEX_TURN_MINUTES ?? "30");
const home = process.env.HOME ?? ".";
const runTurn = createAdapter({
  redactionSecrets,
  adapterPort: PORT,
  binary: process.env.CODEX_BIN?.trim() || "codex",
  model: process.env.CODEX_MODEL?.trim(),
  timeoutMs: minutes * 60_000,
  workspaceRoot:
    process.env.CODEX_WORKSPACE_ROOT?.trim() ||
    join(home, ".openbot", "codex-workspaces"),
  stateDir:
    process.env.CODEX_STATE_DIR?.trim() ||
    join(home, ".openbot", "codex-sessions"),
  // `resume` only finds sessions Codex wrote under its own home, so that path must survive a restart.
  environment: {
    ...process.env,
    CODEX_HOME:
      process.env.CODEX_HOME?.trim() || join(home, ".openbot", "codex-home"),
  },
});

const server = Bun.serve({
  port: PORT,
  // The adapter owns the turn deadline, including turns with no output yet.
  idleTimeout: 0,
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
      return runTurn(input, request.signal);
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

console.info(`agent-codex listening on http://127.0.0.1:${server.port}/ag-ui`);
