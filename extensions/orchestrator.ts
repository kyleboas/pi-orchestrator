import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Type } from "typebox";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	SolToolMode,
	applyWorkerPolicyTransition,
	buildWorkerPrompt,
	buildWorkerPromptSections,
	catalogText,
	lintWorkerTaskPolicyDuplication,
	measureWorkerPrompt,
	workerDescription,
	workerNames,
	piRpcWorkerArgs,
	type ClaudeCodeWorkerProfile,
	type WorkerCatalog,
	type WorkerProfile,
} from "./orchestrator-lib/orchestrator-core.ts";
import {
	claudeApiErrorEvent,
	claudeAssistantText,
	claudeCodeArgs,
	drainClaudeStreamBuffer,
	claudeResultSettlement,
	claudeUsageTokenTotal,
	claudeUserEvent,
	isClaudeTurnStart,
	parseClaudeStreamLine,
	type ClaudeResultSettlement,
} from "./orchestrator-lib/orchestrator-claude.ts";
import { loadOrchestratorConfig, type OrchestratorConfig } from "./orchestrator-lib/orchestrator-config.ts";
import { buildCoordinatorInstructions, subscriptionSensitiveWorkerSelectionGuidance } from "./orchestrator-lib/orchestrator-instructions.ts";
import { withOrchestratorDelegationContract } from "./orchestrator-lib/orchestrator-delegation-contract.ts";
import { AUTONOMOUS_LINEAGE_ENTRY, validateScope, type AutonomousScope } from "./orchestrator-lib/autonomous-run-capability.js";
import { consumeRootCorrection, rootCorrectionAvailable, validateDelegationRelationship } from "./orchestrator-lib/root-lineage-policy.js";
import {
	earliestAccountReset,
	isClaudeAuthFailureText,
	isUsageLimitText,
	markClaudeAccountLimited,
	parseUsageLimitReset,
	pickClaudeAccount,
} from "./orchestrator-lib/orchestrator-accounts.ts";
import {
	beginWorkerRun,
	beginWorkerSettlement,
	canSteerWorker,
	clearClaudeMergeGrace,
	completeClaudeTurn,
	finishWorkerSettlement,
	markWorkerRunActive,
	mergeOutstandingClaudeTurns,
	queueClaudeTurn,
	startClaudeTurn,
	selectFinalWorkerText,
	shouldAbortPiWorkerRun,
	shouldAutoStopReportedWorker,
	shouldHoldWorkerSettlement,
} from "./orchestrator-lib/worker-lifecycle.ts";
import {
	clearBackgroundJobs,
	parseBackgroundJobMarkers,
	trackBackgroundJobEvent,
} from "./orchestrator-lib/background-job.ts";
import {
	bindOrchestratorApi,
	bindOrchestratorSession,
	deliverWorkerReport,
	ensureOrchestratorExitHook,
	getOrchestratorRuntime,
	holdWorkerReportDelivery,
	isWorkerReportDeliveryHeld,
	isWorkerProcessLive,
	killWorkerProcessTree,
	notifyOrchestratorStateChange,
	nextWorkerStatusRevision,
	releaseOrchestratorSession,
	releaseWorkerReportDelivery,
	scheduleIdleWorkerReportRecovery,
	scheduleWorkerReportDelivery,
	stopWorkerProcess,
	type OrchestratorWorker as Worker,
} from "./orchestrator-lib/orchestrator-runtime.ts";
import { renderBaseFooter } from "./orchestrator-lib/orchestrator-footer.ts";
import { WORKER_STATUS_WIDGET_ID, workerStatusWidgetLines } from "./orchestrator-lib/orchestrator-worker-status.ts";
import {
	hasAnimatingWorker,
	isExpiredWorker,
	panelWorkers,
	renderWorkerFooterRows,
	renderWorkerPanel,
	workerSessionTitle,
	WORKER_WIDGET_TICK_MS,
	type WorkerPanelOptions,
} from "./orchestrator-lib/orchestrator-ui.ts";
import {
	appendTranscript,
	mergeTranscriptEntry,
	transcriptFromClaudeEvent,
	transcriptFromRpcEvent,
	type TranscriptEntry,
} from "./orchestrator-lib/orchestrator-transcript.ts";
import { assessWorkerCheckIn, buildCheckInDigest, deliverCheckIn, isCheckInDue, shouldWakeForCheckIn } from "./orchestrator-lib/orchestrator-checkin.ts";
import { accumulateReportedUsage, piMessageUsage, shouldAccumulatePiUsage } from "./orchestrator-lib/orchestrator-usage.ts";
import {
	OUTCOME_ROLLOVER_INSTRUCTIONS,
	beginOutcomeRollover,
	completeOutcomeRollover,
	failOutcomeRollover,
	isOutcomeRolloverEligible,
} from "./orchestrator-lib/orchestrator-rollover.ts";
import {
	TASK_CATEGORIES,
	TASK_COMPLEXITIES,
	acceptReviewedRuns,
	classifyTask,
	cleanStatsLedger,
	loadStats,
	recoverStaleV2StatsLedger,
	recordWorkerOutcome,
	recordWorkerSteer,
	statsSummary,
	workerDurationEstimate,
	updateWorkerRunStatus,
	type StatsLedger,
	type TaskCategory,
	type TaskComplexity,
	type WorkerRunStatus,
} from "./orchestrator-lib/orchestrator-stats.ts";
import {
	anchorScrollUp,
	isDownKey,
	isEndKey,
	isEnterKey,
	isEscapeKey,
	isPageDownKey,
	isHomeKey,
	MOUSE_TRACKING_OFF,
	MOUSE_TRACKING_ON,
	isPageUpKey,
	isUpKey,
	moveSelection,
	renderSessionScreen,
	wheelDirection,
	WHEEL_SCROLL_LINES,
	wrapPlainText,
} from "./orchestrator-lib/orchestrator-session-view.ts";

const LEGACY_WORKER_WIDGET_ID = "orchestrator-workers";

/** Mi keeps reported workers alive so the coordinator can steer them again. */
export function shouldReapHeadlessSession(): boolean {
	return process.env.MI_COORDINATOR_MODE !== "1";
}

// One correction steer is allowed for a failed attempt. A separate retry uses
// a new worker and its retryOf lineage, so it gets its own correction budget.
const correctionSteerCounts = new Map<string, number>();

export function createWorkerSchema(catalog: WorkerCatalog) {
	return Type.Union(workerNames(catalog).map((name) => Type.Literal(name, { description: workerDescription(name, catalog[name]!) })));
}

export function coordinatorInstructions(catalog: WorkerCatalog, statsText?: string, options: { subscriptionSensitive?: boolean } = {}): string {
	return buildCoordinatorInstructions(catalog, statsText, options);
}

function workerWidgetLines(now = Date.now(), width = 80, options: WorkerPanelOptions = {}): string[] | undefined {
	return renderWorkerPanel([...getOrchestratorRuntime().workers.values()], now, width, options);
}


const TAKEOVER_SYSTEM_INSTRUCTIONS = (reason: string) => `
Sol takeover is active for one task (${reason}). Implement this task yourself
using the available normal implementation tools. Do not delegate or use
orchestrator worker controls. Complete the work and validation directly;
orchestration resumes after this task settles.`.trim();

function workerSummary(worker: Worker): string {
	const age = Math.max(0, Math.floor((Date.now() - worker.startedAt.getTime()) / 1000));
	return `${worker.name} (${worker.id}) — ${worker.state}, ${age}s — ${worker.task}`;
}

function content(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function getText(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const candidate = message as { role?: unknown; content?: unknown };
	if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return undefined;
	const text = candidate.content
		.filter((part): part is { type: string; text: string } =>
			typeof part === "object" && part !== null &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text || undefined;
}

/** Text from any RPC message role, used only for strict extension protocol markers. */
function rpcMessageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type?: unknown; text?: unknown } => !!part && typeof part === "object")
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

function recordBackgroundJobEvents(worker: Worker, message: unknown): void {
	const role = message && typeof message === "object" ? (message as { role?: unknown }).role : undefined;
	for (const event of parseBackgroundJobMarkers(rpcMessageText(message))) {
		// Start markers can only come from a tool result; completion markers can
		// only come from the extension's follow-up user message. This avoids using
		// an assistant's ordinary prose as lifecycle control data.
		if ((event.kind === "started" && role !== "toolResult") || (event.kind === "completed" && role !== "user")) continue;
		const change = trackBackgroundJobEvent(worker, event);
		if (change === "started" && event.kind === "started") {
			recordWorkerActivity(worker, { at: Date.now(), role: "system", text: `Background job ${event.name} (${event.jobId}) started; waiting for its completion.` });
		} else if (change === "completed" && event.kind === "completed") {
			recordWorkerActivity(worker, { at: Date.now(), role: "system", text: `Background job ${event.jobId} finished with exit status ${event.exitCode ?? "none"}${event.signal ? ` (${event.signal})` : ""}; completion follow-up received.` });
		} else if (change === "already-completed") {
			recordWorkerActivity(worker, { at: Date.now(), role: "system", text: `Background job ${event.jobId} finished before its start marker was received.` });
		}
	}
}

function recordWorkerActivity(worker: Worker, entry: TranscriptEntry): void {
	mergeTranscriptEntry(worker.transcript ??= [], entry);
	worker.transcriptRevision = (worker.transcriptRevision ?? 0) + 1;
	// The row timer shows time since the worker was last instructed (delegate
	// or steer), so only user entries reset it — worker output does not.
	if (entry.role === "user") {
		worker.lastActivityAt = new Date(entry.at);
		worker.lastCheckinAt = new Date(entry.at);
		worker.healthStreak = 0;
		worker.runTokensBase = worker.tokens ?? 0;
		worker.runCostBase = worker.costUsd ?? 0;
		applyRunEstimate(worker);
	}
}

/**
 * The footer row's `~20m` reference, resolved once per run because the row
 * repaints every couple of seconds and must never read the ledger per frame.
 */
