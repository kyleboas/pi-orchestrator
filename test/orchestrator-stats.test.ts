import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_RECENT_RUNS,
	acceptReviewedRuns,
	classifyTask,
	cleanStatsLedger,
	loadStats,
	recoverStaleV2StatsLedger,
	recordWorkerOutcome,
	recordWorkerSteer,
	rollingWorkerMetrics,
	statsSummary,
	updateWorkerRunStatus,
} from "../extensions/orchestrator-lib/orchestrator-stats.ts";
function tempStatsPath(): string { return join(mkdtempSync(join(tmpdir(), "orch-stats-")), "stats.json"); }
function outcome(runId: string, status: "completed" | "accepted" | "rework" | "failed" | "unavailable" | "cancelled" = "completed", timestamp = new Date().toISOString()) {
	return { runId, rootTaskId: "task-one", status, durationMs: 30_000, tokens: 4_000, costUsd: .0123, costKind: "reported" as const, backend: "pi-rpc", model: "p/luna", category: "code" as const, complexity: "medium" as const, timestamp };
}

test("v1/v2 migration preserves real workers and never turns aggregate names into workers", () => {
	const path = tempStatsPath();
	writeFileSync(path, JSON.stringify({
		Luna: { tasks: 2, failures: 1, steers: 1, totalDurationMs: 120_000, totalTokens: 12_000 },
		tasks: 9, failures: 2, steers: 4, durationMs: 1, tokens: 5, costUsd: 3,
	}));
	const migrated = loadStats(path, ["Luna", "Terra"]);
	assert.deepEqual(Object.keys(migrated.workers), ["Luna"]);
	assert.equal(migrated.workers.Luna!.statusCounts.failed, 1);
	assert.equal(migrated.workers.Luna!.statusCounts.accepted, 1);
	assert.equal(migrated.version, 3);

	writeFileSync(path, JSON.stringify({ version: 2, workers: { Luna: { tasks: 1, failures: 0, steers: 0, totalDurationMs: 1, totalTokens: 1 } }, recentRuns: [{ worker: "Luna", task: "do not retain task text", timestamp: "2026-07-10T00:00:00.000Z", failed: false, durationMs: 1, tokens: 1 }] }));
	const v2 = loadStats(path, ["Luna"]);
	assert.equal(v2.recentRuns[0]!.status, "completed");
	assert.equal("task" in v2.recentRuns[0]!, false, "normalization does not retain task text");
});

test("safe cleanup takes a sibling backup before removing phantom fields", () => {
	const path = tempStatsPath();
	writeFileSync(path, JSON.stringify({ Luna: { tasks: 1, failures: 0, steers: 0, totalDurationMs: 1, totalTokens: 1 }, tasks: 2, failures: 0, steers: 0, durationMs: 1, tokens: 1, costUsd: 1 }));
	const backup = cleanStatsLedger(path, ["Luna"]);
	assert.ok(backup && existsSync(backup));
	assert.deepEqual(Object.keys(loadStats(path).workers), ["Luna"]);
	assert.match(readFileSync(backup!, "utf8"), /"tasks"/, "backup is written before cleanup");
});

test("startup recovery merges a richer v2 backup with newer v2 attempts without taking stale aggregates", () => {
	const path = tempStatsPath(); const backup = `${path}.backup-2026-07-17T01-30-26-946Z`;
	const oldRun = (worker: string, timestamp: string, durationMs: number) => ({ worker, task: "redacted by normalization", timestamp, failed: false, durationMs, tokens: durationMs, backend: "pi-rpc", model: "p/model" });
	writeFileSync(backup, JSON.stringify({ version: 2, workers: { Luna: { tasks: 5, failures: 1, steers: 2, totalDurationMs: 500, totalTokens: 500 }, tasks: 99 }, recentRuns: [oldRun("Luna", "2026-07-10T00:00:00.000Z", 10), oldRun("Luna", "2026-07-11T00:00:00.000Z", 11), oldRun("Luna", "2026-07-12T00:00:00.000Z", 12)] }));
	writeFileSync(path, JSON.stringify({ version: 2, workers: { Luna: { tasks: 6, failures: 1, steers: 3, totalDurationMs: 600, totalTokens: 600 }, Terra: { tasks: 1, failures: 0, steers: 0, totalDurationMs: 20, totalTokens: 20 } }, recentRuns: [oldRun("Luna", "2026-07-12T00:00:00.000Z", 12), oldRun("Terra", "2026-07-17T01:34:00.000Z", 20)] }));
	const recovery = recoverStaleV2StatsLedger(path, ["Luna", "Terra"]);
	assert.ok(recovery && existsSync(recovery.safetyBackup));
	assert.equal(recovery!.sourceBackup, backup);
	assert.equal(recovery!.recoveredRuns, 4, "duplicate retained v2 observations union once");
	const ledger = loadStats(path, ["Luna", "Terra"]);
	assert.equal(ledger.version, 3);
	assert.equal(ledger.workers.Luna!.tasks, 6, "live aggregate includes newer work and wins");
	assert.equal(ledger.workers.Terra!.tasks, 1);
	assert.equal(ledger.workers.tasks, undefined, "phantom aggregate field never becomes a worker");
	assert.equal(ledger.recentRuns.length, 4);
	assert.equal(recoverStaleV2StatsLedger(path, ["Luna", "Terra"]), undefined, "v3 recovery is one-time");
});

