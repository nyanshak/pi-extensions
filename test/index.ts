/**
 * ACP (Agent Client Protocol) Test Suite
 * 
 * Tests spec compliance against https://agentclientprotocol.com/
 * 
 * Run with: npx tsx test/index.ts
 */

import { spawn } from "node:child_process";

interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

async function runTest(name: string, fn: () => Promise<boolean>): Promise<boolean> {
	try {
		const result = await fn();
		console.log(result ? `✓ ${name}` : `✗ ${name}`);
		return result;
	} catch (err) {
		console.log(`✗ ${name}: ${err}`);
		return false;
	}
}

async function createAgent(): Promise<{
	send: (msg: object, timeoutMs?: number) => Promise<JsonRpcMessage>;
	sessionId: string;
	kill: () => void;
}> {
	return new Promise((resolve) => {
		const agent = spawn("pi", ["--acp"], { stdio: ["pipe", "pipe", "pipe"] });
		const pending = new Map<number | string, (msg: JsonRpcMessage) => void>();
		let sessionId = "";

		agent.stdout?.on("data", (data) => {
			for (const line of data.toString().split("\n")) {
				if (!line.trim() || line.includes("```") || line.includes("[pi-acp]")) continue;
				try {
					const msg = JSON.parse(line) as JsonRpcMessage;
					if (msg.id && pending.has(msg.id)) {
						pending.get(msg.id)?.(msg);
						pending.delete(msg.id);
					}
				} catch {}
			}
		});

		const send = (msg: object, timeoutMs = 5000): Promise<JsonRpcMessage> => {
			return new Promise((resolve) => {
				const id = (msg as any).id || Date.now();
				pending.set(id, resolve as any);
				agent.stdin?.write(JSON.stringify({ ...msg, id }) + "\n");
				setTimeout(() => {
					if (pending.has(id)) {
						pending.delete(id);
						resolve({ jsonrpc: "2.0", id, error: { code: -32603, message: "timeout" } });
					}
				}, timeoutMs);
			});
		};

		setTimeout(async () => {
			await send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } }, 8000);
			const res = await send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } }, 8000);
			sessionId = (res.result as any)?.sessionId || "";
			resolve({ send, sessionId, kill: () => agent.kill() });
		}, 500);
	});
}

