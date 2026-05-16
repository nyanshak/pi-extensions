/**
 * ACP (Agent Client Protocol) Extension for pi
 *
 * This extension enables pi to act as an ACP-compatible agent that can be
 * controlled by ACP clients like Zed, VS Code, or other editors.
 *
 * Protocol Reference: https://agentclientprotocol.com/
 *
 * ACP Messages:
 * - Agent → Client: session/update notifications (message chunks, tool calls, plans, etc.)
 * - Client → Agent: initialize, authenticate, session/new, session/prompt, session/cancel, etc.
 *
 * This module implements the ACP transport layer over stdio using JSON-RPC 2.0.
 */

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ACP Protocol Constants
const ACP_PROTOCOL_VERSION = "1.0.0" as const;
const ACP_JSONRPC_VERSION = "2.0" as const;

// ACP Message Types
interface JsonRpcRequest {
	jsonrpc: typeof ACP_JSONRPC_VERSION;
	id?: number | string;
	method: string;
	params?: Record<string, unknown>;
}

interface JsonRpcResponse {
	jsonrpc: typeof ACP_JSONRPC_VERSION;
	id?: number | string;
	result?: unknown;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

interface JsonRpcNotification {
	jsonrpc: typeof ACP_JSONRPC_VERSION;
	method: string;
	params?: Record<string, unknown>;
}

// ACP Request Types
interface InitializeRequest {
	clientCapabilities: {
		fs: {
			readTextFile: boolean;
			writeTextFile: boolean;
		};
		terminal: boolean;
	};
	clientInfo?: {
		name: string;
		version: string;
	};
	protocolVersion: string;
}

interface AuthenticateRequest {
	methodId: string;
	credentials?: Record<string, unknown>;
}

interface SessionNewRequest {
	id: string;
	_systemPrompt?: string;
	workingDirectory?: string;
	environment?: Record<string, string>;
}

interface SessionPromptRequest {
	sessionId: string;
	prompt: {
		messages: Array<{
			role: "user" | "assistant" | "system";
			content: Array<{
				type: "text" | "image";
				text?: string;
				source?: {
					type: "base64" | "url";
					mediaType?: string;
					data?: string;
					url?: string;
				};
			}>;
		}>;
	};
}

interface SessionCancelRequest {
	sessionId: string;
}

interface SessionSetModeRequest {
	sessionId: string;
	mode: "readOnly" | "auto" | "fullAccess";
}

// ACP Response Types
interface InitializeResponse {
	agentCapabilities: {
		loadSession: boolean;
		sessionCapabilities: {
			close: boolean;
			resume: boolean;
		};
		promptCapabilities: {
			audio: boolean;
			image: boolean;
			embeddedContext: boolean;
		};
		mcpCapabilities: {
			http: boolean;
			sse: boolean;
		};
	};
	agentInfo: {
		name: string;
		version: string;
	};
	authMethods: Array<{
		id: string;
		description: string;
	}>;
	protocolVersion: string;
}

interface SessionNewResponse {
	sessionId: string;
	commands: Array<{
		name: string;
		description: string;
	}>;
}

interface SessionPromptResponse {
	sessionId: string;
	result: {
		stopReason: "completion" | "tool_use" | "canceled" | "error";
		message: {
			role: "assistant";
			content: Array<{
				type: "text" | "tool_call" | "tool_result" | "thinking";
				text?: string;
				name?: string;
				input?: unknown;
				tool_call_id?: string;
				thinking?: string;
			}>;
			usage?: {
				inputTokens: number;
				outputTokens: number;
			};
		};
	};
}

// ACP Notification Types (sent to client)
interface SessionUpdateNotification {
	sessionId: string;
	content: Array<{
		type: "message" | "message_chunk" | "tool_call" | "tool_call_start" | "tool_call_end" | "tool_call_progress" | "thinking" | "plan" | "done";
		role?: "user" | "assistant" | "system";
		id?: string;
		content?: string;
		chunk?: string;
		toolName?: string;
		toolCallId?: string;
		input?: unknown;
		progress?: string;
		thinking?: string;
		plan?: {
			steps: Array<{ description: string; status: "pending" | "in_progress" | "completed" }>;
		};
	}>;
}

interface AvailableCommandsUpdate {
	sessionId: string;
	commands: Array<{
		name: string;
		description: string;
	}>;
}

// ACP Session State
interface AcpSession {
	id: string;
	messages: Array<{
		role: "user" | "assistant" | "system";
		content: Array<{
			type: "text" | "image";
			text?: string;
			source?: {
				type: "base64" | "url";
				mediaType?: string;
				data?: string;
				url?: string;
			};
		}>;
	}>;
	workingDirectory?: string;
	environment?: Record<string, string>;
	systemPrompt?: string;
	mode: "readOnly" | "auto" | "fullAccess";
}

// ACP Error Codes
const ACP_ERROR_CODES = {
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	SESSION_NOT_FOUND: 10001,
	SESSION_ALREADY_EXISTS: 10002,
	AUTHENTICATION_FAILED: 20001,
} as const;

// ACP Extension State
interface AcpState {
	running: boolean;
	initialized: boolean;
	currentSession: AcpSession | null;
	sessions: Map<string, AcpSession>;
	requestId: number;
	transport: "stdio";
}

/**
 * Create an ACP-compatible JSON-RPC request
 */
function createJsonRpcRequest(method: string, params?: Record<string, unknown>, id?: number | string): JsonRpcRequest {
	return {
		jsonrpc: ACP_JSONRPC_VERSION,
		...(id !== undefined && { id }),
		method,
		...(params && { params }),
	};
}

/**
 * Create an ACP-compatible JSON-RPC response
 */
function createJsonRpcResponse(id: number | string, result: unknown): JsonRpcResponse {
	return {
		jsonrpc: ACP_JSONRPC_VERSION,
		id,
		result,
	};
}

/**
 * Create an ACP-compatible JSON-RPC error response
 */
function createJsonRpcError(id: number | string, code: number, message: string, data?: unknown): JsonRpcResponse {
	return {
		jsonrpc: ACP_JSONRPC_VERSION,
		id,
		error: {
			code,
			message,
			...(data !== undefined && { data }),
		},
	};
}

/**
 * Send a JSON-RPC notification (no response expected)
 */
function sendNotification(transport: { write: (msg: string) => void }, method: string, params?: Record<string, unknown>): void {
	const notification: JsonRpcNotification = {
		jsonrpc: ACP_JSONRPC_VERSION,
		method,
		...(params && { params }),
	};
	transport.write(JSON.stringify(notification) + "\n");
}

/**
 * Send a JSON-RPC response
 */
function sendResponse(transport: { write: (msg: string) => void }, response: JsonRpcResponse): void {
	transport.write(JSON.stringify(response) + "\n");
}

/**
 * ACP Transport over stdio
 */
class AcpStdioTransport {
	private input: NodeJS.ReadableStream;
	private pendingRequests: Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }> = new Map();
	private messageBuffer: string = "";

