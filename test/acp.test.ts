import { describe, it, expect } from "./test.js";
import { startServer } from "../src/server.js";
import { WebSocketTransport, type JsonRpcMessage } from "../src/websocket.js";

async function connectWs(port: number): Promise<WebSocket> {
  const { WebSocket } = await import("ws");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("Timeout")), 2000);
  });
}

// ACP method handlers for testing
const acpHandlers = {
  session_new: async (params: unknown) => ({
    sessionId: `session-${Date.now()}`,
    capability: {},
  }),
  session_prompt: async (params: unknown) => ({ sessionId: params, content: [] }),
  session_end: async (params: unknown) => ({ success: true }),
  "session/list": async () => ({ sessions: [], nextCursor: null }),
  "session/update_metadata": async (params: unknown) => ({ success: true }),
  "session/cancel": async (params: unknown) => ({ success: true }),
  capabilities: async () => ({
    capabilities: {
      streaming: true,
      tools: true,
      commands: true,
    },
  }),
};

describe("ACP Handler Tests", () => {
  it("should handle session_new via request", async () => {
    const server = await startServer({ port: 0 }, (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        // Echo back a response for this test
        if (msg.method === "session_new") {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { sessionId: "test-session", capability: {} }
          }));
        }
      });
    });

    const rawWs = await connectWs(server.port);
    const transport = new WebSocketTransport(rawWs);

    let result: any = null;
    transport.onMessage = (msg) => {
      if (msg.result) result = msg.result;
    };

    // Send request (which will be echoed back)
    const response = await transport.sendRequest<{ sessionId: string }>("session_new", { model: "claude" });

    expect(response).toBeTruthy();
    expect(response.sessionId).toBe("test-session");

    rawWs.close();
    await server.close();
  });

  it("should handle session_prompt via request", async () => {
    const server = await startServer({ port: 0 }, (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === "session_prompt") {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { sessionId: msg.params?.sessionId || "unknown", content: [] }
          }));
        }
      });
    });

    const rawWs = await connectWs(server.port);
    const transport = new WebSocketTransport(rawWs);

    const response = await transport.sendRequest("session_prompt", { sessionId: "test", prompt: "hello" });

    expect(response).toBeTruthy();
    expect((response as any).sessionId).toBe("test");

    rawWs.close();
    await server.close();
  });

  it("should handle session_end via request", async () => {
    const server = await startServer({ port: 0 }, (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === "session_end") {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { success: true }
          }));
        }
      });
    });

    const rawWs = await connectWs(server.port);
    const transport = new WebSocketTransport(rawWs);

    const response = await transport.sendRequest("session_end", { sessionId: "test" });

    expect(response).toBeTruthy();
    expect((response as any).success).toBe(true);

    rawWs.close();
    await server.close();
  });

  it("should handle session/list via request", async () => {
    const server = await startServer({ port: 0 }, (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === "session/list") {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { sessions: [], nextCursor: null }
          }));
        }
      });
    });

    const rawWs = await connectWs(server.port);
    const transport = new WebSocketTransport(rawWs);

    const response = await transport.sendRequest("session/list", {});

    expect(response).toBeTruthy();
    expect((response as any).sessions).toEqual([]);
    expect((response as any).nextCursor).toBe(null);

    rawWs.close();
    await server.close();
  });

  it("should handle session/update_metadata via request", async () => {
    const server = await startServer({ port: 0 }, (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === "session/update_metadata") {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { success: true }
          }));
        }
      });
    });

    const rawWs = await connectWs(server.port);
    const transport = new WebSocketTransport(rawWs);

    const response = await transport.sendRequest("session/update_metadata", { sessionId: "test", name: "My Session" });

    expect(response).toBeTruthy();
    expect((response as any).success).toBe(true);

    rawWs.close();
    await server.close();
  });

  it("should handle session/cancel via request", async () => {
    const server = await startServer({ port: 0 }, (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === "session/cancel") {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { success: true }
          }));
        }
      });
    });

    const rawWs = await connectWs(server.port);
    const transport = new WebSocketTransport(rawWs);

    const response = await transport.sendRequest("session/cancel", { sessionId: "test" });

    expect(response).toBeTruthy();
    expect((response as any).success).toBe(true);

    rawWs.close();
    await server.close();
  });

  it("should handle capabilities via request", async () => {
    const server = await startServer({ port: 0 }, (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === "capabilities") {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              capabilities: {
                streaming: true,
                tools: true,
                commands: true,
              },
            },
          }));
        }
      });
    });

    const rawWs = await connectWs(server.port);
    const transport = new WebSocketTransport(rawWs);

    const response = await transport.sendRequest("capabilities", {});

    expect(response).toBeTruthy();
    expect((response as any).capabilities.streaming).toBe(true);
    expect((response as any).capabilities.tools).toBe(true);
    expect((response as any).capabilities.commands).toBe(true);

    rawWs.close();
    await server.close();
  });

  it("should return error for unknown method", async () => {
    const server = await startServer({ port: 0 }, (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        // Return error for unknown method
        if (msg.method === "unknown_method") {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "Method not found" }
          }));
        }
      });
    });

    const rawWs = await connectWs(server.port);
    const transport = new WebSocketTransport(rawWs);

    let threw = false;
    try {
      await transport.sendRequest("unknown_method", {});
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("Method not found");
    }

    expect(threw).toBe(true);

    rawWs.close();
    await server.close();
  });

  it("should handle notifications without response", async () => {
    const server = await startServer({ port: 0 }, (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        // No response for notifications
        expect(msg.id).toBeUndefined();
        expect(msg.method).toBe("test_notification");
      });
    });

    const rawWs = await connectWs(server.port);
    const transport = new WebSocketTransport(rawWs);

    // Send notification - should not wait for response
    transport.sendNotification("test_notification", { data: "test" });

    // Small delay to allow message to be sent
    await new Promise((r) => setTimeout(r, 50));

    rawWs.close();
    await server.close();
  });

  it("should send multiple requests in sequence", async () => {
    const server = await startServer({ port: 0 }, (ws) => {
      let counter = 0;
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method) {
          const reqId = msg.id;
          setTimeout(() => {
            ws.send(JSON.stringify({
              jsonrpc: "2.0",
              id: reqId,
              result: { index: counter++ }
            }));
          }, counter * 10); // Stagger responses
        }
      });
    });

    const rawWs = await connectWs(server.port);
    const transport = new WebSocketTransport(rawWs);

    const r1 = await transport.sendRequest("test1", {});
    const r2 = await transport.sendRequest("test2", {});

    expect((r1 as any).index).toBe(0);
    expect((r2 as any).index).toBe(1);

    rawWs.close();
    await server.close();
  });
});