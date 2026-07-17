import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
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
	catalogText,
	workerDescription,
	workerNames,
	piRpcWorkerArgs,
	type WorkerCatalog,
	type WorkerProfile,
} from "./orchestrator-lib/orchestrator-core.ts";
import {
	claudeCodeArgs,
	claudeResultSettlement,
	claudeUsageTokenTotal,
	claudeUserEvent,
	parseClaudeStreamLine,
} from "./orchestrator-lib/orchestrator-claude.ts";
import { loadOrchestratorConfig, type OrchestratorConfig } from "./orchestrator-lib/orchestrator-config.ts";
import { pinPullRequestTargetSync, startPullRequestBroker, type PullRequestBroker } from "./orchestrator-lib/orchestrator-pr-broker.ts";
import {
	cleanupWorkerHomeDir,
	createWorkerHomeDir,
	piWorkerSandboxPlan,
	resolveWorkerCommand,
	resolveWorkerLaunch,
	resolveWorkerWorkspace,
	workerHomeDirPath,
	type WorkerLaunchRequest,
} from "./orchestrator-lib/orchestrator-sandbox.ts";
import { claudeGatewayEnv, effectiveWorkerModel, gatewayPiModel, startGatewayRelay, writeGatewayPiModels } from "./orchestrator-lib/orchestrator-gateway.ts";
import {
	earliestAccountReset,
	isUsageLimitText,
	markClaudeAccountLimited,
	parseUsageLimitReset,
	pickClaudeAccount,
} from "./orchestrator-lib/orchestrator-accounts.ts";
import {
	beginWorkerRun,
	beginWorkerSettlement,
	canSteerWorker,
	completeClaudeTurn,
	finishWorkerSettlement,
	queueClaudeTurn,
	selectFinalWorkerText,
	stopWorker,
} from "./orchestrator-lib/worker-lifecycle.ts";
import {
	bindOrchestratorApi,
	bindOrchestratorSession,
	deliverWorkerReport,
	ensureOrchestratorExitHook,
	getOrchestratorRuntime,
	notifyOrchestratorStateChange,
	releaseOrchestratorSession,
	type OrchestratorWorker as Worker,
} from "./orchestrator-lib/orchestrator-runtime.ts";
import { renderBaseFooter } from "./orchestrator-lib/orchestrator-footer.ts";
import {
	hasAnimatingWorker,
	isExpiredWorker,
	panelWorkers,
	renderWorkerFooterRows,
	renderWorkerPanel,
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
	updateWorkerRunStatus,
	type TaskCategory,
	type TaskComplexity,
	type WorkerRunStatus,
} from "./orchestrator-lib/orchestrator-stats.ts";
import {
	isDownKey,
	isEnterKey,
	isEscapeKey,
	isPageDownKey,
	isPageUpKey,
	isUpKey,
	moveSelection,
	renderSessionScreen,
	wrapPlainText,
} from "./orchestrator-lib/orchestrator-session-view.ts";

const LEGACY_WORKER_WIDGET_ID = "orchestrator-workers";

export function createWorkerSchema(catalog: WorkerCatalog) {
	return Type.Union(workerNames(catalog).map((name) => Type.Literal(name, { description: workerDescription(name, catalog[name]!) })));
}

