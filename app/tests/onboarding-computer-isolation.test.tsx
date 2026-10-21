import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Route } from "@/routes/_authed/onboarding";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function setup(computerIsolation: unknown, unavailable = false) {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      if (String(input) === "/api/capabilities") {
        return unavailable
          ? Response.json({ error: "Unavailable" }, { status: 503 })
          : Response.json({ computerIsolation });
      }
      return Response.json({ agents: [] });
    },
    { preconnect: originalFetch.preconnect },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const rootRoute = createRootRoute({ component: Route.options.component });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function advance(view: ReturnType<typeof setup>) {
  const button = await view.findByRole("button", { name: "Continue" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  fireEvent.click(button);
}

test("per-bot onboarding discloses the computer shared by public coworker users", async () => {
  const view = setup("per-bot");
  await advance(view);
  expect(
    await view.findByRole("heading", {
      name: "Each coworker has its own computer",
    }),
  ).toBeTruthy();
  expect(
    view.getByText(
      "People who use the same public coworker share its computer, browser logins and files.",
    ),
  ).toBeTruthy();
  await advance(view);
  expect(await view.findByRole("button", { name: "Get started" })).toBeTruthy();
});

test("shared onboarding discloses shared browser logins and files", async () => {
  const view = setup("shared");
  await advance(view);
  expect(
    await view.findByRole("heading", {
      name: "All agents share one computer",
    }),
  ).toBeTruthy();
  expect(
    view.getByText(
      "One computer is shared across this whole workspace. Browser logins and files on it may be used by agents run by other people.",
    ),
  ).toBeTruthy();
  expect(view.queryByText("Each coworker has its own computer")).toBeNull();
  expect(
    view.queryByText(
      "People who use the same public coworker share its computer, browser logins and files.",
    ),
  ).toBeNull();
});

test.each(["none", undefined, "unknown"])(
  "onboarding skips the computer for %j",
  async (isolation) => {
    const view = setup(isolation);
    await advance(view);
    expect(
      await view.findByRole("heading", {
        name: "Choose from a variety of agents or create your own",
      }),
    ).toBeTruthy();
    expect(view.getByRole("button", { name: "Get started" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Back" }));
    expect(
      await view.findByRole("heading", { name: /^Welcome to/ }),
    ).toBeTruthy();
  },
);

test("unavailable capabilities skip the computer", async () => {
  const view = setup(undefined, true);
  await advance(view);
  expect(await view.findByRole("button", { name: "Get started" })).toBeTruthy();
});