function applyRunEstimate(worker: Worker): void {
	try {
		const estimate = workerDurationEstimate(loadStats(), worker.name, { category: worker.category, complexity: worker.complexity });
		worker.estimateMs = estimate?.p50DurationMs;
		worker.estimateWidened = estimate ? estimate.basis !== "class" : undefined;
	} catch {
		// An unreadable ledger only costs the estimate, never the delegation.
		worker.estimateMs = undefined;
		worker.estimateWidened = undefined;
	}
}

/** Write one ledger attempt per lifecycle run. Later review changes only its status. */
function recordRunOutcome(worker: Worker, status: WorkerRunStatus): void {
	if (worker.statsRecordedRun === worker.run) return;
	worker.statsRecordedRun = worker.run;
	const start = worker.lastActivityAt?.getTime() ?? worker.startedAt.getTime();
	recordWorkerOutcome(worker.name, {
		status,
		runId: worker.runId,
		rootTaskId: worker.rootTaskId,
		...(worker.retryOf ? { retryOf: worker.retryOf } : {}),
		category: worker.category,
		complexity: worker.complexity,
		durationMs: Math.max(0, (worker.settledAt?.getTime() ?? Date.now()) - start),
		tokens: Math.max(0, (worker.tokens ?? 0) - (worker.runTokensBase ?? 0)),
		...(worker.costUsd === undefined ? {} : { costUsd: Math.max(0, worker.costUsd - (worker.runCostBase ?? 0)) }),
		costKind: worker.profile.backend === "claude-code" ? "estimated" : "reported",
		backend: worker.profile.backend,
		model: worker.profile.model,
	});
}

function failWorker(worker: Worker, message: string, status: WorkerRunStatus = "failed"): void {
	if (worker.state === "stopped" || worker.state === "failed") return;
	clearBackgroundJobs(worker);
	worker.backgroundSettlementHeldRun = undefined;
	worker.state = "failed";
	worker.settledAt ??= new Date();
	worker.lastError = message;
	recordRunOutcome(worker, status);
	reportWorkerResult(worker);
	notifyOrchestratorStateChange(getOrchestratorRuntime());
}

function sendRpc(worker: Worker, message: Record<string, unknown>): boolean {
	if (!canSteerWorker(worker, worker.process)) return false;
	try {
		worker.process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
			if (error) failWorker(worker, "Pi RPC worker stdin failed.", "unavailable");
		});
		return true;
	} catch {
		return false;
	}
}

function sendClaudeInstruction(worker: Worker, instructions: string): boolean {
	if (!canSteerWorker(worker, worker.process)) return false;
	try {
		worker.process.stdin.write(`${JSON.stringify(claudeUserEvent(instructions))}\n`, (error) => {
			if (error) failWorker(worker, "Claude Code worker stdin failed.", "unavailable");
		});
		// New instructions invalidate any held merge verdict: its result belongs
		// to a turn this write supersedes.
		clearClaudeMergeGrace(worker);
		queueClaudeTurn(worker);
		worker.lastInstruction = instructions;
		// Unlike Pi RPC's agent_start event, Claude's stream-json protocol has
		// no separate run-start event. Its accepted initial instruction means it
		// is now working (and eligible for a passive check-in).
		if (worker.state === "starting") {
			worker.state = "working";
			notifyOrchestratorStateChange(getOrchestratorRuntime());
		}
		return true;
	} catch {
		return false;
	}
}

function sendWorkerInstruction(worker: Worker, instructions: string, steering = false): boolean {
	if (worker.profile.backend === "claude-code") return sendClaudeInstruction(worker, instructions);
	return sendRpc(worker, {
		type: "prompt",
		id: `${worker.id}:${steering ? randomUUID().slice(0, 8) : "initial"}`,
		message: instructions,
		...(steering ? { streamingBehavior: "steer" } : {}),
	});
}