export function coordinatorInstructions(catalog: WorkerCatalog, statsText?: string): string {
	const names = catalogText(catalog);
	const stats = statsText
		? `\n\nPast worker outcomes (all sessions, averages per task):\n${statsText}\nWeigh this record alongside the worker descriptions: prefer the cheapest tier whose track record fits the task, and escalate a tier when a cheaper one has been failing or needing repeated steers on similar work.\n`
		: "";
	return `You are the orchestration lead. You investigate, think, and plan yourself, then hand implementation to workers; you never mutate anything.

Before delegating, use your read-only tools to inspect the relevant files, locate the root cause, and decide the approach. Then delegate with orchestrator_delegate, choosing one of: ${names}. Give a precise implementation brief: files to change, the change and why, edge cases, and validation. Workers implement your plan — do not send them off to investigate what you could determine yourself. Configured names are intentional: natural requests such as ${workerNames(catalog).map((name) => `“ask ${name}”`).join(", ")} select that worker and always win.

For every unqualified new task, start with Luna unless the scope you already inspected demonstrably requires Sol or Terra. Escalate only when substantial complexity is known up front or Luna's cheaper attempt cannot complete the task. Each distinct new task gets a new delegate; orchestrator_steer is only for continuation or correction of the same task, never as a substitute for a new delegation. For a separately delegated retry of prior work, pass retryOf with that prior root task ID so its lineage is joined; otherwise it is a new root.

Worker tiers, cheapest first, with what each is for:
${workerNames(catalog).map((name) => `- ${workerDescription(name, catalog[name]!)}`).join("\n")}
Default to Luna for unqualified new work, then use the cheapest tier that the inspected scope demonstrably requires; escalate only when the task's difficulty is known or a cheaper attempt has not completed it.${stats}

Workers are persistent: use orchestrator_steer for corrections or follow-up instructions. Completed worker results arrive as follow-up messages; review them and steer or delegate fixes. Mark each steer kind: correction means the reported attempt needs rework; continuation means its result is accepted and work continues on the same root task. Do not use /end or request an end-of-task summary.

Never steer a worker just to ask how it is doing: status-report steers interrupt the work and waste its context. Healthy passive checks are silently retained for your next real turn and need no acknowledgement. Only suspicious passive checks wake you; review their concrete signals and steer only to correct actual drift.

Workers run concurrently, and parallel delegation is your default: before delegating, always decompose the task into independent workstreams (different files or subsystems with no ordering dependency). Two or more independent workstreams MUST each go to a different worker in the same assistant turn — emit the orchestrator_delegate calls together; never delegate one piece, wait for its result, then delegate the next when they were independent all along. Give each worker a disjoint set of files to change so they never edit the same file. Keep it to two or three concurrent workers, and sequence genuinely dependent work through steering instead. This applies regardless of how earlier tasks in this session were delegated.

Write progress updates and reviews as plain sentences that lead with the content itself. Never open with a label prefix such as "Checkpoint:", "Update:", "Status:", or similar.

Workers may use the restricted PR broker only when the user explicitly requested a PR create/update. Never delegate a merge: merge only after an explicit user request, normally by taking over the task yourself.\n\nIf the user explicitly asks you to do a task yourself without delegating, call orchestrator_takeover once with a short reason. That enables direct implementation tools for exactly this task; orchestration resumes automatically afterward. Only use it for an explicit takeover request.`;
}

function workerWidgetLines(now = Date.now(), width = 80, options: WorkerPanelOptions = {}): string[] | undefined {
	return renderWorkerPanel([...getOrchestratorRuntime().workers.values()], now, width, options);
}


const TAKEOVER_SYSTEM_INSTRUCTIONS = (reason: string) => `
The user explicitly requested a one-task Sol takeover (${reason}). Implement
this task yourself using the available normal implementation tools. Do not
delegate or use orchestrator worker controls. Complete the work and validation
directly; orchestration resumes after this task settles.`.trim();

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
	if (!runtime.headlessReap || worker.reportedRun !== worker.run) return;
	if (worker.state !== "idle" && worker.state !== "failed") return;
	stopWorker(worker);
	worker.process.kill();
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
		if (failoverClaudeWorker(worker, config, settlement.result ?? "")) return;
		const reset = earliestAccountReset(config.claudeAccounts);
		failWorker(worker, `Usage limit reached and every Claude account is in cooldown${reset ? ` (earliest reset ${new Date(reset * 1_000).toLocaleTimeString()})` : ""}. Use a Pi worker or retry later.`, "unavailable");
		return;
	}
	// A result for an earlier turn (one that was already streaming when a
	// steer queued another) must not settle the steered run: the worker is
	// still working on the follow-up instructions.
	if (!completeClaudeTurn(worker)) {
		notifyOrchestratorStateChange(getOrchestratorRuntime());
		return;
	}
	const run = beginWorkerSettlement(worker);
	if (run === undefined) return;
	if (settlement.isError || !settlement.result) {
		worker.settlingRun = undefined;
		worker.state = "failed";
		worker.settledAt ??= new Date();
		worker.lastError = settlement.result ?? "Claude Code returned a result event without final text.";
		recordRunOutcome(worker, "failed");
		reportWorkerResult(worker);
	} else {
		worker.lastResult = settlement.result;
		if (finishWorkerSettlement(worker, run)) {
			recordRunOutcome(worker, "completed");
			reportWorkerResult(worker);
		}
	}
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
			if (worker.state !== "stopped" && worker.state !== "failed") worker.state = "working";
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
		case "agent_settled":
			void settleWorker(worker);
			break;
		case "error":
			failWorker(worker, "Pi RPC worker reported an error.");
			break;
	}
	notifyOrchestratorStateChange(getOrchestratorRuntime());
}

