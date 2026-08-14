import assert from "node:assert/strict";
import test from "node:test";
import { advisorWorkerName, buildModeChangeDirective, buildWorkerPrompt, lintWorkerTaskPolicyDuplication, measureWorkerPrompt, scoreWorkerExtraWork, type WorkerCatalog } from "../extensions/orchestrator-lib/orchestrator-core.ts";
import { DEFAULT_WORKERS } from "../extensions/orchestrator-lib/orchestrator-config.ts";
import { buildCoordinatorInstructions, subscriptionSensitiveWorkerSelectionGuidance } from "../extensions/orchestrator-lib/orchestrator-instructions.ts";

const VERSIONED: WorkerCatalog = {
	"GPT-5.5 Medium": { backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "medium" },
	"GPT-5.6 Luna Low": { backend: "pi-rpc", model: "openai-codex/gpt-5.6-luna", thinking: "low" },
	"GPT-5.6 Sol Low": { backend: "pi-rpc", model: "openai-codex/gpt-5.6-sol", thinking: "low" },
	"GPT-5.6 Sol High": { backend: "pi-rpc", model: "openai-codex/gpt-5.6-sol", thinking: "high" },
	"Opus 5 Medium": { backend: "claude-code", model: "claude-opus-5", thinking: "medium", selfPlanning: true },
};

test("delegated worker prompt reserves merges for the coordinator after explicit user authorization", () => {
	const prompt = buildWorkerPrompt({ worker: "Luna", task: "Fix the parser.", cwd: "/repo", backend: "pi-rpc" });
	assert.match(prompt, /Delegated workers must never merge pull requests/);
	assert.match(prompt, /coordinator-only after explicit user authorization/);
});

test("PR-creation instructions require a fresh push or safe empty trigger commit", () => {
	const workerPrompt = buildWorkerPrompt({ worker: "Luna", task: "Create a PR.", cwd: "/repo", backend: "pi-rpc", prCreationRequested: true });
	assert.match(workerPrompt, /newly pushed commit representing the final PR contents/);
	assert.match(workerPrompt, /deliberate empty trigger commit/);
	assert.match(workerPrompt, /dirty, detached, shared, or uncertain worktree/);
	assert.match(workerPrompt, /no-empty-commit or no-CI-trigger request/);
	assert.doesNotMatch(
		buildWorkerPrompt({ worker: "Luna", task: "Review this PR.", cwd: "/repo", backend: "pi-rpc" }),
		/newly pushed commit representing the final PR contents/,
	);

	const coordinatorPrompt = buildCoordinatorInstructions(VERSIONED);
	assert.match(coordinatorPrompt, /newly pushed commit representing the final PR contents/);

});

test("worker prompts keep reusable resource guidance outside the task contract", () => {
	const prompt = buildWorkerPrompt({ worker: "Luna", task: "Exact task bytes.\n", cwd: "/repo", backend: "pi-rpc" });
	assert.match(prompt, /Run bounded, low-resource commands directly/);
	assert.equal(prompt.endsWith("Exact task bytes.\n"), true);
});

test("the worker prompt tells a planned worker to execute and a self-planning worker to plan", () => {
	const base = { worker: "Luna", task: "Fix the parser.", cwd: "/repo", backend: "pi-rpc" } as const;
	assert.match(buildWorkerPrompt(base), /carries the plan to execute/);
	assert.match(buildWorkerPrompt(base), /Do not re-plan the approach/);
	assert.match(buildWorkerPrompt({ ...base, selfPlan: true }), /leaves the approach to you/);
	assert.doesNotMatch(buildWorkerPrompt({ ...base, selfPlan: true }), /Do not re-plan the approach/);
});

test("a plan-only worker is told the plan is the deliverable and must not implement it", () => {
	const base = { worker: "Opus 5 Medium", task: "Fix the parser.", cwd: "/repo", backend: "claude-code" } as const;
	const plan = buildWorkerPrompt({ ...base, planOnly: true });
	assert.match(plan, /a planning worker/);
	assert.match(plan, /The plan is the entire deliverable\. Do not implement it/);
	assert.match(plan, /make no edits, commits, or other changes/);
	// The implementation mandate would otherwise order the worker to do the work anyway.
	assert.doesNotMatch(plan, /You own actual implementation/);
	assert.doesNotMatch(plan, /include changed files/);
	assert.doesNotMatch(plan, /Worktree lifecycle contract/);
	assert.doesNotMatch(plan, /newly pushed commit representing the final PR contents/);
	// planOnly wins over selfPlan rather than the two combining into an implement instruction.
	assert.match(buildWorkerPrompt({ ...base, planOnly: true, selfPlan: false }), /Do not implement it/);
	assert.match(buildWorkerPrompt(base), /You own actual implementation/);
});

