import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shouldReapHeadlessSession } from "../extensions/orchestrator.ts";
import { workerStatusSnapshot, workerStatusWidgetLines } from "../extensions/orchestrator-lib/orchestrator-worker-status.ts";
import { shouldAutoStopReportedWorker } from "../extensions/orchestrator-lib/worker-lifecycle.ts";
import {
	bindOrchestratorApi,
	killWorkerProcessTree,
	bindOrchestratorSession,
	createOrchestratorRuntimeForTesting,
	deliverWorkerReport,
	disposeOrchestratorCheckInTimer,
	ensureOrchestratorExitHook,
	getOrchestratorRuntime,
	notifyOrchestratorStateChange,
	nextWorkerStatusRevision,
	releaseOrchestratorSession,
	stopWorkerProcess,
	type OrchestratorWorker,
} from "../extensions/orchestrator-lib/orchestrator-runtime.ts";

function api(sendUserMessage: (text: string) => void): ExtensionAPI {
	return { sendUserMessage } as unknown as ExtensionAPI;
}

function worker(): OrchestratorWorker {
	return {
		id: "terra-reload-test",
		name: "Terra",
		profile: { backend: "pi-rpc", model: "openai-codex/gpt-5.6-terra", thinking: "high" },
		task: "test reload ownership",
		rootTaskId: "task-reload-test",
		runId: "terra-reload-test:run-1",
		category: "tests",
		complexity: "low",
		cwd: "/tmp",
		process: { pid: undefined, exitCode: null, signalCode: null, kill: () => true } as unknown as OrchestratorWorker["process"],
		state: "idle",
		run: 1,
		startedAt: new Date(),
		buffer: "",
		transcript: [],
		rpcNextId: 0,
		rpcPending: new Map(),
	};
}

test("worker status is one bounded JSON widget line without task or transcript text", () => {
	const startedAt = new Date("2026-01-01T00:00:00.000Z");
	const entries = Array.from({ length: 70 }, (_, index) => ({
		id: `worker-${index}`,
		name: "Luna",
		state: index === 0 ? "working" : "idle",
		startedAt,
		lastActivityAt: startedAt,
		rootTaskId: "task-1",
		runId: `run-${index}`,
		task: "do not export this secret prompt",
		transcript: [{ role: "assistant", text: "do not export this transcript" }],
	}));
	const metadata = { revision: 7, sessionId: "parent-session-1", emittedAt: startedAt };
	const line = workerStatusWidgetLines(entries, metadata)[0]!;
	assert.equal(line.includes("\\n"), false);
	const snapshot = JSON.parse(line) as ReturnType<typeof workerStatusSnapshot>;
	assert.deepEqual(Object.keys(snapshot), ["version", "revision", "sessionId", "emittedAt", "workers"]);
	assert.equal(snapshot.version, 1);
	assert.equal(snapshot.revision, 7);
	assert.equal(snapshot.sessionId, "parent-session-1");
	assert.equal(snapshot.emittedAt, "2026-01-01T00:00:00.000Z");
	assert.equal(snapshot.workers.length, 64);
	assert.deepEqual(snapshot.workers[0], {
		id: "worker-0",
		name: "Luna",
		state: "working",
		activity: "Working on assigned task",
		startedAt: "2026-01-01T00:00:00.000Z",
		lastActivityAt: "2026-01-01T00:00:00.000Z",
		rootTaskId: "task-1",
		runId: "run-0",
	});
	assert.equal(line.includes("secret prompt"), false);
	assert.equal(line.includes("transcript"), false);
	assert.deepEqual(JSON.parse(workerStatusWidgetLines([], metadata)[0]!), {
		version: 1,
		revision: 7,
		sessionId: "parent-session-1",
		emittedAt: "2026-01-01T00:00:00.000Z",
		workers: [],
	});
	const runtime = createOrchestratorRuntimeForTesting();
	assert.equal(nextWorkerStatusRevision(runtime), 1);
	assert.equal(nextWorkerStatusRevision(runtime), 2);
});

