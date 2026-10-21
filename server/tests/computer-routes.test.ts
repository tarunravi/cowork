import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import {
  computerAccessCheck,
  computerControlCheck,
  computerRecoveryAcknowledgementCheck,
} from "../src/agents/computer-access";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  type ComputerGateway,
  createComputerGateway,
} from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import type { ComputerProvider } from "../src/computer/provider";
import { createComputerRoutes } from "../src/computer/routes";

describe("computer routes", () => {
  test("gets a screenshot through the governed computer gateway", async () => {
    const requestedBotIds: string[] = [];
    const gateway = {
      screenshot: async (botId: string) => {
        requestedBotIds.push(botId);
        return { image: "aGVsbG8=", mimeType: "image/png" as const };
      },
    } as unknown as ComputerGateway;
    const policyStore = {} as PolicyStore;
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      _context,
      next,
    ) => next();
    // Permissive: what this covers is the gateway seam, not who may act as the Bot. That question
    // has its own suite in bot-access.test.ts.
    const routes = createComputerRoutes(
      gateway,
      policyStore,
      requireUser,
      async () => true,
    );

    const response = await routes.request(
      "http://openbot.test/bot-17/screenshot",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      image: "aGVsbG8=",
      mimeType: "image/png",
    });
    expect(requestedBotIds).toEqual(["bot-17"]);
  });
});

/**
 * The fleet listing is the one route here that is not about the Bot in its path.
 *
 * `:botId` is ignored and the handler returns every computer, so a signed-in person asking about a
 * Bot they own learned every Bot id in the deployment and whether its computer was running,
 * private coworkers included. Being signed in is not the question; administering the deployment is.
 */
const member: AuthenticatedActor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
};

const administrator: AuthenticatedActor = {
  id: "admin-1",
  email: "admin@openbot.test",
  role: "admin",
};

function asActor(
  actor: AuthenticatedActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

function appFor(actor: AuthenticatedActor, computers: () => Promise<unknown>) {
  let listed = 0;
  const countingGateway = {
    async computers() {
      listed += 1;
      return computers();
    },
  } as ComputerGateway;

  return {
    app: createComputerRoutes(
      countingGateway,
      {} as PolicyStore,
      asActor(actor),
      // Permissive. Whether this person may act as the Bot in the path is a different question with
      // its own suite, and `:botId` is not what this route answers about anyway.
      async () => true,
    ),
    listed: () => listed,
  };
}

describe("computer fleet listing", () => {
  test("refuses a signed-in user the fleet, and does not ask the gateway", async () => {
    const { app, listed } = appFor(member, async () => ({
      isolation: "per-bot",
      computers: [
        { botId: "private-coworker", running: true, startedAt: null },
      ],
    }));

    const response = await app.request("http://openbot.test/any-bot/computers");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Administrator access required.",
    });
    // Refused before the gateway is asked: a check that runs after the fleet has been read is not a
    // check, it is a filter on the response.
    expect(listed()).toBe(0);
  });

  test("lets an administrator see the fleet", async () => {
    const fleet = {
      isolation: "per-bot" as const,
      computers: [
        {
          botId: "private-coworker",
          running: true,
          startedAt: "2026-08-20T00:00:00.000Z",
          egress: null,
        },
      ],
    };
    const { app, listed } = appFor(administrator, async () => fleet);

    const response = await app.request("http://openbot.test/any-bot/computers");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(fleet);
    expect(listed()).toBe(1);
  });
});

/**
 * The kind of human input is what the path says, and only what the path says.
 *
 * The route checks `:kind` against the four gestures a person's mouse and keyboard produce, and then
 * built the call as `{ kind, ...body }`, so a body carrying its own `kind` replaced the value that
 * had just been checked. The gateway puts that value straight into the path it calls on the
 * computer, so the check decided one thing and the request went somewhere else.
 *
 * This route is the one that deliberately skips the policy decision and the audit row, because a
 * takeover exists so a person can type the thing nothing should keep. That makes it the worst one to
 * be able to redirect: nothing downstream writes the row that would have shown where it went.
 */
