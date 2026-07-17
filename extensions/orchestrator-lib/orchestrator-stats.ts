import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/** A run starts completed, then coordinator review resolves it to accepted or rework. */
export const RUN_STATUSES = ["completed", "accepted", "rework", "failed", "unavailable", "cancelled"] as const;
export type WorkerRunStatus = typeof RUN_STATUSES[number];
export const TASK_CATEGORIES = ["code", "tests", "documentation", "operations", "research", "integration"] as const;
export type TaskCategory = typeof TASK_CATEGORIES[number];
export const TASK_COMPLEXITIES = ["low", "medium", "high"] as const;
export type TaskComplexity = typeof TASK_COMPLEXITIES[number];
export type TaskClassification = { category: TaskCategory; complexity: TaskComplexity };

/** Lifetime aggregates. Counts are adjusted on status resolution, never appended again. */
export type WorkerStats = {
	tasks: number;
	failures: number;
	steers: number;
	correctionSteers: number;
	continuationSteers: number;
	totalDurationMs: number;
	totalTokens: number;
	/** Retained for v2 readers; new totals are separated by cost kind below. */
	totalCostUsd: number;
	reportedCostRuns: number;
	estimatedCostRuns: number;
	totalReportedCostUsd: number;
	totalEstimatedCostUsd: number;
	statusCounts: Record<WorkerRunStatus, number>;
};

export type RecentRun = {
	runId: string;
	rootTaskId: string;
	/** A retry may point at the root supplied by the coordinator. */
	retryOf?: string;
	worker: string;
	backend?: string;
	model?: string;
	timestamp: string;
	status: WorkerRunStatus;
	/** Compatibility field for older consumers. New code must use status. */
	failed: boolean;
	durationMs: number;
	tokens: number;
	costUsd?: number;
	/** Claude CLI totals are API-equivalent estimates, not subscription billing. */
	costKind?: "reported" | "estimated";
	category: TaskCategory;
	complexity: TaskComplexity;
};

export type StatsLedger = { version: 3; workers: Record<string, WorkerStats>; recentRuns: RecentRun[] };
export type WorkerOutcome = Omit<RecentRun, "worker" | "timestamp" | "failed" | "status" | "runId" | "rootTaskId" | "category" | "complexity"> & {
	status?: WorkerRunStatus;
	/** v1/v2 caller compatibility. Explicit status wins. */
	failed?: boolean;
	timestamp?: string;
	runId?: string;
	rootTaskId?: string;
	retryOf?: string;
	category?: TaskCategory;
	complexity?: TaskComplexity;
};
export const MAX_RECENT_RUNS = 200;
const RESERVED_TOP_LEVEL = new Set([
	"version", "workers", "recentRuns", "tasks", "failures", "steers", "correctionSteers", "continuationSteers",
	"durationMs", "totalDurationMs", "tokens", "totalTokens", "costUsd", "totalCostUsd", "totalReportedCostUsd",
	"totalEstimatedCostUsd", "reportedCostRuns", "estimatedCostRuns", "statusCounts",
]);

