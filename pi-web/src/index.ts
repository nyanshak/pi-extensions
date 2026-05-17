// pi-web: WebSocket server extension for pi

import { startServer, buildWsUrl, buildHttpUrl } from "./server.js";
import { WebSocketTransport, type JsonRpcMessage } from "./websocket.js";
import type { ExtensionAPI, ExtensionContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

// ACP error codes
const ACP_ERROR_PARSE_ERROR = -32700;
const ACP_ERROR_INVALID_REQUEST = -32600;
const ACP_ERROR_METHOD_NOT_FOUND = -32601;
const ACP_ERROR_INVALID_PARAMS = -32602;
const ACP_ERROR_INTERNAL_ERROR = -32603;

// ACP method handlers
interface AcpHandlers {
  [key: string]: ((params: unknown, transport: WebSocketTransport, ws?: WebSocket) => Promise<unknown>) | undefined;
}

// Active connections and server handle
let activeTransports: Map<WebSocket, WebSocketTransport> = new Map();
let activeServer: { url: string; close: () => Promise<void> } | null = null;
let webCommandName = "web";
let piApi: ExtensionAPI | null = null;

// Session state for tracking commands
interface SessionState {
  sessionId: string;
  initialized: boolean;
  commandsSent: boolean;
}
const sessionStates = new Map<WebSocket, SessionState>();

/**
 * Get available commands formatted for ACP spec
 */
function getAvailableCommands(): Array<{ name: string; description?: string; input?: { hint: string } }> {
  if (!piApi) return [];
  const commands = piApi.getCommands();
  return commands.map((cmd: SlashCommandInfo) => ({
    name: cmd.name,
    description: cmd.description || undefined,
    // Note: SlashCommandInfo doesn't have a hint field, but we can add hints for known commands
    input: getCommandHint(cmd),
  }));
}

/**
 * Get hint for a command if known
 */
function getCommandHint(cmd: SlashCommandInfo): { hint: string } | undefined {
  // Provide helpful hints for known commands
  const hints: Record<string, string> = {
    web: "optional host, port, and password",
    compact: "optional custom instructions for summarization",
    new: "start a new session",
    fork: "entry ID to fork from",
    switch: "session file path or name",
    clear: "clear conversation history",
    undo: "revert to a previous state",
    model: "model name to switch to",
    tools: "enable or disable specific tools",
    thinking: "thinking level (off, low, high)",
    help: "show available commands and usage",
  };
  
  const hint = hints[cmd.name];
  return hint ? { hint } : undefined;
}

/**
 * Handle ACP WebSocket connection
 */
function handleConnection(ws: WebSocket, _req: unknown): void {
  const transport = new WebSocketTransport(ws, {
    onMessage: (message: JsonRpcMessage) => {
      handleAcpMessage(message, transport, ws);
    },
    onClose: (code: number, reason: string) => {
      activeTransports.delete(ws);
      sessionStates.delete(ws);
    },
  });

  activeTransports.set(ws, transport);
  sessionStates.set(ws, { sessionId: "", initialized: false, commandsSent: false });
}

/**
 * Handle ACP JSON-RPC message
 */
async function handleAcpMessage(
  message: JsonRpcMessage,
  transport: WebSocketTransport,
  ws: WebSocket
): Promise<void> {
  const { method, id, params } = message;

  if (!method) {
    transport.sendError(id ?? null, ACP_ERROR_INVALID_REQUEST, "Method not found");
    return;
  }

  const handler = acpHandlers[method];
  if (!handler) {
    transport.sendError(
      id ?? null,
      ACP_ERROR_METHOD_NOT_FOUND,
      `Method '${method}' not found`
    );
    return;
  }

  try {
    const result = await handler(params, transport, ws);
    if (id !== undefined) {
      transport.sendResponse(id, result);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Internal error";
    if (id !== undefined) {
      transport.sendError(id, ACP_ERROR_INTERNAL_ERROR, errorMessage);
    } else {
      console.error(`Handler error for ${method}:`, err);
    }
  }
}

// ACP method handlers
const acpHandlers: AcpHandlers = {
  // Initialize handler - sends available commands on session/new
  initialize: async (params, transport, ws) => {
    console.log("initialize called with:", params);
    // Send available commands update to advertise slash commands
    if (ws) {
      const sessionState = sessionStates.get(ws);
      if (sessionState) {
        sessionState.initialized = true;
      }
      transport.sendNotification("session/update", {
        sessionId: "init",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: getAvailableCommands(),
        },
      });
    }
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          close: {},
          resume: {},
        },
        promptCapabilities: {
          audio: false,
          image: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
      },
      agentInfo: {
        name: "pi-web",
        version: "1.0.0",
      },
      authMethods: [],
    };
  },

  // Session methods
  session_new: async (params, transport, ws) => {
    console.log("session_new called with:", params);
    const sessionId = `session-${Date.now()}`;
    
    // Update session state
    if (ws) {
      const sessionState = sessionStates.get(ws);
      if (sessionState) {
        sessionState.sessionId = sessionId;
        sessionState.commandsSent = true;
      }
      
      // Send available commands update after session creation
      transport.sendNotification("session/update", {
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: getAvailableCommands(),
        },
      });
    }
    
    return {
      sessionId,
      capability: {},
    };
  },

  session_prompt: async (params, _transport, _ws) => {
    console.log("session_prompt called with:", params);
    return { sessionId: (params as any)?.sessionId, content: [] };
  },

  session_end: async (params, _transport, _ws) => {
    console.log("session_end called with:", params);
    return { success: true };
  },

  "session/list": async (_params, _transport, _ws) => {
    return { sessions: [], nextCursor: null };
  },

  "session/update_metadata": async (params, _transport, _ws) => {
    console.log("session/update_metadata called with:", params);
    return { success: true };
  },

  "session/cancel": async (params, _transport, _ws) => {
    console.log("session/cancel called with:", params);
    return { success: true };
  },

  // Capability reporting
  capabilities: async (_params, _transport, _ws) => {
    return {
      capabilities: {
        streaming: true,
        tools: true,
        commands: true,
      },
    };
  },
};