function handleClaudeLine(worker: Worker, line: string, config?: OrchestratorConfig): void {
	const parsed = parseClaudeStreamLine(line);
	if (!parsed.ok) {
		failWorker(worker, "Invalid Claude Code stream JSON.");
		return;
	}
	for (const event of parsed.events) {
		for (const entry of transcriptFromClaudeEvent(event)) recordWorkerActivity(worker, entry);
		settleClaudeResult(worker, event, config);
	}
}

/** A sandbox-policy rejection: the worker process was never spawned. */
class WorkerLaunchRejected extends Error {}

export function brokerSafeWorkerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const safe: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		// Preserve existing model-provider auth exactly; remove only GitHub/SSH
		// credentials that are irrelevant to a worker using the host-side broker.
		if (["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_ASKPASS", "GH_CONFIG_DIR", "GITHUB_CONFIG_DIR"].includes(key)) continue;
		safe[key] = value;
	}
	return safe;
}

type SpawnedWorkerChild = {
	child: Worker["process"];
	sandboxed: boolean;
	warning?: string;
	prBroker?: PullRequestBroker;
};

/**
 * Single spawn path for every worker process (initial Pi RPC, initial Claude,
 * and Claude failover respawns) so sandbox policy cannot be bypassed by one
 * call site. Throws WorkerLaunchRejected when the policy fails closed.
 */
function spawnWorkerChild(
	workerKey: string,
	command: string,
	args: string[],
	cwd: string,
	envOverrides: Record<string, string>,
	config: OrchestratorConfig,
	hostEnv: NodeJS.ProcessEnv,
	paths: Pick<WorkerLaunchRequest, "sandboxEnvOverrides" | "readOnlyTryPaths" | "fileMountsReadOnlyTry" | "fileMountsReadOnly" | "readWritePaths"> & { gatewayPiModel?: string } = {},
): SpawnedWorkerChild {
	const homeDir = workerHomeDirPath(workerKey);
	let relay: ReturnType<typeof startGatewayRelay> | undefined;
	if (config.sandbox.network === "gateway") {
		if (!config.sandbox.gateway) throw new WorkerLaunchRejected("Gateway configuration is unavailable.");
		createWorkerHomeDir(homeDir);
		try {
			if (paths.gatewayPiModel) writeGatewayPiModels(homeDir, paths.gatewayPiModel);
			relay = startGatewayRelay(workerKey, config.sandbox.gateway, undefined, config.sandbox.command);
		}
		catch { cleanupWorkerHomeDir(homeDir); throw new WorkerLaunchRejected("Gateway relay failed its readiness check."); }
	}
	const node = relay ? resolveWorkerCommand(relay.nodePath, process.env) : undefined;
	const request = { command, args, cwd, envOverrides, homeDir, ...paths,
		...(relay && node ? { gateway: { relayDirectory: relay.directory, nodePath: relay.nodePath, nodeRoot: node.readOnlyRoots[0]!, bootstrapPath: relay.bootstrapPath, entrypointPath: relay.entrypointPath } } : {}),
	};
	const workerEnv = config.pullRequests ? brokerSafeWorkerEnv(hostEnv) : hostEnv;
	let launch = resolveWorkerLaunch(config.sandbox, request, workerEnv);
	if (!launch.ok) { if (relay) void relay.cleanup().catch(() => {}); cleanupWorkerHomeDir(homeDir); throw new WorkerLaunchRejected(launch.error); }
	// The broker is intentionally unavailable to direct/legacy workers: only a
	// sandbox can expose its fixed /pr mount without exposing host credentials.
	let prBroker: PullRequestBroker | undefined;
	if (launch.sandboxed && config.pullRequests) {
		const target = pinPullRequestTargetSync(cwd, config.pullRequests);
		if (target) {
			try {
				prBroker = startPullRequestBroker(target, config.pullRequests);
				// Add only /pr. Existing narrow Pi/Claude provider-auth/config mounts
				// are required for model access and remain exactly as configured.
				const brokerLaunch = resolveWorkerLaunch(config.sandbox, { ...request, prBrokerDirectory: prBroker.directory }, workerEnv);
				if (brokerLaunch.ok) launch = brokerLaunch;
				else { void prBroker.cleanup(); prBroker = undefined; }
			} catch {
				// A broker setup failure removes authority rather than preventing a
				// normal delegation to an unlisted/unavailable repository.
				if (prBroker) void prBroker.cleanup(); prBroker = undefined;
			}
		}
	}
	if (launch.sandboxed) createWorkerHomeDir(homeDir);
	let child: Worker["process"];
	try {
		child = spawn(launch.spec.command, launch.spec.args, { cwd, env: launch.spec.env, stdio: ["pipe", "pipe", "pipe"] as const });
	} catch (error) {
		if (relay) void relay.cleanup().catch(() => {});
		if (prBroker) void prBroker.cleanup();
		if (launch.sandboxed) cleanupWorkerHomeDir(homeDir);
		throw error;
	}
	if (launch.sandboxed) {
		const clean = () => { if (relay) void relay.cleanup().catch(() => {}); if (prBroker) void prBroker.cleanup(); cleanupWorkerHomeDir(homeDir); };
		child.once("exit", clean);
		child.once("error", clean);
	}
	return { child, sandboxed: launch.sandboxed, ...(launch.warning ? { warning: launch.warning } : {}), ...(prBroker ? { prBroker } : {}) };
}

