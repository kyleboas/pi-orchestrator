import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkerPrompt } from "../extensions/orchestrator-lib/orchestrator-core.ts";

test("delegated worker prompt reserves merges for the coordinator after explicit user authorization", () => {
	const prompt = buildWorkerPrompt({ worker: "Luna", task: "Fix the parser.", cwd: "/repo", backend: "pi-rpc" });
	assert.match(prompt, /Delegated workers must never merge pull requests/);
	assert.match(prompt, /coordinator-only after explicit user authorization/);
});
