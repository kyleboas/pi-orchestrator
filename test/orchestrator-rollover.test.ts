import assert from "node:assert/strict";
import test from "node:test";
import { beginOutcomeRollover, completeOutcomeRollover, failOutcomeRollover, isOutcomeRolloverEligible } from "../extensions/orchestrator-lib/orchestrator-rollover.ts";

function state() { return { outcomeVersion: 1, outcomePending: true }; }
test("rollover is one-shot only at a sufficiently large idle outcome boundary", () => {
	const current = state();
	assert.equal(isOutcomeRolloverEligible([{ state: "working" }], current, { percent: 50 }, 38), false);
	assert.equal(isOutcomeRolloverEligible([], current, { percent: 37 }, 38), false);
	assert.equal(isOutcomeRolloverEligible([], current, { percent: 38 }, 0), false);
	assert.equal(isOutcomeRolloverEligible([], current, { percent: 38 }, 38), true);
	const version = beginOutcomeRollover(current); assert.equal(version, 1); assert.equal(isOutcomeRolloverEligible([], current, { percent: 50 }, 38), false);
	completeOutcomeRollover(current, version!); assert.equal(current.outcomePending, false); assert.equal(isOutcomeRolloverEligible([], current, { percent: 50 }, 38), false);
});
test("failed rollover clears only in-flight state so the same outcome safely retries", () => {
	const current = state(); const version = beginOutcomeRollover(current)!; failOutcomeRollover(current, version);
	assert.equal(current.outcomePending, true); assert.equal(isOutcomeRolloverEligible([], current, { percent: 50 }, 38), true);
});