function spawnClaudeChild(model: string, cwd: string, config: OrchestratorConfig, workerKey: string, accountDir?: string, resumeSessionId?: string): SpawnedWorkerChild {
	// An inherited CLAUDE_CONFIG_DIR (e.g. pi launched from a shell that set
	// one) must not pin every worker to a single account: account choice
	// belongs to the orchestrator's rotation, or to the launcher's own.
	const hostEnv: NodeJS.ProcessEnv = { ...process.env };
	delete hostEnv.CLAUDE_CONFIG_DIR;
	// A sandboxed worker's isolated HOME has no ~/.claude, so the selected
	// account directory (or the host default when no rotation is configured) is
	// mounted and pinned explicitly — sandbox-only, so unsandboxed launches
	// keep exact legacy behavior. That directory's credentials remain visible
	// to that worker until a gateway-based auth relay replaces them.
	const sandboxAccountDir = accountDir ?? resolve(homedir(), ".claude");
	const gateway = config.sandbox.network === "gateway";
	return spawnWorkerChild(
		workerKey,
		config.commands.claude,
		[...claudeCodeArgs(effectiveWorkerModel(model, config.sandbox.gateway)), ...(resumeSessionId ? ["--resume", resumeSessionId] : [])],
		cwd,
		gateway
			? claudeGatewayEnv(resolve(workerHomeDirPath(workerKey), ".claude-gateway"))
			: { PI_ORCHESTRATOR_WORKER: "1", ...(accountDir ? { CLAUDE_CONFIG_DIR: accountDir } : {}) },
		config,
		hostEnv,
		gateway ? {} : {
			...(accountDir ? {} : { sandboxEnvOverrides: { CLAUDE_CONFIG_DIR: sandboxAccountDir } }),
			readWritePaths: [sandboxAccountDir],
		},
	);
}

