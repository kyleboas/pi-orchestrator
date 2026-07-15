import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_RECENT_RUNS, loadStats, recordWorkerOutcome, recordWorkerSteer, statsSummary } from "../extensions/orchestrator-lib/orchestrator-stats.ts";
function tempStatsPath(): string { return join(mkdtempSync(join(tmpdir(), "orch-stats-")), "stats.json"); }

test("legacy aggregate ledgers load backward-compatibly", () => {
	const path = tempStatsPath(); writeFileSync(path, JSON.stringify({ Luna: { tasks: 2, failures: 1, steers: 1, totalDurationMs: 120_000, totalTokens: 12_000 } }));
	assert.deepEqual(loadStats(path), { version: 2, workers: { Luna: { tasks: 2, failures: 1, steers: 1, totalDurationMs: 120_000, totalTokens: 12_000, totalCostUsd: 0, reportedCostRuns: 0, estimatedCostRuns: 0 } }, recentRuns: [] });
});

test("outcomes aggregate cost and retain a bounded task/model run ledger", () => {
	const path = tempStatsPath();
	recordWorkerOutcome("Luna", { failed: false, durationMs: 30_000, tokens: 4_000, costUsd: 0.0123, backend: "pi-rpc", model: "p/luna", task: "first task" }, path);
	recordWorkerOutcome("Luna", { failed: true, durationMs: 90_000, tokens: 8_000, costUsd: 0.05, costKind: "estimated", backend: "claude-code", model: "sonnet", task: "second task" }, path);
	recordWorkerSteer("Luna", path); const ledger = loadStats(path); const luna = ledger.workers.Luna!;
	assert.equal(luna.tasks, 2); assert.equal(luna.failures, 1); assert.equal(luna.steers, 1); assert.equal(luna.totalCostUsd, 0.0623); assert.equal(luna.reportedCostRuns, 1); assert.equal(luna.estimatedCostRuns, 1);
	assert.deepEqual(ledger.recentRuns.map((run) => [run.backend, run.model, run.task, run.costKind]), [["pi-rpc", "p/luna", "first task", undefined], ["claude-code", "sonnet", "second task", "estimated"]]);
	for (let i = 0; i < MAX_RECENT_RUNS + 2; i++) recordWorkerOutcome("Terra", { failed: false, durationMs: 1, tokens: 1, task: `run ${i}` }, path);
	assert.equal(loadStats(path).recentRuns.length, MAX_RECENT_RUNS);
});

test("corrupt ledgers load empty and summary labels estimated versus reported cost", () => {
	const path = tempStatsPath(); writeFileSync(path, "not json"); assert.deepEqual(loadStats(path), { version: 2, workers: {}, recentRuns: [] });
	const ledger = { version: 2 as const, workers: { Luna: { tasks: 4, failures: 1, steers: 2, totalDurationMs: 240_000, totalTokens: 40_000, totalCostUsd: 1, reportedCostRuns: 4, estimatedCostRuns: 0 }, Opus: { tasks: 1, failures: 0, steers: 0, totalDurationMs: 10_000, totalTokens: 100, totalCostUsd: 2, reportedCostRuns: 0, estimatedCostRuns: 1 } }, recentRuns: [] };
	assert.match(statsSummary(ledger, ["Luna", "Opus"])!, /avg reported \$0.25/); assert.match(statsSummary(ledger, ["Luna", "Opus"])!, /avg estimated\/notional \$2.00/);
});
