import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  ChannelWorkPanel,
  channelWork,
} from "../src/components/bot-profile/activity";
import { conversationPanelSearch } from "../src/components/channels/conversation-panel";
import {
  type ActivityItem,
  type BotActivity,
  botActivityQueryOptions,
} from "../src/lib/bot-lifecycle/queries";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function item(overrides: Partial<ActivityItem> & { id: string }): ActivityItem {
  return {
    kind: "handoff",
    title: `Task ${overrides.id}`,
    detail: null,
    status: "running",
    at: "2026-10-19T10:00:00Z",
    channelId: "channel-1",
    needsYou: false,
    stoppable: false,
    cancellable: false,
    ...overrides,
  };
}

const activity: BotActivity = {
  inProgress: [
    item({ id: "other-running", channelId: "channel-2" }),
    item({ id: "running", stoppable: true }),
    item({ id: "asking", kind: "question", needsYou: true }),
  ],
  scheduled: [
    item({ id: "scheduled", kind: "follow_up", status: "scheduled" }),
  ],
  completed: [
    item({ id: "done", status: "completed" }),
    item({ id: "done-elsewhere", status: "completed", channelId: "channel-2" }),
    item({ id: "routine", kind: "routine", channelId: null }),
  ],
};

test("only this channel's work is kept, and channel-less work is left for the profile", () => {
  const work = channelWork(activity, "channel-1");
  const ids = Object.values(work)
    .flat()
    .map((entry) => entry.id);
  expect(ids.sort()).toEqual(["asking", "done", "running", "scheduled"].sort());
});

test("needs-you work leads, then in progress, then scheduled and completed", () => {
  const work = channelWork(activity, "channel-1");
  expect(work.needsYou.map((entry) => entry.id)).toEqual(["asking"]);
  expect(work.inProgress.map((entry) => entry.id)).toEqual(["running"]);
  expect(work.scheduled.map((entry) => entry.id)).toEqual(["scheduled"]);
  expect(work.completed.map((entry) => entry.id)).toEqual(["done"]);
});

test("a needs-you item found in a later section still leads, and is listed once", () => {
  const work = channelWork(
    {
      inProgress: [],
      scheduled: [],
      completed: [
        item({ id: "late-ask", status: "completed", needsYou: true }),
      ],
    },
    "channel-1",
  );
  expect(work.needsYou.map((entry) => entry.id)).toEqual(["late-ask"]);
  expect(work.completed).toEqual([]);
});

