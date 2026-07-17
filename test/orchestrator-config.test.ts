import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_ROLLOVER_CONTEXT_PERCENT, DEFAULT_WORKERS, loadOrchestratorConfig } from "../extensions/orchestrator-lib/orchestrator-config.ts";
import { DEFAULT_CHECKIN_MINUTES } from "../extensions/orchestrator-lib/orchestrator-checkin.ts";
import { catalogText, piRpcWorkerArgs, workerDescription, workerNames } from "../extensions/orchestrator-lib/orchestrator-core.ts";
import { claudeCodeArgs } from "../extensions/orchestrator-lib/orchestrator-claude.ts";
import { coordinatorInstructions, createWorkerSchema } from "../extensions/orchestrator.ts";

function configFile(value: unknown): string { const dir = mkdtempSync(join(tmpdir(), "pi-orchestrator-")); const file = join(dir, "config.json"); writeFileSync(file, JSON.stringify(value)); return file; }
function remove(file: string) { rmSync(join(file, ".."), { recursive: true, force: true }); }

const EXPECTED_DEFAULT_WORKERS = {
	Luna: { backend: "pi-rpc", model: "openai-codex/gpt-5.6-luna", thinking: "low", description: "Fast and cheap; the default for routine bounded work: narrow searches, small mechanical edits, config changes, verification runs." },
	"Sol-Low": { backend: "pi-rpc", model: "openai-codex/gpt-5.6-sol", thinking: "low", description: "Mid tier for ordinary single-file implementation when Luna would be out of its depth." },
	"Sol-Medium": { backend: "pi-rpc", model: "openai-codex/gpt-5.6-sol", thinking: "medium", description: "Mid tier with more thinking for multi-step changes with edge cases." },
	Terra: { backend: "pi-rpc", model: "openai-codex/gpt-5.6-terra", thinking: "high", description: "Heavy tier; reserve for genuinely hard multi-file work, tricky debugging, or design-sensitive changes." },
	Opus: { backend: "claude-code", model: "opus" },
	Sonnet: { backend: "claude-code", model: "sonnet" },
	Haiku: { backend: "claude-code", model: "haiku" },
	Fable: { backend: "claude-code", model: "fable" },
} as const;

test("default catalog uses eight explicit individual worker profiles", () => {
	const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: join(tmpdir(), "absent-config") });
	assert.deepEqual(workerNames(config.workers), ["Luna", "Sol-Low", "Sol-Medium", "Terra", "Opus", "Sonnet", "Haiku", "Fable"]);
	assert.deepEqual(config.workers, EXPECTED_DEFAULT_WORKERS);
	assert.deepEqual(DEFAULT_WORKERS, EXPECTED_DEFAULT_WORKERS);
	const terra = config.workers.Terra!;
	assert.equal(terra.backend, "pi-rpc");
	assert.deepEqual(piRpcWorkerArgs(terra), ["--mode", "rpc", "--no-session", "--no-extensions", "--tools", "read,bash,edit,write", "--model", "openai-codex/gpt-5.6-terra", "--thinking", "high"]);
	assert.equal(config.commands.pi, "pi"); assert.equal(config.commands.claude, "claude");
	assert.equal(config.checkInMinutes, DEFAULT_CHECKIN_MINUTES);
	assert.equal(config.rolloverContextPercent, DEFAULT_ROLLOVER_CONTEXT_PERCENT);
});

test("checkInMinutes and rollover threshold accept bounded configuration with zero disable", () => {
	for (const [value, expected] of [[0, 0], [1, 1], [0.25, 0.25], [Number.MAX_VALUE, Number.MAX_VALUE], [-1, DEFAULT_CHECKIN_MINUTES], ["15", DEFAULT_CHECKIN_MINUTES], [null, DEFAULT_CHECKIN_MINUTES]] as const) {
		const file = configFile({ checkInMinutes: value });
		try {
			assert.equal(loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: file }).checkInMinutes, expected);
		} finally { remove(file); }
	}
	for (const [value, expected] of [[0, 0], [38, 38], [100, 100], [-1, DEFAULT_ROLLOVER_CONTEXT_PERCENT], [101, DEFAULT_ROLLOVER_CONTEXT_PERCENT], ["38", DEFAULT_ROLLOVER_CONTEXT_PERCENT]] as const) {
		const file = configFile({ rolloverContextPercent: value });
		try { assert.equal(loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: file }).rolloverContextPercent, expected); } finally { remove(file); }
	}
});

test("Pi launch arguments always use the profile model, never the coordinator model", () => {
	const workers = { Builder: { backend: "pi-rpc", model: "workers/implementation", thinking: "low" } };
	const first = configFile({ coordinator: { provider: "coordinator", id: "first", thinking: "high" }, workers });
	const second = configFile({ coordinator: { provider: "other", id: "second", thinking: "medium" }, workers });
	try {
		const firstProfile = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: first }).workers.Builder!;
		const secondProfile = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: second }).workers.Builder!;
		assert.equal(firstProfile.backend, "pi-rpc"); assert.equal(secondProfile.backend, "pi-rpc");
		assert.deepEqual(piRpcWorkerArgs(firstProfile), piRpcWorkerArgs(secondProfile));
		assert.deepEqual(piRpcWorkerArgs(firstProfile).slice(-4), ["--model", "workers/implementation", "--thinking", "low"]);
	} finally { remove(first); remove(second); }
});

