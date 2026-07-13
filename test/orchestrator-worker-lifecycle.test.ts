import assert from "node:assert/strict";
import test from "node:test";
import {
	beginWorkerRun,
	beginWorkerSettlement,
	canSteerWorker,
	claimWorkerReport,
	finishWorkerSettlement,
	selectFinalWorkerText,
	stopWorker,
	type WorkerLifecycle,
	type WorkerProcessState,
} from "../extensions/orchestrator-lib/worker-lifecycle.ts";

function worker(overrides: Partial<WorkerLifecycle> = {}): WorkerLifecycle {
	return { state: "working", run: 1, ...overrides };
}

function process(overrides: Partial<WorkerProcessState> = {}): WorkerProcessState {
	return { exitCode: null, signalCode: null, killed: false, stdin: { writable: true }, ...overrides };
}

test("settlement retrieves the authoritative final text when message events had none", () => {
	assert.equal(selectFinalWorkerText(undefined, " Luna final report "), "Luna final report");
	assert.equal(selectFinalWorkerText("early draft", " Luna final report "), "Luna final report");
});

test("a settled run can claim exactly one delayed result notification", () => {
	const lifecycle = worker();
	const run = beginWorkerSettlement(lifecycle);
	assert.equal(run, 1);
	assert.equal(beginWorkerSettlement(lifecycle), undefined, "duplicate agent_settled must not start another delivery");
	assert.equal(finishWorkerSettlement(lifecycle, run!), true);
	assert.equal(lifecycle.state, "idle");
	assert.equal(claimWorkerReport(lifecycle), true);
	assert.equal(beginWorkerSettlement(lifecycle), undefined, "reported run cannot deliver again");
	assert.equal(claimWorkerReport(lifecycle), false, "duplicate completion must not notify twice");
});

test("stop invalidates an in-flight settlement and prevents stale result delivery", () => {
	const lifecycle = worker();
	const run = beginWorkerSettlement(lifecycle);
	stopWorker(lifecycle);
	assert.equal(finishWorkerSettlement(lifecycle, run!), false);
	assert.equal(claimWorkerReport(lifecycle), false);
});

test("steering is refused while settling and after the child has exited", () => {
	const lifecycle = worker({ state: "idle" });
	assert.equal(canSteerWorker(lifecycle, process()), true);
	beginWorkerSettlement(lifecycle);
	assert.equal(canSteerWorker(lifecycle, process()), false, "wait for final delivery before a new run");
	lifecycle.settlingRun = undefined;
	assert.equal(canSteerWorker(lifecycle, process({ exitCode: 0 })), false);
	assert.equal(canSteerWorker(lifecycle, process({ signalCode: "SIGTERM" })), false);
	assert.equal(canSteerWorker(lifecycle, process({ killed: true })), false);
	assert.equal(canSteerWorker(lifecycle, process({ stdin: { writable: false, destroyed: true } })), false);
});

test("a live follow-up starts a new generation and cannot reuse the prior report claim", () => {
	const lifecycle = worker({ state: "idle", reportedRun: 1 });
	beginWorkerRun(lifecycle);
	assert.equal(lifecycle.run, 2);
	assert.equal(claimWorkerReport(lifecycle), true);
});
