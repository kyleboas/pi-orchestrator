import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/** Advisory outcome ledger, including a bounded task/model-level recent-run trail. */
export type WorkerStats = {
	tasks: number;
	failures: number;
	steers: number;
	totalDurationMs: number;
	totalTokens: number;
	totalCostUsd: number;
	reportedCostRuns: number;
	estimatedCostRuns: number;
};

export type RecentRun = {
	worker: string;
	backend?: string;
	model?: string;
	task: string;
	timestamp: string;
	failed: boolean;
	durationMs: number;
	tokens: number;
	costUsd?: number;
	/** Claude CLI totals are API-equivalent estimates, not subscription billing. */
	costKind?: "reported" | "estimated";
};

export type StatsLedger = { version: 2; workers: Record<string, WorkerStats>; recentRuns: RecentRun[] };
export type WorkerOutcome = Omit<RecentRun, "worker" | "timestamp" | "task"> & { task?: string; timestamp?: string };
export const MAX_RECENT_RUNS = 200;

export function defaultStatsPath(): string { return resolve(homedir(), ".config/pi-orchestrator/stats.json"); }
function emptyStats(): WorkerStats { return { tasks: 0, failures: 0, steers: 0, totalDurationMs: 0, totalTokens: 0, totalCostUsd: 0, reportedCostRuns: 0, estimatedCostRuns: 0 }; }
function emptyLedger(): StatsLedger { return { version: 2, workers: {}, recentRuns: [] }; }
function finite(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
function optionalFinite(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function text(value: unknown, max: number): string | undefined { return typeof value === "string" && value.trim() ? Array.from(value.replace(/\s+/g, " ").trim()).slice(0, max).join("") : undefined; }

function stats(value: unknown): WorkerStats {
	const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	return { tasks: finite(record.tasks), failures: finite(record.failures), steers: finite(record.steers), totalDurationMs: finite(record.totalDurationMs), totalTokens: finite(record.totalTokens), totalCostUsd: finite(record.totalCostUsd), reportedCostRuns: finite(record.reportedCostRuns), estimatedCostRuns: finite(record.estimatedCostRuns) };
}
function recentRun(value: unknown): RecentRun | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const worker = text(record.worker, 49); const task = text(record.task, 240); const timestamp = text(record.timestamp, 40);
	if (!worker || !task || !timestamp || typeof record.failed !== "boolean") return undefined;
	const costUsd = optionalFinite(record.costUsd);
	return { worker, ...(text(record.backend, 40) ? { backend: text(record.backend, 40) } : {}), ...(text(record.model, 120) ? { model: text(record.model, 120) } : {}), task, timestamp, failed: record.failed, durationMs: finite(record.durationMs), tokens: finite(record.tokens), ...(costUsd === undefined ? {} : { costUsd }), ...(record.costKind === "reported" || record.costKind === "estimated" ? { costKind: record.costKind } : {}) };
}

/** Loads v2 and the pre-v2 top-level worker map without losing existing aggregates. */
export function loadStats(path = defaultStatsPath()): StatsLedger {
	try {
		if (!existsSync(path)) return emptyLedger();
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyLedger();
		const record = raw as Record<string, unknown>;
		const sourceWorkers = record.workers && typeof record.workers === "object" && !Array.isArray(record.workers) ? record.workers as Record<string, unknown> : Object.fromEntries(Object.entries(record).filter(([name]) => name !== "version" && name !== "recentRuns"));
		const workers: Record<string, WorkerStats> = {};
		for (const [name, value] of Object.entries(sourceWorkers)) if (text(name, 49)) workers[name] = stats(value);
		const recentRuns = Array.isArray(record.recentRuns) ? record.recentRuns.map(recentRun).filter((run): run is RecentRun => !!run).slice(-MAX_RECENT_RUNS) : [];
		return { version: 2, workers, recentRuns };
	} catch { return emptyLedger(); }
}
function saveStats(ledger: StatsLedger, path: string): void {
	try { mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.tmp`; writeFileSync(temp, `${JSON.stringify(ledger, null, "\t")}\n`); renameSync(temp, path); } catch { /* advisory only */ }
}

export function recordWorkerOutcome(name: string, outcome: WorkerOutcome, path = defaultStatsPath()): void {
	const ledger = loadStats(path); const worker = ledger.workers[name] ?? emptyStats();
	worker.tasks++; if (outcome.failed) worker.failures++; worker.totalDurationMs += finite(outcome.durationMs); worker.totalTokens += finite(outcome.tokens);
	const costUsd = optionalFinite(outcome.costUsd);
	if (costUsd !== undefined) { worker.totalCostUsd += costUsd; if (outcome.costKind === "estimated") worker.estimatedCostRuns++; else worker.reportedCostRuns++; }
	ledger.workers[name] = worker;
	ledger.recentRuns.push({ worker: name, ...(text(outcome.backend, 40) ? { backend: text(outcome.backend, 40) } : {}), ...(text(outcome.model, 120) ? { model: text(outcome.model, 120) } : {}), task: text(outcome.task, 240) ?? "(task unavailable)", timestamp: outcome.timestamp ?? new Date().toISOString(), failed: outcome.failed, durationMs: finite(outcome.durationMs), tokens: finite(outcome.tokens), ...(costUsd === undefined ? {} : { costUsd, ...(outcome.costKind ? { costKind: outcome.costKind } : {}) }) });
	ledger.recentRuns = ledger.recentRuns.slice(-MAX_RECENT_RUNS); saveStats(ledger, path);
}
export function recordWorkerSteer(name: string, path = defaultStatsPath()): void { const ledger = loadStats(path); const worker = ledger.workers[name] ?? emptyStats(); worker.steers++; ledger.workers[name] = worker; saveStats(ledger, path); }
function formatDuration(ms: number): string { const seconds = Math.round(ms / 1_000); if (seconds < 60) return `${seconds}s`; const minutes = Math.floor(seconds / 60); const remainder = seconds % 60; return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`; }
function formatTokens(tokens: number): string { if (tokens < 1_000) return `${Math.round(tokens)}`; if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`; return `${(tokens / 1_000_000).toFixed(1)}m`; }
function formatUsd(cost: number): string { return `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`; }

export function statsSummary(ledger: StatsLedger, catalogNames: readonly string[]): string | undefined {
	const lines = catalogNames.filter((name) => (ledger.workers[name]?.tasks ?? 0) > 0).map((name) => {
		const worker = ledger.workers[name]!; const parts = [`${worker.tasks} task${worker.tasks === 1 ? "" : "s"}`, `${worker.failures} failed`, `avg ${formatDuration(worker.totalDurationMs / worker.tasks)}`, `avg ${formatTokens(worker.totalTokens / worker.tasks)} tokens`];
		const costRuns = worker.reportedCostRuns + worker.estimatedCostRuns;
		if (costRuns) parts.push(`avg ${worker.estimatedCostRuns ? "estimated/notional" : "reported"} ${formatUsd(worker.totalCostUsd / costRuns)}`);
		if (worker.steers > 0) parts.push(`${worker.steers} steer${worker.steers === 1 ? "" : "s"}`); return `- ${name}: ${parts.join(", ")}`;
	});
	return lines.length ? lines.join("\n") : undefined;
}
