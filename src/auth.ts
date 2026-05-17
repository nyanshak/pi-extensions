// Password authentication for WebSocket connections

import type { IncomingMessage } from "node:http";

/**
 * Check if request has valid password authentication
 */
export function checkAuth(req: IncomingMessage, password: string): boolean {
  // Check Authorization header: "Authorization: Bearer <password>"
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1] === password) {
      return true;
    }
  }

  // Check query parameter: ?password=<password>
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const queryPassword = url.searchParams.get("password");
  if (queryPassword === password) {
    return true;
  }

  return false;
}

/**
 * Format password for display (masked)
 */
export function maskPassword(password: string): string {
  return "*".repeat(password.length);
}