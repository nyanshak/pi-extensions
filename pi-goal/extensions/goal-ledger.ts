/**
 * Goal ledger compatibility layer.
 * 
 * File-based storage removed; ledger events now stored via session entries.
 * Note: Append functions (appendFocusEntry, appendStateEntry, appendGoalEvent)
 * are defined locally in goal.ts since they need access to `pi.appendEntry`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	GoalCreationConfig,
	GoalFocusEntry,
	GoalFocusReason,
	GoalRecord,
	GoalStateEntry,
	GoalStatus,
} from "./goal-record.ts";

// Goal event types
export type GoalLedgerEvent =
	| { type: "goal_created"; goalId: string; objective: string; sisyphus: boolean; autoContinue: boolean; at: string }
	| { type: "goal_focused"; goalId: string; reason: string; at: string }
	| { type: "goal_unfocused"; reason: string; at: string }
	| { type: "goal_paused"; goalId: string; reason: string; suggestedAction?: string; status?: "paused"; at: string }
	| { type: "goal_resumed"; goalId: string; reason: string; at: string }
	| { type: "goal_tweaked"; goalId: string; changeSummary: string; at: string }
	| { type: "completion_requested"; goalId: string; summary?: string; at: string }
	| { type: "audit_started"; goalId: string; provider?: string; model?: string; thinkingLevel?: string; at: string }
	| { type: "audit_result"; goalId: string; verdict: "approved" | "disapproved" | "error"; report: string; at: string }
	| { type: "goal_completed"; goalId: string; at: string }
	| { type: "goal_aborted"; goalId: string; reason: string; at: string };

// Session entry type constants
export const GOALS_TABLE = "goals";
export const GOAL_FOCUS_ENTRY = "pi-goal-focus";
export const GOAL_STATE_ENTRY = "pi-goal-state";
export const GOAL_EVENT_ENTRY = "pi-goal-event";

// Helper functions
function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nowIso(): string {
	return new Date(Date.now()).toISOString();
}

function safeIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "goal";
}

function newGoalId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyUsage(): { tokensUsed: number; activeSeconds: number } {
	return { tokensUsed: 0, activeSeconds: 0 };
}

function normalizeUsage(value: unknown): { tokensUsed: number; activeSeconds: number } {
	const raw = asRecord(value);
	if (!raw) return emptyUsage();
	const tokens = typeof raw.tokensUsed === "number" && Number.isFinite(raw.tokensUsed) ? Math.max(0, Math.floor(raw.tokensUsed)) : 0;
	const seconds = typeof raw.activeSeconds === "number" && Number.isFinite(raw.activeSeconds) ? Math.max(0, Math.floor(raw.activeSeconds)) : 0;
	return { tokensUsed: tokens, activeSeconds: seconds };
}

export function normalizeGoalRecord(value: unknown): GoalRecord | null {
	const raw = asRecord(value);
	if (!raw) return null;
	const objective = typeof raw.objective === "string" ? raw.objective.trim() : "";
	if (!objective) return null;

	const timestamp = nowIso();
	const rawStatus = raw.status;
	let status: GoalStatus = rawStatus === "complete" ? "complete" : rawStatus === "paused" ? "paused" : "active";
	const autoContinue = typeof raw.autoContinue === "boolean" ? raw.autoContinue : true;
	const usage = normalizeUsage(raw.usage);
	const sisyphus = raw.sisyphus === true;

	if (status === "paused" && autoContinue) {
		status = "active";
	}

	return {
		id: typeof raw.id === "string" && raw.id ? safeIdPart(raw.id) : newGoalId(),
		objective,
		status,
		autoContinue,
		usage,
		sisyphus,
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : timestamp,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : timestamp,
		stopReason: raw.stopReason === "agent" || raw.stopReason === "user" ? raw.stopReason as "agent" | "user" : undefined,
		pauseReason: typeof raw.pauseReason === "string" && raw.pauseReason.trim() ? raw.pauseReason : undefined,
		pauseSuggestedAction: typeof raw.pauseSuggestedAction === "string" && raw.pauseSuggestedAction.trim() ? raw.pauseSuggestedAction : undefined,
	};
}

export function cloneGoal(goal: GoalRecord): GoalRecord {
	return { ...goal, usage: { ...goal.usage } };
}

export function createGoal(config: GoalCreationConfig, now = Date.now()): GoalRecord {
	const timestamp = new Date(now).toISOString();
	return {
		id: newGoalId(),
		objective: config.objective,
		status: "active",
		autoContinue: config.autoContinue,
		usage: emptyUsage(),
		sisyphus: config.sisyphus,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

function normalizeGoalFocusEntry(value: unknown): GoalFocusEntry | null {
	const raw = asRecord(value);
	if (!raw || raw.version !== 1) return null;
	const focusedGoalId = typeof raw.focusedGoalId === "string" && raw.focusedGoalId.trim()
		? safeIdPart(raw.focusedGoalId)
		: null;
	const reason: GoalFocusReason =
		raw.reason === "created" || raw.reason === "selected" || raw.reason === "resumed" || raw.reason === "completed" || raw.reason === "cleared" || raw.reason === "aborted" || raw.reason === "migrated"
			? raw.reason as GoalFocusReason
			: "selected";
	return { version: 1, focusedGoalId, reason };
}

export function goalFocusDetails(focusedGoalId: string | null, reason: GoalFocusReason): GoalFocusEntry {
	return {
		version: 1,
		focusedGoalId: focusedGoalId ? safeIdPart(focusedGoalId) : null,
		reason,
	};
}

export function buildStateEntry(goal: GoalRecord | null): GoalStateEntry {
	return {
		version: 3,
		goal: goal ? cloneGoal(goal) : null,
	};
}

// Get all goals from session entries
export function getGoalsFromSession(ctx: ExtensionContext): Map<string, GoalRecord> {
	const pool = new Map<string, GoalRecord>();
	const entries = ctx.sessionManager.getEntries();
	
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		
		// Handle GoalStateEntry format
		if (entry.customType === GOAL_STATE_ENTRY && entry.data) {
			const data = entry.data as { goal?: unknown };
			if (data?.goal) {
				const record = normalizeGoalRecord(data.goal);
				if (record && record.status !== "complete") {
					pool.set(record.id, record);
				}
			}
		}
		
		// Handle direct GoalRecord format
		if (entry.customType === GOALS_TABLE && entry.data) {
			const record = normalizeGoalRecord(entry.data);
			if (record && record.status !== "complete") {
				pool.set(record.id, record);
			}
		}
	}
	
	return pool;
}

// Get focus entry from session
export function getFocusEntryFromSession(ctx: ExtensionContext): { focusedGoalId: string | null; reason: GoalFocusReason } {
	const entries = ctx.sessionManager.getBranch();
	let focusEntry: GoalFocusEntry | null = null;
	
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom") continue;
		if (entry.customType === GOAL_FOCUS_ENTRY) {
			focusEntry = normalizeGoalFocusEntry(entry.data);
			break;
		}
	}
	
	return {
		focusedGoalId: focusEntry?.focusedGoalId ?? null,
		reason: focusEntry?.reason ?? "selected",
	};
}

// Resolve session focus
export function resolveSessionFocusFromEntries(
	pool: Map<string, GoalRecord>,
	ctx: ExtensionContext,
): string | null {
	const { focusedGoalId } = getFocusEntryFromSession(ctx);
	if (focusedGoalId && pool.has(focusedGoalId)) {
		return focusedGoalId;
	}
	return null;
}

// Read events from session
export function readGoalLedgerFromSession(ctx: ExtensionContext): { events: GoalLedgerEvent[] } {
	const events: GoalLedgerEvent[] = [];
	const entries = ctx.sessionManager.getEntries();
	
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== GOAL_EVENT_ENTRY) continue;
		events.push(entry.data as GoalLedgerEvent);
	}
	
	return { events };
}

export function latestAuditorResultForGoal(events: GoalLedgerEvent[], goalId: string): { verdict: "approved" | "disapproved" | "error"; report: string; at: string } | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event.type === "audit_result" && event.goalId === goalId) {
			return { verdict: event.verdict, report: event.report, at: event.at };
		}
	}
	return undefined;
}

// File-based context - kept for compatibility
export interface GoalLedgerContext {
	cwd: string;
}

export interface GoalLedgerReadResult {
	events: GoalLedgerEvent[];
	malformed: number;
}

export interface ReconstructedGoalState {
	goalId: string;
	latestStatus: "active" | "paused" | "complete" | "aborted" | "unknown";
	latestFocus: boolean;
	latestPauseReason?: string;
	latestPauseSuggestedAction?: string;
	latestAuditorResult?: { verdict: "approved" | "disapproved" | "error"; report: string; at: string };
	createdAt?: string;
	completedAt?: string;
	abortedAt?: string;
	tweakedAt?: string;
	resumedAt?: string;
}

export interface ReconstructedLedgerState {
	focusedGoalId: string | null;
	goals: Map<string, ReconstructedGoalState>;
	terminalGoals: Map<string, ReconstructedGoalState>;
}

// File-based functions - no-ops, replaced by session-based equivalents
export function appendGoalEventToDisk(_ctx: GoalLedgerContext, _event: GoalLedgerEvent): void {
	// No-op: file-based ledger removed, uses pi.appendEntry in goal.ts
}

export function readGoalLedger(_ctx: GoalLedgerContext): GoalLedgerReadResult {
	// No-op: use readGoalLedgerFromSession(ctx) instead
	return { events: [], malformed: 0 };
}

// Reconstruct ledger state from session events
export function reconstructGoalLedger(events: GoalLedgerEvent[]): ReconstructedLedgerState {
	const goals = new Map<string, ReconstructedGoalState>();
	const terminalGoals = new Map<string, ReconstructedGoalState>();
	let focusedGoalId: string | null = null;

	for (const event of events) {
		switch (event.type) {
			case "goal_created": {
				const state: ReconstructedGoalState = {
					goalId: event.goalId,
					latestStatus: "active",
					latestFocus: false,
					createdAt: event.at,
				};
				goals.set(event.goalId, state);
				break;
			}
			case "goal_focused": {
				focusedGoalId = event.goalId;
				for (const g of goals.values()) g.latestFocus = false;
				for (const g of terminalGoals.values()) g.latestFocus = false;
				const state = goals.get(event.goalId) ?? terminalGoals.get(event.goalId);
				if (state) state.latestFocus = true;
				break;
			}
			case "goal_unfocused": {
				focusedGoalId = null;
				for (const g of goals.values()) g.latestFocus = false;
				for (const g of terminalGoals.values()) g.latestFocus = false;
				break;
			}
			case "goal_paused": {
				const state = goals.get(event.goalId);
				if (state) {
					state.latestStatus = event.status ?? "paused";
					state.latestPauseReason = event.reason;
					state.latestPauseSuggestedAction = event.suggestedAction;
				}
				break;
			}
			case "goal_resumed": {
				const state = goals.get(event.goalId);
				if (state) {
					state.latestStatus = "active";
					state.resumedAt = event.at;
					delete state.latestPauseReason;
					delete state.latestPauseSuggestedAction;
				}
				break;
			}
			case "goal_tweaked": {
				const state = goals.get(event.goalId);
				if (state) state.tweakedAt = event.at;
				break;
			}
			case "completion_requested": {
				// No status change until audit_result or goal_completed
				break;
			}
			case "audit_started": {
				// No state change
				break;
			}
			case "audit_result": {
				const state = goals.get(event.goalId) ?? terminalGoals.get(event.goalId);
				if (state) {
					state.latestAuditorResult = { verdict: event.verdict, report: event.report, at: event.at };
				}
				break;
			}
			case "goal_completed": {
				let state = goals.get(event.goalId);
				if (!state) {
					state = { goalId: event.goalId, latestStatus: "complete", latestFocus: false };
				}
				state.latestStatus = "complete";
				state.completedAt = event.at;
				terminalGoals.set(event.goalId, state);
				goals.delete(event.goalId);
				break;
			}
			case "goal_aborted": {
				let state = goals.get(event.goalId);
				if (!state) {
					state = { goalId: event.goalId, latestStatus: "aborted", latestFocus: false };
				}
				state.latestStatus = "aborted";
				state.abortedAt = event.at;
				terminalGoals.set(event.goalId, state);
				goals.delete(event.goalId);
				break;
			}
		}
	}

	// If the focused goal was moved to terminal (e.g., aborted/completed), clear focus.
	if (focusedGoalId && !goals.has(focusedGoalId)) {
		focusedGoalId = null;
	}

	return { focusedGoalId, goals, terminalGoals };
}

export function latestEventsForGoal(events: GoalLedgerEvent[], goalId: string, limit = 10): GoalLedgerEvent[] {
	const result: GoalLedgerEvent[] = [];
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if ("goalId" in event && event.goalId === goalId) {
			result.unshift(event);
			if (result.length >= limit) break;
		}
	}
	return result;
}

export function latestGoalLifecycleEvent(events: GoalLedgerEvent[], goalId: string): GoalLedgerEvent | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if ("goalId" in event && event.goalId === goalId) {
			return event;
		}
	}
	return undefined;
}