test("configured map generates dynamic names, explicit Pi metadata, commands, and custom Claude aliases", () => {
	const file = configFile({ coordinator: { provider: "example", id: "lead", thinking: "medium" }, commands: { pi: "pi-custom", claude: "claude-auto" }, workers: { Builder: { backend: "pi-rpc", model: "example/worker", thinking: "high" }, Fable: { backend: "claude-code", model: "fable-placeholder" } } });
	try {
		const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: file, PI_ORCHESTRATOR_PI_BIN: "pi-env" });
		assert.deepEqual(workerNames(config.workers), ["Builder", "Fable"]);
		assert.equal(catalogText(config.workers), "Builder, or Fable");
		assert.match(workerDescription("Builder", config.workers.Builder!), /example\/worker, high thinking/);
		assert.match(workerDescription("Fable", config.workers.Fable!), /Fable: persistent Claude Code implementation worker \(fable-placeholder\)/);
		const schema = createWorkerSchema(config.workers) as unknown as { anyOf: Array<{ const: string; description: string }> };
		assert.deepEqual(schema.anyOf.map((entry) => entry.const), ["Builder", "Fable"]);
		assert.match(schema.anyOf[0]!.description, /example\/worker/);
		assert.match(schema.anyOf[1]!.description, /fable-placeholder/);
		assert.match(coordinatorInstructions(config.workers), /ask Fable/);
		assert.match(coordinatorInstructions(config.workers), /unqualified new task, start with Luna/);
		assert.match(coordinatorInstructions(config.workers), /Each distinct new task gets a new delegate/);
		assert.match(coordinatorInstructions(config.workers), /Never delegate a merge/);
		assert.equal(config.commands.pi, "pi-env"); assert.equal(config.commands.claude, "claude-auto");
		const fable = config.workers.Fable!;
		assert.equal(fable.backend, "claude-code");
		assert.deepEqual(claudeCodeArgs(fable.model).slice(0, 3), ["-p", "--model", "fable-placeholder"]);
		assert.deepEqual(config.coordinator, { provider: "example", id: "lead", thinking: "medium" });
	} finally { remove(file); }
});

test("configured list is accepted and malformed, missing-model, empty, or duplicate catalogs safely fall back", () => {
	const list = configFile({ workers: [{ name: "Reviewer", backend: "claude-code", model: "reviewer-alias" }] });
	try { assert.deepEqual(workerNames(loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: list }).workers), ["Reviewer"]); } finally { remove(list); }
	for (const value of [
		{ workers: {} },
		{ workers: { "Bad/Name": { backend: "claude-code", model: "x" } } },
		{ workers: { Builder: { backend: "pi-rpc", thinking: "high" } } },
		{ workers: { Builder: { backend: "pi-rpc", model: "   ", thinking: "high" } } },
		{ workers: [{ name: "Same", backend: "claude-code", model: "x" }, { name: "same", backend: "claude-code", model: "y" }] },
	]) {
		const file = configFile(value); try { const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: file }); assert.deepEqual(config.workers, DEFAULT_WORKERS); assert.equal(config.warning, "Orchestrator configuration was invalid; using defaults."); } finally { remove(file); }
	}
});

test("pull request broker config is opt-in and malformed policy fails closed", () => {
	const absent = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: join(tmpdir(), "absent-pr-broker-config") });
	assert.equal(absent.pullRequests, undefined);
	const valid = configFile({ pullRequests: { repositories: ["Owner/Repository"], branchPrefixes: ["feat/"] } });
	const invalid = configFile({ pullRequests: { repositories: ["owner/repository"], branchPrefixes: ["feat/", "feat/"] } });
	try {
		assert.deepEqual(loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: valid }).pullRequests, { repositories: ["owner/repository"], branchPrefixes: ["feat/"] });
		const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: invalid });
		assert.equal(config.pullRequests, undefined);
		assert.match(config.warning ?? "", /Pull request broker configuration was invalid/);
	} finally { remove(valid); remove(invalid); }
});

test("environment command overrides are portable even when config is unavailable", () => {
	const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: join(tmpdir(), "missing"), PI_ORCHESTRATOR_PI_BIN: "my-pi", PI_ORCHESTRATOR_CLAUDE_BIN: "claude-auto" });
	assert.deepEqual(config.commands, { pi: "my-pi", claude: "claude-auto" });
});

test("a config without workers keeps its coordinator and commands with the default catalog", () => {
	const file = configFile({ coordinator: { provider: "p", id: "m", thinking: "high" }, commands: { claude: "claude-auto" } });
	const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: file });
	assert.equal(config.warning, undefined);
	assert.equal(config.coordinator.id, "m");
	assert.equal(config.commands.claude, "claude-auto");
	assert.deepEqual(config.workers, EXPECTED_DEFAULT_WORKERS);
});

test("worker descriptions are accepted, sanitized, and surfaced", () => {
	const file = configFile({ workers: { Builder: { backend: "pi-rpc", model: "p/m", thinking: "low", description: "Line one\nline two\t end  " } } });
	const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: file });
	assert.equal(config.workers.Builder!.description, "Line one line two end");
});