export function defaultStatsPath(): string { return resolve(homedir(), ".config/pi-orchestrator/stats.json"); }
function emptyStatusCounts(): Record<WorkerRunStatus, number> { return Object.fromEntries(RUN_STATUSES.map((status) => [status, 0])) as Record<WorkerRunStatus, number>; }
function emptyStats(): WorkerStats {
	return { tasks: 0, failures: 0, steers: 0, correctionSteers: 0, continuationSteers: 0, totalDurationMs: 0, totalTokens: 0, totalCostUsd: 0, reportedCostRuns: 0, estimatedCostRuns: 0, totalReportedCostUsd: 0, totalEstimatedCostUsd: 0, statusCounts: emptyStatusCounts() };
}
function emptyLedger(): StatsLedger { return { version: 3, workers: {}, recentRuns: [] }; }
function finite(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
function optionalFinite(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function text(value: unknown, max: number): string | undefined { return typeof value === "string" && value.trim() ? Array.from(value.replace(/\s+/g, " ").trim()).slice(0, max).join("") : undefined; }
function status(value: unknown, failed: unknown): WorkerRunStatus { return RUN_STATUSES.includes(value as WorkerRunStatus) ? value as WorkerRunStatus : failed === true ? "failed" : "completed"; }
function category(value: unknown): TaskCategory { return TASK_CATEGORIES.includes(value as TaskCategory) ? value as TaskCategory : "code"; }
function complexity(value: unknown): TaskComplexity { return TASK_COMPLEXITIES.includes(value as TaskComplexity) ? value as TaskComplexity : "medium"; }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/** Stable, deliberately broad fallback for old/unannotated delegate calls. */
export function classifyTask(task: string): TaskClassification {
	const lower = task.toLowerCase();
	const category: TaskCategory = /\b(tests?|spec|coverage|fixture|assert)\b/.test(lower) ? "tests"
		: /\b(readme|docs?|documentation|guide|changelog)\b/.test(lower) ? "documentation"
		: /\b(deploy|release|infra|ci\b|monitor|incident|migration|database)\b/.test(lower) ? "operations"
		: /\b(research|investigate|compare|evaluate|analysis)\b/.test(lower) ? "research"
		: /\b(api|integration|webhook|oauth|provider|route)\b/.test(lower) ? "integration" : "code";
	const signals = (lower.match(/\b(and|across|all|multiple|complex|refactor|architecture|migrate|concurrent|parallel)\b/g)?.length ?? 0) + (task.match(/\n/g)?.length ?? 0) / 3;
	return { category, complexity: signals >= 4 || task.length > 1_200 ? "high" : signals >= 1 || task.length > 350 ? "medium" : "low" };
}

function stats(value: unknown): WorkerStats {
	const record = isRecord(value) ? value : {};
	const statusCounts = emptyStatusCounts();
	const suppliedCounts = isRecord(record.statusCounts) ? record.statusCounts : {};
	for (const key of RUN_STATUSES) statusCounts[key] = finite(suppliedCounts[key]);
	// Pre-status aggregate ledgers cannot distinguish successful reviewed runs;
	// preserve their completed work as accepted historical outcomes.
	if (!isRecord(record.statusCounts)) {
		statusCounts.failed = finite(record.failures);
		statusCounts.accepted = Math.max(0, finite(record.tasks) - statusCounts.failed);
	}
	const totalCostUsd = finite(record.totalCostUsd);
	let totalReportedCostUsd = finite(record.totalReportedCostUsd);
	let totalEstimatedCostUsd = finite(record.totalEstimatedCostUsd);
	if (totalReportedCostUsd + totalEstimatedCostUsd === 0 && totalCostUsd > 0) {
		if (finite(record.estimatedCostRuns) > 0 && finite(record.reportedCostRuns) === 0) totalEstimatedCostUsd = totalCostUsd;
		else if (finite(record.reportedCostRuns) > 0 && finite(record.estimatedCostRuns) === 0) totalReportedCostUsd = totalCostUsd;
	}
	return { tasks: finite(record.tasks), failures: finite(record.failures), steers: finite(record.steers), correctionSteers: finite(record.correctionSteers), continuationSteers: finite(record.continuationSteers), totalDurationMs: finite(record.totalDurationMs), totalTokens: finite(record.totalTokens), totalCostUsd, reportedCostRuns: finite(record.reportedCostRuns), estimatedCostRuns: finite(record.estimatedCostRuns), totalReportedCostUsd, totalEstimatedCostUsd, statusCounts };
}
function isLegacyWorkerRecord(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return ["tasks", "failures", "steers", "totalDurationMs", "totalTokens", "totalCostUsd"].some((key) => typeof value[key] === "number");
}
function recentRun(value: unknown, index: number): RecentRun | undefined {
	if (!isRecord(value)) return undefined;
	const worker = text(value.worker, 49); const timestamp = text(value.timestamp, 40);
	if (!worker || !timestamp) return undefined;
	const runId = text(value.runId, 120) ?? `legacy-${timestamp}-${index}`;
	const rootTaskId = text(value.rootTaskId, 120) ?? `legacy-root-${runId}`;
	const runStatus = status(value.status, value.failed);
	const costUsd = optionalFinite(value.costUsd);
	return { runId, rootTaskId, ...(text(value.retryOf, 120) ? { retryOf: text(value.retryOf, 120) } : {}), worker, ...(text(value.backend, 40) ? { backend: text(value.backend, 40) } : {}), ...(text(value.model, 120) ? { model: text(value.model, 120) } : {}), timestamp, status: runStatus, failed: runStatus === "failed", durationMs: finite(value.durationMs), tokens: finite(value.tokens), ...(costUsd === undefined ? {} : { costUsd }), ...(value.costKind === "reported" || value.costKind === "estimated" ? { costKind: value.costKind } : {}), category: category(value.category), complexity: complexity(value.complexity) };
}

/** Loads v1/v2/v3 ledgers while never treating aggregate keys as worker names. */
export function loadStats(path = defaultStatsPath(), catalogNames: readonly string[] = []): StatsLedger {
	try {
		if (!existsSync(path)) return emptyLedger();
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(raw)) return emptyLedger();
		const sourceWorkers = isRecord(raw.workers) ? raw.workers : Object.fromEntries(Object.entries(raw).filter(([name, value]) => !RESERVED_TOP_LEVEL.has(name) && isLegacyWorkerRecord(value)));
		const allowed = new Set(catalogNames.map((name) => name.toLowerCase()));
		const workers: Record<string, WorkerStats> = {};
		for (const [name, value] of Object.entries(sourceWorkers)) {
			const validName = text(name, 49);
			if (!validName || RESERVED_TOP_LEVEL.has(name) || (!allowed.has(name.toLowerCase()) && !isLegacyWorkerRecord(value) && !isRecord(raw.workers))) continue;
			// v3 worker records are structurally accepted; catalog names permit empty/new records.
			if (!allowed.has(name.toLowerCase()) && !isLegacyWorkerRecord(value) && !(isRecord(value) && isRecord(value.statusCounts))) continue;
			workers[name] = stats(value);
		}
		const recentRuns = Array.isArray(raw.recentRuns) ? raw.recentRuns.map(recentRun).filter((run): run is RecentRun => !!run).slice(-MAX_RECENT_RUNS) : [];
		return { version: 3, workers, recentRuns };
	} catch { return emptyLedger(); }
}
function saveStats(ledger: StatsLedger, path: string): void {
	try { mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.tmp`; writeFileSync(temp, `${JSON.stringify(ledger, null, "\t")}\n`); renameSync(temp, path); } catch { /* advisory only */ }
}

function timestampedBackupPath(path: string, suffix = ""): string { return `${path}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}${suffix}`; }
/** Normalize a live ledger only after making a timestamped sibling backup. */
export function cleanStatsLedger(path = defaultStatsPath(), catalogNames: readonly string[] = []): string | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const original = readFileSync(path, "utf8");
		const ledger = loadStats(path, catalogNames);
		const normalized = `${JSON.stringify(ledger, null, "\t")}\n`;
		if (original === normalized) return undefined;
		const backup = timestampedBackupPath(path);
		copyFileSync(path, backup);
		saveStats(ledger, path);
		return backup;
	} catch { return undefined; }
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
	try { const raw: unknown = JSON.parse(readFileSync(path, "utf8")); return isRecord(raw) ? raw : undefined; } catch { return undefined; }
}
function recentIdentity(run: RecentRun): string {
	// v3 run IDs are globally stable. v2 had no IDs, so use its complete
	// non-text observation shape; this avoids duplicate historic runs if a
	// stale v2 writer retained a subset of the backup's recent trail.
	if (!run.runId.startsWith("legacy-")) return `id:${run.runId}`;
	return `v2:${run.worker}\u0000${run.timestamp}\u0000${run.backend ?? ""}\u0000${run.model ?? ""}\u0000${run.status}\u0000${run.durationMs}\u0000${run.tokens}\u0000${run.costUsd ?? ""}`;
}
function mergeRecentRuns(richer: RecentRun[], current: RecentRun[]): RecentRun[] {
	const merged = new Map<string, RecentRun>();
	for (const run of richer) merged.set(recentIdentity(run), run);
	// Current observations win ties because they may reflect a later v2 write.
	for (const run of current) merged.set(recentIdentity(run), run);
	return [...merged.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp) || recentIdentity(left).localeCompare(recentIdentity(right))).slice(-MAX_RECENT_RUNS);
}

export type StaleV2Recovery = { sourceBackup: string; safetyBackup: string; recoveredRuns: number };
/**
 * One-time startup repair for the exact stale-writer failure mode: a still
 * loaded v2 extension overwrote a normalized v3 ledger after cleanup. It only
 * runs while the live file explicitly says v2 and a sibling backup has more
 * recoverable recent runs. Current aggregates always win; the richer backup
 * contributes only missing workers and the historical recent-run trail.
 */
export function recoverStaleV2StatsLedger(path = defaultStatsPath(), catalogNames: readonly string[] = []): StaleV2Recovery | undefined {
	try {
		const liveRaw = readJsonRecord(path);
		if (!liveRaw || liveRaw.version !== 2) return undefined;
		const live = loadStats(path, catalogNames);
		const prefix = `${path.split("/").pop()}.backup-`;
		const candidates = readdirSync(dirname(path))
			.map((name) => resolve(dirname(path), name))
			.filter((candidate) => candidate.split("/").pop()?.startsWith(prefix))
			.map((candidate) => ({ path: candidate, ledger: loadStats(candidate, catalogNames) }))
			.filter((candidate) => candidate.ledger.recentRuns.length > live.recentRuns.length)
			.sort((left, right) => right.ledger.recentRuns.length - left.ledger.recentRuns.length || right.path.localeCompare(left.path));
		const richer = candidates[0];
		if (!richer) return undefined;
		const recentRuns = mergeRecentRuns(richer.ledger.recentRuns, live.recentRuns);
		if (recentRuns.length <= live.recentRuns.length) return undefined;
		const safetyBackup = timestampedBackupPath(path, ".pre-v2-recovery");
		copyFileSync(path, safetyBackup);
		// Do not add old aggregates: live totals are the only totals known to
		// include post-backup attempts. Backup workers fill only absent names.
		const workers = { ...richer.ledger.workers, ...live.workers };
		saveStats({ version: 3, workers, recentRuns }, path);
		return { sourceBackup: richer.path, safetyBackup, recoveredRuns: recentRuns.length };
	} catch { return undefined; }
}

function applyStatus(worker: WorkerStats, runStatus: WorkerRunStatus, delta: number): void {
	worker.statusCounts[runStatus] = Math.max(0, worker.statusCounts[runStatus] + delta);
	if (runStatus === "failed") worker.failures = Math.max(0, worker.failures + delta);
}
function legacyRunId(name: string, outcome: WorkerOutcome): string { return `${name}:legacy:${outcome.timestamp ?? new Date().toISOString()}:${Math.random().toString(36).slice(2, 8)}`; }

/** Insert one attempt or resolve/update the same attempt by stable run ID. */
export function recordWorkerOutcome(name: string, outcome: WorkerOutcome, path = defaultStatsPath()): void {
	const ledger = loadStats(path); const worker = ledger.workers[name] ?? emptyStats();
	const classification = outcome.category && outcome.complexity ? { category: outcome.category, complexity: outcome.complexity } : classifyTask("");
	const runStatus = outcome.status ?? (outcome.failed ? "failed" : "completed");
	const runId = text(outcome.runId, 120) ?? legacyRunId(name, outcome);
	const existing = ledger.recentRuns.find((run) => run.runId === runId);
	if (existing) {
		if (existing.worker !== name) return; // Never corrupt another worker's accounting.
		if (existing.status !== runStatus) { applyStatus(worker, existing.status, -1); applyStatus(worker, runStatus, 1); existing.status = runStatus; existing.failed = runStatus === "failed"; }
		ledger.workers[name] = worker; saveStats(ledger, path); return;
	}
	const costUsd = optionalFinite(outcome.costUsd);
	worker.tasks++; applyStatus(worker, runStatus, 1); worker.totalDurationMs += finite(outcome.durationMs); worker.totalTokens += finite(outcome.tokens);
	if (costUsd !== undefined) {
		worker.totalCostUsd += costUsd;
		if (outcome.costKind === "estimated") { worker.estimatedCostRuns++; worker.totalEstimatedCostUsd += costUsd; }
		else { worker.reportedCostRuns++; worker.totalReportedCostUsd += costUsd; }
	}
	ledger.workers[name] = worker;
	ledger.recentRuns.push({ runId, rootTaskId: text(outcome.rootTaskId, 120) ?? `root-${runId}`, ...(text(outcome.retryOf, 120) ? { retryOf: text(outcome.retryOf, 120) } : {}), worker: name, ...(text(outcome.backend, 40) ? { backend: text(outcome.backend, 40) } : {}), ...(text(outcome.model, 120) ? { model: text(outcome.model, 120) } : {}), timestamp: outcome.timestamp ?? new Date().toISOString(), status: runStatus, failed: runStatus === "failed", durationMs: finite(outcome.durationMs), tokens: finite(outcome.tokens), ...(costUsd === undefined ? {} : { costUsd, ...(outcome.costKind ? { costKind: outcome.costKind } : {}) }), category: classification.category, complexity: classification.complexity });
	ledger.recentRuns = ledger.recentRuns.slice(-MAX_RECENT_RUNS); saveStats(ledger, path);
}

export function updateWorkerRunStatus(runId: string, runStatus: WorkerRunStatus, path = defaultStatsPath(), expectedStatus?: WorkerRunStatus): boolean {
	const ledger = loadStats(path); const run = ledger.recentRuns.find((candidate) => candidate.runId === runId);
	if (!run || (expectedStatus && run.status !== expectedStatus) || run.status === runStatus) return !!run && (!expectedStatus || run.status === expectedStatus);
	const worker = ledger.workers[run.worker] ?? emptyStats();
	applyStatus(worker, run.status, -1); applyStatus(worker, runStatus, 1); run.status = runStatus; run.failed = runStatus === "failed";
	ledger.workers[run.worker] = worker; saveStats(ledger, path); return true;
}
export type ReviewableWorkerRun = { state: string; run: number; reportedRun?: number; statsRecordedRun?: number; runId: string };
/** Resolve only completed, reported, still-idle runs at the coordinator review boundary. */
export function acceptReviewedRuns(workers: Iterable<ReviewableWorkerRun>, path = defaultStatsPath()): number {
	let accepted = 0;
	for (const worker of workers) {
		if (worker.state === "idle" && worker.reportedRun === worker.run && worker.statsRecordedRun === worker.run && updateWorkerRunStatus(worker.runId, "accepted", path, "completed")) accepted++;
	}
	return accepted;
}
export function recordWorkerSteer(name: string, kindOrLegacyPath: "correction" | "continuation" | string = "correction", configuredPath = defaultStatsPath()): void {
	// The v2 public signature was (name, path); retain it while adding kind.
	const kind = kindOrLegacyPath === "continuation" ? "continuation" : "correction";
	const path = kindOrLegacyPath === "correction" || kindOrLegacyPath === "continuation" ? configuredPath : kindOrLegacyPath;
	const ledger = loadStats(path); const worker = ledger.workers[name] ?? emptyStats(); worker.steers++; if (kind === "correction") worker.correctionSteers++; else worker.continuationSteers++; ledger.workers[name] = worker; saveStats(ledger, path);
}
function formatDuration(ms: number): string { const seconds = Math.round(ms / 1_000); if (seconds < 60) return `${seconds}s`; const minutes = Math.floor(seconds / 60); const remainder = seconds % 60; return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`; }
function formatTokens(tokens: number): string { if (tokens < 1_000) return `${Math.round(tokens)}`; if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`; return `${(tokens / 1_000_000).toFixed(1)}m`; }
function formatUsd(cost: number): string { return `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`; }
function percentile(values: number[], p: number): number | undefined { if (!values.length) return undefined; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]; }

export type RollingWorkerMetrics = { samples: number; p50DurationMs?: number; p95DurationMs?: number; p50ReportedCostUsd?: number; p95ReportedCostUsd?: number; p50EstimatedCostUsd?: number; p95EstimatedCostUsd?: number; statuses: Partial<Record<WorkerRunStatus, number>>; accepted: number; rework: number };
export function rollingWorkerMetrics(ledger: StatsLedger, worker: string, classification?: TaskClassification, now = Date.now()): RollingWorkerMetrics {
	const since = now - 7 * 24 * 60 * 60 * 1_000;
	const runs = ledger.recentRuns.filter((run) => run.worker === worker && Date.parse(run.timestamp) >= since && (!classification || (run.category === classification.category && run.complexity === classification.complexity)));
	const statuses: Partial<Record<WorkerRunStatus, number>> = {};
	for (const run of runs) statuses[run.status] = (statuses[run.status] ?? 0) + 1;
	const costs = (kind: "reported" | "estimated") => runs.filter((run) => run.costKind === kind && run.costUsd !== undefined).map((run) => run.costUsd!);
	const reported = costs("reported"); const estimated = costs("estimated"); const durations = runs.map((run) => run.durationMs);
	return { samples: runs.length, ...(percentile(durations, .5) === undefined ? {} : { p50DurationMs: percentile(durations, .5), p95DurationMs: percentile(durations, .95) }), ...(percentile(reported, .5) === undefined ? {} : { p50ReportedCostUsd: percentile(reported, .5), p95ReportedCostUsd: percentile(reported, .95) }), ...(percentile(estimated, .5) === undefined ? {} : { p50EstimatedCostUsd: percentile(estimated, .5), p95EstimatedCostUsd: percentile(estimated, .95) }), statuses, accepted: statuses.accepted ?? 0, rework: statuses.rework ?? 0 };
}

/** Bounded routing context: lifetime overview plus task-specific seven-day evidence. */
export function statsSummary(ledger: StatsLedger, catalogNames: readonly string[], classification?: TaskClassification): string | undefined {
	const lines = catalogNames.filter((name) => (ledger.workers[name]?.tasks ?? 0) > 0).map((name) => {
		const worker = ledger.workers[name]!; const parts = [`${worker.tasks} task${worker.tasks === 1 ? "" : "s"}`, `${worker.failures} failed`, `avg ${formatDuration(worker.totalDurationMs / worker.tasks)}`, `avg ${formatTokens(worker.totalTokens / worker.tasks)} tokens`];
		if (worker.reportedCostRuns && worker.totalReportedCostUsd > 0) parts.push(`avg reported ${formatUsd(worker.totalReportedCostUsd / worker.reportedCostRuns)}`);
		if (worker.estimatedCostRuns && worker.totalEstimatedCostUsd > 0) parts.push(`avg estimated/notional ${formatUsd(worker.totalEstimatedCostUsd / worker.estimatedCostRuns)}`);
		if (worker.steers > 0) parts.push(`${worker.correctionSteers}/${worker.continuationSteers} correction/continuation steers`);
		return `- ${name}: ${parts.join(", ")}`;
	});
	if (!classification) return lines.length ? lines.join("\n") : undefined;
	const evidence = catalogNames.map((name) => [name, rollingWorkerMetrics(ledger, name, classification)] as const).filter(([, metrics]) => metrics.samples >= 3).slice(0, 5).map(([name, metrics]) => {
		const parts = [`${metrics.samples} recent`, `${metrics.accepted} accepted`, `${metrics.rework} rework`, `p50/p95 ${formatDuration(metrics.p50DurationMs ?? 0)}/${formatDuration(metrics.p95DurationMs ?? 0)}`];
		if (metrics.p50ReportedCostUsd !== undefined) parts.push(`reported p50 ${formatUsd(metrics.p50ReportedCostUsd)}`);
		if (metrics.p50EstimatedCostUsd !== undefined) parts.push(`estimated/notional p50 ${formatUsd(metrics.p50EstimatedCostUsd)}`);
		return `- ${name}: ${parts.join(", ")}`;
	});
	const heading = `Recent 7d ${classification.category}/${classification.complexity} evidence:`;
	if (!evidence.length) lines.push(`${heading} sparse (fewer than 3 matching runs per worker); do not infer a routing preference.`);
	else lines.push(`${heading}\n${evidence.join("\n")}`);
	return lines.length ? lines.join("\n") : undefined;
}
