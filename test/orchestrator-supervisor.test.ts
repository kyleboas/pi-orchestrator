import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ActiveWorkerSupervisor,
	DEFAULT_SUPERVISOR_BATCH_MS,
	DEFAULT_SUPERVISOR_MODEL,
	DEFAULT_SUPERVISOR_TIMEOUT_MS,
	SUPERVISOR_MAX_EVENT_CHARS,
	SUPERVISOR_MAX_EVENTS,
	buildSupervisorPrompt,
	classifySupervisorEntry,
	isSupervisorSteerCurrent,
	parseSupervisorDecision,
	runSupervisorAssessment,
	type SupervisorConfig,
	type SupervisorWorkerView,
} from "../extensions/orchestrator-lib/orchestrator-supervisor.ts";

const config: SupervisorConfig = {
	enabled: true,
	model: DEFAULT_SUPERVISOR_MODEL,
	thinking: "medium",
	batchMs: 20,
	timeoutMs: 500,
	workers: ["Luna"],
};
function worker(overrides: Partial<SupervisorWorkerView> = {}): SupervisorWorkerView {
	return { id: "luna-1", name: "Luna", run: 1, state: "working", task: "Fix the parser", cwd: process.cwd(), ...overrides };
}
function assistant(text: string, extras: Record<string, unknown> = {}) { return { role: "assistant" as const, text, at: Date.now(), ...extras }; }
function tool(name: string, text: string, extras: Record<string, unknown> = {}) {
	return { role: "tool" as const, text, at: Date.now(), tool: { name, ...extras } };
}

test("supervisor classification ignores echoes/thinking and batches ordinary milestones", () => {
	assert.equal(classifySupervisorEntry({ role: "user", text: "echo", at: 1 }), "ignored");
	assert.equal(classifySupervisorEntry({ role: "assistant", text: "private reasoning", thinking: true, at: 1 }), "ignored");
	assert.equal(classifySupervisorEntry(tool("read", "README.md")), "routine");
	assert.equal(classifySupervisorEntry(tool("edit", "README.md", { result: { content: [], isError: false } })), "routine");
	assert.equal(classifySupervisorEntry(tool("bash", "git status", { args: { command: "npm test" }, result: { content: [], isError: false } })), "routine");
	assert.equal(classifySupervisorEntry(tool("bash", "danger", { args: { command: "rm -rf build" } })), "urgent");
	assert.equal(classifySupervisorEntry(tool("read", "permission denied", { result: { content: [{ type: "text", text: "permission denied" }], isError: false } })), "urgent");
	assert.equal(classifySupervisorEntry(tool("bash", "failed", { result: { content: [], isError: true } })), "urgent");
	assert.equal(classifySupervisorEntry(assistant("All tests passed successfully")), "routine");
});

test("supervisor decisions parse strictly and prompts stay bounded", () => {
	assert.deepEqual(parseSupervisorDecision('{"action":"none"}'), { action: "none" });
	assert.deepEqual(parseSupervisorDecision('{"action":"steer","instructions":"Stop using the wrong file.","interrupt":true}'), { action: "steer", instructions: "Stop using the wrong file.", interrupt: true });
	for (const output of ["noise", "{}", '{"action":"none","instructions":"x"}', '{"action":"steer","instructions":"x"}', '{"action":"steer","instructions":"x","interrupt":false,"extra":1}', '{"action":"steer","instructions":"x","interrupt":"false"}']) assert.equal(parseSupervisorDecision(output), undefined);
	const prompt = buildSupervisorPrompt({ worker: worker(), events: Array.from({ length: SUPERVISOR_MAX_EVENTS }, (_, i) => assistant("x".repeat(SUPERVISOR_MAX_EVENT_CHARS) + i)) });
	assert.ok(Buffer.byteLength(prompt, "utf8") <= 12_000);
});

test("routine events batch while urgent events review immediately without coordinator delivery", async () => {
	let calls = 0;
	let seenEvents = 0;
	let coordinatorMessages = 0;
	const supervisor = new ActiveWorkerSupervisor({
		config,
		command: "unused",
		isLive: () => true,
		assess: async (input) => { calls++; seenEvents += input.events.length; return { action: "none" }; },
		onDecision: () => { coordinatorMessages++; },
	});
	supervisor.observe(worker(), assistant("Read one file"));
	supervisor.observe(worker(), assistant("Run the successful tests"));
	await new Promise((resolve) => setTimeout(resolve, 45));
	assert.equal(calls, 1);
	assert.equal(seenEvents, 2);
	supervisor.observe(worker(), tool("bash", "error", { result: { content: [], isError: true } }));
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(calls, 2);
	assert.equal(coordinatorMessages, 0);
	supervisor.dispose();
});