	constructor(input: NodeJS.ReadableStream) {
		this.input = input;
	}

	/**
	 * Write a message to stdout
	 */
	write(message: string): void {
		process.stdout.write(message);
	}

	/**
	 * Send a JSON-RPC request and wait for response
	 */
	async sendRequest<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
		const id = Date.now();
		const request = createJsonRpcRequest(method, params, id);

		return new Promise((resolve, reject) => {
			this.pendingRequests.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
			});

			this.write(JSON.stringify(request) + "\n");

			// Timeout after 60 seconds
			setTimeout(() => {
				if (this.pendingRequests.has(id)) {
					this.pendingRequests.delete(id);
					reject(new Error(`Request ${method} timed out`));
				}
			}, 60000);
		});
	}

	/**
	 * Handle incoming messages from stdin
	 */
	onMessage(handler: (message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification) => void): void {
		readline.createInterface({
			input: this.input,
			crlfDelay: Infinity,
		}).on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;

			try {
				const message = JSON.parse(trimmed) as JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

				// Handle responses to our requests
				if ("id" in message && message.jsonrpc === ACP_JSONRPC_VERSION) {
					const pending = this.pendingRequests.get(message.id);
					if (pending) {
						this.pendingRequests.delete(message.id);
						if ("error" in message && message.error) {
							pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
						} else {
							pending.resolve(message.result);
						}
						return;
					}
				}

				// Handle requests/notifications from client
				handler(message);
			} catch (error) {
				console.error("Failed to parse JSON-RPC message:", error);
			}
		});
	}

	/**
	 * Close the transport
	 */
	close(): void {
		this.pendingRequests.clear();
	}
}

/**
 * ACP Session Manager
 */
class AcpSessionManager {
	private sessions: Map<string, AcpSession> = new Map();
	private currentSession: AcpSession | null = null;

	createSession(id: string, options?: Partial<AcpSession>): AcpSession {
		const session: AcpSession = {
			id,
			messages: [],
			mode: "auto",
			...(options && {
				workingDirectory: options.workingDirectory,
				environment: options.environment,
				systemPrompt: options.systemPrompt,
			}),
		};
		this.sessions.set(id, session);
		this.currentSession = session;
		return session;
	}

	getSession(id: string): AcpSession | undefined {
		return this.sessions.get(id);
	}

	getCurrentSession(): AcpSession | null {
		return this.currentSession;
	}

	closeSession(id: string): boolean {
		return this.sessions.delete(id);
	}

	listSessions(): AcpSession[] {
		return Array.from(this.sessions.values());
	}
}

