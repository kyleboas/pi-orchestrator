import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadStats,
	recordWorkerOutcome,
	recordWorkerSteer,
	statsSummary,
} from "../extensions/orchestrator-lib/orchestrator-stats.ts";

function tempStatsPath(): string {
	return join(mkdtempSync(join(tmpdir(), "orch-stats-")), "stats.json");
}

test("outcomes accumulate per worker and reload from disk", () => {
	const path = tempStatsPath();
	recordWorkerOutcome("Luna", { failed: false, durationMs: 30_000, tokens: 4_000 }, path);
	recordWorkerOutcome("Luna", { failed: true, durationMs: 90_000, tokens: 8_000 }, path);
	recordWorkerSteer("Luna", path);
	const ledger = loadStats(path);
	assert.deepEqual(ledger.Luna, { tasks: 2, failures: 1, steers: 1, totalDurationMs: 120_000, totalTokens: 12_000 });
});

test("a corrupt ledger loads as empty and negative fields are dropped", () => {
	const path = tempStatsPath();
	writeFileSync(path, "not json");
	assert.deepEqual(loadStats(path), {});
	writeFileSync(path, JSON.stringify({ Luna: { tasks: -3, failures: "x", steers: 1, totalDurationMs: 5, totalTokens: 5 } }));
	assert.deepEqual(loadStats(path).Luna, { tasks: 0, failures: 0, steers: 1, totalDurationMs: 5, totalTokens: 5 });
});

test("summary lists only catalog workers with history", () => {
	const ledger = {
		Luna: { tasks: 4, failures: 1, steers: 2, totalDurationMs: 240_000, totalTokens: 40_000 },
		Terra: { tasks: 0, failures: 0, steers: 0, totalDurationMs: 0, totalTokens: 0 },
		Retired: { tasks: 9, failures: 0, steers: 0, totalDurationMs: 9_000, totalTokens: 9_000 },
	};
	const summary = statsSummary(ledger, ["Luna", "Terra"]);
	assert.equal(summary, "- Luna: 4 tasks, 1 failed, avg 1m, avg 10.0k tokens, 2 steers");
	assert.equal(statsSummary({}, ["Luna"]), undefined);
});