describe("human input", () => {
  function recordingGateway() {
    const calls: Array<{ botId: string; input: Record<string, unknown> }> = [];
    const gateway = {
      humanInput: async (botId: string, input: Record<string, unknown>) => {
        calls.push({ botId, input });
        return { ok: true };
      },
    } as unknown as ComputerGateway;
    return {
      calls,
      app: createComputerRoutes(
        gateway,
        {} as PolicyStore,
        asActor(member),
        async () => true,
      ),
    };
  }

  async function send(body: unknown, kind = "click") {
    const { app, calls } = recordingGateway();
    const response = await app.request(
      `http://openbot.test/bot-1/human/${kind}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { response, calls };
  }

  test("refuses a real gesture at the server boundary", async () => {
    const { response, calls } = await send({ x: 10, y: 20 });

    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("a body naming its own kind does not decide where the call goes", async () => {
    // `../computers/reset` is the shape that matters: the gateway interpolates this into the path it
    // calls, and a fetch resolves the `..` away, so the request lands on a different endpoint of the
    // computer's API carrying the deployment's computer token.
    const { calls } = await send({ kind: "../computers/reset", x: 1, y: 1 });

    expect(calls).toEqual([]);
  });

  test("a body naming its own kind cannot reach the shell either", async () => {
    const { calls } = await send(
      { kind: "../exec", text: "cat /workspace/notes" },
      "type",
    );

    expect(calls).toEqual([]);
  }, 10_000);

  test("a kind the path does not allow is still refused", async () => {
    // The existing check, which must go on working: the four gestures are the whole surface.
    const { response, calls } = await send({ x: 1 }, "screenshot");

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("private isolated computer ownership", () => {
  for (const isolation of ["per-bot", "shared", "none"] as const) {
    for (const visibility of ["private", "team", "public"] as const) {
      for (const actor of [
        member,
        administrator,
        { ...member, id: "teammate" },
      ]) {
        test(`${isolation} ${visibility} ${actor.id}: capability and direct handoff routes`, async () => {
          const profile = { visibility, ownerUserId: member.id };
          const store = {
            get: async () => profile,
          } as unknown as AgentProfileStore;
          const calls: string[] = [];
          let holder = "bot";
          const state = () => ({ holder, request: { id: "r1" } });
          const gateway = {
            control: async () => state(),
            requestHelp: async () => {
              calls.push("request");
              return state();
            },
            takeControl: async () => {
              calls.push("take");
              holder = "human";
              return state();
            },
            releaseControl: async () => {
              calls.push("release");
              holder = "bot";
              return state();
            },
            acknowledgeRecovery: async () => {
              calls.push("acknowledge");
              return { ...state(), acknowledged: true };
            },
          } as unknown as ComputerGateway;
          const app = createComputerRoutes(
            gateway,
            {} as PolicyStore,
            asActor(actor),
            computerAccessCheck(store),
            undefined,
            undefined,
            computerControlCheck(store, isolation),
            computerRecoveryAcknowledgementCheck(store),
          );
          const teammate = visibility !== "public" && actor.id === "teammate";
          const mayAcknowledge =
            actor.role === "admin" || actor.id === member.id;
          const eligible =
            isolation === "per-bot" && visibility === "private" && !teammate;
          const read = await app.request("http://test/bot/control");
          expect(read.status).toBe(teammate ? 404 : 200);
          if (!teammate)
            expect(await read.json()).toMatchObject({
              canControl: eligible,
              canAcknowledgeRecovery: mayAcknowledge,
            });
          for (const action of ["request", "take", "release"]) {
            const response = await app.request(
              `http://test/bot/control/${action}`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ requestId: "r1" }),
              },
            );
            expect(response.status).toBe(
              teammate ? 404 : action === "take" && !eligible ? 403 : 200,
            );
            if (eligible)
              expect((await response.json()).holder).toBe(
                action === "take" ? "human" : "bot",
              );
          }
          const acknowledgement = await app.request(
            "http://test/bot/control/acknowledge-recovery",
            { method: "POST" },
          );
          expect(acknowledgement.status).toBe(
            teammate ? 404 : mayAcknowledge ? 200 : 403,
          );
          expect(calls).toEqual(
            teammate
              ? []
              : [
                  "request",
                  ...(eligible ? ["take"] : []),
                  "release",
                  ...(mayAcknowledge ? ["acknowledge"] : []),
                ],
          );
        });
      }
    }
  }
  test("missing handoff policy fails closed", async () => {
    const app = createComputerRoutes(
      {} as ComputerGateway,
      {} as PolicyStore,
      asActor(member),
      async () => true,
    );
    for (const action of ["take"]) {
      expect(
        (
          await app.request(`http://test/bot/control/${action}`, {
            method: "POST",
          })
        ).status,
      ).toBe(403);
    }
  });
});

test("allowed handoff preserves gateway ownership audit events", async () => {
  const rows: AuditEventInput[] = [];
  let eligible = true;
  let holder = "bot";
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-bot",
    locate: async () => "http://computer.test",
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    list: async () => [],
  };
  const gateway = createComputerGateway({
    provider,
    token: "test-token",
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    auditStore: {
      insert: async (row: AuditEventInput) => {
        rows.push(row);
      },
    } as unknown as AuditStore,
    fetchImpl: (async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/control/take") holder = "human";
      if (path === "/control/release") holder = "bot";
      return Response.json({
        holder,
        reason: "Manual handoff",
        request: { id: "r1" },
      });
    }) as typeof fetch,
  });
  const app = createComputerRoutes(
    gateway,
    {} as PolicyStore,
    asActor(member),
    async () => true,
    undefined,
    undefined,
    async () => eligible,
  );
  for (const action of ["take", "release"]) {
    if (action === "release") eligible = false;
    const response = await app.request(`http://test/bot/control/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r1" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).holder).toBe(
      action === "take" ? "human" : "bot",
    );
  }
  expect(rows.map((row) => row.eventType)).toEqual([
    "computer.control_taken",
    "computer.control_released",
  ]);
  expect(rows.map((row) => row.actorUserId)).toEqual([member.id, member.id]);
});
