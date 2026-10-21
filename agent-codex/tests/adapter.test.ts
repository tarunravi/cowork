import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunAgentInput } from "@ag-ui/core";
import { createAdapter, parseCodexLine, threadKey } from "../src/adapter";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const input = (
  prompt: string,
  threadId = "thread",
  system?: string,
): RunAgentInput => ({
  threadId,
  runId: "run",
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
  messages: [
    ...(system
      ? [{ id: "system", role: "system" as const, content: system }]
      : []),
    { id: "old", role: "user", content: "old prompt" },
    { id: "new", role: "user", content: prompt },
  ],
});
// Every provider variable the container carries, so the allowlist has something to refuse.
const containerEnvironment = {
  PATH: process.env.PATH,
  CODEX_HOME: "/tmp/codex-home-test",
  OPENAI_API_KEY: "sk-test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  CLAUDE_CODE_OAUTH_TOKEN: "claude-plan-test",
  GOOGLE_API_KEY: "google-test",
  CHATGPT_AUTH_FILE: "/root/.langchain/chatgpt-auth.json",
  MANAGED_AGENT_TOKEN: "managed-test",
};
async function setup(
  timeoutMs = 2000,
  binary = resolve(import.meta.dir, "fake-codex.ts"),
  environment: Record<string, string | undefined> = containerEnvironment,
) {
  const root = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  roots.push(root);
  const options = {
    binary,
    timeoutMs,
    workspaceRoot: join(root, "work"),
    stateDir: join(root, "state"),
    environment,
  };
  return {
    options,
    run: createAdapter(options),
    workspace: join(options.workspaceRoot, threadKey("thread")),
  };
}
const events = (sse: string): any[] =>
  sse
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
function terminal(sse: string, type: string) {
  const ends = events(sse).filter(
    (event) => event.type === "RUN_ERROR" || event.type === "RUN_FINISHED",
  );
  expect(ends).toHaveLength(1);
  expect(ends[0].type).toBe(type);
  return ends[0];
}
async function eventually(check: () => Promise<boolean>) {
  const end = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Condition did not become true");
    await Bun.sleep(10);
  }
}
async function invocation(workspace: string) {
  await eventually(async () =>
    Bun.file(join(workspace, "invocation.json")).exists(),
  );
  return JSON.parse(await readFile(join(workspace, "invocation.json"), "utf8"));
}
async function dead(pid: number) {
  await eventually(async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
}

test("first prompt includes standing instructions; restart resumes only latest prompt and retains new session", async () => {
  const { run, options, workspace } = await setup();
  terminal(
    await run(input("latest", "thread", "Be precise")).text(),
    "RUN_FINISHED",
  );
  const first = await invocation(workspace);
  expect(first.prompt).toBe(
    "Bot standing instructions:\nBe precise\n\nUser message:\nlatest\n",
  );
  expect(first.args).not.toContain("resume");
  terminal(
    await createAdapter(options)(
      input("follow-up", "thread", "Be precise"),
    ).text(),
    "RUN_FINISHED",
  );
  const next = await invocation(workspace);
  expect(next.prompt).toBe("follow-up\n");
  expect(next.args.slice(-3)).toEqual(["resume", "session-first", "-"]);
  expect(
    await readFile(
      join(options.stateDir, `${threadKey("thread")}.sid`),
      "utf8",
    ),
  ).toBe("session-replaced\n");
});

test("Codex receives core variables and no credentials", async () => {
  const { run, workspace } = await setup();
  terminal(await run(input("hello")).text(), "RUN_FINISHED");
  const { env } = await invocation(workspace);
  expect(env).not.toContain("OPENAI_API_KEY");
  expect(env).toContain("CODEX_HOME");
  for (const refused of [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GOOGLE_API_KEY",
    "CHATGPT_AUTH_FILE",
    "MANAGED_AGENT_TOKEN",
  ])
    expect(env).not.toContain(refused);
});

test("unavailable sandbox fails before spawning a model turn", async () => {
  const { run, workspace } = await setup(2000, undefined, {
    ...containerEnvironment,
    CODEX_HOME: "/sandbox-unavailable",
  });
  const output = await run(input("hello")).text();
  expect(terminal(output, "RUN_ERROR").message).toContain(
    "sandbox unavailable",
  );
  for (const value of Object.values(containerEnvironment).filter((v) =>
    v?.includes("test"),
  ))
    expect(output).not.toContain(value!);
  expect(await Bun.file(join(workspace, "invocation.json")).exists()).toBe(
    false,
  );
});

test("the adapter requests a filtered, write-limited sandbox; read isolation remains unverified", async () => {
  const { run, workspace } = await setup();
  terminal(await run(input("hello")).text(), "RUN_FINISHED");
  const { args } = await invocation(workspace);
  expect(args).toContain("sandbox_workspace_write.network_access=false");
  expect(args).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
  expect(args).toContain("sandbox_workspace_write.exclude_tmpdir_env_var=true");
  const probe = JSON.parse(
    await readFile(join(workspace, "probe.json"), "utf8"),
  );
  expect(probe.args).toContain('sandbox_mode="workspace-write"');
  expect(probe.args).toContain("sandbox_workspace_write.network_access=false");
  expect(probe.args).toContain(
    "sandbox_workspace_write.exclude_slash_tmp=true",
  );
  expect(probe.args).toContain(
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
  );
  expect(probe.args).toContain("features.use_legacy_landlock=false");
  expect(probe.env.some((name: string) => /KEY|TOKEN|SECRET/.test(name))).toBe(
    false,
  );
  expect(args).toContain('approval_policy="never"');
  expect(args.join(" ")).not.toContain("danger-full-access");
  expect(args).toContain('model_provider="openbot-proxy"');
  expect(args).toContain(
    'model_providers.openbot-proxy={name="OpenBot proxy",base_url="http://127.0.0.1:60001/v1",wire_api="responses"}',
  );
  expect(args.join(" ")).not.toContain("api_key");
  expect(args).toContain('shell_environment_policy.inherit="core"');
  expect(args.join(" ")).not.toContain("network_access=true");
  expect(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2)).toEqual([
    "-s",
    "workspace-write",
  ]);
});

