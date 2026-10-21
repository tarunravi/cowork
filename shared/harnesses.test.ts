import { expect, test } from "bun:test";
import { HARNESSES } from "./harnesses";

test("carries every row the desktop picker offers, in its order", () => {
  expect(HARNESSES.map((h) => h.id)).toEqual([
    "crewai",
    "llamaindex",
    "agno",
    "langgraph",
    "google-adk",
    "antigravity",
    "pydantic-ai",
    "microsoft-agent-framework",
    "claude-agent-sdk",
    "codex",
    "strands",
    "ag2",
    "langroid",
    "mastra",
    "byo-url",
  ]);
});

/*
 * Codex is the one row OpenBot maintains itself, and that is a deliberate exception rather than a
 * drift in the rule. Every other row is kept working by its vendor or a partner; this one is the
 * adapter in agent-codex/, because the Codex CLI has no AG-UI server of its own. The row stays only
 * while that adapter is maintained, which is why it is asserted here rather than left implicit.
 */
test("keeps Codex as a first-party row served by our own adapter, on its own port", () => {
  const codex = HARNESSES.find((h) => h.id === "codex");
  expect(codex?.maintainer).toBe("first-party");
  expect(codex?.image).toBe("agent-codex");
  expect(codex?.port).toBe(4215);
  expect(codex?.credential).toBe("openai");
  expect(codex?.webCreate).toBe(false);
});

test("no two rows share a port", () => {
  const ports = HARNESSES.map((h) => h.port).filter((port) => port !== null);
  expect(new Set(ports).size).toBe(ports.length);
});

test("the brands with no usable mark carry none", () => {
  const unmarked = HARNESSES.filter((h) => h.mark === null)
    .map((h) => h.id)
    .sort();
  expect(unmarked).toEqual(["ag2", "agno", "byo-url", "langroid"]);
});

/*
 * Mastra is the one row a plain AG-UI endpoint cannot stand in for: the server dials it through the
 * `@ag-ui/mastra` bridge as `remote_mastra` and needs a roster id, neither of which the web create
 * API can send. Offered there it would make a Bot that answers nothing.
 */
test("marks harnesses without a truthful web creation route as unavailable", () => {
  const notOfferable = HARNESSES.filter((h) => !h.webCreate).map((h) => h.id);
  expect(notOfferable).toEqual(["codex", "mastra"]);
});

test("gives a web-specific summary only where the installer's is false here", () => {
  const rewritten = HARNESSES.filter((h) => h.webSummary !== null).map(
    (h) => h.id,
  );
  expect(rewritten.sort()).toEqual(["byo-url", "claude-agent-sdk"]);
});

/*
 * The web app and the desktop both resolve a mark by globbing this directory, and a glob that
 * matches nothing fails silently: every row simply shows its name, which is also what a brand with
 * no mark legitimately looks like. Only this assertion tells the two apart.
 */
test("every named mark is vendored where both apps look for it", async () => {
  for (const harness of HARNESSES) {
    if (harness.mark === null) continue;
    const file = Bun.file(`${import.meta.dir}/marks/${harness.mark}.svg`);
    expect(await file.exists()).toBe(true);
  }
});

test("every row an image publishes names the directory it is built from", () => {
  const crewai = HARNESSES.find((h) => h.id === "crewai");
  expect(crewai?.image).toBe("agent-crewai");
  expect(crewai?.healthPath).toBe("/health");
  expect(crewai?.port).toBe(4202);
});

/*
 * Antigravity only ever runs on Gemini: its README says the harness requires a Gemini API key
 * wherever `base_url` points. `any-provider` would let a deployment holding only an OpenAI key
 * install it and get a Bot that cannot answer — the shape of failure `webCreate: false` exists to
 * stop for Mastra.
 */
test("marks Antigravity as needing Google's key rather than any provider's", () => {
  const antigravity = HARNESSES.find((h) => h.id === "antigravity");
  expect(antigravity?.credential).toBe("google");
  expect(antigravity?.name).toBe("Google Antigravity");
  expect(antigravity?.image).toBe("agent-antigravity");
  expect(antigravity?.port).toBe(4214);
  expect(antigravity?.mark).toBe("antigravity");
  expect(antigravity?.webCreate).toBe(true);
});

test("gives every row a credential the type actually names", () => {
  const known = [
    "any-provider",
    "anthropic",
    "google",
    "openai",
    "their-endpoint",
  ];
  for (const harness of HARNESSES) {
    expect(known).toContain(harness.credential);
  }
});

test("desktop availability is explicit and only Codex is unavailable", () => {
  expect(HARNESSES.filter((h) => !h.desktopCreate).map((h) => h.id)).toEqual([
    "codex",
  ]);
  for (const harness of HARNESSES) {
    expect(typeof harness.desktopCreate).toBe("boolean");
    if (harness.desktopCreate) {
      expect(harness.desktopUnavailableReason).toBeNull();
    } else {
      expect(harness.desktopUnavailableReason).toBe(
        "Temporarily unavailable because conversation files and history are not isolated.",
      );
      expect(harness.summary).not.toContain("sandboxed");
    }
  }
});
