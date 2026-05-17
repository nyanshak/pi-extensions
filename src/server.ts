// HTTP server with WebSocket upgrade support

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { checkAuth } from "./auth.js";
import type { IncomingMessage } from "node:http";

export interface WebSocketHandler {
  (ws: WebSocket, request: IncomingMessage): void;
}

export interface ServerConfig {
  host?: string;
  port?: number;
  password?: string;
}

export interface StartServerResult {
  host: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Start HTTP server with WebSocket upgrade support
 */
export async function startServer(
  config: ServerConfig,
  onConnection: WebSocketHandler
): Promise<StartServerResult> {
  const host = config.host || "127.0.0.1";
  const password = config.password;
  let actualPort = config.port || 0;

  return new Promise((resolve, reject) => {
    // Create HTTP server
    const server = http.createServer((req, res) => {
      // Handle CORS preflight (we're not enabling CORS, but handle gracefully)
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Parse URL to get pathname and query params
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      // Check auth for WebSocket upgrade requests
      if (password && !checkAuth(req, password)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorized");
        return;
      }

      // Health check endpoint
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      // Unknown endpoint
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    // Create WebSocket server attached to HTTP server
    const wss = new WebSocketServer({ server });

    // Handle WebSocket upgrade
    wss.on("upgrade", (request, socket, head) => {
      // Check auth for WebSocket connections
      if (password && !checkAuth(request, password)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });

    // Handle new WebSocket connections
    wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
      onConnection(ws, request);
    });

    // Handle errors
    server.on("error", (err) => {
      reject(err);
    });

    // Start listening
    server.listen(actualPort, host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        actualPort = addr.port;
      }

      resolve({
        host,
        port: actualPort,
        close: () =>
          new Promise<void>((res) => {
            wss.close(() => {
              server.close(() => res());
            });
          }),
      });
    });
  });
}

/**
 * Build WebSocket URL from server config
 */
export function buildWsUrl(host: string, port: number, password?: string): string {
  let url = `ws://${host}:${port}`;
  if (password) {
    url += `?password=${encodeURIComponent(password)}`;
  }
  return url;
}

/**
 * Build HTTP URL from server config
 */
export function buildHttpUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}