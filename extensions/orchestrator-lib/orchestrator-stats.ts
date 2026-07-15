import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * Per-worker outcome ledger. Aggregates completed runs across sessions so the
 * coordinator can weigh real data (failure rate, speed, token cost) when
 * choosing a worker tier, instead of routing blind.
 */
export type WorkerStats = {
	tasks: number;
	failures: number;
	steers: number;
	totalDurationMs: number;
	totalTokens: number;
};

export type StatsLedger = Record<string, WorkerStats>;

export type WorkerOutcome = {
	failed: boolean;
	durationMs: number;
	tokens: number;
};

export function defaultStatsPath(): string {
	return resolve(homedir(), ".config/pi-orchestrator/stats.json");
}

function emptyStats(): WorkerStats {
	return { tasks: 0, failures: 0, steers: 0, totalDurationMs: 0, totalTokens: 0 };
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** A corrupt or missing ledger silently becomes an empty one; stats are advisory. */
export function loadStats(path = defaultStatsPath()): StatsLedger {
	try {
		if (!existsSync(path)) return {};
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		const ledger: StatsLedger = {};
		for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
			if (!value || typeof value !== "object" || Array.isArray(value)) continue;
			const record = value as Record<string, unknown>;
			ledger[name] = {
				tasks: finite(record.tasks),
				failures: finite(record.failures),
				steers: finite(record.steers),
				totalDurationMs: finite(record.totalDurationMs),
				totalTokens: finite(record.totalTokens),
			};
		}
		return ledger;
	} catch {
		return {};
	}
}

function saveStats(ledger: StatsLedger, path: string): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const temp = `${path}.tmp`;
		writeFileSync(temp, `${JSON.stringify(ledger, null, "\t")}\n`);
		renameSync(temp, path);
	} catch {
		// Stats are advisory; never let ledger IO disturb orchestration.
	}
}

export function recordWorkerOutcome(name: string, outcome: WorkerOutcome, path = defaultStatsPath()): void {
	const ledger = loadStats(path);
	const stats = ledger[name] ?? emptyStats();
	stats.tasks += 1;
	if (outcome.failed) stats.failures += 1;
	stats.totalDurationMs += finite(outcome.durationMs);
	stats.totalTokens += finite(outcome.tokens);
	ledger[name] = stats;
	saveStats(ledger, path);
}

export function recordWorkerSteer(name: string, path = defaultStatsPath()): void {
	const ledger = loadStats(path);
	const stats = ledger[name] ?? emptyStats();
	stats.steers += 1;
	ledger[name] = stats;
	saveStats(ledger, path);
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function formatTokens(tokens: number): string {
	if (tokens < 1_000) return `${Math.round(tokens)}`;
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}m`;
}

/**
 * One line per worker with data, for the coordinator's system prompt.
 * Only names in the current catalog are shown; renamed or removed workers'
 * history stays in the file without cluttering the prompt.
 */
export function statsSummary(ledger: StatsLedger, catalogNames: readonly string[]): string | undefined {
	const lines = catalogNames
		.filter((name) => (ledger[name]?.tasks ?? 0) > 0)
		.map((name) => {
			const stats = ledger[name]!;
			const parts = [
				`${stats.tasks} task${stats.tasks === 1 ? "" : "s"}`,
				`${stats.failures} failed`,
				`avg ${formatDuration(stats.totalDurationMs / stats.tasks)}`,
				`avg ${formatTokens(stats.totalTokens / stats.tasks)} tokens`,
			];
			if (stats.steers > 0) parts.push(`${stats.steers} steer${stats.steers === 1 ? "" : "s"}`);
			return `- ${name}: ${parts.join(", ")}`;
		});
	return lines.length ? lines.join("\n") : undefined;
}