/**
 * Start web server with given config
 */
async function startWebServer(config: {
  host?: string;
  port?: number;
  password?: string;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const port = config.port || 0;

  const server = await startServer(config, handleConnection);

  const protocol = config.password ? "wss" : "ws";
  let url = `${protocol}://${server.host}:${server.port}`;
  if (config.password) {
    url += `?password=${encodeURIComponent(config.password)}`;
  }

  return {
    url,
    close: server.close,
  };
}

/**
 * Register the extension with pi
 */
export default function (pi: ExtensionAPI): void {
  // Store pi API reference for command queries
  piApi = pi;
  
  // Register /web command
  pi.registerCommand("web", {
    description: "Start web server for remote connections",
    source: "extension",
    sourceInfo: { type: "pi-web" },
    execute: async (ctx: ExtensionContext) => {
      // Get interactive input from user
      const host = await ctx.prompt("Host", { default: "127.0.0.1" }) || "127.0.0.1";
      const portStr = await ctx.prompt("Port (leave empty for random)", { default: "" });
      const port = portStr ? parseInt(portStr, 10) : 0;
      const password = await ctx.prompt("Password (optional, leave empty for none)", { default: "" });

      try {
        // Start the server
        activeServer = await startWebServer({
          host,
          port,
          password: password || undefined,
        });

        // Output the URL to the user
        const httpUrl = activeServer.url.replace(/^ws/, "http");
        const wsUrl = activeServer.url.replace(/^\w+/, (m) => m.replace("http", "ws"));

        console.log("\n========================================");
        console.log("  Web server started");
        console.log(`  HTTP: ${httpUrl.replace("ws://", "http://")}`);
        console.log(`  WebSocket: ${wsUrl}`);
        if (password) {
          console.log(`  Password: ${password}`);
        }
        console.log("========================================\n");

        // Register cleanup handler
        ctx.onUnload(() => {
          if (activeServer) {
            console.log("Stopping web server...");
            activeServer.close();
            activeServer = null;
          }
        });
      } catch (err) {
        console.error("Failed to start web server:", err);
      }
    },
  });
}

// Also support running as standalone CLI
async function main(args: string[]): Promise<void> {
  const config: { web?: boolean; webHost?: string; webPort?: number; webPassword?: string; help?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--web" || arg === "-w") {
      config.web = true;
    } else if (arg === "--web-host" || arg === "--host") {
      config.webHost = args[++i];
    } else if (arg === "--web-port" || arg === "--port" || arg === "-p") {
      config.webPort = parseInt(args[++i], 10);
    } else if (arg === "--web-password") {
      config.webPassword = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      config.help = true;
    }
  }

  if (config.help) {
    console.log(`
pi-web: WebSocket server for pi with ACP protocol support

Usage: pi-web [options]

Options:
  --web              Start web server mode
  --web-host <host>  Host to bind to (default: 127.0.0.1)
  --web-port <port>  Port to listen on (default: random)
  --web-password <p> Optional password authentication
  --help, -h         Show this help message

Examples:
  pi-web --web                      Start server on random port
  pi-web --web --web-port 8080      Start server on port 8080
  pi-web --web --web-password secret  Start server with password auth

For pi integration, use as a pi extension.
`);
    return;
  }

  if (!config.web) {
    console.log("Use --web to start the WebSocket server");
    console.log("Use --help for usage information");
    return;
  }

  const server = await startWebServer({
    host: config.webHost,
    port: config.webPort,
    password: config.webPassword,
  });

  console.log(`Web server running at ${server.url}`);
  console.log("Press Ctrl+C to stop");

  await new Promise<void>((resolve) => {
    process.on("SIGINT", async () => {
      console.log("\nShutting down...");
      await server.close();
      resolve();
    });
  });
}

// Run CLI if executed directly
const args = process.argv.slice(2);
if (import.meta.url.endsWith(process.argv[1]?.split("/").pop() || "")) {
  main(args).catch(console.error);
}