test("stable run IDs make status resolution exact-once without changing attempt totals", () => {
	const path = tempStatsPath();
	recordWorkerOutcome("Luna", outcome("luna:run-1"), path);
	recordWorkerOutcome("Luna", { ...outcome("luna:run-1", "failed"), durationMs: 999_999 }, path);
	let worker = loadStats(path).workers.Luna!;
	assert.equal(worker.tasks, 1);
	assert.equal(worker.failures, 1);
	assert.equal(worker.totalDurationMs, 30_000, "status update does not add duration again");
	assert.equal(updateWorkerRunStatus("luna:run-1", "accepted", path, "failed"), true);
	assert.equal(updateWorkerRunStatus("luna:run-1", "accepted", path, "completed"), false);
	worker = loadStats(path).workers.Luna!;
	assert.equal(worker.tasks, 1);
	assert.equal(worker.failures, 0);
	assert.equal(worker.statusCounts.accepted, 1);
	assert.equal(worker.statusCounts.failed, 0);
});

test("review-boundary acceptance only resolves completed, reported, still-idle runs", () => {
	const path = tempStatsPath();
	recordWorkerOutcome("Luna", outcome("review-me"), path);
	recordWorkerOutcome("Luna", outcome("still-working"), path);
	assert.equal(acceptReviewedRuns([
		{ state: "idle", run: 1, reportedRun: 1, statsRecordedRun: 1, runId: "review-me" },
		{ state: "working", run: 1, reportedRun: 1, statsRecordedRun: 1, runId: "still-working" },
	], path), 1);
	assert.deepEqual(loadStats(path).recentRuns.map((run) => run.status), ["accepted", "completed"]);
});

test("all terminal statuses, root/retry linkage, and steer kinds persist separately", () => {
	const path = tempStatsPath();
	recordWorkerOutcome("Luna", { ...outcome("one", "cancelled"), rootTaskId: "root-a" }, path);
	recordWorkerOutcome("Luna", { ...outcome("two", "unavailable"), rootTaskId: "root-a", retryOf: "root-a" }, path);
	recordWorkerSteer("Luna", "correction", path);
	recordWorkerSteer("Luna", "continuation", path);
	const ledger = loadStats(path); const worker = ledger.workers.Luna!;
	assert.equal(worker.statusCounts.cancelled, 1);
	assert.equal(worker.statusCounts.unavailable, 1);
	assert.equal(worker.steers, 2);
	assert.equal(worker.correctionSteers, 1);
	assert.equal(worker.continuationSteers, 1);
	assert.deepEqual(ledger.recentRuns.map((run) => [run.runId, run.rootTaskId, run.retryOf]), [["one", "root-a", undefined], ["two", "root-a", "root-a"]]);
});

test("fallback task classification is deterministic and broad", () => {
	assert.deepEqual(classifyTask("Update README with installation examples"), { category: "documentation", complexity: "low" });
	assert.deepEqual(classifyTask("Investigate API webhook integration and compare providers"), { category: "research", complexity: "medium" });
	assert.equal(classifyTask("Add unit tests and fixtures").category, "tests");
});

test("seven-day metrics separate reported and estimated cost and routing advice warns when sparse", () => {
	const path = tempStatsPath(); const now = Date.parse("2026-07-17T12:00:00.000Z");
	for (let i = 0; i < 3; i++) {
		recordWorkerOutcome("Luna", { ...outcome(`r${i}`, "completed", new Date(now - (i + 1) * 60_000).toISOString()), durationMs: (i + 1) * 1_000, costUsd: (i + 1) * .01 }, path);
		updateWorkerRunStatus(`r${i}`, i === 2 ? "rework" : "accepted", path, "completed");
	}
	recordWorkerOutcome("Luna", { ...outcome("estimated", "accepted", new Date(now - 60_000).toISOString()), costUsd: .5, costKind: "estimated" }, path);
	recordWorkerOutcome("Terra", { ...outcome("old", "accepted", new Date(now - 8 * 24 * 60 * 60 * 1_000).toISOString()) }, path);
	const ledger = loadStats(path); const metrics = rollingWorkerMetrics(ledger, "Luna", { category: "code", complexity: "medium" }, now);
	assert.equal(metrics.samples, 4);
	assert.equal(metrics.accepted, 3);
	assert.equal(metrics.rework, 1);
	assert.equal(metrics.p50DurationMs, 2_000);
	assert.equal(metrics.p50ReportedCostUsd, .02);
	assert.equal(metrics.p50EstimatedCostUsd, .5);
	const summary = statsSummary(ledger, ["Luna", "Terra"], { category: "code", complexity: "medium" })!;
	assert.match(summary, /Recent 7d code\/medium evidence:[\s\S]*Luna: 4 recent/);
	assert.match(summary, /estimated\/notional/);
	assert.doesNotMatch(summary, /Terra: .*recent/, "old/sparse results do not create a recommendation");
	assert.match(statsSummary(ledger, ["Terra"], { category: "code", complexity: "medium" })!, /sparse/);
});

test("recent runs remain bounded", () => {
	const path = tempStatsPath();
	for (let i = 0; i < MAX_RECENT_RUNS + 2; i++) recordWorkerOutcome("Terra", { ...outcome(`run-${i}`), rootTaskId: `root-${i}` }, path);
	assert.equal(loadStats(path).recentRuns.length, MAX_RECENT_RUNS);
});
