import assert from "node:assert/strict";
import test from "node:test";
import { piMessageUsage } from "../extensions/orchestrator-lib/orchestrator-usage.ts";

test("Pi assistant usage retains provider reported token and total cost only", () => {
	assert.deepEqual(piMessageUsage({ usage: { totalTokens: 123, cost: { total: 0.045 } } }), { tokens: 123, costUsd: 0.045 });
	assert.deepEqual(piMessageUsage({ usage: { totalTokens: "123", cost: { total: -1 } } }), {});
	assert.deepEqual(piMessageUsage({}), {});
});
