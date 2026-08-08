import assert from "node:assert/strict";
import test from "node:test";
import {
	beginWorkerRun,
	completeClaudeTurn,
	mergeOutstandingClaudeTurns,
	queueClaudeTurn,
	startClaudeTurn,
	beginWorkerSettlement,
	canSteerWorker,
	claimWorkerReport,
	finishWorkerSettlement,
	selectFinalWorkerText,
	shouldAutoStopReportedWorker,
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

test("auto-stop selects only current reported terminal runs outside settlement", () => {
	assert.equal(shouldAutoStopReportedWorker(worker({ state: "idle", reportedRun: 1 })), true);
	assert.equal(shouldAutoStopReportedWorker(worker({ state: "failed", reportedRun: 1 })), true);
	assert.equal(shouldAutoStopReportedWorker(worker({ state: "idle", run: 2, reportedRun: 1 })), false, "a steer makes the prior report stale");
	assert.equal(shouldAutoStopReportedWorker(worker({ state: "idle", reportedRun: 1, settlingRun: 1 })), false);
	assert.equal(shouldAutoStopReportedWorker(worker({ state: "starting", reportedRun: 1 })), false);
	assert.equal(shouldAutoStopReportedWorker(worker({ state: "working", reportedRun: 1 })), false);
	assert.equal(shouldAutoStopReportedWorker(worker({ state: "stopped", reportedRun: 1 })), false);
	assert.equal(shouldAutoStopReportedWorker(worker({ state: "idle" })), false, "an undelivered report remains retryable");
});

test("only the last outstanding Claude turn settles a steered worker", () => {
	const worker = { state: "working" as const, run: 1 };
	queueClaudeTurn(worker);
	startClaudeTurn(worker);
	queueClaudeTurn(worker); // steer while the first turn is still streaming
	startClaudeTurn(worker); // Claude began the steered turn as its own
	assert.equal(completeClaudeTurn(worker), "earlier-turn"); // first turn's result must not settle
	assert.equal(completeClaudeTurn(worker), "settles"); // steered turn's result settles
});

test("a result answering an unstarted instruction awaits the merge verdict", () => {
	const worker = { state: "working" as const, run: 1 };
	queueClaudeTurn(worker);
	startClaudeTurn(worker);
	queueClaudeTurn(worker); // steer Claude may merge into the streaming turn
	// The steered turn has not started, so this result may be the only one.
	assert.equal(completeClaudeTurn(worker), "unstarted");
});

test("merged instructions settle on the result of the turn that absorbed them", () => {
	const worker = { state: "working" as const, run: 1, pendingTurns: 1, startedTurns: 0 };
	mergeOutstandingClaudeTurns(worker);
	assert.equal(worker.pendingTurns, 0);
	assert.equal(worker.startedTurns, 0);
});

test("workers from before the counters existed settle on their first result", () => {
	const worker = { state: "working" as const, run: 1 };
	assert.equal(completeClaudeTurn(worker), "settles");
});

test("stopping a worker drops an armed merge verdict", () => {
	let cleared = false;
	const worker: WorkerLifecycle = {
		state: "working",
		run: 1,
		claudeMergeGraceTimer: setTimeout(() => {
			cleared = false;
		}, 60_000),
	};
	cleared = true;
	stopWorker(worker);
	assert.equal(worker.claudeMergeGraceTimer, undefined);
	assert.equal(cleared, true);
});
