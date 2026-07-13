import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_WORKERS, loadOrchestratorConfig } from "../extensions/orchestrator-lib/orchestrator-config.ts";
import { catalogText, resolveWorkerModel, workerDescription, workerNames, workerRpcArgs } from "../extensions/orchestrator-lib/orchestrator-core.ts";
import { claudeCodeArgs } from "../extensions/orchestrator-lib/orchestrator-claude.ts";
import { coordinatorInstructions, createWorkerSchema } from "../extensions/orchestrator.ts";

function configFile(value: unknown): string { const dir = mkdtempSync(join(tmpdir(), "pi-orchestrator-")); const file = join(dir, "config.json"); writeFileSync(file, JSON.stringify(value)); return file; }
function remove(file: string) { rmSync(join(file, ".."), { recursive: true, force: true }); }

test("default catalog is portable and Pi profiles inherit the active model", () => {
	const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: join(tmpdir(), "absent-config") });
	assert.deepEqual(workerNames(config.workers), ["Pi-High", "Pi-Medium", "Pi-Low", "Opus", "Sonnet", "Haiku"]);
	assert.deepEqual(config.workers["Pi-High"], { backend: "pi-rpc", thinking: "high" });
	assert.equal(resolveWorkerModel(config.workers["Pi-High"], "provider/current"), "provider/current");
	assert.equal(resolveWorkerModel(config.workers["Pi-High"]), undefined);
	assert.equal(resolveWorkerModel(config.workers.Opus), "opus");
	assert.equal(config.commands.pi, "pi"); assert.equal(config.commands.claude, "claude");
	assert.deepEqual(workerRpcArgs("provider/current", "low").slice(-4), ["--model", "provider/current", "--thinking", "low"]);
});

test("configured map generates dynamic names, metadata, commands, and custom Claude aliases", () => {
	const file = configFile({ coordinator: { provider: "example", id: "lead", thinking: "medium" }, commands: { pi: "pi-custom", claude: "claude-auto" }, workers: { Builder: { backend: "pi-rpc", model: "example/worker", thinking: "high" }, Fable: { backend: "claude-code", model: "fable-placeholder" } } });
	try {
		const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: file, PI_ORCHESTRATOR_PI_BIN: "pi-env" });
		assert.deepEqual(workerNames(config.workers), ["Builder", "Fable"]);
		assert.equal(catalogText(config.workers), "Builder, or Fable");
		assert.match(workerDescription("Fable", config.workers.Fable!), /Fable: persistent Claude Code implementation worker \(fable-placeholder\)/);
		const schema = createWorkerSchema(config.workers) as unknown as { anyOf: Array<{ const: string; description: string }> };
		assert.deepEqual(schema.anyOf.map((entry) => entry.const), ["Builder", "Fable"]);
		assert.match(schema.anyOf[1]!.description, /fable-placeholder/);
		assert.match(coordinatorInstructions(config.workers), /ask Fable/);
		assert.equal(config.commands.pi, "pi-env"); assert.equal(config.commands.claude, "claude-auto");
		const fable = config.workers.Fable;
		assert.equal(fable.backend, "claude-code");
		assert.deepEqual(claudeCodeArgs(fable.model).slice(0, 3), ["-p", "--model", "fable-placeholder"]);
		assert.deepEqual(config.coordinator, { provider: "example", id: "lead", thinking: "medium" });
	} finally { remove(file); }
});

test("configured list is accepted and malformed, empty, or duplicate catalogs safely fall back", () => {
	const list = configFile({ workers: [{ name: "Reviewer", backend: "claude-code", model: "reviewer-alias" }] });
	try { assert.deepEqual(workerNames(loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: list }).workers), ["Reviewer"]); } finally { remove(list); }
	for (const value of [{ workers: {} }, { workers: { "Bad/Name": { backend: "claude-code", model: "x" } } }, { workers: [{ name: "Same", backend: "claude-code", model: "x" }, { name: "same", backend: "claude-code", model: "y" }] }]) {
		const file = configFile(value); try { const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: file }); assert.deepEqual(config.workers, DEFAULT_WORKERS); assert.equal(config.warning, "Orchestrator configuration was invalid; using defaults."); } finally { remove(file); }
	}
});

test("environment command overrides are portable even when config is unavailable", () => {
	const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: join(tmpdir(), "missing"), PI_ORCHESTRATOR_PI_BIN: "my-pi", PI_ORCHESTRATOR_CLAUDE_BIN: "claude-auto" });
	assert.deepEqual(config.commands, { pi: "my-pi", claude: "claude-auto" });
});
