import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";

/**
 * The home roster is one compact row under the composer: at most four coworkers shared with the
 * person, a "See all" link to `/agents`, and the section named "Coworkers".
 *
 * Same harness as `agent-roster-error.test.tsx`: `GlobalRegistrator` for the document, `cleanup`
 * after each test, and a seeded query so the roster renders without a network read.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;

beforeEach(() => {
  // The seeded query has a long `staleTime`, so agents are never refetched. Other reads from the
  // composer are not part of this assertion, and a 500 keeps them from pretending to succeed.
  global.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    name: "Agent",
    title: "Title",
    roleDescription: "Role",
    avatarSeed: "seed",
    visibility: "public",
    endpoint: null,
    builtIn: false,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    systemOwned: false,
    canManage: false,
    mine: false,
    ...overrides,
  };
}

function queryClientWithAgents(agents: AgentProfile[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  return queryClient;
}

function renderHome(queryClient: QueryClient) {
  const rootRoute = createRootRoute({ component: HomeRoute.options.component });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("the home roster shows at most four coworkers shared with the person", async () => {
  const shared = Array.from({ length: 5 }, (_, index) =>
    agent({ id: `shared-${index + 1}`, name: `Shared ${index + 1}` }),
  );
  const own = agent({ id: "own-1", name: "Own Agent", mine: true });
  const view = renderHome(queryClientWithAgents([own, ...shared]));

  expect(await view.findByRole("heading", { name: "Coworkers" })).toBeTruthy();
  expect(view.queryByText("Explore agents")).toBeNull();

  const messageLinks = view.getAllByRole("button", { name: /^Message / });
  expect(messageLinks.map((link) => link.getAttribute("aria-label"))).toEqual([
    "Message Shared 1",
    "Message Shared 2",
    "Message Shared 3",
    "Message Shared 4",
  ]);
  expect(messageLinks.map((link) => link.getAttribute("href"))).toEqual([
    "/channel/new?agent=shared-1",
    "/channel/new?agent=shared-2",
    "/channel/new?agent=shared-3",
    "/channel/new?agent=shared-4",
  ]);
  expect(view.queryByRole("button", { name: /^View details for / })).toBeNull();
  expect(view.queryByText("Own Agent")).toBeNull();
});

test("See all links to the full agents list", async () => {
  const view = renderHome(
    queryClientWithAgents([agent({ id: "shared-1", name: "Shared 1" })]),
  );

  // The Button renders the Link, so the anchor carries the href but its role is still `button`.
  const seeAll = await view.findByRole("button", { name: "See all" });
  expect(seeAll.getAttribute("href")).toBe("/agents");
});