function requestWorkerRpc(worker: Worker, message: Record<string, unknown>): Promise<unknown> {
	if (worker.profile.backend !== "pi-rpc" || !canSteerWorker(worker, worker.process)) return Promise.reject(new Error("Worker is not live."));
	const id = `${worker.id}:rpc-${++worker.rpcNextId}`;
	return new Promise((resolve, reject) => {
		worker.rpcPending.set(id, { resolve, reject });
		try {
			worker.process.stdin.write(`${JSON.stringify({ ...message, id })}\n`, (error) => {
				if (!error) return;
				worker.rpcPending.delete(id);
				reject(error);
			});
		} catch (error) {
			worker.rpcPending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function rejectPendingRpc(worker: Worker, error: Error): void {
	for (const pending of worker.rpcPending.values()) pending.reject(error);
	worker.rpcPending.clear();
}

function reapIfHeadless(worker: Worker): void {
	const runtime = getOrchestratorRuntime();
	if (!runtime.headlessReap || !shouldAutoStopReportedWorker(worker)) return;
	stopWorkerProcess(worker);
}

function reportWorkerResult(worker: Worker): void {
	const result = worker.lastResult ?? worker.lastError ?? "Worker settled without a final text response.";
	deliverWorkerReport(
		getOrchestratorRuntime(),
		worker,
		`[${worker.name} worker result — ${worker.id}]\n${result}\n\nReview this result. If work remains, steer this worker or delegate a follow-up.`,
	);
	reapIfHeadless(worker);
}

/** Retry reports deferred while /reload had no live ExtensionAPI target. */
function flushDeferredWorkerReports(): void {
	for (const worker of getOrchestratorRuntime().workers.values()) {
		if (worker.state === "idle" || worker.state === "failed") reportWorkerResult(worker);
	}
}

async function settleWorker(worker: Worker): Promise<void> {
	const run = beginWorkerSettlement(worker);
	if (run === undefined) return;
	notifyOrchestratorStateChange(getOrchestratorRuntime());
	const response = await requestWorkerRpc(worker, { type: "get_last_assistant_text" }).catch(() => undefined);
	const latest = response && typeof response === "object" && typeof (response as { text?: unknown }).text === "string"
		? (response as { text: string }).text
		: undefined;
	const text = selectFinalWorkerText(worker.lastResult, latest);
	if (text) worker.lastResult = text;
	if (finishWorkerSettlement(worker, run)) {
		recordRunOutcome(worker, "completed");
		reportWorkerResult(worker);
	}
	notifyOrchestratorStateChange(getOrchestratorRuntime());
}

/**
 * How long a result waits for a turn-start event before its outstanding
 * instructions are treated as merged into the turn that just ended. Claude
 * Code starts a genuinely queued turn within milliseconds of the prior result,
 * so this only delays the merged case, and only by the window itself.
 */
const CLAUDE_MERGED_TURN_GRACE_MS = 3_000;

/**
 * A result answered the current turn while an instruction is still outstanding.
 * Claude Code either starts that instruction's own turn in a moment (its result
 * settles the worker) or already merged it into the turn that just ended, in
 * which case no further result will ever arrive and the worker would hang in
 * "working" holding the finished text. Wait one window for a turn-start event
 * to decide, then settle on this result if none came.
 */
function holdClaudeMergeVerdict(worker: Worker, settlement: ClaudeResultSettlement): void {
	clearClaudeMergeGrace(worker);
	const run = worker.run;
	const timer = setTimeout(() => {
		worker.claudeMergeGraceTimer = undefined;
		if (worker.run !== run || worker.state === "stopped" || worker.state === "failed") return;
		mergeOutstandingClaudeTurns(worker);
		applyClaudeSettlement(worker, settlement);
		notifyOrchestratorStateChange(getOrchestratorRuntime());
	}, CLAUDE_MERGED_TURN_GRACE_MS);
	timer.unref?.();
	worker.claudeMergeGraceTimer = timer;
}

/** Settle or fail the worker on a result that owns the last outstanding turn. */
function applyClaudeSettlement(worker: Worker, settlement: ClaudeResultSettlement): void {
	const run = beginWorkerSettlement(worker);
	if (run === undefined) return;
	// Some Claude Code result events omit result even though the last assistant
	// event already contained the final text. That is a successful terminal
	// turn, not a reason to leave the reusable worker working or fail it.
	const finalText = selectFinalWorkerText(worker.lastResult, settlement.result);
	if (settlement.isError || !finalText) {
		worker.settlingRun = undefined;
		worker.state = "failed";
		worker.settledAt ??= new Date();
		worker.lastError = settlement.result ?? "Claude Code returned a result event without final text.";
		recordRunOutcome(worker, "failed");
		reportWorkerResult(worker);
		return;
	}
	worker.lastResult = finalText;
	if (finishWorkerSettlement(worker, run)) {
		recordRunOutcome(worker, "completed");
		reportWorkerResult(worker);
	}
}

function settleClaudeResult(worker: Worker, event: Record<string, unknown>, config?: OrchestratorConfig): void {
	const settlement = claudeResultSettlement(event);
	if (!settlement) return;
	worker.claudeSessionId = settlement.sessionId ?? worker.claudeSessionId;
	const tokens = claudeUsageTokenTotal(settlement.usage);
	const cumulativeUsage = accumulateReportedUsage(
		{ ...(worker.tokens === undefined ? {} : { tokens: worker.tokens }), ...(worker.costUsd === undefined ? {} : { costUsd: worker.costUsd }) },
		{ ...(tokens === undefined ? {} : { tokens }), ...(settlement.estimatedCostUsd === undefined ? {} : { costUsd: settlement.estimatedCostUsd }) },
	);
	worker.tokens = cumulativeUsage.tokens;
	worker.costUsd = cumulativeUsage.costUsd;
	// A usage-limit result is an account problem, not a task outcome: fail
	// over to the next available account instead of settling or failing.
	if (settlement.isError && isUsageLimitText(settlement.result) && config?.claudeAccounts) {
		if (failoverClaudeWorker(worker, config, "usage-limit", settlement.result ?? "")) return;
		const reset = earliestAccountReset(config.claudeAccounts);
		failWorker(worker, `Usage limit reached and every Claude account is in cooldown${reset ? ` (earliest reset ${new Date(reset * 1_000).toLocaleTimeString()})` : ""}. Use a Pi worker or retry later.`, "unavailable");
		return;
	}
	// Expired credentials are the same class of problem: this account cannot
	// serve any work, but the session (and everything the worker has already
	// done in it) survives on the next account. Never report a /login
	// instruction as a task result.
	if (settlement.isError && (worker.claudeAuthFailed === true || isClaudeAuthFailureText(settlement.result)) && config?.claudeAccounts) {
		const loggedOut = worker.claudeAccount;
		if (failoverClaudeWorker(worker, config, "auth", settlement.result ?? "")) return;
		failWorker(
			worker,
			`Claude account ${loggedOut ?? "(unknown)"} needs re-authentication (run claude /login for it) and no other account is available.${worker.claudeSessionId ? ` Its work is preserved in session ${worker.claudeSessionId}; a worker resumed on that session continues where it stopped.` : ""}`,
			"unavailable",
		);
		return;
	}
	// A result for an earlier turn (one that was already streaming when a
	// steer queued another) must not settle the steered run: the worker is
	// still working on the follow-up instructions.
	const completion = completeClaudeTurn(worker);
	if (completion === "unstarted") holdClaudeMergeVerdict(worker, settlement);
	else if (completion === "settles") applyClaudeSettlement(worker, settlement);
	notifyOrchestratorStateChange(getOrchestratorRuntime());
}

function handleRpcLine(worker: Worker, line: string): void {
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(line) as Record<string, unknown>;
	} catch {
		failWorker(worker, "Invalid Pi RPC worker output.");
		return;
	}

	for (const entry of transcriptFromRpcEvent(event)) recordWorkerActivity(worker, entry);
	if (event.type === "message_end") recordBackgroundJobEvents(worker, event.message);

	if (event.type === "response" && typeof event.id === "string") {
		const pending = worker.rpcPending.get(event.id);
		if (pending) {
			worker.rpcPending.delete(event.id);
			if (event.success === false) pending.reject(new Error("Worker RPC failed."));
			else pending.resolve(event.data);
		}
		return;
	}

	switch (event.type) {
		case "agent_start":
			// A background completion follow-up resumes this same generation. It is
			// no longer a held idle boundary, so a later real interrupt may abort it.
			markWorkerRunActive(worker);
			break;
		case "message_end":
		case "turn_end": {
			const text = getText(event.message);
			if (text) worker.lastResult = text;
			if (shouldAccumulatePiUsage(event.type)) {
				const cumulativeUsage = accumulateReportedUsage(
					{ ...(worker.tokens === undefined ? {} : { tokens: worker.tokens }), ...(worker.costUsd === undefined ? {} : { costUsd: worker.costUsd }) },
					piMessageUsage(event.message),
				);
				worker.tokens = cumulativeUsage.tokens;
				worker.costUsd = cumulativeUsage.costUsd;
			}
			break;
		}
		case "agent_end":
		case "agent_settled":
			// Pi 0.80.x emits agent_end; agent_settled remains accepted for
			// compatibility with runtimes that expose the later idle boundary.
			// An initial completion is deliberately held while a worker-owned
			// background job is still in its process tree. Its completion extension
			// follow-up starts the final callback-driven run; only that later settled
			// boundary may report this worker to the coordinator.
			if (shouldHoldWorkerSettlement(worker)) {
				if (worker.backgroundSettlementHeldRun !== worker.run) {
					worker.backgroundSettlementHeldRun = worker.run;
					recordWorkerActivity(worker, { at: Date.now(), role: "system", text: `Waiting for ${worker.pendingBackgroundJobIds!.size} background job${worker.pendingBackgroundJobIds!.size === 1 ? "" : "s"} before reporting this run.` });
				}
				break;
			}
			// An interrupt steer aborted this exact run: swallow its settlement so
			// the partial result is neither reported nor allowed to settle the
			// follow-up generation. Keyed by run number, so a stale flag from an
			// abort that never settled cannot swallow a later legitimate result.
			if (worker.interruptedRun === worker.run) {
				worker.interruptedRun = undefined;
				recordWorkerActivity(worker, { at: Date.now(), role: "system", text: "Run aborted by an interrupt steer; awaiting the correction." });
				break;
			}
			void settleWorker(worker);
			break;
		case "error":
			failWorker(worker, "Pi RPC worker reported an error.");
			break;
	}
	notifyOrchestratorStateChange(getOrchestratorRuntime());
}

function handleClaudeEvents(worker: Worker, events: Record<string, unknown>[], config?: OrchestratorConfig): void {
	for (const event of events) {
		for (const entry of transcriptFromClaudeEvent(event)) recordWorkerActivity(worker, entry);
		// A turn that actually started proves its instructions were not merged
		// into the previous one, so a held result must not settle the worker.
		if (isClaudeTurnStart(event)) {
			clearClaudeMergeGrace(worker);
			startClaudeTurn(worker);
		}
		// An API-level failure is not model output: "Please run /login" must never
		// survive as this worker's final result, and an auth failure arms the
		// account rotation its result event performs.
		const apiError = claudeApiErrorEvent(event);
		if (apiError?.authenticationFailed || isClaudeAuthFailureText(apiError?.text)) worker.claudeAuthFailed = true;
		// A successful result can omit its direct result text. Preserve the last
		// complete assistant message as the safe fallback for that terminal event.
		const text = apiError ? undefined : claudeAssistantText(event);
		if (text) worker.lastResult = text;
		settleClaudeResult(worker, event, config);
		notifyOrchestratorStateChange(getOrchestratorRuntime());
	}
}

function handleClaudeLine(worker: Worker, line: string, config?: OrchestratorConfig): void {
	const parsed = parseClaudeStreamLine(line);
	if (!parsed.ok) {
		failWorker(worker, "Invalid Claude Code stream JSON.");
		return;
	}
	handleClaudeEvents(worker, parsed.events, config);
}

/** Consume Claude output without waiting for its persistent process to exit. */
function drainClaudeWorkerOutput(worker: Worker, config: OrchestratorConfig): void {
	const parsed = drainClaudeStreamBuffer(worker.buffer);
	worker.buffer = parsed.remainder;
	if (!parsed.ok) {
		failWorker(worker, "Invalid Claude Code stream JSON.");
		return;
	}
	handleClaudeEvents(worker, parsed.events, config);
}

/**
 * Workers inherit the coordinator's environment minus every GitHub, SSH, and
 * Git credential vector. Model-provider auth is preserved exactly. This is not
 * containment — a worker still reads ~/.config/gh and ~/.ssh from disk — it
 * only keeps ambient tokens out of a delegated process that never needs them.
 */
export function workerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const safe: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (["GH_", "GITHUB_", "SSH_", "GIT_"].some((prefix) => key.startsWith(prefix))) continue;
		safe[key] = value;
	}
	return safe;
}

/**
 * Single spawn path for every worker process (initial Pi RPC, initial Claude,
 * and Claude failover respawns). Workers run on the host in the coordinator's
 * repository; each becomes its own process group so a stop, a failover, or
 * coordinator exit can signal the whole tree and no grandchild survives as an
 * orphan.
 */
function spawnWorkerChild(
	command: string,
	args: string[],
	cwd: string,
	envOverrides: Record<string, string>,
	hostEnv: NodeJS.ProcessEnv,
): Worker["process"] {
	return spawn(command, args, {
		cwd,
		env: { ...workerEnv(hostEnv), ...envOverrides },
		stdio: ["pipe", "pipe", "pipe"] as const,
		detached: true,
	});
}

function spawnClaudeChild(profile: ClaudeCodeWorkerProfile, cwd: string, config: OrchestratorConfig, accountDir?: string, resumeSessionId?: string): Worker["process"] {
	// An inherited CLAUDE_CONFIG_DIR (e.g. pi launched from a shell that set
	// one) must not pin every worker to a single account: account choice
	// belongs to the orchestrator's rotation, or to the launcher's own.
	const hostEnv: NodeJS.ProcessEnv = { ...process.env };
	delete hostEnv.CLAUDE_CONFIG_DIR;
	return spawnWorkerChild(
		config.commands.claude,
		[...claudeCodeArgs(profile.model, profile.thinking), ...(resumeSessionId ? ["--resume", resumeSessionId] : [])],
		cwd,
		{ PI_ORCHESTRATOR_WORKER: "1", ...(accountDir ? { CLAUDE_CONFIG_DIR: accountDir } : {}) },
		hostEnv,
	);
}

/** Attach stream handlers to a (possibly replacement) child; stale children's late events are ignored. */
function wireWorkerChild(worker: Worker, child: Worker["process"], config: OrchestratorConfig): void {
	child.stdout.on("data", (chunk: Buffer) => {
		if (worker.process !== child) return;
		worker.buffer += chunk.toString("utf8");
		if (worker.profile.backend === "claude-code") {
			drainClaudeWorkerOutput(worker, config);
			return;
		}
		let newline: number;
		while ((newline = worker.buffer.indexOf("\n")) >= 0) {
			const line = worker.buffer.slice(0, newline).trim();
			worker.buffer = worker.buffer.slice(newline + 1);
			if (line) handleRpcLine(worker, line);
		}
	});
	child.stderr.on("data", (chunk: Buffer) => {
		// Do not retain stderr: it can include local auth/config details. Pi and
		// Claude also emit harmless startup warnings there while their structured
		// stdout protocol remains healthy. Process error/exit handlers still fail
		// workers that actually terminate, so stderr must never override a real
		// assistant result or API error from the structured protocol.
		if (worker.process === child && chunk.length && worker.state !== "stopped") {
			recordWorkerActivity(worker, { at: Date.now(), role: "system", text: "Worker process wrote diagnostic output to stderr." });
		}
	});
	child.on("error", () => {
		if (worker.process !== child) return;
		rejectPendingRpc(worker, new Error("Worker process failed to start."));
		failWorker(worker, "Worker process failed to start.", "unavailable");
	});
	child.on("exit", (code, signal) => {
		if (worker.process !== child) return;
		// stdout data normally arrives before exit. Drain once more so an older
		// Claude Code version that ends on a final JSON event without a newline
		// can settle and report before this persistent-worker error path runs.
		if (worker.profile.backend === "claude-code" && worker.buffer.trim()) drainClaudeWorkerOutput(worker, config);
		rejectPendingRpc(worker, new Error("Worker process exited."));
		if (worker.state !== "stopped" && worker.state !== "idle") {
			failWorker(worker, code === 0
				? "Worker process exited before returning a result."
				: `Worker exited with code ${code ?? "null"} (${signal ?? "no signal"}).`, worker.state === "starting" ? "unavailable" : "failed");
		}
		notifyOrchestratorStateChange(getOrchestratorRuntime());
	});
}

/**
 * A Claude worker's account became unusable — its usage limit was reached, or
 * its credentials expired ("Please run /login"). Both are account problems
 * rather than task outcomes: put that account in cooldown (claude-select and
 * claude-auto honor the same state file) and restart the worker on the next
 * available account, resuming the same Claude session so everything the worker
 * has already done is carried over, then resend the interrupted instruction.
 * Returns false when no account is available, in which case the caller fails
 * the worker.
 */
function failoverClaudeWorker(worker: Worker, config: OrchestratorConfig, reason: "usage-limit" | "auth", errorText: string): boolean {
	const accounts = config.claudeAccounts;
	if (!accounts || worker.profile.backend !== "claude-code") return false;
	if (worker.claudeAccount) {
		// A logged-out account has no reset time to parse; the default cooldown
		// keeps rotation off it until it is re-authenticated.
		markClaudeAccountLimited(accounts, worker.claudeAccount, reason === "auth" ? undefined : parseUsageLimitReset(errorText));
	}
	const pick = pickClaudeAccount(accounts);
	if (!pick) return false;
	// killWorkerProcessTree tolerates an already-gone limited process.
	killWorkerProcessTree(worker.process);
	let child: Worker["process"];
	try {
		child = spawnClaudeChild(worker.profile, worker.cwd, config, pick.configDir, worker.claudeSessionId);
	} catch (error) {
		failWorker(worker, `Account failover could not start a replacement worker: ${error instanceof Error ? error.message : String(error)}`, "unavailable");
		return true; // Handled: the worker is already failed, no double-report.
	}
	worker.process = child;
	worker.buffer = "";
	clearClaudeMergeGrace(worker);
	mergeOutstandingClaudeTurns(worker);
	const failedAccount = worker.claudeAccount;
	worker.claudeAccount = pick.name;
	worker.claudeAuthFailed = undefined;
	worker.state = "working";
	wireWorkerChild(worker, child, config);
	recordWorkerActivity(worker, {
		at: Date.now(),
		role: "system",
		text: reason === "auth"
			? `Account ${failedAccount ?? "(unknown)"} needs re-authentication; switched to account ${pick.name} and resumed this session.`
			: `Usage limit reached; switched to account ${pick.name} and resumed.`,
	});
	const instruction = worker.lastInstruction ?? worker.task;
	if (!sendWorkerInstruction(worker, instruction, true)) {
		failWorker(worker, "Worker stdin was unavailable after an account failover.", "unavailable");
		return true; // Handled: the worker is already failed, no double-report.
	}
	notifyOrchestratorStateChange(getOrchestratorRuntime());
	return true;
}

function launchWorker(name: string, profile: WorkerProfile, task: string, cwd: string, config: OrchestratorConfig, lineage: { rootTaskId: string; retryOf?: string; category: TaskCategory; promptCategory?: TaskCategory; complexity: TaskComplexity; selfPlan?: boolean; planOnly?: boolean; needsWorktree?: boolean; needsHeavyWork?: boolean; needsBrowser?: boolean; needsSecrets?: boolean; prCreationRequested?: boolean; validationCommands?: string[]; knownFacts?: string[] }): Worker {
	const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 8)}`;
	const account = profile.backend === "claude-code" && config.claudeAccounts ? pickClaudeAccount(config.claudeAccounts) : undefined;
	const child = profile.backend === "pi-rpc"
		? spawnWorkerChild(config.commands.pi, piRpcWorkerArgs(profile), cwd, { PI_ORCHESTRATOR_WORKER: "1" }, process.env)
		: spawnClaudeChild(profile, cwd, config, account?.configDir);
	const worker: Worker = {
		id,
		name,
		profile,
		task,
		rootTaskId: lineage.rootTaskId,
		runId: `${id}:run-1`,
		...(lineage.retryOf ? { retryOf: lineage.retryOf } : {}),
		category: lineage.category,
		complexity: lineage.complexity,
		cwd,
		process: child,
		state: "starting",
		run: 1,
		startedAt: new Date(),
		buffer: "",
		transcript: [],
		rpcNextId: 0,
		rpcPending: new Map(),
		...(account ? { claudeAccount: account.name } : {}),
		...(lineage.planOnly ? { planOnly: true } : {}),
		...(lineage.needsWorktree !== undefined ? { needsWorktree: lineage.needsWorktree } : {}),
		...(lineage.needsHeavyWork !== undefined ? { needsHeavyWork: lineage.needsHeavyWork } : {}),
		...(lineage.needsBrowser !== undefined ? { needsBrowser: lineage.needsBrowser } : {}),
		...(lineage.needsSecrets !== undefined ? { needsSecrets: lineage.needsSecrets } : {}),
		...(lineage.prCreationRequested ? { prCreationRequested: true } : {}),
		...(!lineage.planOnly ? { implementationPolicySent: lineage.needsWorktree !== false } : {}),
		...(lineage.needsHeavyWork === true ? { heavyGuidanceSent: true } : {}),
		...(lineage.needsBrowser === true ? { browserGuidanceSent: true } : {}),
		...(lineage.needsSecrets === true ? { secretsGuidanceSent: true } : {}),
		...(!lineage.planOnly && lineage.prCreationRequested ? { prCreationGuidanceSent: true } : {}),
		...(lineage.needsHeavyWork === true && profile.backend === "pi-rpc" ? { backgroundGuidanceSent: true } : {}),
	};
	getOrchestratorRuntime().workers.set(id, worker);
	notifyOrchestratorStateChange(getOrchestratorRuntime());
	wireWorkerChild(worker, child, config);
	if (profile.backend === "claude-code" && config.claudeAccounts && !account) {
		const reset = earliestAccountReset(config.claudeAccounts);
		failWorker(worker, `Every Claude account is in usage-limit cooldown${reset ? ` (earliest reset ${new Date(reset * 1_000).toLocaleTimeString()})` : ""}. Use a Pi worker or retry later.`, "unavailable");
		killWorkerProcessTree(child);
		return worker;
	}

	const prompt = buildWorkerPrompt({
		worker: name,
		task,
		cwd,
		backend: profile.backend,
		selfPlan: lineage.selfPlan ?? profile.selfPlanning === true,
		...(lineage.planOnly ? { planOnly: true } : {}),
		...(lineage.promptCategory ? { category: lineage.promptCategory } : {}),
		...(lineage.needsWorktree !== undefined ? { needsWorktree: lineage.needsWorktree } : {}),
		...(lineage.needsHeavyWork !== undefined ? { needsHeavyWork: lineage.needsHeavyWork } : {}),
		...(lineage.needsBrowser !== undefined ? { needsBrowser: lineage.needsBrowser } : {}),
		...(lineage.needsSecrets !== undefined ? { needsSecrets: lineage.needsSecrets } : {}),
		...(lineage.prCreationRequested ? { prCreationRequested: true } : {}),
		...(lineage.validationCommands ? { validationCommands: lineage.validationCommands } : {}),
		...(lineage.knownFacts ? { knownFacts: lineage.knownFacts } : {}),
	});
	worker.promptMetrics = measureWorkerPrompt(task, prompt);
	recordWorkerActivity(worker, { at: Date.now(), role: "user", text: task });
	if (!sendWorkerInstruction(worker, prompt)) failWorker(worker, "Worker stdin was unavailable at startup.", "unavailable");
	notifyOrchestratorStateChange(getOrchestratorRuntime());
	return worker;
}

export default function orchestrator(pi: ExtensionAPI) {
	if (process.env.PI_ORCHESTRATOR_WORKER === "1") return;
	const config = loadOrchestratorConfig();
	const catalog = config.workers;
	const catalogNames = catalogText(catalog);
	const delegateWorkerSchema = createWorkerSchema(catalog);
	// First recover the narrowly scoped stale-v2 overwrite mode, then normalize
	// any remaining legacy shape. Both paths snapshot before writing.
	recoverStaleV2StatsLedger(undefined, workerNames(catalog));
	cleanStatsLedger(undefined, workerNames(catalog));

	// Workers are unref'd so a settled -p host can exit; make sure that exit
	// also reaps any still-running worker processes instead of orphaning them.
	const runtime = getOrchestratorRuntime();
	const generation = bindOrchestratorApi(runtime, pi);
	ensureOrchestratorExitHook(runtime);
	flushDeferredWorkerReports();

	// Passive worker assessments inspect only captured state/transcript. Healthy
	// checks are a hidden next-turn custom message; suspicious checks alone wake
	// the coordinator. Neither path writes to the worker process.
	const checkInIntervalMs = config.checkInMinutes * 60_000;
	const startCheckInTimer = () => {
		if (checkInIntervalMs <= 0 || runtime.checkInTimer !== undefined || runtime.generation !== generation) return;
		const checkInTimer = setInterval(() => {
			if (runtime.generation !== generation || isWorkerReportDeliveryHeld(runtime) || !runtime.api) return;
			// Read the ledger at most once per tick, and only when a check is
			// actually due, so idle ticks stay free of file IO.
			let ledger: StatsLedger | undefined;
			for (const worker of runtime.workers.values()) {
				if (!isCheckInDue(worker, checkInIntervalMs)) continue;
				const checkedAt = Date.now();
				const assessment = assessWorkerCheckIn(worker, checkInIntervalMs, checkedAt);
				try {
					ledger ??= loadStats(undefined, workerNames(catalog));
				} catch {
					// A missing or unreadable ledger only costs the estimate.
				}
				const estimate = ledger ? workerDurationEstimate(ledger, worker.name, { category: worker.category, complexity: worker.complexity }, checkedAt) : undefined;
				const digest = buildCheckInDigest(worker, checkInIntervalMs, checkedAt, assessment, estimate);
				try {
					const wake = shouldWakeForCheckIn(worker, assessment);
					if (assessment.status === "healthy") deliverCheckIn(runtime.api, digest, assessment);
					else if (wake) {
						deliverCheckIn(runtime.api, digest, assessment);
						worker.lastAlertAt = new Date(checkedAt);
						worker.lastAlertRevision = worker.transcriptRevision;
					}
					worker.lastCheckinAt = new Date(checkedAt);
					worker.lastCheckinRevision = worker.transcriptRevision;
					worker.healthStreak = assessment.status === "healthy" ? (worker.healthStreak ?? 0) + 1 : 0;
				} catch {
					// A torn-down session must not break the timer; the next tick retries.
				}
			}
		}, 60_000);
		runtime.checkInTimer = checkInTimer;
		checkInTimer.unref?.();
	};

	let refreshWorkerWidget = () => {};
	let stopWorkerWidgetTimer = () => {};
	let takeoverReason = "explicit user request";
	const solToolMode = new SolToolMode();

	const activate = async (ctx: { modelRegistry: { find(provider: string, id: string): unknown }; cwd: string }) => {
		if (config.coordinator.provider && config.coordinator.id) {
			const coordinator = ctx.modelRegistry.find(config.coordinator.provider, config.coordinator.id);
			if (coordinator) void pi.setModel(coordinator as never).catch(() => {});
		}
		pi.setThinkingLevel(config.coordinator.thinking);
		pi.setActiveTools(solToolMode.activate(pi.getActiveTools(), pi.getAllTools().map((tool) => tool.name)));
	};

	pi.on("session_start", async (_event, ctx) => {
		startCheckInTimer();
		stopWorkerWidgetTimer();
		refreshWorkerWidget = () => {};
		await activate(ctx);
		// RPC workers never create footer components or timers. Their status uses
		// Pi's structured extension UI channel, not the rendered TUI footer.
		if (!ctx.hasUI || ctx.mode !== "tui") {
			const emitHeadlessWorkerStatus = () => {
				if (runtime.generation !== generation) return;
				const revision = nextWorkerStatusRevision(runtime);
				ctx.ui.setWidget(WORKER_STATUS_WIDGET_ID, workerStatusWidgetLines(runtime.workers.values(), {
					revision,
					sessionId: ctx.sessionManager.getSessionId(),
					emittedAt: new Date(),
				}));
			};
			refreshWorkerWidget = emitHeadlessWorkerStatus;
			bindOrchestratorSession(runtime, generation, pi, emitHeadlessWorkerStatus, shouldReapHeadlessSession(), () => {});
			emitHeadlessWorkerStatus();
			flushDeferredWorkerReports();
			return;
		}

		// Remove the old above-footer widget if this session was reloaded.
		ctx.ui.setWidget(LEGACY_WORKER_WIDGET_ID, undefined);
		let timer: ReturnType<typeof setInterval> | undefined;
		let footerInstalled = false;
		let requestFooterRender = () => {};
		// Footer keyboard selection: down from an empty editor enters the worker
		// rows, enter opens that worker's session view, esc/up-past-top returns.
		let selectedWorkerId: string | undefined;
		let viewerOpen = false;
		// Only live workers are shown and selectable. Expiration must never
		// discard the final handle to a child that has not exited: enforce the
		// post-review stop invariant first, then prune on a later render.
		const pruneExpiredWorkers = () => {
			for (const worker of [...runtime.workers.values()]) {
				if (worker.id === selectedWorkerId || viewerOpen || !isExpiredWorker(worker)) continue;
				if (isWorkerProcessLive(worker.process)) {
					stopWorkerProcess(worker);
					continue;
				}
				runtime.workers.delete(worker.id);
			}
		};
		const selectableWorkerIds = () => {
			pruneExpiredWorkers();
			return panelWorkers([...runtime.workers.values()]).map((worker) => worker.id);
		};
		const stopTimer = () => {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
		};
		const removeFooter = () => {
			if (!footerInstalled) return;
			footerInstalled = false;
			requestFooterRender = () => {};
			ctx.ui.setFooter(undefined); // Restore Pi's native footer when workers settle.
		};
		const installFooter = () => {
			if (footerInstalled) {
				requestFooterRender();
				return;
			}
			footerInstalled = true;
			ctx.ui.setFooter((tui, theme, footerData) => {
				requestFooterRender = () => tui.requestRender();
				const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
				return {
					render: (width: number) => {
						const rows = renderWorkerFooterRows(
							workerWidgetLines(Date.now(), width, { selectedId: selectedWorkerId }),
							theme,
						);
						return [
							...renderBaseFooter(ctx as never, footerData as never, theme as never, pi.getThinkingLevel(), width),
							...rows,
						];
					},
					invalidate: () => tui.requestRender(),
					dispose: unsubscribe,
				};
			});
		};
		const render = () => {
			// A selected worker that settles leaves the list; drop the selection
			// with it (but not while its session view is open).
			if (selectedWorkerId !== undefined && !viewerOpen && !selectableWorkerIds().includes(selectedWorkerId)) {
				selectedWorkerId = undefined;
			}
			if (hasAnimatingWorker([...runtime.workers.values()]) || selectedWorkerId !== undefined) installFooter();
			else removeFooter();
		};
		const reconcileTimer = () => {
			if (!hasAnimatingWorker([...runtime.workers.values()])) {
				stopTimer();
				return;
			}
			if (timer === undefined) {
				timer = setInterval(() => {
					// Only redraw local in-memory state; no I/O, RPC, subprocess, or model call.
					render();
					if (!hasAnimatingWorker([...runtime.workers.values()])) stopTimer();
				}, WORKER_WIDGET_TICK_MS);
			}
		};
		const redraw = () => {
			render();
			requestFooterRender();
		};
		const openWorkerSession = (workerId: string) => {
			const opened = runtime.workers.get(workerId);
			if (!opened) return;
			// Workers launched by an older extension generation have no captured
			// transcript; best-effort seed it with the worker's latest reply.
			if (!opened.transcript?.length && opened.profile.backend === "pi-rpc" && canSteerWorker(opened, opened.process)) {
				void requestWorkerRpc(opened, { type: "get_last_assistant_text" })
					.then((response) => {
						const text = response && typeof response === "object" && typeof (response as { text?: unknown }).text === "string"
							? (response as { text: string }).text
							: undefined;
						if (text) appendTranscript(opened.transcript ??= [], "assistant", text);
					})
					.catch(() => {});
			}
			viewerOpen = true;
			// Minimize writes under the overlay: pi's overlay lives in a
			// line-indexed buffer, so any base-screen change rewrites the whole
			// viewport. Hide the streaming loader and hold worker reports (which
			// would start a coordinator turn) until the view closes.
			runtime.reportsHeld = true;
			ctx.ui.setWorkingVisible(false);
			void ctx.ui
				.custom<void>(
					(tui, theme, _keybindings, done) => {
						// Wheel events only reach the extension while tracking is on, and the
						// terminal must be put back the way it was found on the way out.
						const writeRaw = (sequence: string) => { try { process.stdout.write(sequence); } catch { /* a closed stdout is not worth failing the view over */ } };
						writeRaw(MOUSE_TRACKING_ON);
						const restoreMouse = () => writeRaw(MOUSE_TRACKING_OFF);
						process.once("exit", restoreMouse);
						let scrollUp = 0;
						// Anchoring state: a scrolled viewport must keep showing the same
						// lines when the worker appends new output below them.
						let lastBodyLength = 0;
						let lastWidth = 0;
						let pageSize = 10;
						let cachedKey = "";
						let cachedBody: string[] = [];
						// Live view: poll local state only, and only redraw when the
						// transcript actually changed; no I/O or model calls.
						let lastSignature = "";
						const tick = setInterval(() => {
							const worker = runtime.workers.get(workerId);
							const signature = worker ? `${worker.transcriptRevision ?? worker.transcript?.length ?? 0}:${worker.state}` : "gone";
							if (signature !== lastSignature) {
								lastSignature = signature;
								tui.requestRender();
							}
						}, 500);
						// Native pi look: transcript entries render through pi's own
						// message components (markdown, theme colors, word wrap).
						const renderToolEntry = (entry: TranscriptEntry, width: number): string[] => {
							// Pi's own tool row: built-in tools (bash, read, edit, …) get
							// their exact native rendering, unknown tools the generic shell.
							const call = entry.tool!;
							const component = new ToolExecutionComponent(
								call.name,
								call.callId ?? "transcript",
								call.args ?? {},
								{ showImages: false },
								undefined,
								tui,
								runtime.workers.get(workerId)?.cwd ?? process.cwd(),
							);
							component.markExecutionStarted();
							component.setArgsComplete();
							if (call.result) component.updateResult(call.result, false);
							return component.render(width);
						};
						const buildBody = (worker: Worker, width: number): string[] => {
							const transcript = worker.transcript ?? [];
							const key = `${worker.transcriptRevision ?? transcript.length}:${width}`;
							if (key === cachedKey) return cachedBody;
							const markdownTheme = getMarkdownTheme();
							const lines: string[] = [];
							for (const entry of transcript) {
								try {
									if (entry.role === "user") {
										lines.push(...new UserMessageComponent(entry.text, markdownTheme).render(width));
									} else if (entry.role === "assistant") {
										const part = entry.thinking ? { type: "thinking", thinking: entry.text } : { type: "text", text: entry.text };
										const message = { content: [part] };
										lines.push(...new AssistantMessageComponent(message as never, false, markdownTheme).render(width));
									} else if (entry.role === "tool" && entry.tool?.name) {
										lines.push(...renderToolEntry(entry, width));
									} else if (entry.role === "tool") {
										// Legacy flattened entries (pre-structured transcripts):
										// one truncated summary line, never a wall of wrapped text.
										const summary = entry.text.split(/\r?\n/, 1)[0] ?? "";
										const chars = Array.from(` ⚒ ${summary}`);
										lines.push(theme.fg("toolTitle", chars.length > width ? `${chars.slice(0, Math.max(1, width - 1)).join("")}…` : chars.join("")));
									} else {
										lines.push(...wrapPlainText(entry.text, width - 2).map((line) => theme.fg("error", ` ${line}`)));
									}
								} catch {
									lines.push(...wrapPlainText(entry.text, width - 2).map((line) => ` ${line}`));
								}
								lines.push("");
							}
							cachedKey = key;
							cachedBody = lines;
							return lines;
						};
						return {
							render: (width: number) => {
								const worker = runtime.workers.get(workerId);
								if (!worker) return [theme.fg("dim", "Worker is gone.")];
								const height = Math.max(12, process.stdout.rows ?? 30);
								const title = workerSessionTitle(worker.name, worker.state, worker.id);
								// Workers launched before this version predate the transcript field.
								const body = buildBody(worker, width);
								// A resize rewraps every line, so its length change is not new output.
								if (width !== lastWidth) { lastBodyLength = body.length; lastWidth = width; }
								scrollUp = anchorScrollUp(scrollUp, lastBodyLength, body.length);
								const view = renderSessionScreen(title, body, width, height, scrollUp, theme);
								scrollUp = Math.min(scrollUp, view.maxScrollUp);
								lastBodyLength = view.bodyLength;
								pageSize = Math.max(1, view.viewport - 1);
								return view.lines;
							},
							handleInput: (data: string) => {
								const wheel = wheelDirection(data);
								if (wheel) scrollUp = Math.max(0, scrollUp + (wheel === "up" ? WHEEL_SCROLL_LINES : -WHEEL_SCROLL_LINES));
								else if (isUpKey(data)) scrollUp += 1;
								else if (isDownKey(data)) scrollUp = Math.max(0, scrollUp - 1);
								else if (isPageUpKey(data)) scrollUp += pageSize;
								else if (isPageDownKey(data)) scrollUp = Math.max(0, scrollUp - pageSize);
								// Home reaches the oldest captured output; end resumes following.
								else if (isHomeKey(data)) scrollUp = Number.MAX_SAFE_INTEGER;
								else if (isEndKey(data)) scrollUp = 0;
								else if (isEscapeKey(data) || data === "q") {
									done(undefined);
									return;
								} else return;
								tui.requestRender();
							},
							invalidate: () => {},
							dispose: () => {
							clearInterval(tick);
							process.off("exit", restoreMouse);
							restoreMouse();
						},
						};
					},
					// Full-terminal takeover: extensions cannot swap pi's core chat
					// view, so the session view covers it edge to edge instead.
					{ overlay: true, overlayOptions: { width: "100%", anchor: "top-left", row: 0, col: 0 } },
				)
				.catch(() => {})
				.finally(() => {
					viewerOpen = false;
					runtime.reportsHeld = false;
					ctx.ui.setWorkingVisible(true);
					flushDeferredWorkerReports();
					redraw();
				});
		};
		const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			if (viewerOpen) return undefined;
			if (selectedWorkerId === undefined) {
				// Only an empty editor hands the down arrow over to the worker rows,
				// so history navigation and multi-line editing keep their keys.
				if (!isDownKey(data) || ctx.ui.getEditorText() !== "") return undefined;
				const ids = selectableWorkerIds();
				if (ids.length === 0) return undefined;
				selectedWorkerId = moveSelection(ids, undefined, "down");
				redraw();
				return { consume: true };
			}
			if (isUpKey(data) || isDownKey(data)) {
				selectedWorkerId = moveSelection(selectableWorkerIds(), selectedWorkerId, isUpKey(data) ? "up" : "down");
				redraw();
				return { consume: true };
			}
			if (isEnterKey(data)) {
				openWorkerSession(selectedWorkerId);
				redraw();
				return { consume: true };
			}
			if (isEscapeKey(data)) {
				selectedWorkerId = undefined;
				redraw();
				return { consume: true };
			}
			// Any other key returns focus to the editor and is handled normally.
			selectedWorkerId = undefined;
			redraw();
			return undefined;
		});
		const disposeUi = () => {
			unsubscribeInput();
			selectedWorkerId = undefined;
			runtime.reportsHeld = false;
			stopTimer();
			removeFooter();
			ctx.ui.setWidget(LEGACY_WORKER_WIDGET_ID, undefined);
		};
		stopWorkerWidgetTimer = disposeUi;
		refreshWorkerWidget = () => {
			render(); // Lifecycle transitions are reflected immediately.
			reconcileTimer();
		};
		if (!bindOrchestratorSession(runtime, generation, pi, refreshWorkerWidget, false, disposeUi)) return;
		flushDeferredWorkerReports();
		refreshWorkerWidget();
	});

	pi.on("session_shutdown", () => {
		// A stale /reload callback cannot detach the newer generation's bindings.
		releaseOrchestratorSession(runtime, generation);
	});

	pi.on("agent_end", () => {
		if (runtime.generation === generation) holdWorkerReportDelivery(runtime, "settling");
	});

	pi.on("session_before_compact", () => {
		if (runtime.generation === generation) holdWorkerReportDelivery(runtime, "compaction");
	});

	pi.on("session_compact", () => {
		// Pi emits this while its compaction call stack is still active. Releasing
		// on the next macrotask prevents sendUserMessage() from entering that stack.
		scheduleWorkerReportDelivery(runtime, generation, ["compaction"], flushDeferredWorkerReports);
	});

	pi.on("input", async (event, ctx) => {
		// Worker-result follow-ups are extension messages, not a user asking Sol
		// to take over. Explicit solo prompts and the inspected fast path use the
		// same one-task escape hatch; agent_settled restores orchestration afterward.
		if (event.source === "extension") return { action: "continue" };
		// A cancelled/failed compaction may emit no session_compact (and an
		// aborted turn may emit no settled event). Only idle real input proves Pi
		// accepted a new safe boundary: streaming steer/follow-up input must retain
		// the settlement guard. Flush after this callback, never reentrantly in it.
		if (runtime.generation === generation) {
			scheduleIdleWorkerReportRecovery(runtime, generation, ctx.isIdle(), flushDeferredWorkerReports);
		}
		// agent_settled never fires for a takeover turn the user aborted (esc),
		// which used to leave takeover stuck on. A fresh user prompt while the
		// agent is idle means that task is over: restore orchestration first,
		// then let this prompt request a new takeover if it explicitly asks.
		if (solToolMode.takeoverActive && ctx.isIdle()) {
			const restoredTools = solToolMode.settle();
			if (restoredTools) pi.setActiveTools(restoredTools);
		}
		const takeoverTools = solToolMode.beginTakeover(
			event.text,
			pi.getActiveTools(),
			pi.getAllTools().map((tool) => tool.name),
		);
		if (!takeoverTools) return { action: "continue" };
		pi.setActiveTools(takeoverTools);
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event) => {
		const prompt = typeof (event as { prompt?: unknown }).prompt === "string" ? (event as { prompt: string }).prompt : "";
		const classification = classifyTask(prompt);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${solToolMode.takeoverActive
				? TAKEOVER_SYSTEM_INSTRUCTIONS(takeoverReason)
				: coordinatorInstructions(catalog, statsSummary(loadStats(undefined, workerNames(catalog)), workerNames(catalog), classification))}`,
		};
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const restrictedTools = solToolMode.settle();
		// This is the first boundary after a result follow-up and its coordinator
		// review. A still-idle reported run was accepted; correction steers resolve
		// it to rework before they begin their next lifecycle run.
		acceptReviewedRuns(runtime.workers.values());
		if (restrictedTools) pi.setActiveTools(restrictedTools);
		// agent_settled is Pi's safe boundary: unlike agent_end, no automatic
		// retry, compaction retry, or queued follow-up remains active.
		let rolloverStarted = false;
		if (runtime.generation === generation && isOutcomeRolloverEligible("agent_settled", runtime.workers.values(), runtime, ctx.getContextUsage(), config.rolloverContextPercent)) {
			const version = beginOutcomeRollover(runtime);
			if (version !== undefined) {
				rolloverStarted = true;
				// Close the gap before ctx.compact synchronously emits its before event.
				holdWorkerReportDelivery(runtime, "compaction");
				releaseWorkerReportDelivery(runtime, "settling");
				try {
					ctx.compact({
						customInstructions: OUTCOME_ROLLOVER_INSTRUCTIONS,
						onComplete: () => {
							completeOutcomeRollover(runtime, version);
							scheduleWorkerReportDelivery(runtime, generation, ["compaction"], flushDeferredWorkerReports);
						},
						onError: () => {
							failOutcomeRollover(runtime, version);
							scheduleWorkerReportDelivery(runtime, generation, ["compaction"], flushDeferredWorkerReports);
						},
					});
				} catch {
					failOutcomeRollover(runtime, version);
					scheduleWorkerReportDelivery(runtime, generation, ["compaction"], flushDeferredWorkerReports);
				}
			}
		}
		if (!rolloverStarted && runtime.generation === generation) {
			releaseWorkerReportDelivery(runtime, "settling");
			// This safe boundary also recovers a cancelled/failed compaction that
			// emitted no session_compact event.
			scheduleWorkerReportDelivery(runtime, generation, ["compaction"], flushDeferredWorkerReports);
		}
		// Do not let a stale generation reap workers after a reload. At the
		// current generation's safe review boundary, stop every delivered run
		// that was not steered into a newer generation during review.
		if (runtime.generation !== generation) return;
		for (const worker of runtime.workers.values()) {
			if (shouldAutoStopReportedWorker(worker)) stopWorkerProcess(worker);
		}
	});

	pi.registerCommand("orchestrator", {
		description: `Activate orchestration mode (${catalogNames} are persistent workers); also exits a stuck takeover`,
		handler: async (_args, ctx) => {
			await activate(ctx);
			ctx.ui.notify(`Orchestration mode is active. Delegate to ${catalogNames}.`, "info");
		},
	});

	pi.registerTool({
		name: "orchestrator_takeover",
		label: "Take over implementation",
		description: "Call once for a one-task Sol takeover after read-only inspection. Use it without an explicit solo request only when the root cause and exact change are known, the change is small and local (normally one file or a few tightly related files), risk is low, and validation is short and focused. Never use that fast path for security or auth work, destructive actions, data or schema migrations, deploys, broad refactors, public API changes, or ambiguous work. An explicit user request to work without delegation always selects takeover, whatever its wording. Enables normal implementation tools for exactly one task and starts a follow-up turn; orchestration resumes when that task settles. Use orchestrator_delegate for other work.",
		parameters: Type.Object({
			reason: Type.String({ description: "Short reason: quote the explicit solo request, or name the inspected root cause, small local change, low risk, and focused validation that qualify for the fast path." }),
		}),
		execute: async (_toolCallId, params) => {
			takeoverReason = params.reason;
			pi.setActiveTools(solToolMode.beginTakeoverTool(pi.getActiveTools(), pi.getAllTools().map((tool) => tool.name)));
			return content(`Direct mode enabled (${params.reason}).`);
		},
	});

	pi.registerTool({
		name: "orchestrator_delegate",
		label: "Delegate to worker",
		description: `Start a persistent ${catalogNames} implementation worker. Its final result is delivered to the coordinator. Delegate only work that should not use the qualifying takeover fast path. Independent workstreams may be delegated to different workers in one turn only when they are truly independent; do not split tiny work just to meet a worker count.${config.maxConcurrentWorkers > 0 ? ` At most ${config.maxConcurrentWorkers} workers may be live at once; delegation beyond that is rejected until one settles, so plan fan-out within that limit.` : ""} For a separately delegated retry, pass retryOf as the original root task ID returned in tool details; it joins that root only when resolvable. Category is one of ${TASK_CATEGORIES.join(", ")}; complexity is low, medium, or high.`,
		executionMode: "parallel",
		parameters: Type.Object({
			worker: delegateWorkerSchema,
			task: Type.String({ description: "Complete worker brief. Start directly with coordinator investigation, facts, conclusions, and constraints. Carry forward exact paths, stable symbols or line ranges when useful, concrete root cause, planned changes, edge cases, acceptance criteria, and exact focused validation commands when discoverable. Do not begin with a Requested outcome heading, a request paraphrase, a command, an implementation summary, or any similar restatement of what the user wants. Do not require broad rediscovery, brittle line numbers, or large code dumps. End with a separately labeled verbatim user operative request; only when the request is too large, use a clearly labeled faithful excerpt. Nothing may follow that final user-request section. Never ask the worker to diagnose something you already determined, and never silently replace the user's request with your inferred plan." }),
			cwd: Type.Optional(Type.String({ description: "Absolute repository directory the worker runs in. Defaults to the coordinator's session directory." })),
			relationship: Type.Union([
				Type.Literal("new"), Type.Literal("continuation"), Type.Literal("replacement"), Type.Literal("correction"), Type.Literal("retry"),
			], { description: "Declare new only for genuinely distinct work. Every continuation, replacement, correction, or retry must carry retryOf with the prior worker ID; omission must never reset lineage budgets." }),
			retryOf: Type.Optional(Type.String({ description: "Prior worker ID for a linked continuation, replacement, correction, or retry. Omit only for a genuinely distinct new task or when autonomousScope supplies source-authorized lineage." })),
			category: Type.Optional(Type.Union(TASK_CATEGORIES.map((value) => Type.Literal(value)))),
			complexity: Type.Optional(Type.Union(TASK_COMPLEXITIES.map((value) => Type.Literal(value)))),
			selfPlan: Type.Optional(Type.Boolean({ description: "True when this brief states a goal and leaves the approach to the worker; false when it carries a plan for the worker to execute. Set it explicitly whenever the user says in plain English who should plan. Omit to use the worker's configured default." })),
			planOnly: Type.Optional(Type.Boolean({ description: "True when the plan itself is the deliverable: the worker investigates and reports an approach, changing nothing. Set it whenever the user asked for a plan, approach, or options without asking for the work to be done. The plan returns to you for the user to approve; implementing it is a separate delegation." })),
			prCreationRequested: Type.Optional(Type.Boolean({ description: "Set true only when the user explicitly asked to create or update a pull request. Do not infer this from task text. A request to review a pull request does not qualify." })),
			needsWorktree: Type.Optional(Type.Boolean({ description: "Set false only when this task does not need worktree lifecycle guidance, such as read-only research. Omit to preserve the implementation default." })),
			needsHeavyWork: Type.Optional(Type.Boolean({ description: "Set true when the task needs heavy-command or resource guidance. Set false for concise read-only research or documentation unless heavy work is authorized and needed." })),
			needsBrowser: Type.Optional(Type.Boolean({ description: "Set true when the worker needs browser guidance." })),
			needsSecrets: Type.Optional(Type.Boolean({ description: "Set true only when the task needs secrets. This adds policy text only and never reads secrets." })),
			validationCommands: Type.Optional(Type.Array(Type.String({ maxLength: 4000 }), { maxItems: 12 })),
			knownFacts: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 12 })),
			subscriptionSensitive: Type.Optional(Type.Boolean({ description: "Set true only when the user explicitly asks for subscription limits, quota-aware routing, or cost-effective subscription use. Do not infer it from ordinary task text. When true, prefer GPT-5.6 Luna Low or Medium for routine work, Luna High for moderate reasoning, and Luna xHigh for deep reasoning when they can avoid retries. Explicit user-selected models and advisor routing always win." })),
			autonomousScope: Type.Optional(Type.Object({
				capabilityId: Type.String(),
				runId: Type.String(),
				projectId: Type.String(),
				workItemId: Type.String(),
				dispatchId: Type.String(),
				generation: Type.Integer({ minimum: 0 }),
				role: Type.Union([Type.Literal("implementation"), Type.Literal("review"), Type.Literal("fix"), Type.Literal("replacement"), Type.Literal("continuation")]),
			})),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const name = params.worker as string;
			const scope = params.autonomousScope as AutonomousScope | undefined;
			const authorization = validateScope(ctx.sessionManager.getEntries() as any[], scope);
			if (!authorization.ok && (authorization.active || scope)) {
				return content(`Delegation rejected: ${authorization.error}`, { rejected: true });
			}
			const binding = authorization.ok ? authorization.binding : undefined;
			const requestedRetry = typeof params.retryOf === "string" ? params.retryOf.trim() : undefined;
			const prior = requestedRetry ? runtime.workers.get(requestedRetry) : undefined;
			let rootTaskId: string;
			let retryOf: string | undefined;
			if (authorization.ok) {
				if (requestedRetry && (!prior || (binding && prior.rootTaskId !== binding.rootTaskId))) {
					return content("Delegation rejected: retryOf conflicts with the source-authorized autonomous root.", { rejected: true });
				}
				rootTaskId = binding?.rootTaskId ?? prior?.rootTaskId ?? `task-${randomUUID()}`;
				retryOf = prior?.id;
			} else {
				const relationship = validateDelegationRelationship(params.relationship, requestedRetry, Boolean(prior));
				if (!relationship.ok) return content(`Delegation rejected: ${relationship.error}`, { rejected: true });
				rootTaskId = prior?.rootTaskId ?? `task-${randomUUID()}`;
				retryOf = prior?.id;
			}
			const fallback = classifyTask(params.task);
			const suppliedCategory: unknown = params.category;
			const suppliedComplexity: unknown = params.complexity;
			const promptCategory = typeof suppliedCategory === "string" && TASK_CATEGORIES.includes(suppliedCategory as TaskCategory) ? suppliedCategory as TaskCategory : undefined;
			const category = promptCategory ?? fallback.category;
			const planOnly = params.planOnly === true;
			// Conditional prompt policy uses explicit metadata only. The fallback classification remains stats metadata.
			const researchLike = promptCategory === "research" || promptCategory === "documentation";
			const needsWorktree = typeof params.needsWorktree === "boolean" ? params.needsWorktree : !planOnly && !researchLike;
			const needsHeavyWork = typeof params.needsHeavyWork === "boolean" ? params.needsHeavyWork : !planOnly && !researchLike;
			const needsBrowser = params.needsBrowser === true;
			const needsSecrets = params.needsSecrets === true;
			const validationCommands = Array.isArray(params.validationCommands) ? params.validationCommands.filter((command): command is string => typeof command === "string" && command.trim().length > 0) : undefined;
			const knownFacts = Array.isArray(params.knownFacts) ? params.knownFacts.filter((fact): fact is string => typeof fact === "string" && fact.trim().length > 0) : undefined;
			const policyWarnings = lintWorkerTaskPolicyDuplication(params.task);
			const subscriptionGuidance = params.subscriptionSensitive === true ? subscriptionSensitiveWorkerSelectionGuidance(catalog) : undefined;
			const profile = catalog[name];
			if (!profile) return content(`Delegation rejected: ${name} is not a configured worker.`);
			const cwd = resolve(typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : ctx.cwd);
			let workerTask: string;
			try {
				workerTask = withOrchestratorDelegationContract(params.task, rootTaskId, {
					planOnly,
					needsWorktree,
					prCreationRequested: params.prCreationRequested === true,
				});
			} catch (error) {
				return content(`Delegation rejected: ${error instanceof Error ? error.message : String(error)}`);
			}
			// Settled workers stay in the map until a later render prunes them, so
			// admission counts live processes: those are what actually hold memory.
			// This check and the launch stay in one synchronous block because
			// delegation runs in parallel mode and two calls must not both pass.
			const live = [...runtime.workers.values()].filter((candidate) => isWorkerProcessLive(candidate.process));
			if (config.maxConcurrentWorkers > 0 && live.length >= config.maxConcurrentWorkers) {
				return content(`Delegation rejected: ${live.length} of ${config.maxConcurrentWorkers} allowed workers are already live (${live.map((candidate) => candidate.id).join(", ")}). Wait for one to settle, or stop one, before delegating again.`);
			}
			let worker: Worker;
			try {
				worker = launchWorker(name, profile, workerTask, cwd, config, {
					rootTaskId,
					...(retryOf ? { retryOf } : {}),
					category,
					...(promptCategory ? { promptCategory } : {}),
					complexity: typeof suppliedComplexity === "string" && TASK_COMPLEXITIES.includes(suppliedComplexity as TaskComplexity) ? suppliedComplexity as TaskComplexity : fallback.complexity,
					// An explicit per-task choice wins; the profile default applies only when the coordinator did not choose.
					selfPlan: typeof params.selfPlan === "boolean" ? params.selfPlan : profile.selfPlanning === true,
					...(planOnly ? { planOnly: true } : {}),
					needsWorktree,
					needsHeavyWork,
					needsBrowser,
					needsSecrets,
					...(params.prCreationRequested === true ? { prCreationRequested: true } : {}),
					...(validationCommands ? { validationCommands } : {}),
					...(knownFacts ? { knownFacts } : {}),
				});
			} catch (error) {
				return content(`Delegation rejected: the worker process could not be started (${error instanceof Error ? error.message : String(error)}).`);
			}
			if (authorization.ok && !authorization.binding && scope) {
				pi.appendEntry(AUTONOMOUS_LINEAGE_ENTRY, {
					version: 1,
					kind: "bind",
					capabilityId: scope.capabilityId,
					runId: scope.runId,
					projectId: scope.projectId,
					workItemId: scope.workItemId,
					rootTaskId: worker.rootTaskId,
					workerId: worker.id,
					at: Date.now(),
				});
			}
			return content(`Started ${worker.name} as ${worker.id}. It can be steered while active; its result will return directly to you.`, {
				workerId: worker.id,
				rootTaskId: worker.rootTaskId,
				runId: worker.runId,
				...(policyWarnings.length ? { warnings: policyWarnings.map((warning) => warning.message) } : {}),
				...(subscriptionGuidance ? { subscriptionGuidance } : {}),
			});
		},
	});

	pi.registerTool({
		name: "orchestrator_steer",
		label: "Steer worker",
		description: `Send real continuation or correction instructions to a live configured worker (${catalogNames}), including a Pi worker waiting for its own background job. Do not use this for status-only check-ins. Set kind to correction when the preceding completed result needs rework, or continuation when it is accepted and work continues on the same root. Allow at most one silent correction steer for the same failed attempt; if it still fails, do not loop silently — delegate one concrete retry with retryOf or report/ask about the blocker. Continuation steers for accepted work remain allowed. Omitted kind conservatively means correction. Set interrupt true only when the worker has an in-flight run that is actively heading the wrong way and must not continue: a Pi worker's current run is aborted before the instructions are delivered (its partial result is discarded). A Pi worker that already settled and is waiting for a background job has no active turn to abort, so its useful follow-up is sent without an abort. A Claude worker cannot be aborted mid-turn, so the instructions queue for its next turn boundary instead.`,
		parameters: Type.Object({
			workerId: Type.String({ description: "Worker ID returned by orchestrator_delegate." }),
			instructions: Type.String({ description: "Concrete follow-up instructions for the worker." }),
			kind: Type.Optional(Type.Union([Type.Literal("correction"), Type.Literal("continuation")])),
			interrupt: Type.Optional(Type.Boolean({ description: "Abort the in-flight run before delivering the instructions (Pi workers only; discards the aborted run's partial result). Use only to stop active wrong-direction work, never for routine follow-ups." })),
			planOnly: Type.Optional(Type.Boolean({ description: "Switch this live worker's mode. False authorizes it to implement the plan it reported; true stops it implementing and makes the plan the deliverable, keeping any work already on disk. Omit to leave the current mode unchanged." })),
			prCreationRequested: Type.Optional(Type.Boolean({ description: "Set true only when this follow-up introduces an explicit user request to create or update a pull request. Do not set it for pull request review or infer it from instructions." })),
			needsWorktree: Type.Optional(Type.Boolean({ description: "Set false only when this follow-up does not need worktree lifecycle guidance." })),
			needsHeavyWork: Type.Optional(Type.Boolean({ description: "Set true when this follow-up needs heavy-command or resource guidance." })),
			needsBrowser: Type.Optional(Type.Boolean({ description: "Set true when this follow-up needs browser guidance." })),
			needsSecrets: Type.Optional(Type.Boolean({ description: "Set true only when this follow-up needs secrets. This adds policy text only and never reads secrets." })),
			validationCommands: Type.Optional(Type.Array(Type.String({ maxLength: 4000 }), { maxItems: 12 })),
			knownFacts: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 12 })),
		}),
		execute: async (_toolCallId, params) => {
			const worker = runtime.workers.get(params.workerId);
			if (!worker) return content(`No worker exists with ID ${params.workerId}.`);
			if (!canSteerWorker(worker, worker.process)) {
				return content(`${worker.id} is not live or is still settling (state: ${worker.state}).`);
			}
			const kind = params.kind === "continuation" ? "continuation" : "correction";
			if (kind === "correction" && !rootCorrectionAvailable(worker.rootTaskId)) {
				return content(`Correction not sent for ${worker.id}: the root task's one correction has already been used. Delegate one concrete retry with retryOf ${worker.id}.`, { rejected: true, rootTaskId: worker.rootTaskId });
			}
			const completedAttempt = worker.state === "idle" && worker.reportedRun === worker.run;
			const correctionBudgetKey = `${worker.id}:${worker.rootTaskId}`;
			if (kind === "correction" && completedAttempt && (correctionSteerCounts.get(correctionBudgetKey) ?? 0) >= 1) {
				return content(`Correction not sent for ${worker.id}: its one silent correction steer for this failed attempt already failed. Delegate one concrete retry with retryOf ${worker.id}, or report/ask about the blocker.`);
			}
			let interruptNote = "";
			if (params.interrupt === true) {
				if (worker.profile.backend === "pi-rpc" && shouldAbortPiWorkerRun(worker)) {
					// Flag before aborting: the aborted run's agent_settled must be
					// swallowed (see handleRpcLine) rather than reported as a result.
					worker.interruptedRun = worker.run;
					const aborted = await Promise.race([
						requestWorkerRpc(worker, { type: "abort" }).then(() => true, () => false),
						new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
					]);
					// The settled event normally precedes the abort response on the
					// pipe, but wait briefly for the flag to be consumed so a late
					// settlement cannot land in the new generation below.
					for (let i = 0; i < 20 && worker.interruptedRun === worker.run; i++) await new Promise((resolve) => setTimeout(resolve, 100));
					worker.interruptedRun = undefined;
					interruptNote = aborted
						? " Its in-flight run was aborted first; the partial result was discarded."
						: " The abort did not confirm in time; the instructions were delivered anyway.";
				} else if (worker.profile.backend === "pi-rpc") {
					interruptNote = " Its prior turn had already settled while waiting for a background job, so no abort was sent.";
				} else if (worker.profile.backend === "claude-code") {
					interruptNote = " Claude workers cannot be aborted mid-turn; the instructions are queued for the next turn boundary.";
				}
			}
			// Resolve a completed reported attempt before creating the next unique
			// attempt ID. An active run has no completion to relabel yet.
			if (worker.state === "idle" && worker.reportedRun === worker.run) {
				updateWorkerRunStatus(worker.runId, kind === "correction" ? "rework" : "accepted", undefined, "completed");
			}
			// A stream-json Claude turn (and a Pi RPC steer) belongs to a new
			// lifecycle generation before it is written, so a late prior result
			// cannot settle or report this follow-up.
			beginWorkerRun(worker);
			worker.runId = `${worker.id}:run-${worker.run}`;
			worker.lastResult = undefined;
			worker.lastError = undefined;
			worker.claudeAuthFailed = undefined;
			// The launch prompt issued the opposite standing order, so a mode switch
			// must lead the instructions rather than trail them.
			const policy = applyWorkerPolicyTransition(worker, {
				...(typeof params.planOnly === "boolean" ? { planOnly: params.planOnly } : {}),
				...(params.prCreationRequested === true ? { prCreationRequested: true } : {}),
				...(typeof params.needsWorktree === "boolean" ? { needsWorktree: params.needsWorktree } : {}),
				...(typeof params.needsHeavyWork === "boolean" ? { needsHeavyWork: params.needsHeavyWork } : {}),
				...(typeof params.needsBrowser === "boolean" ? { needsBrowser: params.needsBrowser } : {}),
				...(typeof params.needsSecrets === "boolean" ? { needsSecrets: params.needsSecrets } : {}),
				backend: worker.profile.backend,
			});
			const { modeChanged, requestedMode } = policy;
			const contextSections = buildWorkerPromptSections(params.instructions, {
				...(Array.isArray(params.knownFacts) ? { knownFacts: params.knownFacts } : {}),
				...(Array.isArray(params.validationCommands) ? { validationCommands: params.validationCommands } : {}),
			});
			const policyWarnings = lintWorkerTaskPolicyDuplication(params.instructions);
			const instructions = [...policy.directives, ...contextSections, params.instructions].join("\n\n");
			recordWorkerActivity(worker, { at: Date.now(), role: "user", text: instructions });
			if (!sendWorkerInstruction(worker, instructions, true)) {
				failWorker(worker, "Worker stdin failed while sending follow-up instructions.", "unavailable");
				return content(`${worker.id} could not accept follow-up instructions.`);
			}
			const modeNote = modeChanged ? ` It switched to ${requestedMode ? "planning only, keeping any work already on disk" : "implementing"}.` : "";
			if (kind === "correction") {
				consumeRootCorrection(worker.rootTaskId);
				if (completedAttempt) correctionSteerCounts.set(correctionBudgetKey, (correctionSteerCounts.get(correctionBudgetKey) ?? 0) + 1);
			} else if (completedAttempt) correctionSteerCounts.delete(correctionBudgetKey);
			recordWorkerSteer(worker.name, kind);
			refreshWorkerWidget();
			return content(`Sent ${kind} follow-up instructions to ${worker.id}.${interruptNote}${modeNote}`, {
				...(policyWarnings.length ? { warnings: policyWarnings.map((warning) => warning.message) } : {}),
			});
		},
	});

	pi.registerTool({
		name: "orchestrator_workers",
		label: "Worker status",
		description: `List persistent configured workers (${catalogNames}) and their current state.`,
		parameters: Type.Object({}),
		execute: async () => {
			const active = [...runtime.workers.values()];
			return content(active.length ? active.map(workerSummary).join("\n") : "No workers have been started.");
		},
	});

	pi.registerTool({
		name: "orchestrator_stop",
		label: "Stop worker",
		description: "Stop a persistent worker only when its work is no longer needed.",
		parameters: Type.Object({ workerId: Type.String() }),
		execute: async (_toolCallId, params) => {
			const worker = runtime.workers.get(params.workerId);
			if (!worker) return content(`No worker exists with ID ${params.workerId}.`);
			// Do not overwrite a completed/reviewed result. An explicit stop only
			// creates a cancelled outcome for an actually active attempt.
			if (worker.state === "starting" || worker.state === "working") {
				worker.settledAt = new Date();
				recordRunOutcome(worker, "cancelled");
			}
			stopWorkerProcess(worker);
			refreshWorkerWidget();
			return content(`Stopped ${worker.id}.`);
		},
	});
}
