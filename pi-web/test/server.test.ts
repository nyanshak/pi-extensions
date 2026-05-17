import { describe, it, expect } from "./test.js";
import { startServer, buildWsUrl, buildHttpUrl } from "../src/server.js";
import WebSocket from "ws";

async function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("Timeout")), 2000);
  });
}

describe("Server Module", () => {
  describe("startServer", () => {
    it("should start server on random port and accept connections", async () => {
      const server = await startServer({}, (ws) => {});
      expect(server.port).toBeTruthy();
      expect(server.host).toBe("127.0.0.1");

      const ws = await connectWs(server.port);
      ws.close();
      await server.close();
    });

    it("should start server on specific port", async () => {
      const port = 9876;
      const server = await startServer({ port }, (ws) => {});
      expect(server.port).toBe(port);

      const ws = await connectWs(port);
      ws.close();
      await server.close();
    });

    it("should start server on 0.0.0.0", async () => {
      const server = await startServer({ host: "0.0.0.0", port: 0 }, (ws) => {});
      expect(server.host).toBe("0.0.0.0");
      await server.close();
    });

    it("should close and free the port", async () => {
      const server = await startServer({ port: 0 }, (ws) => {});
      const port = server.port;
      await server.close();

      // Port should no longer be in use
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => {
        ws.on("error", () => resolve()); // Expected
      });
    });
  });

  describe("buildWsUrl", () => {
    it("should build URL without password", () => {
      expect(buildWsUrl("127.0.0.1", 8080)).toBe("ws://127.0.0.1:8080");
    });

    it("should build URL with password", () => {
      expect(buildWsUrl("127.0.0.1", 8080, "secret")).toBe("ws://127.0.0.1:8080?password=secret");
    });

    it("should URL-encode special characters", () => {
      expect(buildWsUrl("127.0.0.1", 8080, "p@ss word")).toBe("ws://127.0.0.1:8080?password=p%40ss%20word");
    });

    it("should handle localhost", () => {
      expect(buildWsUrl("localhost", 3000)).toBe("ws://localhost:3000");
    });
  });

  describe("buildHttpUrl", () => {
    it("should build HTTP URL", () => {
      expect(buildHttpUrl("127.0.0.1", 8080)).toBe("http://127.0.0.1:8080");
    });

    it("should handle localhost", () => {
      expect(buildHttpUrl("localhost", 3000)).toBe("http://localhost:3000");
    });
  });

  describe("health endpoint", () => {
    it("should return 200 with ok status", async () => {
      const server = await startServer({ port: 0 }, (ws) => {});

      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe("ok");

      await server.close();
    });

    it("should return 404 for unknown endpoints", async () => {
      const server = await startServer({ port: 0 }, (ws) => {});

      const res = await fetch(`http://127.0.0.1:${server.port}/unknown`);
      expect(res.status).toBe(404);

      await server.close();
    });
  });

  describe("password auth - HTTP", () => {
    it("should reject HTTP without password", async () => {
      const server = await startServer({ port: 0, password: "secret" }, (ws) => {});
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(res.status).toBe(401);
      await server.close();
    });

    it("should accept HTTP with Bearer header", async () => {
      const server = await startServer({ port: 0, password: "secret" }, (ws) => {});
      const res = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { Authorization: "Bearer secret" },
      });
      expect(res.status).toBe(200);
      await server.close();
    });

    it("should accept HTTP with query param", async () => {
      const server = await startServer({ port: 0, password: "secret" }, (ws) => {});
      const res = await fetch(`http://127.0.0.1:${server.port}/health?password=secret`);
      expect(res.status).toBe(200);
      await server.close();
    });

    it("should reject HTTP with wrong password", async () => {
      const server = await startServer({ port: 0, password: "secret" }, (ws) => {});
      const res = await fetch(`http://127.0.0.1:${server.port}/health?password=wrong`);
      expect(res.status).toBe(401);
      await server.close();
    });
  });

  describe("password auth - WebSocket", () => {
    it("should reject WebSocket without password", async () => {
      const server = await startServer({ port: 0, password: "secret" }, (ws) => {});
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      await new Promise<void>((resolve) => {
        ws.on("error", () => resolve());
        ws.on("close", () => resolve());
      });
      await server.close();
    });

    it("should accept WebSocket with password", async () => {
      const server = await startServer({ port: 0, password: "secret" }, (ws) => {});
      const ws = await connectWsWithPassword(server.port, "secret");
      ws.close();
      await server.close();
    });
  });
});

async function connectWsWithPassword(port: number, password: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?password=${encodeURIComponent(password)}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("Timeout")), 2000);
  });
}