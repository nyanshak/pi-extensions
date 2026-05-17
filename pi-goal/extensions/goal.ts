/**
 * pi-goal: Long-running goal extension for pi
 * 
 * Rewritten to use beads for goal persistence.
 * Storage layer uses beads database via sessionManager.appendCustomEntry()
 * instead of markdown files in .pi/goals/
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import {
	footerStatus,
	formatDuration,
	formatTokenValue,
	statusLabel,
	truncateText,
} from "./goal-core.ts";
import {
	buildDraftConfirmationText,
	goalDraftingPrompt,
	validateGoalDraftProposal,
	type GoalDraftingFocus,
} from "./goal-draft.ts";
import {
	goalAuditorConfigPath,
	loadGoalAuditorFileConfig,
	runGoalCompletionAuditor,
	saveGoalAuditorFileConfig,
	type GoalAuditorConfig,
} from "./goal-auditor.ts";
import {
	proposalDialogFailureMessage,
	registerQuestionnaireTools,
	shouldAutoConfirmProposal,
	showProposalDialog,
} from "./goal-questionnaire.ts";
import {
	ABORT_GOAL_TOOL_NAME,
	ACTIVE_GOAL_TOOL_NAMES,
	CREATE_GOAL_TOOL_NAME,
	POST_STOP_ALLOWED_TOOLS,
	PROPOSE_DRAFT_TOOL_NAME,
	QUESTIONNAIRE_TOOL_NAME,
	QUESTION_TOOL_NAME,
	SISYPHUS_STEP_TOOL_NAME,
	GOAL_PROGRESS_TOOL_NAMES,
	lifecycleToolNamesForGoalStatus,
	TWEAK_APPLY_TOOL_NAME,
} from "./goal-tool-names.ts";
import {
	asRecord,
	cloneGoal,
	createGoal,
	normalizeGoalRecord,
	nowIso,
	safeIdPart,
	type AssistantMessageLike,
	type DraftingFocus,
	type GoalCreationConfig,
	type GoalEventDetails,
	type GoalFocusEntry,
	type GoalFocusReason,
	type GoalRecord,
	type GoalStateEntry,
	type GoalStatus,
	type StopReason,
} from "./goal-record.ts";
import {
	getGoalsFromSession,
	getFocusEntryFromSession,
	resolveSessionFocusFromEntries,
	latestAuditorResultForGoal,
	goalFocusDetails,
	buildStateEntry,
	type GoalLedgerEvent,
} from "./goal-ledger.ts";
import { buildCompactionSummary } from "./goal-compaction.ts";
import {
	buildGoalListText,
	buildUnfocusedOpenGoalsSummary,
	focusedGoalFromPool,
	goalSelectorLabel,
	openGoalsFromPool,
	otherOpenGoalCount,
} from "./goal-pool.ts";
import {
	continuationPrompt,
	goalPrompt,
	goalTweakDraftingPrompt,
	staleContinuationPrompt,
	unfocusedOpenGoalsPrompt,
	untrustedObjectiveBlock,
} from "./prompts/goal-prompts.ts";
import { buildGoalRunningNotification } from "./widgets/goal-notifications.ts";
import { GoalWidgetComponent } from "./widgets/goal-widget.ts";

import {
	abortGoalCommandMessage,
	buildAbortedByAgentGoal,
	buildCompletionReport,
	buildGoalCreatedReport,
	buildPausedByAgentGoal,
	clearGoalCommandMessage,
	shouldArmPostCompactReminder,
	shouldInjectPostCompactReminder,
	validateGoalAbort,
	validateGoalCompletion,
	validatePauseGoal,
	validateResumeGoal,
} from "./goal-policy.ts";

const GOAL_STATE_ENTRY = "pi-goal-state";
const GOAL_FOCUS_ENTRY = "pi-goal-focus";
const GOAL_EVENT_ENTRY = "pi-goal-event";
const GOAL_AUDIT_ENTRY = "pi-goal-audit-event";
const GOALS_TABLE = "goal";  // customType for goal persistence
const COMPLETE_STATUS = "complete";
const CONTINUATION_IDLE_RETRY_MS = 50;
const STATUS_REFRESH_MS = 1000;

const GOAL_PROGRESS_TOOL_SET = new Set<string>(GOAL_PROGRESS_TOOL_NAMES);
const POST_STOP_ALLOWED_TOOL_SET = new Set<string>(POST_STOP_ALLOWED_TOOLS);

let tweakDraftingFor: string | null = null;

interface GoalConfirmationIntent {
	focus: GoalDraftingFocus;
	originalTopic: string;
	startedAt: number;
}
let confirmationIntent: GoalConfirmationIntent | null = null;

// ---------- summaries ----------

function usageLines(goal: GoalRecord): string[] {
	return [
		`Time spent: ${formatDuration(goal.usage.activeSeconds)}`,
		`Tokens used: ${formatTokenValue(goal.usage.tokensUsed)}`,
	];
}

function detailedSummary(goal: GoalRecord | null): string {
	if (!goal) return "No goal is set. Use /goals <topic> or /sisyphus <topic> to discuss, or /goals-set <objective> / /sisyphus-set <objective> to start immediately.";
	const lines = [
		`Goal: ${goal.objective}`,
		`Status: ${statusLabel(goal)}`,
		`Auto-continue: ${goal.autoContinue ? "on" : "off"}`,
		...usageLines(goal),
	];
	if (goal.sisyphus) {
		lines.push("Mode: Sisyphus (prompt/criteria variant; shared goal lifecycle)");
	}
	if (goal.stopReason) lines.push(`Stop reason: ${goal.stopReason}`);
	if (goal.pauseReason) lines.push(`Agent pause reason: ${goal.pauseReason}`);
	if (goal.pauseSuggestedAction) lines.push(`Agent suggests: ${goal.pauseSuggestedAction}`);
	return lines.join("\n");
}

function oneLineSummary(goal: GoalRecord | null): string {
	if (!goal) return "No goal is set.";
	const tail = goal.usage.tokensUsed > 0 ? ` [${formatTokenValue(goal.usage.tokensUsed).split(" ")[0]}]` : "";
	return `${statusLabel(goal)}${tail} - ${truncateText(goal.objective)}`;
}

function goalDetails(goal: GoalRecord | null): GoalStateEntry {
	return { version: 3, goal: goal ? cloneGoal(goal) : null };
}

function renderGoalResult(result: { details?: unknown; content: Array<{ type: string; text?: string }> }, theme: Theme): Text {
	const first = result.content.find((item) => item.type === "text" && typeof item.text === "string");
	const firstText = first?.text ?? "";
	const details = result.details as GoalStateEntry | undefined;
	if (!details || typeof details !== "object" || !("goal" in details)) {
		return new Text(firstText, 0, 0);
	}
	if (
		firstText.startsWith("Goal audit ")
		|| firstText.startsWith("Goal completion rejected")
		|| firstText.startsWith("Goal complete.")
		|| firstText.startsWith("Goal paused.")
		|| firstText.startsWith("Goal aborted.")
		|| firstText.startsWith("Goal confirmed and created.")
	) {
		return new Text(firstText, 0, 0);
	}
	return new Text(theme.fg("accent", "Goal ") + theme.fg("muted", oneLineSummary(details.goal)), 0, 0);
}

function normalizeGoalEventDetails(value: unknown): GoalEventDetails {
	const raw = asRecord(value);
	const kind = raw?.kind === "stale" ? "stale" : raw?.kind === "drafting" ? "drafting" : "checkpoint";
	const goalId = typeof raw?.goalId === "string" ? raw.goalId : "unknown";
	const focus: DraftingFocus | undefined = raw?.focus === "sisyphus" ? "sisyphus" : raw?.focus === "goal" ? "goal" : undefined;
	const status = raw?.status === "active" || raw?.status === "paused" || raw?.status === "complete" ? (raw.status as GoalStatus) : undefined;
	const currentStatus =
		raw?.currentStatus === "active" || raw?.currentStatus === "paused" || raw?.currentStatus === "complete"
			? (raw.currentStatus as GoalStatus)
			: raw?.currentStatus === null
				? null
				: undefined;
	return {
		kind,
		goalId,
		status,
		objective: typeof raw?.objective === "string" ? raw.objective : undefined,
		timestamp: typeof raw?.timestamp === "number" ? raw.timestamp : undefined,
		currentGoalId: typeof raw?.currentGoalId === "string" || raw?.currentGoalId === null ? raw.currentGoalId : undefined,
		currentStatus,
		focus,
	};
}

interface GoalAuditEventDetails {
	phase: "started" | "approved" | "rejected";
	goalId: string;
	auditor?: string;
}

function renderGoalEvent(message: { details?: GoalEventDetails }, options: { expanded: boolean }, theme: Theme): Text {
	const details = normalizeGoalEventDetails(message.details);
	const label =
		details.kind === "stale" ? "stale checkpoint"
			: details.kind === "drafting" ? (details.focus === "sisyphus" ? "sisyphus drafting" : "goal drafting")
				: "checkpoint";
	if (!options.expanded) {
		return new Text(theme.fg("customMessageLabel", "Goal ") + theme.fg("customMessageText", label), 0, 0);
	}
	const lines = [`Status: ${details.status === "active" ? "running" : details.status ?? "unknown"}`];
	if (details.objective) lines.push(`Objective: ${details.objective}`);
	lines.push(`Goal id: ${details.goalId}`);
	if (details.currentGoalId || details.currentStatus) {
		lines.push(`Current: ${details.currentGoalId ?? "none"}${details.currentStatus ? ` (${details.currentStatus})` : ""}`);
	}
	return new Text(
		theme.fg("customMessageLabel", `Goal ${label}`) + "\n" + theme.fg("customMessageText", lines.join("\n")),
		0,
		0,
	);
}

function renderGoalAuditEvent(message: { content?: unknown; details?: GoalAuditEventDetails }, _options: { expanded: boolean }, theme: Theme): Text {
	const phase = message.details?.phase ?? "started";
	const label = phase === "approved" ? "approved" : phase === "rejected" ? "rejected" : "started";
	const content = typeof message.content === "string" ? message.content : `Goal audit ${label}.`;
	return new Text(
		theme.fg("customMessageLabel", `Goal audit ${label}`) + "\n" + theme.fg("customMessageText", content),
		0,
		0,
	);
}

function extractGoalIdFromInjectedMessage(text: string): string | null {
	if (/^\[GOAL (?:DRAFTING|TWEAK DRAFTING)\b/.test(text)) return null;
	const xmlMatch = text.match(/^<pi_goal_continuation\s+goal_id=\"([^\"]+)\"/);
	if (xmlMatch) return xmlMatch[1] ?? null;
	const match = text.match(/^\[(?:GOAL CHECKPOINT|GOAL CONTINUATION|GOAL STALE) goalId=([^\]\s]+)\]/);
	return match?.[1] ?? null;
}

function goalEventMessageId(message: { customType?: string; details?: unknown; content?: unknown }): string | null {
	if (message.customType !== GOAL_EVENT_ENTRY) return null;
	const details = asRecord(message.details);
	if (details?.kind === "drafting") return null;
	const goalId = details && typeof details.goalId === "string" ? details.goalId : null;
	if (goalId) return goalId;
	return typeof message.content === "string" ? extractGoalIdFromInjectedMessage(message.content) : null;
}

function isAbortedAssistantMessage(message: unknown): boolean {
	const raw = asRecord(message);
	return raw?.role === "assistant" && raw.stopReason === "aborted";
}

function isToolUseAssistantMessage(message: unknown): boolean {
	const raw = asRecord(message);
	return raw?.role === "assistant" && raw.stopReason === "toolUse";
}

function hasAbortedAssistantMessage(messages: unknown[]): boolean {
	return messages.some(isAbortedAssistantMessage);
}

function usageChannelTokens(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}

function assistantTurnTokens(message: unknown): number {
	const raw = asRecord(message);
	if (!raw || raw.role !== "assistant") return 0;
	const usage = asRecord(raw.usage);
	if (!usage) return 0;
	return usageChannelTokens(usage.input) + usageChannelTokens(usage.output);
}

function isMeaningfulProgressToolCall(toolName: string, args: unknown): boolean {
	if (!GOAL_PROGRESS_TOOL_SET.has(toolName)) return false;
	if (toolName === "read") {
		const path = asRecord(args)?.path;
		if (typeof path === "string" && (path === ".pi/goals" || path.startsWith(".pi/goals/"))) return false;
	}
	if (toolName === "bash") {
		const command = asRecord(args)?.command;
		if (typeof command === "string" && /^\s*echo\b/.test(command)) return false;
	}
	return true;
}

// ---------- extension entry point ----------

export default function goalExtension(pi: ExtensionAPI): void {
	let goalsById = new Map<string, GoalRecord>();
	let focusedGoalId: string | null = null;
	const state = {
		get goal(): GoalRecord | null {
			return focusedGoalFromPool(goalsById, focusedGoalId);
		},
		set goal(next: GoalRecord | null) {
			if (next) {
				goalsById.set(next.id, next);
				focusedGoalId = next.id;
				return;
			}
			if (focusedGoalId) goalsById.delete(focusedGoalId);
			focusedGoalId = null;
		},
	};
	let continuationQueuedFor: string | null = null;
	let continuationScheduledFor: string | null = null;
	let continuationTimer: ReturnType<typeof setTimeout> | null = null;
	let runningGoalId: string | null = null;
	let terminalInputUnsubscribe: (() => void) | null = null;
	let statusRefreshTimer: ReturnType<typeof setInterval> | null = null;
	let statusRefreshCtx: ExtensionContext | null = null;

	let goalWorkToolCalledThisTurn = false;
	let turnStoppedFor: string | null = null;
	let postCompactReminderPending = false;

	const accounting = {
		activeGoalId: null as string | null,
		lastAccountedAt: null as number | null,
	};

	const draftingHiddenWorkTools = [
		"bash",
		"read",
		"write",
		"edit",
		"grep",
		"find",
		"ls",
		SISYPHUS_STEP_TOOL_NAME,
		TWEAK_APPLY_TOOL_NAME,
		CREATE_GOAL_TOOL_NAME,
	] as const;
	const goalExecutionWorkTools = ["read", "bash", "edit", "write"] as const;

	function syncGoalTools(): void {
		try {
			const active = new Set(pi.getActiveTools());
			for (const name of goalExecutionWorkTools) active.add(name);
			active.delete(QUESTION_TOOL_NAME);
			active.delete(QUESTIONNAIRE_TOOL_NAME);
			for (const name of ACTIVE_GOAL_TOOL_NAMES) active.delete(name);
			const phase = confirmationIntent !== null ? "drafting" : tweakDraftingFor !== null ? "tweakDrafting" : "normal";
			const lifecycleTools = lifecycleToolNamesForGoalStatus(state.goal?.status, phase);
			for (const name of lifecycleTools) active.add(name);
			active.delete(SISYPHUS_STEP_TOOL_NAME);
			if (state.goal && tweakDraftingFor === state.goal.id) {
				active.add(TWEAK_APPLY_TOOL_NAME);
				active.add(QUESTION_TOOL_NAME);
				active.add(QUESTIONNAIRE_TOOL_NAME);
			} else {
				active.delete(TWEAK_APPLY_TOOL_NAME);
			}
			active.add(PROPOSE_DRAFT_TOOL_NAME);
			active.delete(CREATE_GOAL_TOOL_NAME);
			if (confirmationIntent !== null) {
				active.add(QUESTION_TOOL_NAME);
				active.add(QUESTIONNAIRE_TOOL_NAME);
			} else if (state.goal?.status === "active") {
				for (const name of goalExecutionWorkTools) active.add(name);
			}
			pi.setActiveTools(Array.from(active));
		} catch {}
	}

	function stopStatusRefresh(): void {
		if (statusRefreshTimer) {
			clearInterval(statusRefreshTimer);
			statusRefreshTimer = null;
		}
		statusRefreshCtx = null;
	}

	function syncStatusRefresh(ctx: ExtensionContext): void {
		if (!ctx.hasUI || state.goal?.status !== "active") {
			stopStatusRefresh();
			return;
		}
		statusRefreshCtx = ctx;
		if (statusRefreshTimer) return;
		statusRefreshTimer = setInterval(() => {
			if (!statusRefreshCtx || state.goal?.status !== "active") {
				stopStatusRefresh();
				return;
			}
			const displayGoal = goalForDisplay();
			if (displayGoal) {
				const otherCount = otherOpenGoalCount(goalsById, focusedGoalId);
				statusRefreshCtx.ui.setStatus("goal", `${footerStatus(displayGoal)}${otherCount > 0 ? ` (+${otherCount} open)` : ""}`);
			}
			goalWidgetComponent?.update();
		}, STATUS_REFRESH_MS);
		statusRefreshTimer.unref?.();
	}

	function clearContinuationTimer(): void {
		if (continuationTimer) {
			clearTimeout(continuationTimer);
			continuationTimer = null;
		}
		continuationScheduledFor = null;
	}

	function clearContinuationState(): void {
		clearContinuationTimer();
		continuationQueuedFor = null;
	}

	function clearActiveAccounting(): void {
		accounting.activeGoalId = null;
		accounting.lastAccountedAt = null;
	}

	function clearStoppedRuntimeState(): void {
		clearContinuationState();
		clearActiveAccounting();
	}

	const activeGetGoalTurnsByGoalId = new Map<string, number>();

	function resetGetGoalNudgeState(goalId: string | null | undefined): void {
		if (goalId) {
			activeGetGoalTurnsByGoalId.delete(goalId);
		}
	}

	function openGoals(): GoalRecord[] {
		return openGoalsFromPool(goalsById);
	}

	function reconcileFocusedGoalFromSession(ctx: ExtensionContext, opts: { preserveMemoryUsage?: boolean } = {}): boolean {
		const current = state.goal;
		const fresh = getGoalsFromSession(ctx);
		if (!focusedGoalId) {
			goalsById = fresh;
			return true;
		}
		const sessionGoal = fresh.get(focusedGoalId) ?? null;
		if (!sessionGoal) {
			if (current) {
				goalsById = fresh;
				goalsById.set(current.id, current);
				focusedGoalId = current.id;
				return true;
			}
			goalsById = fresh;
			focusedGoalId = null;
			clearStoppedRuntimeState();
			resetGetGoalNudgeState(focusedGoalId);
			if (tweakDraftingFor !== null) tweakDraftingFor = null;
			syncGoalTools();
			updateUI(ctx);
			return false;
		}
		const reconciled = current && opts.preserveMemoryUsage
			? { ...current, usage: { ...current.usage } }
			: sessionGoal;
		goalsById = fresh;
		goalsById.set((reconciled as GoalRecord).id, reconciled as GoalRecord);
		focusedGoalId = (reconciled as GoalRecord).id;
		if (reconciled.status !== "active" || !reconciled.autoContinue) clearContinuationState();
		if (reconciled.status !== "active") clearActiveAccounting();
		return true;
	}

	// Local append functions using pi.appendEntry (replaces file-based storage)
	function appendFocusEntry(ctx: ExtensionContext, goalId: string | null, reason: GoalFocusReason): void {
		pi.appendEntry(GOAL_FOCUS_ENTRY, goalFocusDetails(goalId, reason));
	}

	function appendStateEntry(ctx: ExtensionContext, goal: GoalRecord | null): void {
		pi.appendEntry(GOAL_STATE_ENTRY, buildStateEntry(goal));
	}

	function appendGoalEvent(ctx: ExtensionContext, event: GoalLedgerEvent): void {
		pi.appendEntry(GOAL_EVENT_ENTRY, event);
	}

	function persistGoalsToSession(ctx: ExtensionContext, goals: Map<string, GoalRecord>): void {
		for (const goal of goals.values()) {
			if (goal.status !== "complete") {
				pi.appendEntry(GOALS_TABLE, goal);
			}
		}
	}

	function setFocusedGoalId(goalId: string | null, ctx: ExtensionContext, reason: GoalFocusReason): void {
		const previousGoalId = focusedGoalId;
		focusedGoalId = goalId && goalsById.has(goalId) ? goalId : null;
		if (previousGoalId !== focusedGoalId) {
			clearContinuationState();
			clearActiveAccounting();
			resetGetGoalNudgeState(previousGoalId);
			resetGetGoalNudgeState(focusedGoalId);
			if (tweakDraftingFor !== null && tweakDraftingFor !== focusedGoalId) tweakDraftingFor = null;
		}
		appendFocusEntry(ctx, focusedGoalId, reason);
		try {
			if (focusedGoalId) {
				appendGoalEvent(ctx, { type: "goal_focused", goalId: focusedGoalId, reason, at: nowIso() });
			} else if (previousGoalId) {
				appendGoalEvent(ctx, { type: "goal_unfocused", reason, at: nowIso() });
			}
		} catch {}
		syncGoalTools();
		updateUI(ctx);
	}

	function updateFocusedGoal(next: GoalRecord, ctx: ExtensionContext, shouldPersist = true): void {
		const previousGoalId = focusedGoalId;
		goalsById.set(next.id, next);
		focusedGoalId = next.id;
		if (previousGoalId !== focusedGoalId) {
			resetGetGoalNudgeState(previousGoalId);
			resetGetGoalNudgeState(focusedGoalId);
		}
		if (shouldPersist) persist(ctx);
		else syncGoalTools();
		updateUI(ctx);
	}

	function armFocusedContinuation(ctx: ExtensionContext): void {
		beginAccounting();
		if (state.goal?.status === "active" && state.goal.autoContinue) queueContinuation(ctx, true);
	}

	function removeFocusedGoal(ctx: ExtensionContext, reason: GoalFocusReason): void {
		const previousGoalId = focusedGoalId;
		if (focusedGoalId) goalsById.delete(focusedGoalId);
		focusedGoalId = null;
		clearStoppedRuntimeState();
		resetGetGoalNudgeState(previousGoalId);
		appendFocusEntry(ctx, null, reason);
		syncGoalTools();
		updateUI(ctx);
	}

	function beginAccounting(): void {
		if (confirmationIntent !== null || tweakDraftingFor !== null) {
			clearActiveAccounting();
			return;
		}
		if (!state.goal || (state.goal.status !== "active")) {
			clearActiveAccounting();
			return;
		}
		accounting.activeGoalId = state.goal.id;
		accounting.lastAccountedAt = Date.now();
	}

	function goalForDisplay(): GoalRecord | null {
		if (!state.goal || state.goal.status !== "active" || accounting.activeGoalId !== state.goal.id || accounting.lastAccountedAt === null) {
			return state.goal;
		}
		const liveSeconds = Math.max(0, Math.floor((Date.now() - accounting.lastAccountedAt) / 1000));
		if (liveSeconds === 0) return state.goal;
		const live = cloneGoal(state.goal);
		live.usage.activeSeconds += liveSeconds;
		return live;
	}

	function accountProgress(ctx: ExtensionContext, opts: { completedTurnTokens?: number } = {}): void {
		if (confirmationIntent !== null || tweakDraftingFor !== null) {
			clearActiveAccounting();
			return;
		}
		if (!state.goal || state.goal.status !== "active" || accounting.activeGoalId !== state.goal.id) {
			beginAccounting();
			return;
		}

		const now = Date.now();
		const elapsedSeconds = accounting.lastAccountedAt === null ? 0 : Math.floor((now - accounting.lastAccountedAt) / 1000);
		accounting.lastAccountedAt = now;

		const tokens = Math.max(0, Math.trunc(opts.completedTurnTokens ?? 0));
		if (tokens === 0 && elapsedSeconds === 0) return;

		const next = cloneGoal(state.goal);
		next.usage.tokensUsed += tokens;
		next.usage.activeSeconds += elapsedSeconds;
		next.updatedAt = nowIso();
		state.goal = next;
		persist(ctx);
	}

	function persist(ctx?: ExtensionContext): void {
		const current = state.goal;
		if (current) {
			state.goal = { ...current, updatedAt: nowIso() };
		}
		if (ctx) {
			// Persist all goals to session
			persistGoalsToSession(ctx, goalsById);
			// Also append state entry for focused goal
			appendStateEntry(ctx, state.goal);
		}
		pi.appendEntry(GOAL_STATE_ENTRY, goalDetails(state.goal));
		syncGoalTools();
		if (ctx) updateUI(ctx);
	}

	// Widget management
	const GOAL_WIDGET_KEY = "goal";
	let widgetRegistered = false;
	let goalWidgetComponent: GoalWidgetComponent | null = null;

	function clearGoalWidget(ctx: ExtensionContext): void {
		ctx.ui.setStatus("goal", undefined);
		ctx.ui.setWidget(GOAL_WIDGET_KEY, undefined);
		widgetRegistered = false;
		goalWidgetComponent = null;
	}

	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const totalOpen = openGoals().length;
		if (!state.goal && totalOpen === 0) {
			clearGoalWidget(ctx);
			stopStatusRefresh();
			return;
		}
		if (!state.goal) {
			ctx.ui.setStatus("goal", `goal: unfocused [${totalOpen} open] - /goal-focus`);
			if (!widgetRegistered) {
				ctx.ui.setWidget(
					GOAL_WIDGET_KEY,
					(tui, theme) => {
						goalWidgetComponent = new GoalWidgetComponent({
							tui,
							theme,
							getGoal: () => goalForDisplay() ?? state.goal,
							getOpenGoalCount: () => openGoals().length,
						});
						return goalWidgetComponent;
					},
					{ placement: "aboveEditor" },
				);
				widgetRegistered = true;
			} else {
				goalWidgetComponent?.update();
			}
			stopStatusRefresh();
			return;
		}

		const displayGoal = goalForDisplay() ?? state.goal;
		const otherCount = otherOpenGoalCount(goalsById, focusedGoalId);
		ctx.ui.setStatus("goal", `${footerStatus(displayGoal)}${otherCount > 0 ? ` (+${otherCount} open)` : ""}`);

		if (!widgetRegistered) {
			ctx.ui.setWidget(
				GOAL_WIDGET_KEY,
				(tui, theme) => {
					goalWidgetComponent = new GoalWidgetComponent({
						tui,
						theme,
						getGoal: () => goalForDisplay() ?? state.goal,
						getOpenGoalCount: () => openGoals().length,
					});
					return goalWidgetComponent;
				},
				{ placement: "aboveEditor" },
			);
			widgetRegistered = true;
		} else {
			goalWidgetComponent?.update();
		}

		if (state.goal.status === "complete") {
			stopStatusRefresh();
		} else {
			syncStatusRefresh(ctx);
		}
	}

	function loadState(ctx: ExtensionContext): void {
		goalsById = getGoalsFromSession(ctx);
		focusedGoalId = resolveSessionFocusFromEntries(goalsById, ctx);
		if (!focusedGoalId) {
			const { focusedGoalId: fId } = getFocusEntryFromSession(ctx);
			if (fId && goalsById.has(fId)) {
				focusedGoalId = fId;
				appendFocusEntry(ctx, focusedGoalId, "migrated");
			}
		}
		for (const [id, current] of goalsById) {
			if (current.status === "complete") {
				goalsById.delete(id);
			}
		}
		clearStoppedRuntimeState();
		runningGoalId = null;
		syncGoalTools();
		updateUI(ctx);
	}

	function setGoal(next: GoalRecord | null, ctx: ExtensionContext, shouldPersist = true, focusReason?: GoalFocusReason): void {
		const previousGoalId = state.goal?.id ?? null;
		state.goal = next;
		const focusChanged = previousGoalId !== focusedGoalId;
		if (focusChanged) {
			clearContinuationState();
			clearActiveAccounting();
			resetGetGoalNudgeState(previousGoalId);
			resetGetGoalNudgeState(focusedGoalId);
		}
		if (focusReason && focusChanged) appendFocusEntry(ctx, focusedGoalId, focusReason);
		if (!state.goal || (state.goal.status !== "active") || !state.goal.autoContinue) {
			clearContinuationState();
		}
		if (!state.goal || state.goal.status === "paused" || state.goal.status === "complete") {
			clearActiveAccounting();
		}
		if (!state.goal || state.goal.id !== previousGoalId) {
			if (tweakDraftingFor !== null && tweakDraftingFor !== state.goal?.id) tweakDraftingFor = null;
		}
		if (shouldPersist) persist(ctx);
		else syncGoalTools();
		updateUI(ctx);
	}

	function stopActiveGoal(status: Exclude<GoalStatus, "active">, reason: StopReason | undefined, ctx: ExtensionContext): void {
		if (!state.goal) return;
		let next = { ...state.goal, status, stopReason: reason, updatedAt: nowIso() };
		setGoal(next, ctx);
		if (status === "paused") {
			try {
				appendGoalEvent(ctx, {
					type: "goal_paused",
					goalId: next.id,
					reason: reason ?? "unknown",
					suggestedAction: next.pauseSuggestedAction,
					status,
					at: next.updatedAt,
				});
			} catch {}
		}
	}

	function pauseActiveGoal(ctx: ExtensionContext): void {
		if (!state.goal || state.goal.status !== "active") return;
		const pausedGoalId = state.goal.id;
		state.goal = { ...state.goal, autoContinue: false, pauseReason: undefined, pauseSuggestedAction: undefined };
		stopActiveGoal("paused", "user", ctx);
		resetGetGoalNudgeState(pausedGoalId);
		ctx.ui.notify("Goal paused.", "info");
	}

	function syncTerminalInputPause(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		terminalInputUnsubscribe?.();
		terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
			if (matchesKey(data, "escape") && state.goal?.status === "active" && state.goal.autoContinue) {
				pauseActiveGoal(ctx);
			}
			return undefined;
		});
	}

	function sendQueuedContinuation(ctx: ExtensionContext, goalId: string): void {
		continuationTimer = null;
		continuationScheduledFor = null;
		syncGoalTools();
		if (!state.goal || state.goal.id !== goalId || state.goal.status !== "active" || !state.goal.autoContinue) {
			if (continuationQueuedFor === goalId) continuationQueuedFor = null;
			return;
		}

		let ready: boolean;
		try {
			ready = !ctx.hasPendingMessages() && ctx.isIdle();
		} catch {
			if (continuationQueuedFor === goalId) continuationQueuedFor = null;
			return;
		}

		if (!ready) {
			continuationScheduledFor = goalId;
			continuationTimer = setTimeout(() => sendQueuedContinuation(ctx, goalId), CONTINUATION_IDLE_RETRY_MS);
			continuationTimer.unref?.();
			return;
		}
		continuationQueuedFor = goalId;
		pi.sendMessage<GoalEventDetails>(
			{
				customType: GOAL_EVENT_ENTRY,
				content: continuationPrompt(state.goal),
				display: false,
				details: {
					kind: "checkpoint",
					goalId: state.goal.id,
					status: state.goal.status,
					objective: state.goal.objective,
					timestamp: Date.now(),
				},
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function queueContinuation(ctx: ExtensionContext, force = false): void {
		if (confirmationIntent !== null || tweakDraftingFor !== null) return;
		if (!state.goal || state.goal.status !== "active" || !state.goal.autoContinue) return;
		const goalId = state.goal.id;
		if (!force && (continuationQueuedFor === goalId || continuationScheduledFor === goalId)) return;
		clearContinuationTimer();
		let delay = CONTINUATION_IDLE_RETRY_MS;
		try {
			delay = ctx.isIdle() && !ctx.hasPendingMessages() ? 0 : CONTINUATION_IDLE_RETRY_MS;
		} catch {
			return;
		}
		continuationScheduledFor = goalId;
		continuationTimer = setTimeout(() => sendQueuedContinuation(ctx, goalId), delay);
		continuationTimer.unref?.();
	}

	function replaceGoal(config: GoalCreationConfig, ctx: ExtensionContext, startNow = true): void {
		setGoal(createGoal(config), ctx, true, "created");
		beginAccounting();
		resetGetGoalNudgeState(state.goal?.id);
		confirmationIntent = null;
		ctx.ui.notify(buildGoalRunningNotification(config), "info");
		if (startNow && state.goal?.autoContinue) queueContinuation(ctx, true);
		const created = state.goal;
		if (created) {
			try {
				appendGoalEvent(ctx, {
					type: "goal_created",
					goalId: created.id,
					objective: created.objective,
					sisyphus: created.sisyphus,
					autoContinue: created.autoContinue,
					at: created.createdAt,
				});
			} catch {}
		}
	}

	async function startGoalTweakDrafting(hint: string, ctx: ExtensionContext): Promise<void> {
		reconcileFocusedGoalFromSession(ctx);
		clearContinuationState();
		clearActiveAccounting();
		if (!state.goal) {
			if (openGoals().length > 0) {
				const selected = await chooseOpenGoal(ctx, "Tweak which open goal?");
				if (!selected) return;
			} else {
				ctx.ui.notify("No goal is set. Use /goals or /sisyphus to discuss, or /goals-set / /sisyphus-set to start immediately.", "warning");
				return;
			}
		}
		const currentGoal = state.goal;
		if (!currentGoal) return;
		if (currentGoal.status === "complete") {
			ctx.ui.notify("Goal is complete. Use /goals to discuss a new one or /goals-set to start immediately.", "warning");
			return;
		}
		persist(ctx);
		const trimmed = hint.trim();
		const focused = state.goal;
		if (!focused) return;
		const sisyphusOn = focused.sisyphus;
		const label = sisyphusOn ? "Sisyphus tweak drafting" : "Goal tweak drafting";
		tweakDraftingFor = focused.id;
		syncGoalTools();
		ctx.ui.notify(
			`${label} started${trimmed ? `: ${truncateText(trimmed, 60)}` : ""}. The agent will interview you and then call apply_goal_tweak.`,
			"info",
		);
		const draftId = `tweak-${focused.id}-${Date.now().toString(36)}`;
		try {
			pi.sendMessage<GoalEventDetails>(
				{
					customType: GOAL_EVENT_ENTRY,
					content: goalTweakDraftingPrompt(focused, trimmed),
					display: false,
					details: {
						kind: "drafting",
						goalId: draftId,
						objective: trimmed,
						focus: sisyphusOn ? "sisyphus" : "goal",
						timestamp: Date.now(),
					},
				},
				{ triggerTurn: true, deliverAs: ctx.isIdle() ? "followUp" : "steer" },
			);
		} catch (err) {
			tweakDraftingFor = null;
			syncGoalTools();
			ctx.ui.notify(`Could not start goal tweak: ${(err as Error).message}`, "error");
		}
	}

	function startGoalDrafting(topic: string, focus: DraftingFocus, ctx: ExtensionContext): void {
		clearContinuationState();
		clearActiveAccounting();
		const trimmed = topic.trim();
		const label = focus === "sisyphus" ? "Sisyphus intent discussion" : "Goal intent discussion";
		const hint = focus === "sisyphus"
			? "The agent will research or grill the ordered plan as needed, then propose a draft for you to Confirm. No skipping, no rushing."
			: "The agent will clarify, research, or grill assumptions as needed, then propose a draft for you to Confirm.";
		ctx.ui.notify(
			`${label} started${trimmed ? `: ${truncateText(trimmed, 60)}` : ""}. ${hint}`,
			"info",
		);

		confirmationIntent = {
			focus,
			originalTopic: trimmed,
			startedAt: Date.now(),
		};
		syncGoalTools();
		try {
			pi.sendUserMessage(goalDraftingPrompt(trimmed, focus), { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
		} catch (err) {
			ctx.ui.notify(`Could not start ${label.toLowerCase()}: ${(err as Error).message}`, "error");
		}
	}

	async function chooseOpenGoal(ctx: ExtensionContext, title: string): Promise<GoalRecord | null> {
		reconcileFocusedGoalFromSession(ctx);
		if (state.goal && state.goal.status !== "complete") return state.goal;
		const open = openGoals();
		if (open.length === 0) return null;
		if (open.length === 1) {
			const only = open[0];
			if (!only) return null;
			setFocusedGoalId(only.id, ctx, "selected");
			return state.goal;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(buildUnfocusedOpenGoalsSummary(open.length), "warning");
			return null;
		}
		const labels = open.map((item) => goalSelectorLabel(item, focusedGoalId));
		const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
		const selected = await ctx.ui.select(title, labels);
		const selectedId = selected ? byLabel.get(selected) : undefined;
		if (!selectedId) {
			ctx.ui.notify("Goal focus unchanged.", "info");
			return null;
		}
		setFocusedGoalId(selectedId, ctx, "selected");
		return state.goal;
	}

	async function focusGoalCommand(ctx: ExtensionContext): Promise<void> {
		const open = openGoals();
		if (open.length === 0) {
			ctx.ui.notify("No open goals. Use /goals or /sisyphus to discuss, or /goals-set / /sisyphus-set to start immediately.", "warning");
			return;
		}
		if (open.length === 1) {
			const only = open[0];
			if (!only) return;
			setFocusedGoalId(only.id, ctx, "selected");
			armFocusedContinuation(ctx);
			ctx.ui.notify(`Focused goal: ${oneLineSummary(only)}`, "info");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(buildGoalListText(goalsById, focusedGoalId), "info");
			return;
		}
		const labels = open.map((item) => goalSelectorLabel(item, focusedGoalId));
		const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
		const selected = await ctx.ui.select("Focus open goal", labels);
		const selectedId = selected ? byLabel.get(selected) : undefined;
		if (!selectedId) {
			ctx.ui.notify("Goal focus unchanged.", "info");
			return;
		}
		setFocusedGoalId(selectedId, ctx, "selected");
		armFocusedContinuation(ctx);
		ctx.ui.notify(`Focused goal: ${oneLineSummary(state.goal)}`, "info");
	}

	async function handleGoalCommandTopic(rawTopic: string, ctx: ExtensionContext, focus: DraftingFocus, opts: { replace: boolean }): Promise<void> {
		const topic = rawTopic.trim();
		if (opts.replace) {
			const replacementTarget = await chooseOpenGoal(ctx, "Replace which open goal?");
			if (openGoals().length > 0 && !replacementTarget) return;
			setGoal(null, ctx, true, "cleared");
		}
		startGoalDrafting(topic, focus, ctx);
	}

	function handleDirectGoalSet(rawObjective: string, ctx: ExtensionContext, focus: DraftingFocus): void {
		const objective = rawObjective.trim();
		if (!objective) {
			const command = focus === "sisyphus" ? "/sisyphus-set" : "/goals-set";
			ctx.ui.notify(`No objective provided. Use ${command} <objective>.`, "warning");
			return;
		}
		clearContinuationState();
		clearActiveAccounting();
		confirmationIntent = null;
		syncGoalTools();
		replaceGoal({ objective, autoContinue: true, sisyphus: focus === "sisyphus" }, ctx, true);
	}

	async function showGoalStatus(ctx: ExtensionContext): Promise<void> {
		reconcileFocusedGoalFromSession(ctx);
		const view = goalForDisplay() ?? state.goal;
		const otherCount = otherOpenGoalCount(goalsById, focusedGoalId);
		const extra = view && otherCount > 0 ? `\nOther open goals: ${otherCount} (run /goal-list or /goal-focus)` : "";
		const text = view ? `${detailedSummary(view)}${extra}` : openGoals().length > 0 ? buildUnfocusedOpenGoalsSummary(openGoals().length) : detailedSummary(null);
		ctx.ui.notify(text, "info");
		updateUI(ctx);
	}

	async function handleGoalPause(ctx: ExtensionContext): Promise<void> {
		reconcileFocusedGoalFromSession(ctx);
		if (!state.goal) {
			if (openGoals().length > 0) {
				const selected = await chooseOpenGoal(ctx, "Pause which open goal?");
				if (!selected) return;
			} else {
				ctx.ui.notify("No goal is set.", "warning");
				return;
			}
		}
		const currentGoal = state.goal;
		if (!currentGoal) return;
		if (currentGoal.status === "complete") {
			ctx.ui.notify("Goal is complete.", "warning");
			return;
		}
		if (currentGoal.status === "paused") {
			ctx.ui.notify("Goal is already paused. Use /goal-resume to continue.", "info");
			return;
		}
		pauseActiveGoal(ctx);
	}

	async function handleGoalResume(ctx: ExtensionContext): Promise<void> {
		reconcileFocusedGoalFromSession(ctx);
		if (!state.goal && openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Resume or focus open goal");
			if (!selected) return;
			if (selected.status === "active") {
				armFocusedContinuation(ctx);
				ctx.ui.notify(`Goal focused: ${oneLineSummary(selected)}`, "info");
				return;
			}
		}
		const resumeGate = validateResumeGoal(state.goal);
		if (!resumeGate.ok) {
			const level = resumeGate.message.includes("already running") ? "info" : "warning";
			ctx.ui.notify(resumeGate.message, level);
			return;
		}
		if (!state.goal) throw new Error("Goal disappeared during resume validation.");
		setGoal(
			{
				...state.goal,
				status: "active",
				autoContinue: true,
				stopReason: undefined,
				pauseReason: undefined,
				pauseSuggestedAction: undefined,
			},
			ctx,
		);
		beginAccounting();
		resetGetGoalNudgeState(state.goal.id);
		ctx.ui.notify("Goal resumed.", "info");
		queueContinuation(ctx, true);
		try {
			appendGoalEvent(ctx, {
				type: "goal_resumed",
				goalId: state.goal.id,
				reason: "user",
				at: nowIso(),
			});
		} catch {}
	}

	async function handleGoalClear(ctx: ExtensionContext): Promise<void> {
		if (confirmationIntent !== null || tweakDraftingFor !== null) {
			confirmationIntent = null;
			tweakDraftingFor = null;
			syncGoalTools();
			updateUI(ctx);
			ctx.ui.notify(clearGoalCommandMessage({ archived: false, wasDrafting: true }), "info");
			return;
		}
		reconcileFocusedGoalFromSession(ctx);
		if (!state.goal && openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Clear which open goal?");
			if (!selected) return;
		}
		resetGetGoalNudgeState(state.goal?.id);
		setGoal(null, ctx, true, "cleared");
		const wasDrafting = confirmationIntent !== null;
		confirmationIntent = null;
		syncGoalTools();
		const msg = clearGoalCommandMessage({ archived: false, wasDrafting });
		ctx.ui.notify(msg, wasDrafting ? "info" : "warning");
	}

	async function handleGoalAbort(ctx: ExtensionContext): Promise<void> {
		if (confirmationIntent !== null || tweakDraftingFor !== null) {
			confirmationIntent = null;
			tweakDraftingFor = null;
			syncGoalTools();
			updateUI(ctx);
			ctx.ui.notify(abortGoalCommandMessage({ archived: false, wasDrafting: true }), "info");
			return;
		}
		reconcileFocusedGoalFromSession(ctx);
		if (!state.goal && openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Abort which open goal?");
			if (!selected) return;
		}
		const abortedGoalId = state.goal?.id;
		resetGetGoalNudgeState(state.goal?.id);
		setGoal(null, ctx, true, "aborted");
		const wasDrafting = confirmationIntent !== null;
		confirmationIntent = null;
		syncGoalTools();
		const msg = abortGoalCommandMessage({ archived: true, wasDrafting });
		ctx.ui.notify(msg, "info");
		if (abortedGoalId) {
			try {
				appendGoalEvent(ctx, {
					type: "goal_aborted",
					goalId: abortedGoalId,
					reason: "user",
					at: nowIso(),
				});
			} catch {}
		}
	}

	pi.registerMessageRenderer<GoalEventDetails>(GOAL_EVENT_ENTRY, renderGoalEvent);
	pi.registerMessageRenderer<GoalAuditEventDetails>(GOAL_AUDIT_ENTRY, renderGoalAuditEvent);

	// Commands
	pi.registerCommand("goal", {
		description: "Show focused goal status.",
		handler: async (_rawArgs: string, ctx: ExtensionContext) => {
			await showGoalStatus(ctx);
		},
	});
	pi.registerCommand("goal-status", {
		description: "Show the current goal: objective, status, sisyphus mode, usage.",
		handler: async (_rawArgs, ctx) => {
			await showGoalStatus(ctx);
		},
	});
	pi.registerCommand("goal-list", {
		description: "List all open pi goals.",
		handler: async (_rawArgs, ctx) => {
			reconcileFocusedGoalFromSession(ctx);
			ctx.ui.notify(buildGoalListText(goalsById, focusedGoalId), "info");
			updateUI(ctx);
		},
	});
	pi.registerCommand("goal-focus", {
		description: "Choose which open goal this session should focus on.",
		handler: async (_rawArgs, ctx) => {
			await focusGoalCommand(ctx);
		},
	});
	pi.registerCommand("goals", {
		description: "Discuss a new goal. The agent clarifies, researches, or grills assumptions, then proposes a draft for confirmation.",
		handler: async (rawArgs, ctx) => {
			await handleGoalCommandTopic(rawArgs, ctx, "goal", { replace: false });
		},
	});
	pi.registerCommand("sisyphus", {
		description: "Discuss a Sisyphus goal.",
		handler: async (rawArgs: string, ctx: ExtensionContext) => {
			await handleGoalCommandTopic(rawArgs, ctx, "sisyphus", { replace: false });
		},
	});
	pi.registerCommand("goals-set", {
		description: "Immediately create and start a normal goal.",
		handler: async (rawArgs, ctx) => {
			handleDirectGoalSet(rawArgs, ctx, "goal");
		},
	});
	pi.registerCommand("sisyphus-set", {
		description: "Immediately create and start a Sisyphus goal.",
		handler: async (rawArgs, ctx) => {
			handleDirectGoalSet(rawArgs, ctx, "sisyphus");
		},
	});
	pi.registerCommand("goal-tweak", {
		description: "Refine the current goal via a drafting interview.",
		handler: async (rawArgs, ctx) => {
			await startGoalTweakDrafting(rawArgs, ctx);
		},
	});
	pi.registerCommand("goal-clear", {
		description: "Clear the current goal.",
		handler: async (_rawArgs, ctx) => {
			await handleGoalClear(ctx);
		},
	});
	pi.registerCommand("goal-abort", {
		description: "Abort the current goal.",
		handler: async (_rawArgs, ctx) => {
			await handleGoalAbort(ctx);
		},
	});
	pi.registerCommand("goal-pause", {
		description: "Pause the currently running goal.",
		handler: async (_rawArgs, ctx) => {
			await handleGoalPause(ctx);
		},
	});
	pi.registerCommand("goal-resume", {
		description: "Resume a paused goal.",
		handler: async (_rawArgs, ctx) => {
			await handleGoalResume(ctx);
		},
	});

	registerQuestionnaireTools(pi);

	pi.registerTool(defineTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Get the current pi goal for this session.",
		promptSnippet: "Read the active pi goal state.",
		promptGuidelines: [
			"Use get_goal when you need the current goal before deciding whether to continue or mark it complete.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromSession(ctx);
			syncGoalTools();
			const view = goalForDisplay() ?? state.goal;
			const otherCount = otherOpenGoalCount(goalsById, focusedGoalId);
			const text = view
				? `${detailedSummary(view)}${otherCount > 0 ? `\nOther open goals: ${otherCount}` : ""}`
				: openGoals().length > 0
					? buildUnfocusedOpenGoalsSummary(openGoals().length)
					: detailedSummary(null);
			return {
				content: [{ type: "text", text }],
				details: goalDetails(view),
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", "get_goal"), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: "create_goal",
		label: "Create Goal",
		description: "Create a new active pi goal.",
		promptSnippet: "Create a persistent pi goal.",
		promptGuidelines: [
			"Use create_goal only when the user explicitly asks.",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "Concrete objective." }),
			autoContinue: Type.Optional(Type.Boolean({ description: "Auto-continue." })),
			sisyphus: Type.Optional(Type.Boolean({ description: "Sisyphus mode." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return {
				content: [{ type: "text", text: "create_goal REJECTED: use /goals or /sisyphus with propose_goal_draft." }],
				details: goalDetails(state.goal),
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "create_goal"), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: PROPOSE_DRAFT_TOOL_NAME,
		label: "Propose Goal Draft",
		description: "Propose the goal draft to the user.",
		promptSnippet: "Propose the drafted goal to the user.",
		promptGuidelines: [
			"Call propose_goal_draft when discussion has enough info.",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "Full goal text." }),
			autoContinue: Type.Optional(Type.Boolean({ description: "Auto-continue." })),
			sisyphus: Type.Optional(Type.Boolean({ description: "Sisyphus." })),
			draftId: Type.Optional(Type.String({ description: "Deprecated." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const validation = validateGoalDraftProposal({
				intent: confirmationIntent,
				hasUnfinishedGoal: !!state.goal && state.goal.status !== "complete",
				objective: params.objective,
				sisyphus: params.sisyphus,
				draftId: params.draftId,
			});
			if (!validation.ok) {
				if (validation.clearDrafting) {
					confirmationIntent = null;
					syncGoalTools();
				}
				return {
					content: [{ type: "text", text: validation.message }],
					details: goalDetails(state.goal),
				};
			}
			const activeIntent = confirmationIntent;
			if (!activeIntent) throw new Error("Goal confirmation intent disappeared.");

			const objective = validation.objective;
			const autoContinueFlag = params.autoContinue ?? true;
			const sisyphusFlag = validation.expectedSisyphus;
			const draftSummary = buildDraftConfirmationText({
				focus: activeIntent.focus,
				originalTopic: activeIntent.originalTopic,
				objective,
				autoContinue: autoContinueFlag,
			});

			const headless = shouldAutoConfirmProposal({ hasUI: ctx.hasUI, autoConfirmEnv: process.env.PI_GOAL_AUTO_CONFIRM });

			let decision: "confirm" | "continue";
			if (headless) {
				decision = "confirm";
			} else {
				try {
					decision = await showProposalDialog(ctx, draftSummary, activeIntent.focus);
				} catch (err) {
					const message = proposalDialogFailureMessage(err);
					ctx.ui.notify(message, "error");
					return {
						content: [{ type: "text", text: message }],
						details: goalDetails(state.goal),
					};
				}
			}

			if (decision === "confirm") {
				const config: GoalCreationConfig = {
					objective,
					autoContinue: autoContinueFlag,
					sisyphus: sisyphusFlag,
				};
				confirmationIntent = null;
				replaceGoal(config, ctx, false);
				syncGoalTools();
				return {
					content: [{ type: "text", text: buildGoalCreatedReport({ objective, detailedSummary: detailedSummary(state.goal) }) }],
					details: goalDetails(state.goal),
					terminate: true,
				};
			}
			return {
				content: [{
					type: "text",
					text: "User clicked 'Continue Chatting'. Ask what they want changed.",
				}],
				details: goalDetails(state.goal),
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "propose_goal_draft"), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: "update_goal",
		label: "Update Goal",
		description: "Mark the current goal complete.",
		promptSnippet: "Mark goal complete.",
		promptGuidelines: [
			"Only call update_goal when objective is actually achieved.",
		],
		parameters: Type.Object({
			status: StringEnum([COMPLETE_STATUS] as const, { description: "Set to complete." }),
			completionSummary: Type.Optional(Type.String({ description: "Completion claim." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromSession(ctx);
			if (params.status !== COMPLETE_STATUS) throw new Error("update_goal only supports status=complete.");
			const completionGate = validateGoalCompletion({ goal: state.goal, runningGoalId });
			if (!completionGate.ok) {
				return {
					content: [{ type: "text", text: completionGate.message }],
					details: goalDetails(state.goal),
				};
			}
			if (!state.goal) throw new Error("Goal disappeared during completion validation.");

			try {
				appendGoalEvent(ctx, {
					type: "completion_requested",
					goalId: state.goal.id,
					summary: params.completionSummary,
					at: nowIso(),
				});
			} catch {}

			const auditorConfig = loadGoalAuditorFileConfig(ctx.cwd);
			const auditor = await runGoalCompletionAuditor({
				ctx,
				goal: state.goal,
				completionSummary: params.completionSummary,
				detailedSummary: detailedSummary(state.goal),
				signal,
			});

			const verdict = auditor.approved ? "approved" : auditor.error ? "error" : "disapproved" as const;
			try {
				appendGoalEvent(ctx, {
					type: "audit_result",
					goalId: state.goal.id,
					verdict,
					report: auditor.output || "No output.",
					at: nowIso(),
				});
			} catch {}

			if (!auditor.approved) {
				pi.sendMessage<GoalAuditEventDetails>({
					customType: GOAL_AUDIT_ENTRY,
					content: `Goal completion rejected by auditor.\n${auditor.output || ""}`,
					display: true,
					details: { phase: "rejected", goalId: state.goal.id, auditor: auditor.model },
				});
				return {
					content: [{ type: "text", text: `Goal audit rejected.\n${auditor.output || ""}` }],
					details: goalDetails(state.goal),
				};
			}

			accountProgress(ctx);
			state.goal = { ...state.goal, status: "complete", updatedAt: nowIso() };
			stopActiveGoal("complete", "agent", ctx);
			const completedGoal = state.goal;
			turnStoppedFor = completedGoal?.id ?? null;
			if (completedGoal) {
				resetGetGoalNudgeState(completedGoal.id);
				goalsById.delete(completedGoal.id);
				focusedGoalId = null;
				appendFocusEntry(ctx, null, "completed");
				syncGoalTools();
				updateUI(ctx);
				try {
					appendGoalEvent(ctx, {
						type: "goal_completed",
						goalId: completedGoal.id,
						at: completedGoal.updatedAt,
					});
				} catch {}
			}
			return {
				content: [{
					type: "text",
					text: buildCompletionReport({
						detailedSummary: detailedSummary(completedGoal),
						completionSummary: params.completionSummary,
					}),
				}],
				details: goalDetails(completedGoal),
				terminate: true,
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "update_goal ") + theme.fg("success", args.status), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: "pause_goal",
		label: "Pause Goal",
		description: "Pause the active goal.",
		promptSnippet: "Pause the active goal.",
		promptGuidelines: [
			"Use when you have hit a real blocker.",
		],
		parameters: Type.Object({
			reason: Type.String({ description: "One-sentence blocker." }),
			suggestedAction: Type.Optional(Type.String({ description: "How to unblock." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromSession(ctx);
			const reason = params.reason.trim();
			if (!reason) throw new Error("pause_goal requires non-empty reason.");
			const pauseGate = validatePauseGoal({ goal: state.goal, runningGoalId, reason });
			if (!pauseGate.ok) {
				return {
					content: [{ type: "text", text: pauseGate.message }],
					details: goalDetails(state.goal),
				};
			}
			if (!state.goal) throw new Error("Goal disappeared during pause validation.");
			const suggested = params.suggestedAction?.trim() || undefined;

			accountProgress(ctx);
			const next = {
				...state.goal,
				status: "paused" as GoalStatus,
				pauseReason: reason,
				pauseSuggestedAction: suggested,
				updatedAt: nowIso(),
			};
			setGoal(next, ctx);
			resetGetGoalNudgeState(next.id);
			turnStoppedFor = state.goal.id;

			const suggestionLine = suggested ? `\nSuggested: ${truncateText(suggested, 160)}` : "";
			ctx.ui.notify(
				`Goal paused by agent.\nReason: ${truncateText(reason, 200)}${suggestionLine}\n\nUse /goal-resume to continue, /goal-tweak to revise, or /goal-clear to abandon.`,
				"warning",
			);
			return {
				content: [{
					type: "text",
					text: `Goal paused. Reason: ${reason}${suggested ? `\nSuggested: ${suggested}` : ""}`,
				}],
				details: goalDetails(state.goal),
				terminate: true,
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "pause_goal ") + theme.fg("warning", truncateText(args?.reason ?? "", 80)), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: ABORT_GOAL_TOOL_NAME,
		label: "Abort Goal",
		description: "Abort the current goal.",
		promptSnippet: "Abort goal.",
		promptGuidelines: [
			"Only when user asks or objective is obsolete.",
		],
		parameters: Type.Object({
			reason: Type.String({ description: "One-sentence reason." }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromSession(ctx);
			const reason = params.reason.trim();
			if (!reason) throw new Error("abort_goal requires non-empty reason.");
			const abortGate = validateGoalAbort({ goal: state.goal, runningGoalId, reason });
			if (!abortGate.ok) {
				return {
					content: [{ type: "text", text: abortGate.message }],
					details: goalDetails(state.goal),
				};
			}
			if (!state.goal) throw new Error("Goal disappeared during abort validation.");
			const abortedGoalId = state.goal.id;

			accountProgress(ctx);
			state.goal = buildAbortedByAgentGoal(state.goal, { reason, updatedAt: nowIso() });
			resetGetGoalNudgeState(abortedGoalId);
			setGoal(null, ctx, true, "aborted");
			turnStoppedFor = abortedGoalId;

			ctx.ui.notify(
				`Goal aborted by agent.\nReason: ${truncateText(reason, 200)}`,
				"warning",
			);
			try {
				appendGoalEvent(ctx, {
					type: "goal_aborted",
					goalId: abortedGoalId,
					reason,
					at: nowIso(),
				});
			} catch {}
			return {
				content: [{
					type: "text",
					text: `Goal aborted. Reason: ${reason}`,
				}],
				details: goalDetails(state.goal),
				terminate: true,
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "abort_goal ") + theme.fg("warning", truncateText(args?.reason ?? "", 80)), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: TWEAK_APPLY_TOOL_NAME,
		label: "Apply Goal Tweak",
		description: "Apply /goal-tweak revision.",
		promptSnippet: "Apply the revised goal.",
		promptGuidelines: [
			"Only call during /goal-tweak flow.",
		],
		parameters: Type.Object({
			newObjective: Type.String({ description: "Complete revised objective." }),
			changeSummary: Type.String({ description: "What changed." }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromSession(ctx);
			if (!state.goal) {
				return {
					content: [{ type: "text", text: "No goal is set." }],
					details: goalDetails(state.goal),
				};
			}
			if (tweakDraftingFor !== state.goal.id) {
				return {
					content: [{ type: "text", text: "apply_goal_tweak REJECTED: no /goal-tweak flow active." }],
					details: goalDetails(state.goal),
				};
			}
			const newObjective = params.newObjective.trim();
			if (!newObjective) throw new Error("apply_goal_tweak requires non-empty newObjective.");
			const changeSummary = params.changeSummary.trim();
			if (!changeSummary) throw new Error("apply_goal_tweak requires non-empty changeSummary.");

			const next = {
				...state.goal,
				objective: newObjective,
				pauseReason: undefined,
				pauseSuggestedAction: undefined,
				updatedAt: nowIso(),
			};
			setGoal(next, ctx);
			tweakDraftingFor = null;
			resetGetGoalNudgeState(state.goal.id);
			turnStoppedFor = state.goal.id;
			syncGoalTools();
			updateUI(ctx);
			ctx.ui.notify(`Goal tweaked: ${truncateText(changeSummary, 160)}`, "info");
			try {
				appendGoalEvent(ctx, {
					type: "goal_tweaked",
					goalId: state.goal.id,
					changeSummary,
					at: state.goal.updatedAt,
				});
			} catch {}
			return {
				content: [{
					type: "text",
					text: `Goal tweak applied. ${changeSummary}`,
				}],
				details: goalDetails(state.goal),
				terminate: true,
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "apply_goal_tweak"), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	syncGoalTools();

	pi.on("turn_start", async (_event, ctx) => {
		goalWorkToolCalledThisTurn = false;
		turnStoppedFor = null;
		beginAccounting();
		updateUI(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (turnStoppedFor !== null && !POST_STOP_ALLOWED_TOOL_SET.has(event.toolName)) {
			return {
				block: true,
				reason: `Goal was stopped earlier this turn. Do not call more tools.`,
			};
		}
		if (isMeaningfulProgressToolCall(event.toolName, asRecord(event)?.args)) {
			if (state.goal?.id) activeGetGoalTurnsByGoalId.delete(state.goal.id);
			goalWorkToolCalledThisTurn = true;
		} else if (state.goal?.status === "active" && state.goal.autoContinue && event.toolName !== "get_goal") {
			turnStoppedFor = state.goal.id;
		}
		return;
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		accountProgress(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		const message = event.message as AssistantMessageLike;
		if (confirmationIntent !== null || tweakDraftingFor !== null) return;
		const tokens = assistantTurnTokens(message);
		accountProgress(ctx, { completedTurnTokens: tokens });

		if (isAbortedAssistantMessage(message)) {
			pauseActiveGoal(ctx);
			return;
		}
		if (
			!isToolUseAssistantMessage(message)
			&& state.goal?.status === "active"
			&& state.goal.autoContinue
			&& goalWorkToolCalledThisTurn
		) {
			queueContinuation(ctx);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (isAbortedAssistantMessage(event.message)) pauseActiveGoal(ctx);
	});

	pi.on("session_start", async (event, ctx) => {
		loadState(ctx);
		syncTerminalInputPause(ctx);
		if (event.reason === "resume" && !state.goal && openGoals().length > 1 && ctx.hasUI) {
			await focusGoalCommand(ctx);
		}
		if (event.reason === "resume" && state.goal?.status === "paused" && ctx.hasUI) {
			const current = state.goal;
			const shouldResume = await ctx.ui.confirm("Resume paused goal?", `Goal: ${current.objective}`);
			if (shouldResume) {
				setGoal({ ...current, status: "active", autoContinue: true, stopReason: undefined, pauseReason: undefined, pauseSuggestedAction: undefined }, ctx);
			}
		}
		beginAccounting();
		queueContinuation(ctx, true);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		accountProgress(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (confirmationIntent !== null || tweakDraftingFor !== null) return;
		if (state.goal) persist(ctx);
		beginAccounting();
		if (shouldArmPostCompactReminder(state.goal)) {
			postCompactReminderPending = true;
		}
		queueContinuation(ctx, true);
	});

	pi.on("session_tree", async (_event, ctx) => {
		loadState(ctx);
		syncTerminalInputPause(ctx);
		beginAccounting();
		queueContinuation(ctx, true);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		syncGoalTools();
		const currentSystemPrompt = () => ctx.getSystemPrompt?.() || event.systemPrompt;
		const incomingGoalId = extractGoalIdFromInjectedMessage(event.prompt ?? "");

		if (confirmationIntent !== null) {
			clearContinuationState();
			clearActiveAccounting();
			runningGoalId = null;
			return { systemPrompt: currentSystemPrompt() };
		}

		if (tweakDraftingFor !== null) {
			clearContinuationState();
			clearActiveAccounting();
			runningGoalId = null;
			return { systemPrompt: currentSystemPrompt() };
		}

		if (incomingGoalId !== null) {
			clearContinuationState();
			if (!state.goal || state.goal.id !== incomingGoalId || (state.goal.status !== "active") || !state.goal.autoContinue) {
				try {
					ctx.abort?.();
				} catch {}
				updateUI(ctx);
				return {
					systemPrompt: `${currentSystemPrompt()}\n\n${staleContinuationPrompt(incomingGoalId, state.goal)}`,
				};
			}
		} else {
			clearContinuationState();
			resetGetGoalNudgeState(state.goal?.id);
		}

		if (!state.goal) {
			runningGoalId = null;
			const openCount = openGoals().length;
			if (openCount > 0) {
				return { systemPrompt: `${currentSystemPrompt()}\n\n${unfocusedOpenGoalsPrompt(openCount)}` };
			}
			return;
		}
		reconcileFocusedGoalFromSession(ctx);
		if (!state.goal) {
			runningGoalId = null;
			const openCount = openGoals().length;
			if (openCount > 0) return { systemPrompt: `${currentSystemPrompt()}\n\n${unfocusedOpenGoalsPrompt(openCount)}` };
			return;
		}
		runningGoalId = state.goal.status === "active" ? state.goal.id : null;
		if (state.goal.status === "complete") return;
		if (state.goal.status === "paused") {
			const current = state.goal;
			const pauseExtras: string[] = [];
			if (current.stopReason === "agent") {
				pauseExtras.push("");
				pauseExtras.push(`Pause reason: ${current.pauseReason ?? "(unknown)"}`);
				if (current.pauseSuggestedAction) pauseExtras.push(`Suggested: ${current.pauseSuggestedAction}`);
			}
			let auditorExtra = "";
			try {
				const { events } = { events: [] as GoalLedgerEvent[] };
				const auditorResult = latestAuditorResultForGoal(events, current.id);
				if (auditorResult && auditorResult.verdict === "disapproved") {
					auditorExtra = `\n\n[AUDITOR REJECTION] ${auditorResult.report.slice(0, 300)}`;
				}
			} catch {}
			return {
				systemPrompt: `${currentSystemPrompt()}\n\n[PI GOAL PAUSED goalId=${current.id}]\n${untrustedObjectiveBlock(current)}${pauseExtras.join("\n")}${auditorExtra}\n\nThe goal is paused. Do not autonomously continue substantive work unless the user resumes it.`,
			};
		}
		let prompt = goalPrompt(state.goal);
		if (shouldInjectPostCompactReminder({ pending: postCompactReminderPending, goal: state.goal })) {
			postCompactReminderPending = false;
			try {
				const { events } = { events: [] as GoalLedgerEvent[] };
				const compaction = buildCompactionSummary({ goalsById, focusedGoalId, ledgerEvents: events });
				prompt = `${prompt}\n\n[POST-COMPACTION RESYNC goalId=${state.goal.id}]\n${compaction}`;
			} catch {
				prompt = `${prompt}\n\n[POST-COMPACTION RESYNC]\nThe conversation was just compacted. Re-read the objective and continue.`;
			}
		}
		return { systemPrompt: `${currentSystemPrompt()}\n\n${prompt}` };
	});

	pi.on("agent_end", async (event, ctx) => {
		if (confirmationIntent !== null || tweakDraftingFor !== null) return;
		const endedGoalId = runningGoalId;
		runningGoalId = null;

		const abortedTokens = event.messages
			.filter(isAbortedAssistantMessage)
			.reduce((sum, message) => sum + assistantTurnTokens(message), 0);
		if (abortedTokens > 0 && endedGoalId && state.goal?.id === endedGoalId) {
			accountProgress(ctx, { completedTurnTokens: abortedTokens });
		}

		continuationQueuedFor = null;
		if (!state.goal || state.goal.status !== "active" || !state.goal.autoContinue) return;
		if (endedGoalId && state.goal.id !== endedGoalId) return;
		if (!reconcileFocusedGoalFromSession(ctx)) return;
		if (hasAbortedAssistantMessage(event.messages) || ctx.signal?.aborted) {
			pauseActiveGoal(ctx);
			return;
		}
		persist(ctx);
		updateUI(ctx);
		queueContinuation(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		accountProgress(ctx);
		clearContinuationTimer();
		stopStatusRefresh();
		terminalInputUnsubscribe?.();
		terminalInputUnsubscribe = null;
		if (state.goal) persist(ctx);
	});
}