/**
 * ACP Protocol Handler
 * Handles ACP protocol messages and coordinates with pi's extension API
 */
class AcpProtocolHandler {
	private transport: AcpStdioTransport;
	private sessionManager: AcpSessionManager;
	private pi: ExtensionAPI;
	private state: AcpState;
	private messageId: number = 0;
	private currentAbortController: AbortController | null = null;

	constructor(pi: ExtensionAPI, transport: AcpStdioTransport) {
		this.transport = transport;
		this.sessionManager = new AcpSessionManager();
		this.pi = pi;
		this.state = {
			running: false,
			initialized: false,
			currentSession: null,
			sessions: new Map(),
			requestId: 0,
			transport: "stdio",
		};
	}

	/**
	 * Get next message ID
	 */
	private nextId(): number {
		return ++this.messageId;
	}

	/**
	 * Handle incoming ACP messages
	 */
	handleMessage(message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): void {
		// Only handle requests and notifications (not responses, which are handled by transport)
		if ("method" in message) {
			const method = message.method;
			const params = message.params as Record<string, unknown> | undefined;
			const id = message.id as number | string | undefined;

			try {
				switch (method) {
					case "initialize":
						this.handleInitialize(params, id);
						break;
					case "authenticate":
						this.handleAuthenticate(params, id);
						break;
					case "session/new":
						this.handleSessionNew(params, id);
						break;
					case "session/prompt":
						this.handleSessionPrompt(params, id);
						break;
					case "session/cancel":
						this.handleSessionCancel(params);
						break;
					case "session/set_mode":
						this.handleSessionSetMode(params, id);
						break;
					case "session/close":
						this.handleSessionClose(params, id);
						break;
					default:
						if (id !== undefined) {
							sendResponse(this.transport, createJsonRpcError(
								id,
								ACP_ERROR_CODES.METHOD_NOT_FOUND,
								`Method not found: ${method}`,
							));
						}
				}
			} catch (error) {
				console.error("Error handling ACP message:", error);
				if (id !== undefined) {
					sendResponse(this.transport, createJsonRpcError(
						id,
						ACP_ERROR_CODES.INTERNAL_ERROR,
						error instanceof Error ? error.message : "Internal error",
					));
				}
			}
		}
	}

	/**
	 * Handle initialize request
	 */
	private handleInitialize(params: unknown, id: number | string | undefined): void {
		const req = params as InitializeRequest;

		if (!req.protocolVersion) {
			if (id !== undefined) {
				sendResponse(this.transport, createJsonRpcError(
					id,
					ACP_ERROR_CODES.INVALID_PARAMS,
					"Missing protocolVersion in initialize request",
				));
			}
			return;
		}

		const response: InitializeResponse = {
			agentCapabilities: {
				loadSession: true,
				sessionCapabilities: {
					close: true,
					resume: true,
				},
				promptCapabilities: {
					audio: false,
					image: true,
					embeddedContext: false,
				},
				mcpCapabilities: {
					http: false,
					sse: false,
				},
			},
			agentInfo: {
				name: "pi",
				version: "1.0.0",
			},
			authMethods: [],
			protocolVersion: ACP_PROTOCOL_VERSION,
		};

		this.state.initialized = true;

		if (id !== undefined) {
			sendResponse(this.transport, createJsonRpcResponse(id, response));
		}
	}

	/**
	 * Handle authenticate request
	 */
	private handleAuthenticate(params: unknown, id: number | string | undefined): void {
		const req = params as AuthenticateRequest;

		// ACP doesn't require authentication by default
		if (id !== undefined) {
			sendResponse(this.transport, createJsonRpcResponse(id, { authenticated: true }));
		}
	}

	/**
	 * Handle session/new request
	 */
	private handleSessionNew(params: unknown, id: number | string | undefined): void {
		const req = params as SessionNewRequest;

		if (!req.id) {
			if (id !== undefined) {
				sendResponse(this.transport, createJsonRpcError(
					id,
					ACP_ERROR_CODES.INVALID_PARAMS,
					"Missing session id",
				));
			}
			return;
		}

		const session = this.sessionManager.createSession(req.id, {
			workingDirectory: req.workingDirectory,
			environment: req.environment,
			systemPrompt: req._systemPrompt,
		});

		// Get available commands from pi
		const commands = this.pi.getCommands();

		const response: SessionNewResponse = {
			sessionId: session.id,
			commands: commands.map((cmd) => ({
				name: cmd.name,
				description: cmd.description || "",
			})),
		};

		this.state.currentSession = session;

		if (id !== undefined) {
			sendResponse(this.transport, createJsonRpcResponse(id, response));
		}

		// Send available commands update
		sendNotification(this.transport, "session/update", {
			sessionId: session.id,
			content: [
				{
					type: "available_commands",
					commands: response.commands,
				},
			],
		});
	}