/** Attach stream handlers to a (possibly replacement) child; stale children's late events are ignored. */
function wireWorkerChild(worker: Worker, child: Worker["process"], config: OrchestratorConfig): void {
	child.stdout.on("data", (chunk: Buffer) => {
		if (worker.process !== child) return;
		worker.buffer += chunk.toString("utf8");
		let newline: number;
		while ((newline = worker.buffer.indexOf("\n")) >= 0) {
			const line = worker.buffer.slice(0, newline).trim();
			worker.buffer = worker.buffer.slice(newline + 1);
			if (line) {
				if (worker.profile.backend === "pi-rpc") handleRpcLine(worker, line);
				else handleClaudeLine(worker, line, config);
			}
		}
	});
	child.stderr.on("data", (chunk: Buffer) => {
		// Do not retain stderr: it can include local auth/config details. Exit and
		// stdin paths below report a safe, actionable status instead.
		if (worker.process === child && chunk.length && worker.state !== "stopped") worker.lastError ??= `${worker.profile.backend === "claude-code" ? "Claude Code" : "Pi RPC"} worker reported stderr.`;
	});
	child.on("error", () => {
		if (worker.process !== child) return;
		rejectPendingRpc(worker, new Error("Worker process failed to start."));
		failWorker(worker, "Worker process failed to start.", "unavailable");
	});
	child.on("exit", (code, signal) => {
		if (worker.process !== child) return;
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
 * A Claude worker hit its account's usage limit: put that account in cooldown
 * (claude-select/claude-auto honor the same state file) and restart the
 * worker on the next available account, resuming the same Claude session and
 * resending the interrupted instruction. Returns false when no account is
 * available, in which case the caller fails the worker.
 */
function failoverClaudeWorker(worker: Worker, config: OrchestratorConfig, limitText: string): boolean {
	const accounts = config.claudeAccounts;
	if (!accounts || worker.profile.backend !== "claude-code" || config.sandbox.network === "gateway") return false;
	if (worker.claudeAccount) {
		markClaudeAccountLimited(accounts, worker.claudeAccount, parseUsageLimitReset(limitText));
	}
	const pick = pickClaudeAccount(accounts);
	if (!pick) return false;
	try {
		worker.process.kill();
	} catch {
		// The limited process may already be gone.
	}
	let spawned: SpawnedWorkerChild;
	try {
		spawned = spawnClaudeChild(worker.profile.model, worker.cwd, config, worker.id, pick.configDir, worker.claudeSessionId);
	} catch (error) {
		if (error instanceof WorkerLaunchRejected) {
			failWorker(worker, `Account failover was rejected: ${error.message}`, "unavailable");
			return true; // Handled: the worker is already failed, no double-report.
		}
		throw error;
	}
	const child = spawned.child;
	if (spawned.warning) recordWorkerActivity(worker, { at: Date.now(), role: "system", text: spawned.warning });
	worker.process = child;
	worker.buffer = "";
	worker.pendingTurns = 0;
	worker.claudeAccount = pick.name;
	worker.state = "working";
	wireWorkerChild(worker, child, config);
	recordWorkerActivity(worker, {
		at: Date.now(),
		role: "system",
		text: `Usage limit reached; switched to account ${pick.name} and resumed.`,
	});
	const instruction = worker.lastInstruction ?? worker.task;
	if (!sendWorkerInstruction(worker, instruction, true)) {
		failWorker(worker, "Worker stdin was unavailable after an account failover.", "unavailable");
		return true; // Handled: the worker is already failed, no double-report.
	}
	notifyOrchestratorStateChange(getOrchestratorRuntime());
	return true;
}

function launchWorker(name: string, profile: WorkerProfile, task: string, cwd: string, config: OrchestratorConfig, lineage: { rootTaskId: string; retryOf?: string; category: TaskCategory; complexity: TaskComplexity }): Worker {
	const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 8)}`;
	const account = profile.backend === "claude-code" && config.claudeAccounts && config.sandbox.network !== "gateway" ? pickClaudeAccount(config.claudeAccounts) : undefined;
	const gateway = config.sandbox.network === "gateway";
	const spawned = profile.backend === "pi-rpc"
		? spawnWorkerChild(id, config.commands.pi, piRpcWorkerArgs(gateway ? { ...profile, model: gatewayPiModel(effectiveWorkerModel(profile.model, config.sandbox.gateway)) } : profile), cwd, { PI_ORCHESTRATOR_WORKER: "1" }, config, process.env, {
			...piWorkerSandboxPlan(workerHomeDirPath(id), homedir(), gateway),
			...(gateway ? { gatewayPiModel: config.sandbox.gateway!.model } : {}),
		})
		: spawnClaudeChild(profile.model, cwd, config, id, account?.configDir);
	const child = spawned.child;
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
	};
	getOrchestratorRuntime().workers.set(id, worker);
	notifyOrchestratorStateChange(getOrchestratorRuntime());
	wireWorkerChild(worker, child, config);
	if (spawned.warning) {
		worker.sandboxWarning = spawned.warning;
		recordWorkerActivity(worker, { at: Date.now(), role: "system", text: spawned.warning });
	}
	if (profile.backend === "claude-code" && config.claudeAccounts && config.sandbox.network !== "gateway" && !account) {
		const reset = earliestAccountReset(config.claudeAccounts);
		failWorker(worker, `Every Claude account is in usage-limit cooldown${reset ? ` (earliest reset ${new Date(reset * 1_000).toLocaleTimeString()})` : ""}. Use a Pi worker or retry later.`, "unavailable");
		child.kill();
		return worker;
	}

	const prInstructions = spawned.prBroker
		? `\n\nA credential-free PR broker is available only for this delegated branch at /pr/pio-pr. Use it only when the task explicitly requests creating or updating a PR, after committing all work and ensuring the worktree (including untracked files) is clean: /pr/pio-pr status, then /pr/pio-pr publish "title" "body". It can only publish this pinned branch and create/update its open PR; do not seek GitHub, SSH, token, remote, merge, close, or review access.`
		: "";
	const prompt = `You are ${name}, an implementation worker. Work directly in ${cwd}.

${task}${prInstructions}

Inspect the repository, implement the task, and run the relevant validation. You own actual implementation: do not delegate and do not merely propose a patch. Keep your final response concise and include changed files, validation run, and any blocker. Write it as plain sentences leading with the content — never open with a label prefix such as "Checkpoint:" or "Status:". Sol receives your final response directly and may send follow-up instructions while you work.`;
	recordWorkerActivity(worker, { at: Date.now(), role: "user", text: task });
	if (!sendWorkerInstruction(worker, prompt)) failWorker(worker, "Worker stdin was unavailable at startup.", "unavailable");
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
			if (runtime.generation !== generation || runtime.reportsHeld || !runtime.api) return;
			for (const worker of runtime.workers.values()) {
				if (!isCheckInDue(worker, checkInIntervalMs)) continue;
				const checkedAt = Date.now();
				const assessment = assessWorkerCheckIn(worker, checkInIntervalMs, checkedAt);
				const digest = buildCheckInDigest(worker, checkInIntervalMs, checkedAt, assessment);
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
		// RPC workers never create footer components or timers.
		if (!ctx.hasUI || ctx.mode !== "tui") {
			bindOrchestratorSession(runtime, generation, pi, () => {}, true, () => {});
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
		// Only live workers are shown and selectable; settled ones leave the
		// list immediately but stay in memory (still steerable) until their
		// report is delivered and the retention window passes.
		const pruneExpiredWorkers = () => {
			for (const worker of [...runtime.workers.values()]) {
				if (worker.id !== selectedWorkerId && !viewerOpen && isExpiredWorker(worker)) runtime.workers.delete(worker.id);
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
						let scrollUp = 0;
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
								const title = `${worker.name} · ${worker.state} · ${worker.id}`;
								// Workers launched before this version predate the transcript field.
								const view = renderSessionScreen(title, buildBody(worker, width), width, height, scrollUp, theme);
								scrollUp = Math.min(scrollUp, view.maxScrollUp);
								return view.lines;
							},
							handleInput: (data: string) => {
								if (isUpKey(data)) scrollUp += 1;
								else if (isDownKey(data)) scrollUp = Math.max(0, scrollUp - 1);
								else if (isPageUpKey(data)) scrollUp += 10;
								else if (isPageDownKey(data)) scrollUp = Math.max(0, scrollUp - 10);
								else if (isEscapeKey(data) || data === "q") {
									done(undefined);
									return;
								} else return;
								tui.requestRender();
							},
							invalidate: () => {},
							dispose: () => clearInterval(tick),
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

	pi.on("input", async (event, ctx) => {
		// Worker-result follow-ups are extension messages, not a user asking Sol
		// to take over. Only an explicit user/RPC request can enable this escape
		// hatch, and agent_settled restores orchestration afterward.
		if (event.source === "extension") return { action: "continue" };
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
		if (runtime.generation === generation && isOutcomeRolloverEligible("agent_settled", runtime.workers.values(), runtime, ctx.getContextUsage(), config.rolloverContextPercent)) {
			const version = beginOutcomeRollover(runtime);
			if (version !== undefined) {
				try {
					ctx.compact({
						customInstructions: OUTCOME_ROLLOVER_INSTRUCTIONS,
						onComplete: () => completeOutcomeRollover(runtime, version),
						onError: () => failOutcomeRollover(runtime, version),
					});
				} catch {
					failOutcomeRollover(runtime, version);
				}
			}
		}
		// Do not let a stale generation reap workers after a reload. Deferred
		// reports stay live until a current API target accepts them.
		if (runtime.generation !== generation || !runtime.headlessReap) return;
		for (const worker of runtime.workers.values()) reapIfHeadless(worker);
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
		description: "Call once, exactly when the user has explicitly asked Sol to implement a task directly instead of delegating (any phrasing — 'do it yourself', 'fix it yourself', 'without delegating', etc). Judge intent yourself; do not wait for a fixed phrase. Enables normal implementation tools for exactly one task and starts a follow-up turn to do the work; orchestration resumes automatically once that task settles. Do not call this for routine implementation requests — those go through orchestrator_delegate.",
		parameters: Type.Object({
			reason: Type.String({ description: "Short paraphrase of the user's explicit request to skip delegation." }),
		}),
		execute: async (_toolCallId, params) => {
			takeoverReason = params.reason;
			pi.setActiveTools(solToolMode.beginTakeoverTool(pi.getActiveTools(), pi.getAllTools().map((tool) => tool.name)));
			pi.sendUserMessage(
				"Takeover enabled. Implement the task directly now with the available tools — do not delegate. Orchestration resumes automatically once this task settles.",
				{ deliverAs: "followUp" },
			);
			return content(`Takeover enabled (${params.reason}). Continuing in a follow-up turn with direct implementation tools.`);
		},
	});

	pi.registerTool({
		name: "orchestrator_delegate",
		label: "Delegate to worker",
		description: `Start a persistent ${catalogNames} implementation worker. Its final result is delivered to the coordinator. Independent workstreams may be delegated to different workers in one turn; they run in parallel. For a separately delegated retry, pass retryOf as the original root task ID returned in tool details; it joins that root only when resolvable. Category is one of ${TASK_CATEGORIES.join(", ")}; complexity is low, medium, or high.${config.sandbox.mode !== "off" ? ` Sandboxed workers require a workspace: pass cwd as the exact repository directory, which must be inside a configured sandbox workspace root${config.sandbox.workspaceRoots.length ? ` (${config.sandbox.workspaceRoots.join(", ")})` : " (none are currently configured, so delegation will be rejected until one is added)"}. cwd is REQUIRED whenever this session's own cwd is outside those roots (e.g. a coordinator started in the home directory).` : ""}`,
		executionMode: "parallel",
		parameters: Type.Object({
			worker: delegateWorkerSchema,
			task: Type.String({ description: "Implementation brief built from YOUR OWN investigation: state the root cause or design you already determined, the exact files and changes to make, edge cases, and the validation to run. Never ask the worker to 'diagnose', 'investigate', or 'find' something you already read — hand it your conclusions and acceptance criteria." }),
			cwd: Type.Optional(Type.String({ description: "Absolute repository directory the worker runs in. With the sandbox enabled it must be equal to or inside a configured sandbox workspace root; only this directory is mounted read-write. Required when the coordinator session cwd is outside the configured roots." })),
			retryOf: Type.Optional(Type.String({ description: "Original root task ID for a separately delegated retry. Omit for a distinct new task." })),
			category: Type.Optional(Type.Union(TASK_CATEGORIES.map((value) => Type.Literal(value)))),
			complexity: Type.Optional(Type.Union(TASK_COMPLEXITIES.map((value) => Type.Literal(value)))),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const name = params.worker as string;
			const requestedRetry = typeof params.retryOf === "string" ? params.retryOf.trim() : "";
			const activeMatch = [...runtime.workers.values()].find((candidate) => candidate.rootTaskId === requestedRetry || candidate.id === requestedRetry || candidate.runId === requestedRetry);
			const storedMatch = requestedRetry ? loadStats(undefined, workerNames(catalog)).recentRuns.find((run) => run.rootTaskId === requestedRetry || run.runId === requestedRetry) : undefined;
			const rootTaskId = activeMatch?.rootTaskId ?? storedMatch?.rootTaskId ?? `task-${randomUUID()}`;
			const fallback = classifyTask(params.task);
			const suppliedCategory: unknown = params.category;
			const suppliedComplexity: unknown = params.complexity;
			// Fail closed before any spawn: a cwd that is (or contains) the host
			// home or falls outside the configured workspace roots must never be
			// mounted; the coordinator is told exactly what to pass instead.
			const workspace = resolveWorkerWorkspace(config.sandbox, typeof params.cwd === "string" ? params.cwd : undefined, ctx.cwd);
			if (!workspace.ok) return content(`Delegation rejected: ${workspace.error}`);
			let worker: Worker;
			try {
				worker = launchWorker(name, catalog[name]!, params.task, workspace.cwd, config, {
					rootTaskId,
					...(requestedRetry && (activeMatch || storedMatch) ? { retryOf: rootTaskId } : {}),
					category: typeof suppliedCategory === "string" && TASK_CATEGORIES.includes(suppliedCategory as TaskCategory) ? suppliedCategory as TaskCategory : fallback.category,
					complexity: typeof suppliedComplexity === "string" && TASK_COMPLEXITIES.includes(suppliedComplexity as TaskComplexity) ? suppliedComplexity as TaskComplexity : fallback.complexity,
				});
			} catch (error) {
				// Fail closed and visibly: a required-sandbox rejection never spawns
				// an unsandboxed worker and never silently degrades.
				if (error instanceof WorkerLaunchRejected) return content(`Delegation rejected: ${error.message}`);
				throw error;
			}
			const sandboxNote = worker.sandboxWarning ? ` WARNING: ${worker.sandboxWarning}` : "";
			return content(`Started ${worker.name} as ${worker.id}. It can be steered while active; its result will return directly to you.${sandboxNote}`, { workerId: worker.id, rootTaskId: worker.rootTaskId, runId: worker.runId });
		},
	});

	pi.registerTool({
		name: "orchestrator_steer",
		label: "Steer worker",
		description: `Send immediate follow-up instructions to a live configured worker (${catalogNames}). Set kind to correction when the preceding completed result needs rework, or continuation when it is accepted and work continues on the same root. Omitted kind conservatively means correction.`,
		parameters: Type.Object({
			workerId: Type.String({ description: "Worker ID returned by orchestrator_delegate." }),
			instructions: Type.String({ description: "Concrete follow-up instructions for the worker." }),
			kind: Type.Optional(Type.Union([Type.Literal("correction"), Type.Literal("continuation")])),
		}),
		execute: async (_toolCallId, params) => {
			const worker = runtime.workers.get(params.workerId);
			if (!worker) return content(`No worker exists with ID ${params.workerId}.`);
			if (!canSteerWorker(worker, worker.process)) {
				return content(`${worker.id} is not live or is still settling (state: ${worker.state}).`);
			}
			const kind = params.kind === "continuation" ? "continuation" : "correction";
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
			recordWorkerActivity(worker, { at: Date.now(), role: "user", text: params.instructions });
			if (!sendWorkerInstruction(worker, params.instructions, true)) {
				failWorker(worker, "Worker stdin failed while sending follow-up instructions.", "unavailable");
				return content(`${worker.id} could not accept follow-up instructions.`);
			}
			recordWorkerSteer(worker.name, kind);
			refreshWorkerWidget();
			return content(`Sent ${kind} follow-up instructions to ${worker.id}.`);
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
			stopWorker(worker);
			worker.process.kill();
			refreshWorkerWidget();
			return content(`Stopped ${worker.id}.`);
		},
	});
}
