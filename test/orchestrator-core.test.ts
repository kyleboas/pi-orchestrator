import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ORCHESTRATOR_INSTRUCTIONS } from "../extensions/orchestrator-lib/orchestrator-instructions.ts";
import { consumeRootCorrection, resetRootCorrectionBudgets, rootCorrectionAvailable, rootCorrectionCount, validateDelegationRelationship } from "../extensions/orchestrator-lib/root-lineage-policy.ts";
import {
	appendBoundedWorkerText,
	MAX_WORKER_RESULT_BYTES,
	ORCHESTRATOR_TOOL_NAMES,
	SolToolMode,
	WORKER_PROFILES,
	solRestrictedTools,
	isSoloTakeoverPrompt,
	workerRpcArgs,
} from "../extensions/orchestrator-lib/orchestrator-core.ts";

const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "custom_review", ...ORCHESTRATOR_TOOL_NAMES];

test("coordinator instructions cap acceptance review and correction by root lineage", () => {
	assert.match(ORCHESTRATOR_INSTRUCTIONS, /same review and fix limit/);
	assert.match(ORCHESTRATOR_INSTRUCTIONS, /Review completed implementation once, then allow one fix pass/);
	assert.match(ORCHESTRATOR_INSTRUCTIONS, /Link every follow-up worker to the original task with `retryOf`/);
});

test("delegate relationship contract rejects unlinked retries", () => {
	assert.equal(validateDelegationRelationship("replacement", undefined, false).ok, false);
	assert.equal(validateDelegationRelationship("new", undefined, false).ok, true);
	assert.equal(validateDelegationRelationship("continuation", "prior", true).ok, true);
});

test("root correction budget is inherited across retries", () => {
	resetRootCorrectionBudgets();
	assert.equal(rootCorrectionAvailable("root-a"), true);
	assert.equal(consumeRootCorrection("root-a").ok, true);
	assert.equal(rootCorrectionCount("root-a"), 1);
	assert.equal(consumeRootCorrection("root-a").ok, false);
	assert.equal(rootCorrectionAvailable("root-a"), false);
});

function orchestratorSource(): string {
	return readFileSync(new URL("../extensions/orchestrator.ts", import.meta.url), "utf8");
}

test("worker result accumulation is byte bounded across adversarial Unicode chunks", () => {
	for (const codePoint of ["é", "€", "🙂"]) {
		let result = { text: "", truncated: false };
		for (let i = 0; i < 40_000 && !result.truncated; i++) result = appendBoundedWorkerText(result, codePoint);
		assert.equal(result.truncated, true);
		assert.ok(Buffer.byteLength(result.text, "utf8") <= MAX_WORKER_RESULT_BYTES);
		assert.doesNotMatch(result.text, /�$/);
	}
	const mixed = appendBoundedWorkerText({ text: "a".repeat(MAX_WORKER_RESULT_BYTES - 3), truncated: false }, "🙂");
	assert.equal(Buffer.byteLength(mixed.text, "utf8"), MAX_WORKER_RESULT_BYTES - 3);
});

test("worker profiles expose exactly the supported Pi and Claude Code workers", () => {
	assert.deepEqual(Object.keys(WORKER_PROFILES), ["Terra", "Opus 5 Medium", "GPT-5.5 Off", "GPT-5.5 Minimal", "GPT-5.5 Low", "GPT-5.5 Medium", "GPT-5.5 High", "GPT-5.5 xHigh", "GPT-5.5 Max", "Sol-Medium", "Sol-Low", "Opus", "Sonnet", "Haiku", "Fable"]);
	assert.deepEqual(WORKER_PROFILES.Terra, { backend: "pi-rpc", model: "openai-codex/gpt-5.6-terra", thinking: "high", selfPlanning: true });
	assert.deepEqual(WORKER_PROFILES["Opus 5 Medium"], { backend: "claude-code", model: "opus", thinking: "medium", selfPlanning: true });
	assert.deepEqual(WORKER_PROFILES["GPT-5.5 Off"], { backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "off" });
	assert.deepEqual(WORKER_PROFILES["GPT-5.5 Minimal"], { backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "minimal" });
	assert.deepEqual(WORKER_PROFILES["GPT-5.5 Low"], { backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "low" });
	assert.deepEqual(WORKER_PROFILES["GPT-5.5 Medium"], { backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "medium" });
	assert.deepEqual(WORKER_PROFILES["GPT-5.5 High"], { backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "high" });
	assert.deepEqual(WORKER_PROFILES["GPT-5.5 xHigh"], { backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "xhigh" });
	assert.deepEqual(WORKER_PROFILES["GPT-5.5 Max"], { backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "max" });
	assert.deepEqual(WORKER_PROFILES["Sol-Medium"], { backend: "pi-rpc", model: "openai-codex/gpt-5.6-sol", thinking: "medium" });
	assert.deepEqual(WORKER_PROFILES["Sol-Low"], { backend: "pi-rpc", model: "openai-codex/gpt-5.6-sol", thinking: "low" });
	assert.deepEqual(WORKER_PROFILES.Opus, { backend: "claude-code", model: "opus" });
	assert.deepEqual(WORKER_PROFILES.Sonnet, { backend: "claude-code", model: "sonnet" });
	assert.deepEqual(WORKER_PROFILES.Haiku, { backend: "claude-code", model: "haiku" });
	assert.deepEqual(WORKER_PROFILES.Fable, { backend: "claude-code", model: "fable" });
});