	/**
	 * Handle session/prompt request
	 */
	private handleSessionPrompt(params: unknown, id: number | string | undefined): void {
		const req = params as SessionPromptRequest;

		if (!req.sessionId) {
			if (id !== undefined) {
				sendResponse(this.transport, createJsonRpcError(
					id,
					ACP_ERROR_CODES.INVALID_PARAMS,
					"Missing session id",
				));
			}
			return;
		}

		const session = this.sessionManager.getSession(req.sessionId);
		if (!session) {
			if (id !== undefined) {
				sendResponse(this.transport, createJsonRpcResponse(id, {
					sessionId: req.sessionId,
					result: {
						stopReason: "error",
						message: {
							role: "assistant",
							content: [{ type: "text", text: `Session not found: ${req.sessionId}` }],
						},
					},
				}));
			}
			return;
		}

		// Store messages from the prompt
		if (req.prompt?.messages) {
			session.messages.push(...req.prompt.messages);
		}

		// Cancel any ongoing request
		if (this.currentAbortController) {
			this.currentAbortController.abort();
		}
		this.currentAbortController = new AbortController();

		// Send update notification that we're starting
		sendNotification(this.transport, "session/update", {
			sessionId: session.id,
			content: [
				{
					type: "message_chunk",
					role: "assistant",
					chunk: "",
				},
			],
		});

		// Get the last user message text
		const lastUserMessage = req.prompt?.messages
			?.filter((m) => m.role === "user")
			?.pop()
			?.content
			?.find((c) => c.type === "text")?.text || "";

		// Send user message to pi agent
		this.pi.sendUserMessage(lastUserMessage, { deliverAs: "steer", triggerTurn: true });

		// For now, return a placeholder response
		// In a full implementation, this would wait for the agent's response
		// and stream it back via session/update notifications
		if (id !== undefined) {
			const response: SessionPromptResponse = {
				sessionId: session.id,
				result: {
					stopReason: "completion",
					message: {
						role: "assistant",
						content: [
							{
								type: "text",
								text: "Processing your request via ACP...",
							},
						],
						usage: {
							inputTokens: 0,
							outputTokens: 0,
						},
					},
				},
			};
			sendResponse(this.transport, createJsonRpcResponse(id, response));
		}
	}

	/**
	 * Handle session/cancel notification
	 */
	private handleSessionCancel(params: unknown): void {
		const req = params as SessionCancelRequest;

		if (this.currentAbortController) {
			this.currentAbortController.abort();
			this.currentAbortController = null;
		}

		// Abort via pi's context if available
		this.pi.on("tool_call" as any, (event: unknown, ctx: any) => {
			ctx.abort?.();
		});

		sendNotification(this.transport, "session/update", {
			sessionId: req.sessionId,
			content: [
				{
					type: "done",
					content: "Cancelled",
				},
			],
		});
	}

	/**
	 * Handle session/set_mode request
	 */
	private handleSessionSetMode(params: unknown, id: number | string | undefined): void {
		const req = params as SessionSetModeRequest;

		const session = this.sessionManager.getSession(req.sessionId);
		if (session) {
			session.mode = req.mode;
		}

		if (id !== undefined) {
			sendResponse(this.transport, createJsonRpcResponse(id, { success: true }));
		}
	}

	/**
	 * Handle session/close request
	 */
	private handleSessionClose(params: unknown, id: number | string | undefined): void {
		const req = params as { sessionId?: string };
		const sessionId = req.sessionId || this.sessionManager.getCurrentSession()?.id;

		if (sessionId) {
			this.sessionManager.closeSession(sessionId);
		}

		if (id !== undefined) {
			sendResponse(this.transport, createJsonRpcResponse(id, { success: true }));
		}
	}

	/**
	 * Start listening for ACP messages
	 */
	start(): void {
		this.state.running = true;
		this.transport.onMessage((message) => this.handleMessage(message));
	}

	/**
	 * Stop the ACP handler
	 */
	stop(): void {
		this.state.running = false;
		this.transport.close();
	}

	/**
	 * Check if ACP is running
	 */
	isRunning(): boolean {
		return this.state.running;
	}
}

/**
 * Default ACP extension factory
 */
export default async function (pi: ExtensionAPI): Promise<void> {
	// Check if we should run in ACP mode
	const shouldRunAcp = process.env.PI_ACP === "1" || process.argv.includes("--acp");

	if (!shouldRunAcp) {
		return;
	}

	// Create ACP transport
	const transport = new AcpStdioTransport(process.stdin);

	// Create ACP protocol handler
	const handler = new AcpProtocolHandler(pi, transport);

	// Start ACP protocol
	handler.start();

	// Handle graceful shutdown
	pi.on("session_shutdown" as any, async () => {
		handler.stop();
	});

	// Notify that ACP extension is loaded
	console.error("pi ACP extension loaded - listening on stdio");
}