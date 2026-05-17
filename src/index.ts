/**
 * ACP (Agent Client Protocol) Extension for pi
 *
 * Spec-compliant implementation of the Agent Client Protocol.
 * Reference: https://agentclientprotocol.com/
 *
 * ACP is a JSON-RPC 2.0 based protocol for communication between AI coding
 * agents and their clients (IDEs/editors like Zed).
 */

import * as readline from "node:readline";
import type { ExtensionAPI, MessageUpdateEvent, MessageEndEvent, ToolCallEvent, ToolResultEvent, ToolExecutionStartEvent, ToolExecutionUpdateEvent, ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import { takeOverStdout, writeRawStdout } from "/home/kali/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/output-guard.js";

// ACP Protocol Version (integer, increment on breaking changes)
const ACP_PROTOCOL_VERSION = 1;

// ============================================================================
// Types
// ============================================================================

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: Record<string, unknown>;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number | string;
	result?: unknown;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

// Content Blocks (from ACP spec)
type ContentBlock = TextContent | ImageContent | AudioContent | ResourceContent | ResourceLinkContent;

interface TextContent {
	type: "text";
	text: string;
	annotations?: Record<string, unknown>;
}

interface ImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
	uri?: string;
	annotations?: Record<string, unknown>;
}

interface AudioContent {
	type: "audio";
	data: string; // base64
	mimeType: string;
	annotations?: Record<string, unknown>;
}

interface ResourceContent {
	type: "resource";
	resource: TextResource | BlobResource;
	annotations?: Record<string, unknown>;
}

interface TextResource {
	uri: string;
	text: string;
	mimeType?: string;
}

interface BlobResource {
	uri: string;
	blob: string; // base64
	mimeType?: string;
}

interface ResourceLinkContent {
	type: "resource_link";
	uri: string;
	name: string;
	mimeType?: string;
	title?: string;
	description?: string;
	size?: number;
	annotations?: Record<string, unknown>;
}

// Session Update Types (from spec)
type SessionUpdate =
	| { sessionUpdate: "user_message_chunk"; content: ContentBlock }
	| { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
	| { sessionUpdate: "agent_message_end" }
	| { sessionUpdate: "plan"; entries: PlanEntry[] }
	| { sessionUpdate: "tool_call"; toolCallId: string; title: string; kind: ToolKind; status: ToolCallStatus }
	| { sessionUpdate: "tool_call_update"; toolCallId: string; status?: ToolCallStatus; content?: ToolCallContent[]; error?: string }
	| { sessionUpdate: "available_commands"; commands: Command[] }
	| { sessionUpdate: "mode_change"; mode: SessionMode };

type PlanEntry = {
	content: string;
	priority: "high" | "medium" | "low";
	status: "pending" | "in_progress" | "completed";
};

type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

interface ToolCallContent {
	type: "content" | "diff" | "terminal";
	content?: ContentBlock;
	path?: string;
	oldText?: string;
	newText?: string;
	terminalId?: string;
}

interface Command {
	name: string;
	description?: string;
}

type SessionMode = "readOnly" | "auto" | "fullAccess";

// MCP Server Types
interface McpServer {
	name: string;
	command: string;
	args: string[];
	env?: Array<{ name: string; value: string }>;
}

// Error Codes
const ERROR_CODES = {
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	AUTH_REQUIRED: 10000,
};

// ============================================================================
// Transport
// ============================================================================

class StdioTransport {
	private pendingRequests = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

	write(message: string): void {
		// Use writeRawStdout to bypass output guard - ACP needs clean JSON on stdout
		writeRawStdout(message + "\n");
	}

	sendRequest<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
		const id = Date.now();
		const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

		return new Promise((resolve, reject) => {
			this.pendingRequests.set(id, { resolve: resolve as (v: unknown) => void, reject });
			this.write(JSON.stringify(request));

			setTimeout(() => {
				if (this.pendingRequests.has(id)) {
					this.pendingRequests.delete(id);
					reject(new Error(`Request ${method} timed out`));
				}
			}, 60000);
		});
	}

	onMessage(handler: (msg: JsonRpcRequest | JsonRpcNotification) => void): void {
		readline.createInterface({
			input: process.stdin,
			crlfDelay: Infinity,
		}).on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			try {
				const msg = JSON.parse(trimmed);

				// Check if it's a response to our request
				if ("id" in msg && ("result" in msg || "error" in msg)) {
					const pending = this.pendingRequests.get(msg.id);
					if (pending) {
						this.pendingRequests.delete(msg.id);
						if (msg.error) {
							pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
						} else {
							pending.resolve(msg.result);
						}
						return;
					}
				}

				handler(msg);
			} catch (err) {
				console.error("Failed to parse JSON:", err);
			}
		});
	}
}

