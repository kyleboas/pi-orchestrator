import assert from "node:assert/strict";
import test from "node:test";
import { advisorWorkerName, buildModeChangeDirective, buildWorkerPrompt, selfPlanningWorkerNames, type WorkerCatalog } from "../extensions/orchestrator-lib/orchestrator-core.ts";
import { DEFAULT_WORKERS } from "../extensions/orchestrator-lib/orchestrator-config.ts";
import { buildCoordinatorInstructions } from "../extensions/orchestrator-lib/orchestrator-instructions.ts";

const VERSIONED: WorkerCatalog = {
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
});

test("the coordinator is told a plan request is not an implementation request", () => {
	const instructions = buildCoordinatorInstructions(VERSIONED);
	assert.match(instructions, /A request to plan is never a request to implement/);
	assert.match(instructions, /delegate with planOnly and return the plan for approval/);
	assert.match(instructions, /Never take over to carry out a plan you just produced/);
	assert.match(instructions, /steer that same worker with planOnly false to authorize implementation/);
	assert.match(instructions, /Either mode can change at any point, including mid-run/);
});

test("the advisor tier resolves through a versioned catalog name rather than a bare literal", () => {
	assert.equal(advisorWorkerName(VERSIONED), "GPT-5.6 Sol High");
	assert.equal(advisorWorkerName(DEFAULT_WORKERS), "Sol-High");
	// A lower tier of the same model must never stand in for the advisor tier.
	assert.equal(advisorWorkerName({ "GPT-5.6 Sol Low": VERSIONED["GPT-5.6 Sol Low"]! }), undefined);
	assert.equal(advisorWorkerName({ Haiku: { backend: "claude-code", model: "haiku" } }), undefined);
});

test("coordinator instructions name the resolved advisor tier and report a blocker when none exists", () => {
	const instructions = buildCoordinatorInstructions(VERSIONED);
	assert.match(instructions, /Advisor routing uses GPT-5\.6 Sol High by default/);
	// The stale bare literal would name a worker that cannot be delegated to.
	assert.doesNotMatch(instructions, /(^|[^.6 ])Sol-High/);
	assert.match(buildCoordinatorInstructions({ Haiku: { backend: "claude-code", model: "haiku" } }), /no configured advisor tier/);
});

test("planning stays with the coordinator except for self-planning workers, and stays overridable per task", () => {
	assert.deepEqual(selfPlanningWorkerNames(VERSIONED), ["Opus 5 Medium"]);
	const instructions = buildCoordinatorInstructions(VERSIONED);
	assert.match(instructions, /You do the planning, not the worker/);
	assert.match(instructions, /Opus 5 Medium may instead receive a goal-level brief/);
	assert.match(instructions, /pass selfPlan on orchestrator_delegate to choose per task/);
	assert.match(instructions, /A plain-English user request wins outright/);
	// With no flagged worker the rule still binds, with no exemption to escape through.
	const noExemption = buildCoordinatorInstructions({ "GPT-5.6 Luna Low": VERSIONED["GPT-5.6 Luna Low"]! });
	assert.match(noExemption, /Every brief must carry a complete plan/);
	assert.doesNotMatch(noExemption, /goal-level brief/);
});