test("reload generations share workers while API/notifier ownership moves safely", () => {
	const runtime = getOrchestratorRuntime();
	runtime.workers.clear();
	runtime.api = undefined;
	runtime.onStateChange = undefined;
	runtime.disposeUi = undefined;
	disposeOrchestratorCheckInTimer(runtime);
	runtime.generation = undefined;
	runtime.headlessReap = false;

	const sharedWorker = worker();
	runtime.workers.set(sharedWorker.id, sharedWorker);
	const delivered: string[] = [];
	let firstNotifierCalls = 0;
	let secondNotifierCalls = 0;
	let firstDisposed = 0;
	let secondDisposed = 0;

	const firstGeneration = bindOrchestratorApi(runtime, api((text) => delivered.push(`first:${text}`)));
	assert.equal(bindOrchestratorSession(runtime, firstGeneration, runtime.api!, () => firstNotifierCalls++, true, () => firstDisposed++), true);
	assert.equal(runtime.headlessReap, true);
	notifyOrchestratorStateChange(runtime);
	assert.equal(firstNotifierCalls, 1);

	// This is what a second evaluation of the extension module sees: the same
	// process-global map and child identity, but a new delivery/UI owner.
	assert.strictEqual(getOrchestratorRuntime(), runtime);
	assert.strictEqual(getOrchestratorRuntime().workers.get(sharedWorker.id), sharedWorker);
	const secondGeneration = bindOrchestratorApi(runtime, api((text) => delivered.push(`second:${text}`)));
	assert.equal(firstDisposed, 1, "new generation retires only the old UI binding");
	assert.equal(bindOrchestratorSession(runtime, secondGeneration, runtime.api!, () => secondNotifierCalls++, false, () => secondDisposed++), true);
	notifyOrchestratorStateChange(runtime);
	assert.equal(firstNotifierCalls, 1, "old notifier is no longer reachable");
	assert.equal(secondNotifierCalls, 1);

	assert.equal(releaseOrchestratorSession(runtime, firstGeneration), false, "stale shutdown cannot clear generation two");
	assert.equal(runtime.headlessReap, false, "stale shutdown cannot restore the old headless mode");
	assert.strictEqual(runtime.workers.get(sharedWorker.id), sharedWorker);
	assert.equal(deliverWorkerReport(runtime, sharedWorker, "result"), true);
	assert.deepEqual(delivered, ["second:result"]);
	assert.equal(releaseOrchestratorSession(runtime, secondGeneration), true);
	assert.equal(secondDisposed, 1);
});

test("Mi coordinator headless mode retains idle workers while ordinary headless mode reaps them", () => {
	const previousMode = process.env.MI_COORDINATOR_MODE;
	const item = worker();
	item.state = "idle";
	item.reportedRun = item.run;
	let killed = 0;
	item.process = {
		pid: undefined,
		exitCode: null,
		signalCode: null,
		kill: () => { killed++; return true; },
	} as unknown as OrchestratorWorker["process"];
	try {
		process.env.MI_COORDINATOR_MODE = "1";
		assert.equal(shouldReapHeadlessSession(), false);
		assert.equal(shouldAutoStopReportedWorker(item), true);
		assert.equal(killed, 0, "Mi coordinator keeps a reported worker available for steering");

		delete process.env.MI_COORDINATOR_MODE;
		assert.equal(shouldReapHeadlessSession(), true);
		if (shouldReapHeadlessSession() && shouldAutoStopReportedWorker(item)) stopWorkerProcess(item);
		assert.equal(killed, 1, "ordinary headless sessions reap reported workers");
	} finally {
		if (previousMode === undefined) delete process.env.MI_COORDINATOR_MODE;
		else process.env.MI_COORDINATOR_MODE = previousMode;
	}
});

test("check-in timers are retired on reload and current-session shutdown", async () => {
	const runtime = createOrchestratorRuntimeForTesting();
	let staleTicks = 0;
	runtime.checkInTimer = setInterval(() => { staleTicks++; }, 1);
	const generation = bindOrchestratorApi(runtime, api(() => {}));
	assert.equal(runtime.checkInTimer, undefined, "a replacement generation clears the old ticker");
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(staleTicks, 0);

	let currentTicks = 0;
	runtime.checkInTimer = setInterval(() => { currentTicks++; }, 1);
	assert.equal(releaseOrchestratorSession(runtime, generation), true);
	assert.equal(runtime.checkInTimer, undefined, "current-session shutdown clears its ticker");
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(currentTicks, 0);
});

