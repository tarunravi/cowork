#!/usr/bin/env bun
// A controlled CLI peer: no model, network, credentials, or Codex home access.
import { existsSync, writeFileSync } from "node:fs";
if (process.argv[2] === "sandbox") {
  writeFileSync(
    "probe.json",
    JSON.stringify({
      args: process.argv.slice(2),
      env: Object.keys(process.env),
    }),
  );
  process.exit(process.env.CODEX_HOME === "/sandbox-unavailable" ? 1 : 0);
}
const prompt = await Bun.stdin.text();
writeFileSync(
  "invocation.json",
  JSON.stringify({
    args: process.argv.slice(2),
    env: Object.keys(process.env).sort(),
    prompt,
    pid: process.pid,
  }),
);
const emit = (event: object) =>
  process.stdout.write(`${JSON.stringify(event)}\n`);
const message = (text: string) => ({
  type: "item.completed",
  item: { type: "agent_message", text },
});
if (prompt.trim() !== "no-session")
  emit({
    type: "thread.started",
    thread_id: process.argv.includes("resume")
      ? "session-replaced"
      : "session-first",
  });
if (prompt.trim() === "hang") {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (["failed", "empty-failure"].includes(prompt.trim())) {
  emit({
    type: "turn.failed",
    error: {
      message: prompt.trim() === "empty-failure" ? "" : "Controlled failure",
    },
  });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (prompt.trim() === "redaction") {
  emit(message("synthetic-managed-redaction synthetic-adapter-redaction"));
  process.stderr.write(
    "synthetic-managed-redaction synthetic-adapter-redaction",
  );
  process.exit(7);
}
if (prompt.trim() === "nonzero") {
  emit({ type: "turn.completed" });
  process.stderr.write("Controlled stderr\n");
  process.exit(7);
}
if (prompt.trim() === "incomplete") process.exit(0);
if (prompt.trim() === "stream") {
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(message("hello 🌍"))}\r\n`,
  );
  const split = bytes.indexOf(0xf0) + 2;
  process.stdout.write(bytes.slice(0, split));
  await Bun.sleep(10);
  process.stdout.write(bytes.slice(split));
  while (!existsSync("release")) await Bun.sleep(10);
  emit(message("second"));
}
// The final event intentionally has no trailing newline.
process.stdout.write(JSON.stringify({ type: "turn.completed" }));
