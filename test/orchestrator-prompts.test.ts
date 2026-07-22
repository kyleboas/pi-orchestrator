import assert from "node:assert/strict";
import test from "node:test";
import { DELEGATED_WORKER_PR_RULE } from "../extensions/orchestrator.ts";

test("delegated worker prompt forbids PR finalization and reserves merges for authorized coordinator", () => {
	assert.match(DELEGATED_WORKER_PR_RULE, /must never merge, close, or otherwise finalize a pull request/);
	assert.match(DELEGATED_WORKER_PR_RULE, /Only the coordinator may merge/);
	assert.match(DELEGATED_WORKER_PR_RULE, /user explicitly authorizes/);
});
