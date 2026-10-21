import { expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { createActivityStore } from "../src/activity/activity";
import type { Database } from "../src/db/client";

// The read model is exercised without a database, runner, or provider.
function store(hop: Record<string, unknown>) {
  const results = [[], [], [hop], [], [], []];
  let stopPredicate = "";
  const database = {
    select: () => {
      const rows = results.shift() ?? [];
      const query = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: async () => rows,
        then: (resolve: (value: unknown[]) => unknown) =>
          Promise.resolve(rows).then(resolve),
      };
      return query;
    },
    update: () => ({
      set: () => ({
        where: (predicate: Parameters<PgDialect["sqlToQuery"]>[0]) => {
          stopPredicate = new PgDialect().sqlToQuery(predicate).sql;
          return { returning: async () => [] };
        },
      }),
    }),
  };
  return {
    activity: createActivityStore(database as unknown as Database),
    predicate: () => stopPredicate,
  };
}

for (const [attempts, active, expected] of [
  [4, false, "retrying"],
  [6, false, "retrying"],
  [10, true, "running"],
  [10, false, "failed"],
] as const) {
  test(`saved reply at attempt ${attempts}, active=${active} is ${expected} and cannot be stopped`, async () => {
    const { activity, predicate } = store({
      key: "hop",
      payload: { fromBotId: "asking", toBotId: "answering", task: "help" },
      attempts,
      completionResult: { answer: "produced" },
      finishedAt: null,
      claimedBy: active ? "owner" : null,
      leaseUntil: active ? new Date(Date.now() + 60_000) : null,
      lastError: "queue unavailable",
      updatedAt: new Date(),
    });
    const rows = await activity.forBot("person", "asking");
    const item = [...rows.inProgress, ...rows.scheduled].find(
      (row) => row.id === "hop",
    );
    expect(item).toMatchObject({
      status: expected,
      stoppable: false,
      needsYou: expected === "failed",
    });
    if (expected === "failed")
      expect(item?.detail).toContain("reply delivery failed");
    expect(await activity.stopHandoff("person", "asking", "hop")).toBeNull();
    // The database guards the write too, including a stale UI's Stop request.
    expect(predicate()).toContain('"work_items"."completion_result" is null');
  });
}
