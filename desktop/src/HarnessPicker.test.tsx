import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import catalogue from "../../shared/harnesses.json";
import type { Harness, HarnessChoice } from "./HarnessPicker";

const rows: Harness[] = catalogue.harnesses.map((row) => ({
  ...row,
  credential: row.credential as Harness["credential"],
  maintainer: row.maintainer as Harness["maintainer"],
  health_path: row.healthPath,
  desktop_create: row.desktopCreate,
  desktop_unavailable_reason: row.desktopUnavailableReason,
}));
let loadRows = async () => rows;
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    expect(command).toBe("harnesses");
    return loadRows();
  },
}));
mock.module("./Mark", () => ({ Mark: () => null }));
const { HarnessPicker } = await import("./HarnessPicker");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  loadRows = async () => rows;
});
afterAll(() => GlobalRegistrator.unregister());

async function picker(chosen: HarnessChoice | null) {
  const onChoose = mock(() => {});
  const onContinue = mock(() => {});
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <HarnessPicker
        chosen={chosen}
        onChoose={onChoose}
        onContinue={onContinue}
        onBack={() => {}}
      />,
    );
  });
  return { view, onChoose, onContinue };
}

test("Codex shows its unavailable reason and cannot be selected", async () => {
  const { view, onChoose, onContinue } = await picker(null);
  await userEvent.click(view.getByText("Choose the agent framework"));
  const codex = view.getByRole("radio", { name: /OpenAI Codex/ });
  expect(codex).toHaveProperty("disabled", true);
  expect(
    view.getByText(
      "Temporarily unavailable because conversation files and history are not isolated.",
    ),
  ).toBeTruthy();
  expect(view.queryByText("Needs an OpenAI key")).toBeNull();
  expect(view.getByText("Needs a Gemini key")).toBeTruthy();
  await userEvent.click(codex);
  expect(onChoose).not.toHaveBeenCalled();
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  expect(onContinue).toHaveBeenCalledTimes(1);
  await userEvent.click(view.getByRole("radio", { name: /CrewAI/ }));
  expect(onChoose).toHaveBeenCalledWith({ id: "crewai" });
});

test("a previously selected Codex cannot continue or appear active", async () => {
  const { view, onContinue } = await picker({ id: "codex" });
  expect(view.getByRole("radio", { name: /OpenAI Codex/ })).toHaveProperty(
    "checked",
    false,
  );
  expect(view.queryByText("Using OpenAI Codex")).toBeNull();
  const button = view.getByRole("button", { name: "Continue" });
  expect(button).toHaveProperty("disabled", true);
  await userEvent.click(button);
  expect(onContinue).not.toHaveBeenCalled();
});

test("Continue waits for catalogue availability instead of trusting a stale choice", async () => {
  loadRows = () => new Promise(() => {});
  const { view, onContinue } = await picker({ id: "codex" });
  const button = view.getByRole("button", { name: "Continue" });
  expect(button).toHaveProperty("disabled", true);
  await userEvent.click(button);
  expect(onContinue).not.toHaveBeenCalled();
});
