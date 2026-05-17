import { describe, it, expect } from "./test.js";
import { WebSocketTransport } from "../src/websocket.js";
import { startServer } from "../src/server.js";

async function connectWs(port: number): Promise<WebSocket> {
  const { WebSocket } = await import("ws");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("Timeout")), 2000);
  });
}

describe("WebSocket Transport", () => {
  describe("sendNotification", () => {
    it("should send JSON-RPC notification via WebSocket", async () => {
      const server = await startServer({ port: 0 }, (ws) => {
        ws.on("message", (data) => ws.send(data)); // Echo back
      });
      const rawWs = await connectWs(server.port);
      const transport = new WebSocketTransport(rawWs);

      let received: any = null;
      rawWs.on("message", (data) => {
        try {
          received = JSON.parse(data.toString());
        } catch {
          // Ignore
        }
      });

      transport.sendNotification("ping", { value: 42 });

      // Wait for message
      await new Promise((r) => setTimeout(r, 50));

      expect(received).not.toBe(null);
      expect(received.jsonrpc).toBe("2.0");
      expect(received.method).toBe("ping");
      expect(received.params).toEqual({ value: 42 });
      expect(received.id).toBeUndefined();

      rawWs.close();
      await server.close();
    });
  });

  describe("sendResponse", () => {
    it("should send JSON-RPC response with id and result", async () => {
      const server = await startServer({ port: 0 }, (ws) => {
        ws.on("message", (data) => ws.send(data)); // Echo back
      });
      const rawWs = await connectWs(server.port);
      const transport = new WebSocketTransport(rawWs);

      let received: any = null;
      rawWs.on("message", (data) => {
        try {
          received = JSON.parse(data.toString());
        } catch {
          // Ignore
        }
      });

      transport.sendResponse(123, { success: true });

      await new Promise((r) => setTimeout(r, 50));

      expect(received).not.toBe(null);
      expect(received.jsonrpc).toBe("2.0");
      expect(received.id).toBe(123);
      expect(received.result).toEqual({ success: true });
      expect(received.error).toBeUndefined();

      rawWs.close();
      await server.close();
    });
  });

  describe("sendError", () => {
    it("should send JSON-RPC error response", async () => {
      const server = await startServer({ port: 0 }, (ws) => {
        ws.on("message", (data) => ws.send(data)); // Echo back
      });
      const rawWs = await connectWs(server.port);
      const transport = new WebSocketTransport(rawWs);

      let received: any = null;
      rawWs.on("message", (data) => {
        try {
          received = JSON.parse(data.toString());
        } catch {
          // Ignore
        }
      });

      transport.sendError(456, -32600, "Invalid Request", { detail: "missing field" });

      await new Promise((r) => setTimeout(r, 50));

      expect(received).not.toBe(null);
      expect(received.jsonrpc).toBe("2.0");
      expect(received.id).toBe(456);
      expect(received.error.code).toBe(-32600);
      expect(received.error.message).toBe("Invalid Request");
      expect(received.error.data).toEqual({ detail: "missing field" });

      rawWs.close();
      await server.close();
    });
  });

  describe("close", () => {
    it("should close WebSocket connection", async () => {
      const server = await startServer({ port: 0 }, (ws) => {});
      const rawWs = await connectWs(server.port);
      const transport = new WebSocketTransport(rawWs);

      const closed = new Promise<void>((resolve) => {
        rawWs.on("close", () => resolve());
      });

      transport.close(1000, "Done");

      await closed;
      await server.close();
    });

    it("should call onClose callback", async () => {
      const server = await startServer({ port: 0 }, (ws) => {});
      const rawWs = await connectWs(server.port);
      const transport = new WebSocketTransport(rawWs);

      let closeCode = 0;
      let closeReason = "";
      transport.onClose = (code, reason) => {
        closeCode = code;
        closeReason = reason;
      };

      rawWs.close(1001, "Test");

      await new Promise((r) => setTimeout(r, 50));

      expect(closeCode).toBe(1001);
      expect(closeReason).toBe("Test");

      await server.close();
    });
  });

  describe("isOpen", () => {
    it("should return true when WebSocket is open", async () => {
      const server = await startServer({ port: 0 }, (ws) => {});
      const rawWs = await connectWs(server.port);
      const transport = new WebSocketTransport(rawWs);

      expect(transport.isOpen()).toBe(true);

      rawWs.close();
      await new Promise<void>((resolve) => {
        rawWs.on("close", () => resolve());
      });

      await server.close();
    });

    it("should return false after close", async () => {
      const server = await startServer({ port: 0 }, (ws) => {});
      const rawWs = await connectWs(server.port);
      const transport = new WebSocketTransport(rawWs);

      transport.close();

      await new Promise<void>((resolve) => {
        rawWs.on("close", () => resolve());
      });

      await new Promise((r) => setTimeout(r, 20));

      expect(transport.isOpen()).toBe(false);

      await server.close();
    });
  });

  describe("handle invalid JSON", () => {
    it("should not throw on invalid JSON", async () => {
      const server = await startServer({ port: 0 }, (ws) => {
        ws.on("message", (data) => ws.send(data)); // Echo back
      });
      const rawWs = await connectWs(server.port);
      const transport = new WebSocketTransport(rawWs);

      // Send invalid JSON - should not throw
      let threw = false;
      try {
        rawWs.send("not valid json");
        rawWs.send("{json: 'broken'");
        rawWs.send("");
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);

      // Transport should still be open and functional
      expect(transport.isOpen()).toBe(true);

      rawWs.close();
      await server.close();
    });
  });
});