test("a mid-task mode switch revokes the standing order the launch prompt gave", () => {
	const toPlan = buildModeChangeDirective(true);
	const toImplement = buildModeChangeDirective(false);
	// Merely stating the new mode would leave the launch prompt's opposite order intact.
	assert.match(toPlan, /stop implementing this task/);
	assert.match(toPlan, /Make no further edits/);
	assert.match(toImplement, /implementation is now authorized/);
	assert.match(toImplement, /You own actual implementation/);
	// Switching back to planning must never destroy work already on disk.
	assert.match(toPlan, /Do not revert or clean up what you have already changed/);
	assert.doesNotMatch(toPlan, /revert the/i);
	// The merge guardrail has to survive a switch that grants write access.
	assert.match(toImplement, /never merge pull requests/);
	assert.match(toImplement, /Worktree lifecycle contract/);
	assert.doesNotMatch(toImplement, /newly pushed commit representing the final PR contents/);
});

test("the coordinator uses the concise approved policy without dynamic routing details", () => {
	const instructions = buildCoordinatorInstructions(VERSIONED, "stale worker statistics", { subscriptionSensitive: true });
	for (const phrase of [
		"You are the orchestration lead.",
		"call `orchestrator_takeover` once only",
		"Delegate all other work with `orchestrator_delegate`",
		"For advisor requests, delegate each selected advisor",
		"When delegating it, use `planOnly`",
		"Link every replacement or retry to its original task with `retryOf`",
		"Run the smallest test or check that adequately covers the change.",
		"Use the PR broker when completing a task that explicitly requires a pull request.",
		"A task keeps the same review and fix limit",
	]) assert.match(instructions, new RegExp(phrase.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
	for (const removed of ["GPT-5.6 Luna Low", "Past worker outcomes", "Subscription-sensitive routing is enabled", "Do not infer subscription sensitivity"]) {
		assert.doesNotMatch(instructions, new RegExp(removed.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
	}
	assert.equal(buildCoordinatorInstructions(VERSIONED), instructions);
});

test("the advisor tier resolves through a versioned catalog name rather than a bare literal", () => {
	assert.equal(advisorWorkerName(VERSIONED), "GPT-5.6 Sol High");
	assert.equal(advisorWorkerName(DEFAULT_WORKERS), "Sol-High");
	// A lower tier of the same model must never stand in for the advisor tier.
	assert.equal(advisorWorkerName({ "GPT-5.6 Sol Low": VERSIONED["GPT-5.6 Sol Low"]! }), undefined);
	assert.equal(advisorWorkerName({ Haiku: { backend: "claude-code", model: "haiku" } }), undefined);
});

test("default worker catalog exposes GPT-5.5 at every orchestrator effort level", () => {
	assert.deepEqual(
		["GPT-5.5 Off", "GPT-5.5 Minimal", "GPT-5.5 Low", "GPT-5.5 Medium", "GPT-5.5 High", "GPT-5.5 xHigh", "GPT-5.5 Max"].map((name) => DEFAULT_WORKERS[name]),
		[
			{ backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "off", description: "GPT-5.5 with thinking off; use for simple bounded work when this version is explicitly requested." },
			{ backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "minimal", description: "GPT-5.5 at minimal thinking; use for straightforward bounded work when this version is explicitly requested." },
			{ backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "low", description: "GPT-5.5 at low thinking; use for routine bounded work when this version is explicitly requested." },
			{ backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "medium", description: "GPT-5.5 at medium thinking; use for bounded multi-step work when this version is explicitly requested." },
			{ backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "high", description: "GPT-5.5 at high thinking; use for harder work when this version is explicitly requested." },
			{ backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "xhigh", description: "GPT-5.5 at maximum thinking; reserve for difficult work when this version is explicitly requested." },
			{ backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "max", description: "GPT-5.5 at maximum effort; reserve for the most difficult work when this version is explicitly requested." },
		]
	);
});

test("coordinator output is independent of catalog and planning configuration", () => {
	const instructions = buildCoordinatorInstructions(VERSIONED);
	const alternate = buildCoordinatorInstructions({ Haiku: { backend: "claude-code", model: "haiku" } }, "old stats", { subscriptionSensitive: true });
	assert.equal(alternate, instructions);
	assert.doesNotMatch(instructions, /GPT-5\.6 Luna|GPT-5\.5|Haiku|worker outcomes|subscription-sensitive|quota/i);
});

test("prompt metrics use UTF-8 bytes and preserve the plan, implementation, and PR size order", () => {
	const task = "Fix the parser and validate it.";
	const plan = buildWorkerPrompt({ worker: "Luna", task, cwd: "/repo", backend: "pi-rpc", planOnly: true });
	const ordinary = buildWorkerPrompt({ worker: "Luna", task, cwd: "/repo", backend: "pi-rpc" });
	const pr = buildWorkerPrompt({ worker: "Luna", task, cwd: "/repo", backend: "pi-rpc", prCreationRequested: true });
	const planMetrics = measureWorkerPrompt(task, plan);
	const ordinaryMetrics = measureWorkerPrompt(task, ordinary);
	const prMetrics = measureWorkerPrompt(task, pr);
	assert.equal(planMetrics.totalBytes, planMetrics.taskBytes + planMetrics.policyBytes);
	assert.equal(Buffer.byteLength(task, "utf8"), planMetrics.taskBytes);
	assert.ok(planMetrics.totalBytes < ordinaryMetrics.totalBytes);
	assert.ok(ordinaryMetrics.totalBytes < prMetrics.totalBytes);
	assert.ok(planMetrics.policyBytes > 0);
});

test("tiny plan-only prompts omit PR-create and worktree policy", () => {
	const prompt = buildWorkerPrompt({ worker: "Luna", task: "Plan this.", cwd: "/repo", backend: "pi-rpc", planOnly: true, prCreationRequested: true });
	assert.doesNotMatch(prompt, /newly pushed commit representing the final PR contents/);
	assert.doesNotMatch(prompt, /Worktree lifecycle contract/);
});

test("structured validation commands and known facts stay concise and avoid duplicate commands", () => {
	const one = buildWorkerPrompt({ worker: "Luna", task: "Fix it.", cwd: "/repo", backend: "pi-rpc", validationCommands: ["npm test"] });
	assert.match(one, /Focused validation commands:\n- npm test/);
	const multiple = buildWorkerPrompt({ worker: "Luna", task: "Run npm test, then inspect the result.", cwd: "/repo", backend: "pi-rpc", validationCommands: ["npm test", "npm run lint"] });
	assert.doesNotMatch(multiple, /- npm test\n/);
	assert.match(multiple, /- npm run lint/);
	const known = buildWorkerPrompt({ worker: "Luna", task: "Fix it.", cwd: "/repo", backend: "pi-rpc", knownFacts: ["The parser owns tokenization.", "The focused test is stable."] });
	assert.match(known, /Known facts\. Do not rediscover these facts unless evidence is stale, contradictory, or validation fails/);
	assert.match(known, /The parser owns tokenization/);
	assert.equal(measureWorkerPrompt("Fix it.", buildWorkerPrompt({ worker: "Luna", task: "Fix it.", cwd: "/repo", backend: "pi-rpc" })).totalBytes < measureWorkerPrompt("Fix it.", known).totalBytes, true);
});

test("research and documentation prompts omit default implementation-heavy guidance", () => {
	for (const category of ["research", "documentation"] as const) {
		const prompt = buildWorkerPrompt({ worker: "Luna", task: "Report findings.", cwd: "/repo", backend: "pi-rpc", category });
		assert.doesNotMatch(prompt, /Run bounded, low-resource commands directly/);
		assert.doesNotMatch(prompt, /For heavy local commands expected/);
		assert.doesNotMatch(prompt, /You own actual implementation/);
	}
	const authorized = buildWorkerPrompt({ worker: "Luna", task: "Update the docs.", cwd: "/repo", backend: "pi-rpc", category: "documentation", needsWorktree: true, needsHeavyWork: true });
	assert.match(authorized, /You own actual implementation/);
	assert.match(authorized, /Run bounded, low-resource commands directly/);
	const ordinaryText = buildWorkerPrompt({ worker: "Luna", task: "Research the parser and report the implementation facts.", cwd: "/repo", backend: "pi-rpc" });
	assert.match(ordinaryText, /You own actual implementation/);
	assert.match(ordinaryText, /Run bounded, low-resource commands directly/);
});

test("duplicate-policy linter warns without rejecting and ignores the final verbatim request", () => {
	const warnings = lintWorkerTaskPolicyDuplication("Facts. Use /home/kyle/bin/run-heavy and background_job.\nVerbatim user operative request:\nRun gh pr create.");
	assert.deepEqual(warnings.map((warning) => warning.kind), ["resource", "background"]);
	assert.deepEqual(lintWorkerTaskPolicyDuplication("Verbatim user operative request:\nUse /home/kyle/bin/run-heavy and gh pr create."), []);
});

test("extra-work scoring remains a pure warning scaffold", () => {
	const score = scoreWorkerExtraWork("I ran the full test suite, opened a PR, and searched the entire repository.");
	assert.deepEqual(score.markers, ["full-suite", "unrequested-pr", "broad-rediscovery"]);
	assert.equal(score.score, 3);
	assert.deepEqual(scoreWorkerExtraWork("Created a PR after the requested release work.", { prCreationRequested: true }).markers, []);
});

test("subscription guidance remains exported but is not injected into coordinator output", () => {
	const instructions = buildCoordinatorInstructions(VERSIONED, undefined, { subscriptionSensitive: true });
	assert.doesNotMatch(instructions, /Subscription-sensitive routing/);
	assert.match(subscriptionSensitiveWorkerSelectionGuidance(VERSIONED), /advisor routing remains unchanged/);
});