test("streams complete messages before process exits, decodes split UTF-8, and uses unique message IDs", async () => {
  const { run, workspace } = await setup();
  const reader = run(input("stream")).body!.getReader();
  let output = "";
  while (!output.includes("TEXT_MESSAGE_END")) {
    const result = await reader.read();
    expect(result.done).toBe(false);
    output += new TextDecoder().decode(result.value);
  }
  expect(
    events(output).find((event) => event.type === "TEXT_MESSAGE_CONTENT").delta,
  ).toBe("hello 🌍");
  expect(output).not.toContain("RUN_FINISHED");
  await writeFile(join(workspace, "release"), "");
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    output += new TextDecoder().decode(result.value);
  }
  terminal(output, "RUN_FINISHED");
  const starts = events(output).filter(
    (event) => event.type === "TEXT_MESSAGE_START",
  );
  expect(new Set(starts.map((event) => event.messageId)).size).toBe(2);
});

for (const [prompt, error] of [
  ["failed", "Controlled failure"],
  ["nonzero", "code 7"],
  ["incomplete", "without a turn.completed"],
  ["empty-failure", "Codex turn failed"],
  ["no-session", "did not report a session ID"],
]) {
  test(`reports ${prompt} exactly once`, async () => {
    const { run, workspace } = await setup();
    const result = terminal(await run(input(prompt)).text(), "RUN_ERROR");
    expect(result.message).toContain(error);
    await dead((await invocation(workspace)).pid);
  });
}

test("timeout kills a hung process and frees the thread", async () => {
  const { run, workspace } = await setup(300);
  expect(
    terminal(await run(input("hang")).text(), "RUN_ERROR").message,
  ).toContain("timed out");
  await dead((await invocation(workspace)).pid);
  terminal(await run(input("next")).text(), "RUN_FINISHED");
});

test("disconnect kills the process and rejects an overlapping turn", async () => {
  const { run, workspace } = await setup();
  const controller = new AbortController();
  const response = run(input("hang"), controller.signal);
  const started = await invocation(workspace);
  expect(
    terminal(await run(input("overlap")).text(), "RUN_ERROR").message,
  ).toContain("already running");
  controller.abort();
  expect(terminal(await response.text(), "RUN_ERROR").message).toContain(
    "disconnected",
  );
  await dead(started.pid);
  terminal(await run(input("next")).text(), "RUN_FINISHED");
});

test("response cancellation kills the process", async () => {
  const { run, workspace } = await setup();
  const response = run(input("hang"));
  const started = await invocation(workspace);
  await response.body!.cancel();
  await dead(started.pid);
});

test("pre-aborted requests never spawn", async () => {
  const { run, workspace } = await setup();
  const controller = new AbortController();
  controller.abort();
  terminal(await run(input("hang"), controller.signal).text(), "RUN_ERROR");
  await Bun.sleep(30);
  expect(await Bun.file(join(workspace, "invocation.json")).exists()).toBe(
    false,
  );
});