test("settle, manual steer, run change, and dispose drop stale reviews", async () => {
	let resolveAssessment: ((value: { action: "steer"; instructions: string; interrupt: boolean }) => void) | undefined;
	let decisions = 0;
	const supervisor = new ActiveWorkerSupervisor({
		config: { ...config, batchMs: 1 },
		command: "unused",
		isLive: () => true,
		assess: () => new Promise((resolve) => { resolveAssessment = resolve; }),
		onDecision: () => { decisions++; },
	});
	const item = worker();
	supervisor.observe(item, assistant("explicit blocker"));
	await new Promise((resolve) => setTimeout(resolve, 5));
	supervisor.settle(item.id, item.run);
	resolveAssessment?.({ action: "steer", instructions: "wrong", interrupt: true });
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(decisions, 0);
	resolveAssessment = undefined;
	supervisor.observe(item, assistant("another blocker"));
	supervisor.manualSteer(item.id, item.run);
	item.run = 2;
	supervisor.observe(item, assistant("new blocker"));
	supervisor.dispose();
	assert.equal(decisions, 0);
});

test("a manual steer invalidates an automatic decision before it can start or write a run", async () => {
	const current = worker();
	let generation = 0;
	let runs = 0;
	let writes = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const binding = { id: current.id, name: current.name, run: current.run, generation };
	const automatic = (async () => {
		await gate;
		if (!isSupervisorSteerCurrent(binding, current, generation, () => true)) return;
		runs++;
		writes++;
	})();
	// Manual steering invalidates the reviewed generation and starts its own run.
	generation++;
	current.run++;
	release();
	await automatic;
	assert.equal(runs, 0);
	assert.equal(writes, 0);
});

test("stopping a worker invalidates an automatic decision before it can start or write a run", async () => {
	const current = worker();
	let live = true;
	let runs = 0;
	let writes = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const binding = { id: current.id, name: current.name, run: current.run, generation: 0 };
	const automatic = (async () => {
		await gate;
		if (!isSupervisorSteerCurrent(binding, current, 0, () => live)) return;
		runs++;
		writes++;
	})();
	live = false;
	release();
	await automatic;
	assert.equal(runs, 0);
	assert.equal(writes, 0);
});

test("each assessment uses direct isolated Pi print arguments and timeout cleanup", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-supervisor-test-"));
	const executable = join(dir, "fake-pi");
	writeFileSync(executable, `#!/usr/bin/env node\nconst fs = require('fs');\nconst args = process.argv.slice(2).join(' ');\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.stdout.write(JSON.stringify({action:'steer',instructions:args+' '+process.env.PI_ORCHESTRATOR_WORKER,interrupt:false})));\n`);
	chmodSync(executable, 0o755);
	try {
		const decision = await runSupervisorAssessment({ worker: worker(), events: [assistant("milestone")] }, { command: executable, model: DEFAULT_SUPERVISOR_MODEL, thinking: "medium", cwd: dir, timeoutMs: 500 });
		assert.equal(decision?.action, "steer");
		assert.match((decision as { instructions: string }).instructions, /--print/);
		assert.match((decision as { instructions: string }).instructions, /--no-session/);
		assert.match((decision as { instructions: string }).instructions, /--no-extensions/);
		assert.match((decision as { instructions: string }).instructions, /--no-tools/);
		assert.match((decision as { instructions: string }).instructions, / 1$/);

		const sleeper = join(dir, "sleep-pi");
		writeFileSync(sleeper, "#!/usr/bin/env node\nsetTimeout(() => {}, 10000);\n");
		chmodSync(sleeper, 0o755);
		const started = Date.now();
		assert.equal(await runSupervisorAssessment({ worker: worker(), events: [] }, { command: sleeper, model: DEFAULT_SUPERVISOR_MODEL, thinking: "medium", cwd: dir, timeoutMs: 20 }), undefined);
		assert.ok(Date.now() - started < 2_000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});