test("each panel state is the only one on, and clearing turns all of them off", () => {
  expect(conversationPanelSearch("settings")).toEqual({
    settings: true,
    watch: undefined,
    work: undefined,
  });
  expect(conversationPanelSearch("watch")).toEqual({
    settings: undefined,
    watch: true,
    work: undefined,
  });
  expect(conversationPanelSearch("work")).toEqual({
    settings: undefined,
    watch: undefined,
    work: true,
  });
  expect(conversationPanelSearch(null)).toEqual({
    settings: undefined,
    watch: undefined,
    work: undefined,
  });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const agent = {
  id: "bot-1",
  name: "Knowledge",
  title: "Research",
  avatarSeed: "seed",
  roleDescription: "Role",
  visibility: "private",
  systemOwned: false,
  mine: true,
  canManage: true,
  builtIn: true,
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
};

/**
 * Serves the Bot and its activity, and records every write the panel makes. Each activity read takes
 * the next response, and the last one repeats, so a test can make a refetch fail after a good load.
 */
function serve(...activityResponses: Response[]) {
  const writes: { path: string; body: unknown }[] = [];
  let reads = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") {
      writes.push({
        path: url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ ok: true });
    }
    if (url === "/api/agents/bot-1") return json({ agent });
    if (url === "/api/bots/bot-1/activity") {
      const response =
        activityResponses[Math.min(reads, activityResponses.length - 1)];
      reads += 1;
      return response.clone();
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  return writes;
}

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: Outlet });
  const panel = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <ChannelWorkPanel agentId="bot-1" channelId="channel-1" />,
  });
  const bot = createRoute({
    getParentRoute: () => root,
    path: "/bots/$agentId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([panel, bot]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

test("the panel lists this conversation's work with needs-you first", async () => {
  serve(json({ activity }));
  const { container } = renderPanel();

  await waitFor(() => expect(container.textContent).toContain("Task asking"));
  const text = container.textContent ?? "";
  const order = [
    "Task asking",
    "Task running",
    "Task scheduled",
    "Task done",
  ].map((title) => text.indexOf(title));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(text).not.toContain("Task other-running");
  expect(text).not.toContain("Task routine");
});

test("Stop sends the delegated task's id to the stop endpoint", async () => {
  const writes = serve(json({ activity }));
  const { container } = renderPanel();

  await waitFor(() => expect(container.textContent).toContain("Task running"));
  fireEvent.click(await waitFor(() => getStop(container)));

  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({
    path: "/api/bots/bot-1/activity/handoffs/stop",
    body: { id: "running" },
  });
});

test("an empty conversation says so and still offers the Bot's full work", async () => {
  serve(
    json({
      activity: {
        inProgress: [item({ id: "elsewhere", channelId: "channel-2" })],
        scheduled: [],
        completed: [],
      },
    }),
  );
  const { container, getByRole } = renderPanel();

  await waitFor(() =>
    expect(container.textContent).toContain(
      "No work here is waiting on you, running, scheduled, or recent.",
    ),
  );
  expect(
    getByRole("link", { name: "All work for Knowledge" }).getAttribute("href"),
  ).toBe("/bots/bot-1");
});

test("the panel says it shows only this user's recent work in this conversation", async () => {
  serve(json({ activity }));
  const { container } = renderPanel();

  await waitFor(() => expect(container.textContent).toContain("Task asking"));
  expect(container.textContent).toContain(
    "Your own work in this conversation. Completed work shown here is recent only.",
  );
  expect(container.textContent).toContain("Recently completed");
});

test("rows in this conversation do not link back to it, so Open cannot close the panel", async () => {
  serve(json({ activity }));
  const { container } = renderPanel();

  await waitFor(() => expect(container.textContent).toContain("Task running"));
  const hrefs = [...container.querySelectorAll("a")].map((link) =>
    link.getAttribute("href"),
  );
  expect(hrefs).toEqual(["/bots/bot-1"]);
  expect(
    [...container.querySelectorAll("button")].map((b) => b.textContent),
  ).not.toContain("Open");
  expect(getStop(container).textContent).toBe("Stop");
});

test("a failed activity read is an alert, not an empty list", async () => {
  serve(json({ error: "boom" }, 500));
  const { getByRole, container } = renderPanel();

  await waitFor(() => getByRole("alert"));
  expect(getByRole("alert").textContent).toBe(
    "Could not load your work in this conversation.",
  );
  expect(container.textContent).not.toContain("No work here");
});

test("a failed refresh keeps the loaded rows and their Stop, beside the refresh error", async () => {
  const writes = serve(json({ activity }), json({ error: "boom" }, 500));
  const { container, getByRole, queryClient } = renderPanel();

  await waitFor(() => expect(container.textContent).toContain("Task running"));
  await queryClient.refetchQueries({
    queryKey: botActivityQueryOptions("bot-1").queryKey,
  });

  await waitFor(() => getByRole("alert"));
  expect(getByRole("alert").textContent).toBe(
    "Could not refresh. Showing the last update.",
  );
  expect(container.textContent).toContain("Task asking");
  expect(container.textContent).toContain("Task running");
  expect(container.textContent).not.toContain("Could not load");
  fireEvent.click(getStop(container));
  await waitFor(() => expect(writes).toHaveLength(1));
});

test("a long unbroken title is confined to the row and truncated, and Stop stays visible", async () => {
  const longTitle =
    "LongUnbrokenTitleWithoutSpacesForLayoutRegressionTesting0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  serve(
    json({
      activity: {
        inProgress: [item({ id: "long", title: longTitle, stoppable: true })],
        scheduled: [],
        completed: [],
      },
    }),
  );
  const { container } = renderPanel();

  await waitFor(() => expect(container.textContent).toContain(longTitle));
  const content = container.querySelector('[data-slot="item-content"]');
  const title = container.querySelector('[data-slot="item-title"]');
  const label = title?.querySelector("span");
  expect(content?.classList.contains("min-w-0")).toBe(true);
  expect(title?.classList.contains("w-full")).toBe(true);
  expect(title?.classList.contains("w-fit")).toBe(false);
  expect(title?.classList.contains("min-w-0")).toBe(true);
  expect(label?.classList.contains("truncate")).toBe(true);
  expect(label?.getAttribute("title")).toBe(longTitle);
  expect(getStop(container).textContent).toBe("Stop");
});

function getStop(container: HTMLElement) {
  const stop = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Stop",
  );
  if (!stop) throw new Error("No Stop button rendered");
  return stop;
}
