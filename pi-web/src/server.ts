import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { checkAuth } from "./auth.js";
import type { IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve as pathResolve } from "node:path";

export interface WebSocketHandler {
  (ws: WebSocket, request: IncomingMessage): void;
}

export interface ServerConfig {
  host?: string;
  port?: number;
  password?: string;
  staticDir?: string;
}

export interface StartServerResult {
  host: string;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(
  config: ServerConfig,
  onConnection: WebSocketHandler
): Promise<StartServerResult> {
  const host = config.host || "127.0.0.1";
  const password = config.password;
  let actualPort = config.port || 0;
  // Resolve staticDir to absolute path for path traversal checks
  const staticDir = config.staticDir ? pathResolve(config.staticDir) : undefined;

  return new Promise((resolvePromise, rejectPromise) => {
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

      // Serve static files from configured directory
      if (staticDir) {
        const requestedPath = url.pathname === "/" 
          ? "index.html" 
          : url.pathname.slice(1); // Remove leading slash
        
        const filePath = pathResolve(staticDir, requestedPath);
        
        // Security: ensure path is within static directory
        if (!filePath.startsWith(staticDir + "/") && filePath !== staticDir) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden");
          return;
        }

        readFile(filePath)
          .then((content) => {
            const ext = extname(filePath);
            const mimeTypes: Record<string, string> = {
              ".html": "text/html",
              ".css": "text/css",
              ".js": "application/javascript",
              ".mjs": "application/javascript",
              ".json": "application/json",
              ".png": "image/png",
              ".jpg": "image/jpeg",
              ".svg": "image/svg+xml",
              ".ico": "image/x-icon",
            };
            const contentType = mimeTypes[ext] || "application/octet-stream";
            res.writeHead(200, { "Content-Type": contentType });
            res.end(content);
          })
          .catch(() => {
            // File not found, continue to 404
          });
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    const wss = new WebSocketServer({ server });

    wss.on("upgrade", (request, socket, head) => {
      if (password && !checkAuth(request, password)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });

    wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
      onConnection(ws, request);
    });

    // Handle errors
    server.on("error", (err) => {
      rejectPromise(err);
    });

    // Start listening
    server.listen(actualPort, host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        actualPort = addr.port;
      }

      resolvePromise({
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

export function buildWsUrl(host: string, port: number, password?: string): string {
  let url = `ws://${host}:${port}`;
  if (password) {
    url += `?password=${encodeURIComponent(password)}`;
  }
  return url;
}

export function buildHttpUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}
