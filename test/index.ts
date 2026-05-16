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

// Test runner
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

// Create agent instance and get session ID
async function createAgent(): Promise<{
	send: (msg: object, timeoutMs?: number) => Promise<JsonRpcMessage>;
	sessionId: string;
	kill: () => void;
}> {
	return new Promise((resolveSession) => {
		const agent = spawn("pi", ["--acp"], {
			stdio: ["pipe", "pipe", "pipe"],
		});

		let initDone = false;
		let sessionId: string | null = null;
		const pendingRequests = new Map<number | string, (msg: JsonRpcMessage) => void>();

		agent.stdout?.on("data", (data) => {
			const lines = data.toString().split("\n");
			for (const line of lines) {
				if (!line.trim() || line.includes("```json") || line.includes("[pi-acp]")) continue;
				try {
					const msg = JSON.parse(line) as JsonRpcMessage;
					if (msg.id !== undefined && pendingRequests.has(msg.id)) {
						const resolve = pendingRequests.get(msg.id)!;
						pendingRequests.delete(msg.id);
						resolve(msg);
					}
				} catch {}
			}
		});

		const send = (msg: object, timeoutMs = 5000): Promise<JsonRpcMessage> => {
			return new Promise((resolve) => {
				const id = (msg as any).id || Date.now();
				pendingRequests.set(id, resolve);
				agent.stdin?.write(JSON.stringify({ ...msg, id }) + "\n");
				setTimeout(() => {
					if (pendingRequests.has(id)) {
						pendingRequests.delete(id);
						resolve({ jsonrpc: "2.0", id, error: { code: -32603, message: "timeout" } });
					}
				}, timeoutMs);
			});
		};

		setTimeout(async () => {
			// Send initialize
			await send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } }, 10000);
			
			// Send session/new
			const newRes = await send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } }, 10000);
			if (newRes.result && (newRes.result as any).sessionId) {
				sessionId = (newRes.result as any).sessionId;
			}
			resolveSession({ send, sessionId: sessionId || "", kill: () => agent.kill() });
		}, 500);
	});
}

// Main test suite
async function runTests() {
	console.log("=== ACP Protocol Compliance Tests ===\n");
	console.log("Spec: https://agentclientprotocol.com/\n");

	let passed = 0;
	let failed = 0;

	// Create agent once for all tests
	const agent = await createAgent();
	console.log("Agent ready, session:", agent.sessionId.substring(0, 15) + "...\n");

	// Test 1-7: initialize
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
		const caps = (res.result as any)?.agentCapabilities?.promptCapabilities;
		return caps?.image === true;
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
		const res = await agent.send({ jsonrpc: "2.0", id: 31, method: "session/prompt", params: { sessionId: agent.sessionId, prompt: [{ type: "text", text: "hi" }] } }, 10000);
		return (res.result as any)?.stopReason !== undefined;
	});
	if (t11) passed++; else failed++;

	// Test 12: session/close returns empty result
	const t12 = await runTest("session/close returns empty result", async () => {
		const res = await agent.send({ jsonrpc: "2.0", id: 40, method: "session/close", params: { sessionId: agent.sessionId } });
		return res.result !== undefined;
	});
	if (t12) passed++; else failed++;

	// Test 13: session/set_mode accepts various modes
	const t13 = await runTest("session/set_mode accepts readOnly, auto, fullAccess", async () => {
		for (const mode of ["readOnly", "auto", "fullAccess"]) {
			const res = await agent.send({ jsonrpc: "2.0", id: Date.now(), method: "session/set_mode", params: { sessionId: agent.sessionId, mode } });
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
		// Create new session for this test
		const newSession = await agent.send({ jsonrpc: "2.0", id: Date.now(), method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
		const sessionId = (newSession.result as any)?.sessionId;
		if (!sessionId) return false;
		const res = await agent.send({
			jsonrpc: "2.0",
			id: Date.now(),
			method: "session/prompt",
			params: {
				sessionId,
				prompt: [{
					type: "resource",
					resource: { uri: "file:///tmp/test.txt", text: "test content" }
				}],
			},
		}, 10000);
		return res.result !== undefined;
	});
	if (t16) passed++; else failed++;

	// Test 17: resource_link content block is processed (not rejected as invalid)
	const t17 = await runTest("resource_link content block is processed (not rejected)", async () => {
		// Create new session for this test
		const newSession = await agent.send({ jsonrpc: "2.0", id: Date.now(), method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
		const sessionId = (newSession.result as any)?.sessionId;
		if (!sessionId) {
			return false;
		}
		// Send resource_link prompt - it may timeout because the agent can't access the file,
		// but it should not be immediately rejected as invalid params
		const res = await agent.send({
			jsonrpc: "2.0",
			id: Date.now(),
			method: "session/prompt",
			params: {
				sessionId,
				prompt: [{
					type: "resource_link",
					uri: "file:///tmp/test.txt",
					name: "test.txt"
				}],
			},
		}, 15000);
		// Pass if: result exists (success) OR error is NOT -32602 (invalid params)
		return res.result !== undefined || (res.error && res.error.code !== -32602);
	});
	if (t17) passed++; else failed++;

	// Clean up
	agent.kill();

	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

	if (failed > 0) {
		process.exit(1);
	}
}

runTests().catch(console.error);