async function runTests() {
	console.log("=== ACP Protocol Compliance Tests ===\n");
	console.log("Spec: https://agentclientprotocol.com/\n");

	let passed = 0, failed = 0;
	const agent = await createAgent();
	console.log("Agent ready, session:", agent.sessionId.substring(0, 15) + "...\n");

	// Tests 1-7: initialize
	const t1 = await runTest("initialize returns protocolVersion 1", async () => {
		const res = await agent.send({ jsonrpc: "2.0", id: 10, method: "initialize", params: { protocolVersion: 1 } });
		return (res.result as any)?.protocolVersion === 1;
	});
	if (t1) passed++; else failed++;

	const t2 = await runTest("initialize returns agentCapabilities", async () => {
		const res = await agent.send({ jsonrpc: "2.0", id: 11, method: "initialize", params: { protocolVersion: 1 } });
		return (res.result as any)?.agentCapabilities !== undefined;
	});
	if (t2) passed++; else failed++;

	const t3 = await runTest("initialize returns loadSession: true", async () => {
		const res = await agent.send({ jsonrpc: "2.0", id: 12, method: "initialize", params: { protocolVersion: 1 } });
		return (res.result as any)?.agentCapabilities?.loadSession === true;
	});
	if (t3) passed++; else failed++;

	const t4 = await runTest("initialize returns sessionCapabilities.close and resume", async () => {
		const res = await agent.send({ jsonrpc: "2.0", id: 13, method: "initialize", params: { protocolVersion: 1 } });
		const caps = (res.result as any)?.agentCapabilities?.sessionCapabilities;
		return caps?.close !== undefined && caps?.resume !== undefined;
	});
	if (t4) passed++; else failed++;

	const t5 = await runTest("initialize returns promptCapabilities with image: true", async () => {
		const res = await agent.send({ jsonrpc: "2.0", id: 14, method: "initialize", params: { protocolVersion: 1 } });
		return (res.result as any)?.agentCapabilities?.promptCapabilities?.image === true;
	});
	if (t5) passed++; else failed++;

	const t6 = await runTest("initialize returns agentInfo with name and version", async () => {
		const res = await agent.send({ jsonrpc: "2.0", id: 15, method: "initialize", params: { protocolVersion: 1 } });
		const info = (res.result as any)?.agentInfo;
		return info?.name !== undefined && info?.version !== undefined;
	});
	if (t6) passed++; else failed++;

	const t7 = await runTest("initialize returns authMethods array", async () => {
		const res = await agent.send({ jsonrpc: "2.0", id: 16, method: "initialize", params: { protocolVersion: 1 } });
		return Array.isArray((res.result as any)?.authMethods);
	});
	if (t7) passed++; else failed++;

	// Test 8: session/new requires cwd
	const t8 = await runTest("session/new requires cwd (invalid params)", async () => {
		const res = await agent.send({ jsonrpc: "2.0", id: 20, method: "session/new", params: {} });
		return res.error?.code === -32602;
	});
	if (t8) passed++; else failed++;

	// Test 9: session/new returns sessionId
	const t9 = await runTest("session/new returns sessionId in result", async () => {
		const res = await agent.send({ jsonrpc: "2.0", id: 21, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
		return (res.result as any)?.sessionId?.startsWith("sess_") === true;
	});
	if (t9) passed++; else failed++;

	// Test 10: session/prompt requires sessionId
	const t10 = await runTest("session/prompt requires sessionId", async () => {
		const res = await agent.send({ jsonrpc: "2.0", id: 30, method: "session/prompt", params: { prompt: [] } });
		return res.error?.code === -32602;
	});
	if (t10) passed++; else failed++;

	// Test 11: session/prompt with text content returns stopReason
	const t11 = await runTest("session/prompt with text content returns stopReason", async () => {
		const res = await agent.send({ jsonrpc: "2.0", id: 31, method: "session/prompt", params: { sessionId: agent.sessionId, prompt: [{ type: "text", text: "hi" }] } }, 20000);
		return (res.result as any)?.stopReason !== undefined;
	});
	if (t11) passed++; else failed++;

	// Test 12: session/close returns empty result
	const t12 = await runTest("session/close returns empty result", async () => {
		const res = await agent.send({ jsonrpc: "2.0", id: 40, method: "session/close", params: { sessionId: agent.sessionId } });
		return res.result !== undefined;
	});
	if (t12) passed++; else failed++;

	// Create new session for remaining tests (session/close invalidates the old one)
	const newSession = await agent.send({ jsonrpc: "2.0", id: Date.now(), method: "session/new", params: { cwd: "/tmp", mcpServers: [] } }, 8000);
	const newSessionId = (newSession.result as any)?.sessionId || agent.sessionId;

	// Test 13: session/set_mode accepts various modes
	const t13 = await runTest("session/set_mode accepts readOnly, auto, fullAccess", async () => {
		for (const mode of ["readOnly", "auto", "fullAccess"]) {
			const res = await agent.send({ jsonrpc: "2.0", id: Date.now(), method: "session/set_mode", params: { sessionId: newSessionId, mode } });
			if (res.error) return false;
		}
		return true;
	});
	if (t13) passed++; else failed++;

	// Test 14: unknown method returns -32601
	const t14 = await runTest("unknown method returns METHOD_NOT_FOUND (-32601)", async () => {
		const res = await agent.send({ jsonrpc: "2.0", id: 99, method: "unknown/method", params: {} });
		return res.error?.code === -32601;
	});
	if (t14) passed++; else failed++;

	// Test 15: authenticate returns success
	const t15 = await runTest("authenticate returns success (no-op)", async () => {
		const res = await agent.send({ jsonrpc: "2.0", id: 0, method: "authenticate", params: { methodId: "none" } });
		return res.result !== undefined;
	});
	if (t15) passed++; else failed++;

	// Test 16: resource content block works
	const t16 = await runTest("resource content block is accepted", async () => {
		const res = await agent.send({
			jsonrpc: "2.0", id: Date.now(), method: "session/prompt",
			params: { sessionId: newSessionId, prompt: [{ type: "resource", resource: { uri: "file:///tmp/test.txt", text: "test" } }] },
		}, 20000);
		return res.result !== undefined;
	});
	if (t16) passed++; else failed++;

	// Test 17: resource_link content block is processed
	const t17 = await runTest("resource_link content block is processed (not rejected)", async () => {
		const res = await agent.send({
			jsonrpc: "2.0", id: Date.now(), method: "session/prompt",
			params: { sessionId: newSessionId, prompt: [{ type: "resource_link", uri: "file:///tmp/test.txt", name: "test.txt" }] },
		}, 20000);
		return res.result !== undefined || (res.error && res.error.code !== -32602);
	});
	if (t17) passed++; else failed++;

	// Test 18: session/prompt with tool call returns message content
	// Use a fresh agent for this test to avoid timing issues
	const t18Result = await new Promise<boolean>(async (resolve) => {
		const testAgent = spawn("pi", ["--acp"], { stdio: ["pipe", "pipe", "pipe"] });
		const pending = new Map<number | string, (msg: JsonRpcMessage) => void>();
		testAgent.stdout?.on("data", (data) => {
			for (const line of data.toString().split("\n")) {
				if (!line.trim() || line.includes("```") || line.includes("[pi-acp]")) continue;
				try {
					const msg = JSON.parse(line);
					if (msg.id && pending.has(msg.id)) {
						pending.get(msg.id)?.(msg);
						pending.delete(msg.id);
					}
				} catch {}
			}
		});
		const send = (msg: object): Promise<JsonRpcMessage> => new Promise((r) => {
			const id = (msg as any).id || Date.now();
			pending.set(id, r as any);
			testAgent.stdin?.write(JSON.stringify({...msg, id}) + "\n");
			setTimeout(() => { if (pending.has(id)) { pending.delete(id); r({ jsonrpc: "2.0", id, error: { code: -32603 } }); } }, 20000);
		});
		await send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } });
		const s = await send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
		await new Promise((r) => setTimeout(r, 300));
		const res = await send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: (s.result as any)?.sessionId, prompt: [{ type: "text", text: "read /etc/hostname" }] } });
		testAgent.kill();
		if (res.result) {
			const result = res.result as any;
			resolve(result.stopReason && result.message?.content?.length > 0);
		} else {
			resolve(false);
		}
	});
	console.log(t18Result ? `✓ session/prompt with tool call returns message` : `✗ session/prompt with tool call returns message`);
	if (t18Result) passed++; else failed++;

	// Test 19: no duplicate agent_message_chunk notifications
	const t19 = await runTest("no duplicate agent_message_chunk notifications", async () => {
		const testAgent = spawn("pi", ["--acp"], { stdio: ["pipe", "pipe", "pipe"] });
		const chunks: string[] = [];
		const pending = new Map<number | string, (msg: JsonRpcMessage) => void>();

		testAgent.stdout?.on("data", (data) => {
			for (const line of data.toString().split("\n")) {
				if (!line.trim() || line.includes("```") || line.includes("[pi-acp]")) continue;
				try {
					const msg = JSON.parse(line);
					if (msg.method === "session/update" && msg.params?.update?.sessionUpdate === "agent_message_chunk") {
						chunks.push(msg.params.update.content?.text || "");
					}
					if (msg.id && pending.has(msg.id)) {
						pending.get(msg.id)?.(msg);
						pending.delete(msg.id);
					}
				} catch {}
			}
		});

		const send = (msg: object): Promise<JsonRpcMessage> => {
			return new Promise((resolve) => {
				const id = (msg as any).id || Date.now();
				pending.set(id, resolve as any);
				testAgent.stdin?.write(JSON.stringify(msg) + "\n");
				setTimeout(() => {
					if (pending.has(id)) {
						pending.delete(id);
						resolve({ jsonrpc: "2.0", id, error: { code: -32603 } });
					}
				}, 8000);
			});
		};

		await send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } });
		const s = await send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
		await new Promise((r) => setTimeout(r, 400));
		await send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: (s.result as any)?.sessionId, prompt: [{ type: "text", text: "say hi" }] } });
		await new Promise((r) => setTimeout(r, 2000));
		testAgent.kill();

		// All non-empty chunks should be unique
		const nonEmpty = chunks.filter((t) => t.length > 0);
		return nonEmpty.length === new Set(nonEmpty).size;
	});
	if (t19) passed++; else failed++;

	// Test 20: session/prompt returns message with tool result
	// Use a fresh agent for this test to avoid timing issues
	const t20Result = await new Promise<boolean>(async (resolve) => {
		const testAgent = spawn("pi", ["--acp"], { stdio: ["pipe", "pipe", "pipe"] });
		const pending = new Map<number | string, (msg: JsonRpcMessage) => void>();
		testAgent.stdout?.on("data", (data) => {
			for (const line of data.toString().split("\n")) {
				if (!line.trim() || line.includes("```") || line.includes("[pi-acp]")) continue;
				try {
					const msg = JSON.parse(line);
					if (msg.id && pending.has(msg.id)) {
						pending.get(msg.id)?.(msg);
						pending.delete(msg.id);
					}
				} catch {}
			}
		});
		const send = (msg: object): Promise<JsonRpcMessage> => new Promise((r) => {
			const id = (msg as any).id || Date.now();
			pending.set(id, r as any);
			testAgent.stdin?.write(JSON.stringify({...msg, id}) + "\n");
			setTimeout(() => { if (pending.has(id)) { pending.delete(id); r({ jsonrpc: "2.0", id, error: { code: -32603 } }); } }, 20000);
		});
		await send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } });
		const s = await send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
		await new Promise((r) => setTimeout(r, 300));
		const res = await send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: (s.result as any)?.sessionId, prompt: [{ type: "text", text: "cat /etc/hostname" }] } });
		testAgent.kill();
		if (res.result) {
			const result = res.result as any;
			resolve(result.stopReason && result.message?.content?.length > 0 && (result.message.content[0]?.text?.length || 0) > 0);
		} else {
			resolve(false);
		}
	});
	console.log(t20Result ? `✓ session/prompt returns message with tool result` : `✗ session/prompt returns message with tool result`);
	if (t20Result) passed++; else failed++;

	// Test 21: tool_call_update should not send empty content
	const t21Result = await new Promise<boolean>(async (resolve) => {
		const testAgent = spawn("pi", ["--acp"], { stdio: ["pipe", "pipe", "pipe"] });
		const pending = new Map<number | string, (msg: JsonRpcMessage) => void>();
		const toolUpdates: { toolCallId: string; content?: any[] }[] = [];
		testAgent.stdout?.on("data", (data) => {
			for (const line of data.toString().split("\n")) {
				if (!line.trim() || line.includes("```") || line.includes("[pi-acp]")) continue;
				try {
					const msg = JSON.parse(line);
					if (msg.method === "session/update" && msg.params?.update?.sessionUpdate === "tool_call_update") {
						toolUpdates.push({ toolCallId: msg.params.update.toolCallId, content: msg.params.update.content });
					}
					if (msg.id && pending.has(msg.id)) {
						pending.get(msg.id)?.(msg);
						pending.delete(msg.id);
					}
				} catch {}
			}
		});
		const send = (msg: object): Promise<JsonRpcMessage> => new Promise((r) => {
			const id = (msg as any).id || Date.now();
			pending.set(id, r as any);
			testAgent.stdin?.write(JSON.stringify({...msg, id}) + "\n");
			setTimeout(() => { if (pending.has(id)) { pending.delete(id); r({ jsonrpc: "2.0", id, error: { code: -32603 } }); } }, 20000);
		});
		await send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } });
		const s = await send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
		await new Promise((r) => setTimeout(r, 300));
		// Use ls which triggers bash tool
		await send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: (s.result as any)?.sessionId, prompt: [{ type: "text", text: "ls /tmp" }] } });
		await new Promise((r) => setTimeout(r, 3000));
		testAgent.kill();
		// Check that no tool_call_update has content with empty text
		let hasEmptyContent = false;
		for (const update of toolUpdates) {
			if (update.content && Array.isArray(update.content)) {
				for (const item of update.content) {
					if (item?.content?.text === "" || item?.content?.text === "{}" || item?.content?.text === "{\"content\":[]}") {
						hasEmptyContent = true;
						break;
					}
				}
			}
			if (hasEmptyContent) break;
		}
		resolve(!hasEmptyContent);
	});
	console.log(t21Result ? `✓ tool_call_update should not send empty content` : `✗ tool_call_update should not send empty content`);
	if (t21Result) passed++; else failed++;

	// Test 22: no empty agent_message_chunk notifications
	const t22Result = await new Promise<boolean>(async (resolve) => {
		const testAgent = spawn("pi", ["--acp"], { stdio: ["pipe", "pipe", "pipe"] });
		const pending = new Map<number | string, (msg: JsonRpcMessage) => void>();
		const emptyChunks: string[] = [];
		testAgent.stdout?.on("data", (data) => {
			for (const line of data.toString().split("\n")) {
				if (!line.trim() || line.includes("```") || line.includes("[pi-acp]")) continue;
				try {
					const msg = JSON.parse(line);
					if (msg.method === "session/update" && msg.params?.update?.sessionUpdate === "agent_message_chunk") {
						const text = msg.params.update.content?.text || "";
						if (text === "") {
							emptyChunks.push(text);
						}
					}
					if (msg.id && pending.has(msg.id)) {
						pending.get(msg.id)?.(msg);
						pending.delete(msg.id);
					}
				} catch {}
			}
		});
		const send = (msg: object): Promise<JsonRpcMessage> => new Promise((r) => {
			const id = (msg as any).id || Date.now();
			pending.set(id, r as any);
			testAgent.stdin?.write(JSON.stringify({...msg, id}) + "\n");
			setTimeout(() => { if (pending.has(id)) { pending.delete(id); r({ jsonrpc: "2.0", id, error: { code: -32603 } }); } }, 20000);
		});
		await send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } });
		const s = await send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
		await new Promise((r) => setTimeout(r, 300));
		// Use a prompt that triggers tool call
		await send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: (s.result as any)?.sessionId, prompt: [{ type: "text", text: "ls /tmp" }] } });
		await new Promise((r) => setTimeout(r, 2000));
		testAgent.kill();
		// Should have no empty chunks
		resolve(emptyChunks.length === 0);
	});
	console.log(t22Result ? `✓ no empty agent_message_chunk notifications` : `✗ no empty agent_message_chunk notifications`);
	if (t22Result) passed++; else failed++;

	agent.kill();
	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
	if (failed > 0) process.exit(1);
}

runTests().catch(console.error);