test("undeliverable reports are deferred and delivered exactly once after rebinding", () => {
	const runtime = createOrchestratorRuntimeForTesting();
	const settledWorker = worker();
	const messages: string[] = [];

	assert.equal(deliverWorkerReport(runtime, settledWorker, "final"), false, "no target leaves report pending");
	assert.equal(settledWorker.reportedRun, undefined);
	const failedGeneration = bindOrchestratorApi(runtime, api(() => { throw new Error("old API closed"); }));
	assert.equal(deliverWorkerReport(runtime, settledWorker, "final"), false, "failed target leaves report pending");
	assert.equal(settledWorker.reportedRun, undefined);
	const currentGeneration = bindOrchestratorApi(runtime, api((text) => messages.push(text)));
	assert.notEqual(currentGeneration, failedGeneration);
	assert.equal(deliverWorkerReport(runtime, settledWorker, "final"), true);
	assert.equal(deliverWorkerReport(runtime, settledWorker, "final"), false, "successful delivery is exactly once");
	assert.deepEqual(messages, ["final"]);
});

test("the process exit cleanup hook is registered once across generations", () => {
	const runtime = createOrchestratorRuntimeForTesting();
	let registrations = 0;
	const register = (_event: "exit", _listener: () => void) => { registrations++; };
	assert.equal(ensureOrchestratorExitHook(runtime, register), true);
	assert.equal(ensureOrchestratorExitHook(runtime, register), false);
	assert.equal(registrations, 1);
});

test("process exit cleanup kills every live worker regardless of lifecycle state", () => {
	const runtime = createOrchestratorRuntimeForTesting();
	let listener: (() => void) | undefined;
	const killed: string[] = [];
	for (const state of ["starting", "working", "idle", "failed", "stopped"] as const) {
		const item = worker();
		item.id = state;
		item.state = state;
		item.process = {
			pid: undefined,
			exitCode: null,
			signalCode: null,
			kill: () => { killed.push(state); return true; },
		} as unknown as OrchestratorWorker["process"];
		runtime.workers.set(item.id, item);
	}
	const exited = worker();
	exited.id = "exited";
	exited.process = {
		pid: undefined,
		exitCode: 0,
		signalCode: null,
		kill: () => { killed.push("exited"); return true; },
	} as unknown as OrchestratorWorker["process"];
	runtime.workers.set(exited.id, exited);

	ensureOrchestratorExitHook(runtime, (_event, callback) => { listener = callback; });
	listener?.();
	assert.deepEqual(killed.sort(), ["failed", "idle", "starting", "stopped", "working"]);
});

test("stopWorkerProcess invalidates lifecycle and terminates a live child", () => {
	const item = worker();
	item.state = "idle";
	item.reportedRun = item.run;
	item.settlingRun = item.run;
	let killed = 0;
	item.process = {
		pid: undefined,
		exitCode: null,
		signalCode: null,
		kill: () => { killed++; return true; },
	} as unknown as OrchestratorWorker["process"];

	stopWorkerProcess(item);
	assert.equal(item.state, "stopped");
	assert.equal(item.settlingRun, undefined);
	assert.equal(killed, 1);
});

test("killWorkerProcessTree kills a detached worker's whole process group", async () => {
	const { spawn } = await import("node:child_process");
	// A detached group leader with a grandchild; killing only the leader would
	// orphan the grandchild sleep.
	const leader = spawn("bash", ["-c", "sleep 300 & wait"], { detached: true, stdio: "ignore" });
	assert.ok(typeof leader.pid === "number" && leader.pid > 0);
	await new Promise((resolve) => setTimeout(resolve, 200));
	const children = execSync(`pgrep -g ${leader.pid} | wc -l`, { encoding: "utf8" }).trim();
	assert.ok(Number(children) >= 2, `expected leader plus grandchild in group, saw ${children}`);
	killWorkerProcessTree(leader);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const survivors = execSync(`pgrep -g ${leader.pid} | wc -l || true`, { encoding: "utf8" }).trim();
	assert.equal(Number(survivors), 0, "the entire process group is gone");
});

test("killWorkerProcessTree tolerates fake and already-dead children", () => {
	killWorkerProcessTree({ pid: undefined, kill: () => true } as never);
	let killed = false;
	killWorkerProcessTree({ pid: undefined, kill: () => { killed = true; return true; } } as never);
	assert.equal(killed, true, "falls back to a direct kill without a pid");
});