test("missing executable, missing prompt, and storage errors terminate", async () => {
  const { run, options } = await setup(2000, "/does-not-exist/codex");
  terminal(await run(input("hello")).text(), "RUN_ERROR");
  terminal(await run(input("")).text(), "RUN_ERROR");
  await writeFile(
    join(options.stateDir, `${threadKey("thread")}.sid`),
    "--last\n",
  );
  expect(
    terminal(await run(input("hello")).text(), "RUN_ERROR").message,
  ).toContain("Invalid persisted");
  const blocked = join(options.workspaceRoot, "blocked");
  await writeFile(blocked, "file");
  terminal(
    await createAdapter({ ...options, workspaceRoot: blocked })(
      input("hello"),
    ).text(),
    "RUN_ERROR",
  );
});

test("arbitrary thread IDs stay within roots and do not collide", async () => {
  const { run, options } = await setup();
  const ids = [
    ".",
    "..",
    "../../escape",
    "/absolute",
    "a/b",
    "a_b",
    "",
    "🌍",
    "\ud800",
    "\ud801",
    "\ufffd",
    "x".repeat(10000),
  ];
  expect(new Set(ids.map(threadKey)).size).toBe(ids.length);
  for (const id of ids) {
    expect(threadKey(id)).toMatch(/^[a-f0-9]{64}$/);
    terminal(await run(input("hello", id)).text(), "RUN_FINISHED");
    expect(
      await Bun.file(
        join(options.workspaceRoot, threadKey(id), "invocation.json"),
      ).exists(),
    ).toBe(true);
  }
});

test("invalid timeouts fail immediately and non-events are ignored", () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 2 ** 31]) {
    expect(() =>
      createAdapter({
        binary: "codex",
        workspaceRoot: ".",
        stateDir: ".",
        timeoutMs,
        environment: {},
      }),
    ).toThrow();
  }
  for (const line of ["null", "[]", "garbage", "{", "4"])
    expect(parseCodexLine(line)).toBeNull();
});

test("pinned proxy rejects non-Responses endpoints without exposing its stdin key", async () => {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  const key = `synthetic-${crypto.randomUUID()}`;
  const proxy = Bun.spawn(
    [
      resolve(import.meta.dir, "../node_modules/.bin/codex"),
      "responses-api-proxy",
      "--port",
      String(port),
    ],
    {
      env: { PATH: process.env.PATH, HOME: "/tmp" },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  try {
    proxy.stdin.write(`${key}\n`);
    proxy.stdin.end();
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await fetch(`http://127.0.0.1:${port}/health`);
        ready = true;
        break;
      } catch {
        await Bun.sleep(20);
      }
    }
    expect(ready).toBe(true);
    for (const [method, path] of [
      ["GET", "/v1/responses"],
      ["POST", "/v1/chat/completions"],
      ["POST", "/v1/responses?query=1"],
      ["GET", "/shutdown"],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
      });
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text.includes(key)).toBe(false);
      expect(JSON.stringify([...response.headers]).includes(key)).toBe(false);
    }
  } finally {
    proxy.kill("SIGKILL");
    await proxy.exited;
  }
});

test("captured secrets redact output and errors without entering child environments", async () => {
  const redactionSecrets = [
    "synthetic-managed-redaction",
    "synthetic-adapter-redaction",
  ];
  // Match startup: service credentials have already been removed from the environment.
  const { options, workspace } = await setup(2000, undefined, {
    PATH: process.env.PATH,
  });
  const output = await createAdapter({
    ...options,
    redactionSecrets,
    adapterPort: 4321,
  })(input("redaction")).text();
  expect(terminal(output, "RUN_ERROR").message).toContain(
    "[redacted] [redacted]",
  );
  expect(
    events(output).find((event) => event.type === "TEXT_MESSAGE_CONTENT")
      ?.delta,
  ).toBe("[redacted] [redacted]");
  const invocationData = await invocation(workspace);
  const probe = JSON.parse(
    await readFile(join(workspace, "probe.json"), "utf8"),
  );
  for (const secret of redactionSecrets) {
    expect(output).not.toContain(secret);
    expect(JSON.stringify(invocationData)).not.toContain(secret);
    expect(JSON.stringify(probe)).not.toContain(secret);
  }
  for (const name of ["MANAGED_AGENT_TOKEN", "CODEX_ADAPTER_TOKEN"]) {
    expect(invocationData.env).not.toContain(name);
    expect(probe.env).not.toContain(name);
  }
  // Inspect the command only: the fake peer never executes the sandbox or opens a proxy.
  const script = probe.args.at(-1);
  expect(script).toContain("[4321,60001]");
  expect(script).not.toContain(":4215");
  expect(script).toContain('socket.once("connect", () => process.exit(1))');
});
