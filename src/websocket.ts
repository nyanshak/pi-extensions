// WebSocket transport for ACP protocol

import WebSocket from "ws";
import type {Duplex} from "node:stream";

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type MessageHandler = (message: JsonRpcMessage, ws: WebSocket) => void;

export interface WebSocketTransportConfig {
  onMessage?: MessageHandler;
  onClose?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
}

/**
 * WebSocket transport for JSON-RPC 2.0 messages
 */
export class WebSocketTransport {
  private ws: WebSocket;
  private pendingRequests: Map<string | number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private requestId = 0;
  private onMessage?: MessageHandler;
  private onClose?: (code: number, reason: string) => void;
  private onError?: (error: Error) => void;

  constructor(ws: WebSocket, config?: WebSocketTransportConfig) {
    this.ws = ws;
    this.onMessage = config?.onMessage;
    this.onClose = config?.onClose;
    this.onError = config?.onError;

    this.ws.on("message", (data: WebSocket.RawData) => {
      try {
        const message = JSON.parse(data.toString()) as JsonRpcMessage;
        this.handleMessage(message);
      } catch {
        // Silently ignore invalid JSON - not a valid JSON-RPC message
      }
    });

    this.ws.on("close", (code, reason) => {
      this.onClose?.(code, reason.toString());
    });

    this.ws.on("error", (err) => {
      this.onError?.(err as Error);
    });
  }

  /**
   * Handle incoming JSON-RPC message
   */
  private handleMessage(raw: unknown): void {
    // Validate message is an object
    if (!raw || typeof raw !== "object") {
      return;
    }

    const message = raw as JsonRpcMessage;

    // Must have jsonrpc version
    if (message.jsonrpc !== "2.0") {
      return;
    }
    // Notification (no id) - just pass to handler
    if (message.id === undefined && message.method) {
      this.onMessage?.(message, this.ws);
      return;
    }

    // Request (has id and method) - pass to handler for response
    if (message.id !== undefined && message.method) {
      this.onMessage?.(message, this.ws);
      return;
    }

    // Response (has id, no method) - resolve pending request
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(String(message.id));
      if (pending) {
        this.pendingRequests.delete(String(message.id));
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  async sendRequest<T = unknown>(
    method: string,
    params?: unknown
  ): Promise<T> {
    const id = ++this.requestId;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(String(id), { resolve, reject });

      const message: JsonRpcMessage = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      this.ws.send(JSON.stringify(message));

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(String(id))) {
          this.pendingRequests.delete(String(id));
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  sendNotification(method: string, params?: unknown): void {
    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      method,
      params,
    };

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Send a JSON-RPC response
   */
  sendResponse(id: string | number | null, result?: unknown): void {
    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      result,
    };

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Send a JSON-RPC error response
   */
  sendError(
    id: string | number | null,
    code: number,
    errorMsg: string,
    data?: unknown
  ): void {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      error: { code, message: errorMsg, data },
    };

    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Close the WebSocket connection
   */
  close(code = 1000, reason = "Normal closure"): void {
    this.ws.close(code, reason);
  }

  /**
   * Check if WebSocket is open
   */
  isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }
}