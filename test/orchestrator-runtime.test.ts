import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	bindOrchestratorApi,
	bindOrchestratorSession,
	createOrchestratorRuntimeForTesting,
	deliverWorkerReport,
	ensureOrchestratorExitHook,
	getOrchestratorRuntime,
	notifyOrchestratorStateChange,
	releaseOrchestratorSession,
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
		cwd: "/tmp",
		process: { kill: () => true } as unknown as OrchestratorWorker["process"],
		state: "idle",
		run: 1,
		startedAt: new Date(),
		buffer: "",
		transcript: [],
		rpcNextId: 0,
		rpcPending: new Map(),
	};
}

test("reload generations share workers while API/notifier ownership moves safely", () => {
	const runtime = getOrchestratorRuntime();
	runtime.workers.clear();
	runtime.api = undefined;
	runtime.onStateChange = undefined;
	runtime.disposeUi = undefined;
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
