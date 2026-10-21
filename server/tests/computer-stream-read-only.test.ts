import { expect, test } from "bun:test";
import { startHttpServer } from "../src/http-server";

test("trusted stream proxy drops incoming gestures while streaming frames outward", async () => {
  const forwarded: unknown[] = [];
  const frame = JSON.stringify({
    type: "frame",
    data: "jpeg",
    width: 1280,
    height: 800,
  });
  const upstream = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("Upgrade required", { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.subscribe("frames");
        ws.send(frame);
      },
      message(_ws, raw) {
        forwarded.push(raw);
      },
    },
  });
  const server = startHttpServer({
    port: 0,
    config: { computer: { token: "fixture" } },
    resolveRequestActor: async () => ({
      id: "owner",
      name: "Owner",
      role: "user",
    }),
    agentProfileStore: {
      get: async () => ({ visibility: "private", ownerUserId: "owner" }),
    },
    computerGateway: { locate: async () => upstream.url.toString() },
    demonstrationStore: { active: async () => undefined },
  } as unknown as Parameters<typeof startHttpServer>[0]);
  const socket = new WebSocket(
    `ws://localhost:${server.port}/api/computers/bot/stream`,
  );
  try {
    const received = await new Promise<string>((resolve, reject) => {
      socket.onmessage = (event) => resolve(String(event.data));
      socket.onerror = reject;
    });
    expect(received).toBe(frame);
    for (const type of [
      "click",
      "type",
      "key",
      "scroll",
      "mouse",
      "keyboard",
      "paste",
      "unknown",
    ]) {
      socket.send(JSON.stringify({ type, text: "input", x: 10, y: 20 }));
    }
    socket.send(Buffer.from([1, 2, 3]));
    socket.send("invalid json");
    await Bun.sleep(50);
    expect(forwarded).toEqual([]);
    const nextFrame = new Promise<string>((resolve) => {
      socket.onmessage = (event) => resolve(String(event.data));
    });
    upstream.publish("frames", frame);
    expect(await nextFrame).toBe(frame);
  } finally {
    socket.close();
    server.stop(true);
    upstream.stop(true);
  }
});