test("delegate schema and worker-facing descriptions use the configured worker catalog", () => {
	const source = orchestratorSource();
	assert.match(source, /createWorkerSchema\(catalog/);
	assert.match(source, /workerNames\(catalog\)/);
	assert.match(source, /buildCoordinatorInstructions\(catalog/);
	assert.match(source, /autonomousScope: Type\.Optional/);
	assert.match(source, /subscriptionSensitive: Type\.Optional/);
	for (const field of ["needsWorktree", "needsHeavyWork", "needsBrowser", "needsSecrets", "validationCommands", "knownFacts"]) {
		assert.match(source, new RegExp(`${field}: Type\\.Optional`));
	}
});

test("Pi RPC workers receive thinking plus the required background-job extension", () => {
	for (const [model, thinking] of [[WORKER_PROFILES.Terra.model, "high"], [WORKER_PROFILES["Sol-Low"].model, "low"]] as const) {
		const args = workerRpcArgs(model, thinking);
		assert.deepEqual(args.slice(0, 4), ["--mode", "rpc", "--no-session", "--no-extensions"]);
		assert.match(args[args.indexOf("--extension") + 1] ?? "", /worker-background-job\.ts$/);
		assert.match(args[args.indexOf("--tools") + 1] ?? "", /background_job/);
		assert.equal(args[args.indexOf("--thinking") + 1], thinking);
	}
});

test("Pi RPC lifecycle accepts the public agent_end event and stderr cannot mask structured results", () => {
	const source = orchestratorSource();
	assert.match(source, /case "agent_end":\s*case "agent_settled":/);
	const stderrHandler = source.match(/child\.stderr\.on\("data"[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.match(stderrHandler, /recordWorkerActivity/);
	assert.doesNotMatch(stderrHandler, /lastError\s*[?]?=/);
});

test("coordinator validation policy stays concise", () => {
	const source = readFileSync(new URL("../extensions/orchestrator-lib/orchestrator-instructions.ts", import.meta.url), "utf8");
	assert.match(source, /Run the smallest test or check that adequately covers the change/);
	assert.match(source, /Rerun validation only when the existing result no longer adequately covers the final work/);
});

test("ordinary requests stay in restricted orchestration mode", () => {
	const mode = new SolToolMode();
	assert.equal(isSoloTakeoverPrompt("Fix the failing test"), false);
	assert.deepEqual(mode.activate(["read", "custom_review"], allTools), solRestrictedTools(allTools));
	assert.equal(mode.beginTakeover("Fix the failing test", ORCHESTRATOR_TOOL_NAMES, allTools), undefined);
	assert.equal(mode.takeoverActive, false);
});

test("explicit Sol takeover enables normal implementation tools for one task", () => {
	for (const prompt of ["do it yourself", "Please proceed without delegating.", "Sol fix it now"]) {
		assert.equal(isSoloTakeoverPrompt(prompt), true, prompt);
	}

	const mode = new SolToolMode();
	mode.activate(["read", "custom_review", "orchestrator_delegate"], allTools);
	assert.deepEqual(
		mode.beginTakeover("Sol fix it now", ORCHESTRATOR_TOOL_NAMES, allTools),
		["read", "custom_review", "bash", "edit", "write", "grep", "find", "ls"],
	);
	assert.equal(mode.takeoverActive, true);
});

test("takeover restoration returns exactly to restricted orchestration tools", () => {
	const mode = new SolToolMode();
	mode.activate(["read"], allTools);
	assert.equal(mode.beginTakeover("do it yourself", ORCHESTRATOR_TOOL_NAMES, allTools)?.includes("edit"), true);
	assert.deepEqual(mode.settle(), solRestrictedTools(allTools));
	assert.equal(mode.takeoverActive, false);
	assert.equal(mode.settle(), undefined);
});

test("orchestrator_takeover tool trigger enables takeover for any phrasing, not just the literal regex", () => {
	const mode = new SolToolMode();
	mode.activate(["read", "custom_review", "orchestrator_delegate"], allTools);
	assert.equal(isSoloTakeoverPrompt("Could you just handle this one directly instead of farming it out?"), false);
	assert.deepEqual(
		mode.beginTakeoverTool(ORCHESTRATOR_TOOL_NAMES, allTools),
		["read", "custom_review", "bash", "edit", "write", "grep", "find", "ls"],
	);
	assert.equal(mode.takeoverActive, true);
	assert.deepEqual(mode.settle(), solRestrictedTools(allTools));
});

test("orchestrator_takeover stays in the restricted tool set so it is always available", () => {
	assert.ok(ORCHESTRATOR_TOOL_NAMES.includes("orchestrator_takeover"));
	const mode = new SolToolMode();
	assert.ok(mode.activate(["read"], allTools).includes("orchestrator_takeover"));
});