// ============================================================================
// Session Management
// ============================================================================

interface AcpSession {
	id: string;
	cwd?: string;
	mcpServers?: McpServer[];
	messages: ContentBlock[];
	mode: SessionMode;
}

// ============================================================================
// Protocol Handler
// ============================================================================

interface PendingPrompt {
	sessionId: string;
	resolve: (stopReason: string) => void;
	reject: (error: Error) => void;
	messageEndPromise: Promise<void>;
	messageEndResolve: () => void;
	pendingMessageEnd: boolean; // Track if we got message_end with empty content
}

class AcpProtocolHandler {
	private transport: StdioTransport;
	private pi: ExtensionAPI;
	private sessions = new Map<string, AcpSession>();
	private currentSessionId: string | null = null;
	private pendingToolCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private abortController: AbortController | null = null;
	private pendingPrompt: PendingPrompt | null = null;
	private messageBuffer: string = "";
	

	constructor(pi: ExtensionAPI, transport: StdioTransport) {
		this.transport = transport;
		this.pi = pi;

		// Set up event listeners for agent messaging
		this.setupEventListeners();
	}

	private setupEventListeners(): void {
		// Track last sent text hash to detect duplicates
		let lastSentTextHash = "";
		
		// Listen for message updates (streaming text)
		this.pi.on("message_update", (event: MessageUpdateEvent) => {
			const msg = event.message as any;
			
			// Only process assistant messages
			if (!this.pendingPrompt || msg?.role !== "assistant") return;

			const text = this.getTextFromMessage(msg);
			if (!text) return;
			
			// Create a simple hash of the text to detect duplicates
			// Use first 50 chars + length as a quick identifier
			const textHash = text.substring(0, 50) + ":" + text.length;
			
			// Skip if we've already sent this exact text
			if (textHash === lastSentTextHash) {
				return;
			}
			lastSentTextHash = textHash;
			
			// Only append NEW text (not already in buffer)
			if (!this.messageBuffer.includes(text)) {
				this.messageBuffer += text;
				this.sendSessionUpdate(this.pendingPrompt.sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text },
				});
			}
		});

		// Listen for message end
		this.pi.on("message_end", (event: MessageEndEvent) => {
			const msg = event.message as any;
			// Only process assistant message ends
			if (!this.pendingPrompt || msg?.role !== "assistant") return;

			// Capture final text if not already in buffer
			const finalText = this.getTextFromMessage(msg);
			if (finalText && !this.messageBuffer.includes(finalText)) {
				this.messageBuffer += finalText;
			}

			// If we have content, send end and resolve
			// message_update already sent the final chunk
			if (this.messageBuffer) {
				this.sendSessionUpdate(this.pendingPrompt.sessionId, {
					sessionUpdate: "agent_message_end",
				});
				this.pendingPrompt.messageEndResolve();
			}
		});

		// Listen for tool calls
		this.pi.on("tool_call", (event: ToolCallEvent) => {
			if (!this.pendingPrompt) return;

			const toolCallId = event.toolCallId;
			const title = event.toolName;

			// Determine kind based on tool name
			let kind: ToolKind = "other";
			if (event.toolName === "read") kind = "read";
			else if (event.toolName === "write") kind = "edit";
			else if (event.toolName === "bash" || event.toolName === "execute") kind = "execute";
			else if (event.toolName === "edit") kind = "edit";
			else if (event.toolName === "search" || event.toolName === "grep") kind = "search";

			this.sendSessionUpdate(this.pendingPrompt.sessionId, {
				sessionUpdate: "tool_call",
				toolCallId,
				title,
				kind,
				status: "pending",
			});
		});

		// Listen for tool execution start
		this.pi.on("tool_execution_start", (event: ToolExecutionStartEvent) => {
			if (!this.pendingPrompt) return;

			this.sendSessionUpdate(this.pendingPrompt.sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId,
				status: "in_progress",
			});
		});

		// Listen for tool execution updates (streaming results)
		this.pi.on("tool_execution_update", (event: ToolExecutionUpdateEvent) => {
			if (!this.pendingPrompt) return;

			// Only send tool_call_update if there's actual non-empty content
			if (!event.partialResult) return;

			const text = typeof event.partialResult === "string" 
				? event.partialResult 
				: JSON.stringify(event.partialResult);

			// Skip empty or placeholder content (like {"content":[]})
			if (!text || text === "{}" || text === "{\"content\":[]}") return;

			this.sendSessionUpdate(this.pendingPrompt.sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId,
				status: "in_progress",
				content: [{ type: "content", content: { type: "text", text } }],
			});
		});

		// Listen for tool results
		this.pi.on("tool_result", (event: ToolResultEvent) => {
			if (!this.pendingPrompt) return;

			const content: ToolCallContent[] = [];
			if (event.content) {
				for (const block of event.content) {
					if (block.type === "text") {
						content.push({ type: "content", content: block });
					}
				}
			}

			this.sendSessionUpdate(this.pendingPrompt.sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId,
				status: event.isError ? "failed" : "completed",
				content: content.length > 0 ? content : undefined,
				error: event.isError ? "Tool execution failed" : undefined,
			});

			// If we got message_end before this tool result, resolve now
			if (this.pendingPrompt.pendingMessageEnd) {
				this.sendSessionUpdate(this.pendingPrompt.sessionId, {
					sessionUpdate: "agent_message_end",
				});
				this.pendingPrompt.messageEndResolve();
			}
		});

		// Listen for tool execution end
		this.pi.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
			if (!this.pendingPrompt) return;
			// Tool execution complete - LLM will continue processing
		});


	}

	private getTextFromMessage(message: any): string {
		if (!message) {
			// console.error("[pi-acp] getText: message is null/undefined");
			return "";
		}
		
		// Message might be an array with one element
		if (Array.isArray(message)) {
			// console.error("[pi-acp] getText: message is array, first element:", JSON.stringify(message[0]).substring(0, 100));
			message = message[0];
		}

		const msg = message as any;
		// console.error("[pi-acp] getText: msg.role=", msg?.role, "has content?", !!msg?.content);
		
		// Try direct content array (the actual structure: {role, content: [...]})
		if (msg?.content && Array.isArray(msg.content)) {
			// console.error("[pi-acp] getText: content length=", msg.content.length);
			// Sort by index and extract text blocks
			const parts: string[] = [];
			const sorted = [...msg.content].sort((a: any, b: any) => (a.index || 0) - (b.index || 0));
			for (const block of sorted) {
				// Extract text from text blocks (block.text) or thinking blocks (block.thinking)
				if (block.type === "text" && block.text) {
					parts.push(block.text);
				} else if (block.type === "thinking" && block.thinking) {
					// For thinking blocks, text is in block.thinking field
					// Optionally include thinking, but let's skip it per ACP spec
				}
			}
			// console.error("[pi-acp] getText: extracted parts:", parts.length);
			return parts.join("");
		}
		
		// Try message.message.content (nested structure)
		if (msg?.message?.content) {
			// console.error("[pi-acp] getText: has nested message.content");
			const content = msg.message.content;
			if (Array.isArray(content)) {
				return content.map((c: any) => c.text || "").filter(Boolean).join("");
			}
			if (content.text) return content.text;
		}
		
		// Try direct text field
		if (msg?.text) {
			// console.error("[pi-acp] getText: has direct text:", msg.text.substring(0, 50));
			return msg.text;
		}

		// console.error("[pi-acp] getText: no text found. msg keys:", Object.keys(msg || {}));
		return "";
	}

	sendResponse(id: number | string, result: unknown): void {
		const response: JsonRpcResponse = { jsonrpc: "2.0", id, result };
		this.transport.write(JSON.stringify(response));
	}

	sendError(id: number | string, code: number, message: string): void {
		const response: JsonRpcResponse = {
			jsonrpc: "2.0",
			id,
			error: { code, message },
		};
		this.transport.write(JSON.stringify(response));
	}

	sendNotification(method: string, params: Record<string, unknown>): void {
		const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
		this.transport.write(JSON.stringify(notification));
	}

	sendSessionUpdate(sessionId: string, update: SessionUpdate): void {
		this.sendNotification("session/update", { sessionId, update: update as any });
	}

	start(): void {
		this.transport.onMessage((msg) => this.handleMessage(msg));
	}

	private handleMessage(msg: JsonRpcRequest | JsonRpcNotification): void {
		if (!("method" in msg)) return;

		const { method, params, id } = msg;
		const requestId = "id" in msg ? msg.id : undefined;

		try {
			switch (method) {
				case "initialize":
					this.handleInitialize(params as any, requestId);
					break;
				case "authenticate":
					this.handleAuthenticate(params as any, requestId);
					break;
				case "session/new":
					this.handleSessionNew(params as any, requestId);
					break;
				case "session/load":
					this.handleSessionLoad(params as any, requestId);
					break;
				case "session/resume":
					this.handleSessionResume(params as any, requestId);
					break;
				case "session/prompt":
					this.handleSessionPrompt(params as any, requestId);
					break;
				case "session/cancel":
					this.handleSessionCancel(params as any);
					break;
				case "session/close":
					this.handleSessionClose(params as any, requestId);
					break;
				case "session/set_mode":
					this.handleSessionSetMode(params as any, requestId);
					break;
				case "session/request_permission":
					this.handleSessionRequestPermission(params as any, requestId);
					break;
				default:
					if (requestId !== undefined) {
						this.sendError(requestId, ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${method}`);
					}
			}
		} catch (err) {
			console.error("Error handling message:", err);
			if (requestId !== undefined) {
				this.sendError(requestId, ERROR_CODES.INTERNAL_ERROR, err instanceof Error ? err.message : "Internal error");
			}
		}
	}

	private handleInitialize(params: {
		protocolVersion: number;
		clientCapabilities?: {
			fs?: { readTextFile?: boolean; writeTextFile?: boolean };
			terminal?: boolean;
		};
		clientInfo?: { name: string; version?: string };
		_meta?: Record<string, unknown>;
	}, id: number | string | undefined): void {
		// Validate protocol version - spec says client sends latest version
		// Agent responds with same if supported, else latest it supports
		const negotiatedVersion = params.protocolVersion >= ACP_PROTOCOL_VERSION
			? ACP_PROTOCOL_VERSION
			: params.protocolVersion;

		// Build response per spec
		const response = {
			protocolVersion: negotiatedVersion,
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
				name: "pi-coding-agent",
				version: "1.0.0",
			},
			authMethods: [] as { id: string; description?: string }[],
		};

		if (id !== undefined) {
			this.sendResponse(id, response);
		}
	}

	private handleAuthenticate(_params: {
		methodId: string;
		_meta?: Record<string, unknown>;
	}, id: number | string | undefined): void {
		// No-op authentication - return success
		if (id !== undefined) {
			this.sendResponse(id, {});
		}
	}

	private handleSessionNew(params: {
		cwd?: string;
		mcpServers?: McpServer[];
		_meta?: Record<string, unknown>;
	}, id: number | string | undefined): void {
		// Validate required params
		if (!params.cwd) {
			if (id !== undefined) {
				this.sendError(id, ERROR_CODES.INVALID_PARAMS, "Missing required parameter: cwd");
			}
			return;
		}

		const sessionId = `sess_${Date.now().toString(36)}`;

		const session: AcpSession = {
			id: sessionId,
			cwd: params.cwd,
			mcpServers: params.mcpServers || [],
			messages: [],
			mode: "auto",
		};

		this.sessions.set(sessionId, session);
		this.currentSessionId = sessionId;

		// Send available commands
		this.sendSessionUpdate(sessionId, {
			sessionUpdate: "available_commands",
			commands: this.pi.getCommands().map((cmd) => ({
				name: cmd.name,
				description: cmd.description || "",
			})),
		});

		if (id !== undefined) {
			this.sendResponse(id, { sessionId });
		}
	}

	private handleSessionLoad(_params: {
		sessionId: string;
		cwd: string;
		mcpServers?: McpServer[];
		_meta?: Record<string, unknown>;
	}, _id: number | string | undefined): void {
		// Session loading with replay - not implemented in this minimal version
		// Would need to restore session context and replay history
	}

	private handleSessionResume(params: {
		sessionId: string;
		cwd: string;
		mcpServers?: McpServer[];
		_meta?: Record<string, unknown>;
	}, id: number | string | undefined): void {
		const session = this.sessions.get(params.sessionId);
		if (!session) {
			if (id !== undefined) {
				this.sendError(id, -32602, "Session not found");
			}
			return;
		}

		// Update cwd and reconnect MCP servers
		session.cwd = params.cwd;
		session.mcpServers = params.mcpServers || [];

		if (id !== undefined) {
			this.sendResponse(id, {});
		}
	}

	private async handleSessionPrompt(params: {
		sessionId: string;
		prompt: ContentBlock[];
		_meta?: Record<string, unknown>;
	}, id: number | string | undefined): Promise<void> {
		const session = this.sessions.get(params.sessionId);
		if (!session) {
			if (id !== undefined) {
				this.sendError(id, -32602, "Session not found");
			}
			return;
		}

		// Abort any ongoing request
		if (this.abortController) {
			this.abortController.abort();
		}
		this.abortController = new AbortController();

		// Reset message buffer
		this.messageBuffer = "";

		// Store user message
		session.messages.push(...params.prompt);

		// Extract text from prompt for pi
		const userText = this.extractTextFromPrompt(params.prompt);

		// Send user message chunk
		for (const block of params.prompt) {
			if (block.type === "text" || block.type === "resource" || block.type === "resource_link") {
				this.sendSessionUpdate(session.id, {
					sessionUpdate: "user_message_chunk",
					content: block,
				});
			}
		}

		// Send initial agent chunk (empty)
		this.sendSessionUpdate(session.id, {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "" },
		});

		// Create promise for message end
		let messageEndResolve: () => void;
		const messageEndPromise = new Promise<void>((resolve) => {
			messageEndResolve = resolve;
		});

		// Set up pending prompt tracker
		this.pendingPrompt = {
			sessionId: session.id,
			resolve: () => {},
			reject: () => {},
			messageEndPromise,
			messageEndResolve: messageEndResolve!,
			pendingMessageEnd: false,
		};

		try {
			// Send user message to pi
			await this.pi.sendUserMessage(userText, { deliverAs: "steer" });

			// Wait for message end or cancellation
			const stopReason = await Promise.race([
				messageEndPromise.then(() => "end_turn" as const),
				new Promise<"cancelled" | "max_tokens" | "refusal">((resolve) => {
					this.abortController!.signal.addEventListener("abort", () => {
						resolve("cancelled");
					});
				}),
			]);

			// Send final response
			if (id !== undefined) {
				this.sendResponse(id, { 
					stopReason,
					message: this.messageBuffer ? {
						role: "assistant",
						content: [{ type: "text", text: this.messageBuffer }]
					} : undefined,
				});
			}

			// Store assistant message
			if (this.messageBuffer) {
				session.messages.push({ type: "text", text: this.messageBuffer });
			}
		} catch (err) {
			if (id !== undefined) {
				this.sendError(id, ERROR_CODES.INTERNAL_ERROR, err instanceof Error ? err.message : "Error processing prompt");
			}
		} finally {
			this.pendingPrompt = null;
		}
	}

	private handleSessionCancel(params: { sessionId: string; _meta?: Record<string, unknown> }): void {
		// Cancel ongoing work
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}

		// Mark pending tool calls as cancelled
		for (const [toolCallId] of this.pendingToolCalls) {
			this.sendSessionUpdate(params.sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId,
				status: "failed",
				error: "Cancelled by client",
			});
		}
		this.pendingToolCalls.clear();

		// Clear pending prompt
		if (this.pendingPrompt && this.pendingPrompt.sessionId === params.sessionId) {
			this.sendSessionUpdate(params.sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "[Cancelled]" },
			});

			this.sendSessionUpdate(params.sessionId, { sessionUpdate: "agent_message_end" });

			// Resolve the pending prompt
			this.pendingPrompt.resolve();
			this.pendingPrompt = null;
		}
	}

	private handleSessionClose(params: { sessionId: string; _meta?: Record<string, unknown> }, id: number | string | undefined): void {
		// Cancel ongoing work
		if (this.abortController) {
			this.abortController.abort();
		}

		// Clear pending prompt if it's for this session
		if (this.pendingPrompt && this.pendingPrompt.sessionId === params.sessionId) {
			this.pendingPrompt.resolve();
			this.pendingPrompt = null;
		}

		// Delete session
		this.sessions.delete(params.sessionId);

		if (this.currentSessionId === params.sessionId) {
			this.currentSessionId = null;
		}

		if (id !== undefined) {
			this.sendResponse(id, {});
		}
	}

	private handleSessionSetMode(params: { sessionId: string; mode: SessionMode; _meta?: Record<string, unknown> }, id: number | string | undefined): void {
		const session = this.sessions.get(params.sessionId);
		if (session) {
			session.mode = params.mode;
			this.sendSessionUpdate(session.id, {
				sessionUpdate: "mode_change",
				mode: params.mode,
			});
		}

		if (id !== undefined) {
			this.sendResponse(id, {});
		}
	}

	private handleSessionRequestPermission(_params: {
		sessionId: string;
		toolCall?: any;
		options?: Array<{ optionId: string; name: string; kind: string }>;
		_meta?: Record<string, unknown>;
	}, id: number | string | undefined): void {
		// For now, auto-allow permissions
		if (id !== undefined) {
			this.sendResponse(id, {
				outcome: {
					outcome: "selected",
					optionId: "allow-once",
				},
			});
		}
	}

	private extractTextFromPrompt(prompt: ContentBlock[]): string {
		const parts: string[] = [];
		for (const block of prompt) {
			if (block.type === "text") {
				parts.push(block.text);
			} else if (block.type === "resource" && "text" in block.resource) {
				parts.push(`[File: ${block.resource.uri}]\n${block.resource.text}`);
			} else if (block.type === "resource_link") {
				parts.push(`[Link: ${block.resource.uri}]`);
			}
		}
		return parts.join("\n\n");
	}
}

// ============================================================================
// Extension Entry Point
// ============================================================================

// Check if ACP mode is enabled via flag or environment
function isAcpEnabled(): boolean {
	if (process.env.PI_ACP === "1") return true;
	if (process.argv.includes("--acp") || process.argv.includes("-acp")) return true;
	return false;
}

export default async function (pi: ExtensionAPI): Promise<void> {
	// Register the --acp flag (also check argv directly since flags are parsed before extension loads)
	pi.registerFlag("acp", {
		description: "Enable ACP (Agent Client Protocol) mode for editor integration",
		type: "boolean",
		default: false,
	});

	const shouldRunAcp = isAcpEnabled();

	if (!shouldRunAcp) {
		return;
	}

	// Take over stdout so our JSON-RPC messages go to stdout only
	takeOverStdout();

	// Create transport and handler
	const transport = new StdioTransport();
	const handler = new AcpProtocolHandler(pi, transport);

	// Start the protocol
	handler.start();
}