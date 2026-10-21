import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { deploymentCapabilitiesQueryOptions } from "../src/lib/deployment/queries";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const isolationCases: Array<[unknown, "per-bot" | "shared" | "none"]> = [
  ["per-bot", "per-bot"],
  ["shared", "shared"],
  ["none", "none"],
  [undefined, "none"],
  ["unknown", "none"],
  [true, "none"],
  [null, "none"],
];

test.each(isolationCases)(
  "parses computer isolation %j as %s",
  async (value, expected) => {
    globalThis.fetch = Object.assign(
      async () => Response.json({ computerIsolation: value }),
      { preconnect: originalFetch.preconnect },
    );
    const client = new QueryClient();
    try {
      const capabilities = await client.fetchQuery(
        deploymentCapabilitiesQueryOptions(),
      );
      expect(capabilities.computerIsolation).toBe(expected);
    } finally {
      client.clear();
    }
  },
);
