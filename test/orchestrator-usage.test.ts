import assert from "node:assert/strict";
import test from "node:test";
import { accumulateReportedUsage, piMessageUsage, shouldAccumulatePiUsage, type ReportedUsage } from "../extensions/orchestrator-lib/orchestrator-usage.ts";

test("Pi assistant usage retains provider reported token and total cost only", () => {
	assert.deepEqual(piMessageUsage({ usage: { totalTokens: 123, cost: { total: 0.045 } } }), { tokens: 123, costUsd: 0.045 });
	assert.deepEqual(piMessageUsage({ usage: { totalTokens: "123", cost: { total: -1 } } }), {});
	assert.deepEqual(piMessageUsage({}), {});
});

test("two Pi turns count only turn_end and produce correct run-base deltas", () => {
	const first = piMessageUsage({ usage: { totalTokens: 100, cost: { total: 0.01 } } });
	const second = piMessageUsage({ usage: { totalTokens: 200, cost: { total: 0.02 } } });
	let lifetime: ReportedUsage = {};
	for (const event of ["message_end", "turn_end"]) if (shouldAccumulatePiUsage(event)) lifetime = accumulateReportedUsage(lifetime, first);
	const firstRun = lifetime;
	for (const event of ["message_end", "turn_end"]) if (shouldAccumulatePiUsage(event)) lifetime = accumulateReportedUsage(lifetime, second);
	assert.deepEqual(lifetime, { tokens: 300, costUsd: 0.03 });
	assert.equal(lifetime.tokens! - firstRun.tokens!, 200);
	assert.ok(Math.abs((lifetime.costUsd! - firstRun.costUsd!) - 0.02) < 1e-12);
});

test("two Claude result usages accumulate across a steer and preserve per-run deltas", () => {
	const beforeSteer = accumulateReportedUsage({}, { tokens: 80, costUsd: 0.008 });
	const afterSteer = accumulateReportedUsage(beforeSteer, { tokens: 120, costUsd: 0.012 });
	assert.deepEqual(afterSteer, { tokens: 200, costUsd: 0.02 });
	assert.deepEqual({ tokens: afterSteer.tokens! - beforeSteer.tokens!, costUsd: afterSteer.costUsd! - beforeSteer.costUsd! }, { tokens: 120, costUsd: 0.012 });
});
