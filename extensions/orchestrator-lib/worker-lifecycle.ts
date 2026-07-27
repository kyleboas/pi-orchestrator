import { clearBackgroundJobs, type BackgroundJobTracking } from "./background-job.ts";

export type WorkerState = "starting" | "working" | "idle" | "failed" | "stopped";

export type WorkerLifecycle = BackgroundJobTracking & {
	state: WorkerState;
	run: number;
	settlingRun?: number;
	reportedRun?: number;
	/** A synchronous report send is in progress; failed sends clear this for retry. */
	reportingRun?: number;
	/** When the worker last left the live states; freezes the row timer and ages it out of selection. */
	settledAt?: Date;
	/** Claude Code emits one result event per user turn; only the last outstanding turn settles the worker. */
	pendingTurns?: number;
	/** A Pi turn that has settled and is waiting for its background jobs. */
	backgroundSettlementHeldRun?: number;
};

/** Record that one more user turn was written to a Claude Code worker. */
export function queueClaudeTurn(worker: WorkerLifecycle): void {
	worker.pendingTurns = (worker.pendingTurns ?? 0) + 1;
}

/**
 * Record one Claude Code result event. Returns true when it belongs to the
 * last outstanding turn and may settle the worker; earlier results (a turn
 * that was already streaming when a steer queued another) must not settle
 * the steered run.
 */
export function completeClaudeTurn(worker: WorkerLifecycle): boolean {
	worker.pendingTurns = Math.max(0, (worker.pendingTurns ?? 1) - 1);
	return worker.pendingTurns === 0;
}

export type WorkerProcessState = {
	exitCode: number | null;
	signalCode: string | null;
	killed: boolean;
	stdin: { writable: boolean; destroyed?: boolean };
};

function isTerminal(state: WorkerState): boolean {
	return state === "failed" || state === "stopped";
}

/** Start a new prompt generation after a verified live worker accepts it. */
export function beginWorkerRun(worker: WorkerLifecycle): void {
	worker.run += 1;
	worker.settlingRun = undefined;
	// This marker belongs to the settled prior turn. Pending job IDs deliberately
	// remain: useful steered work can continue while those jobs run.
	worker.backgroundSettlementHeldRun = undefined;
	worker.reportingRun = undefined;
	worker.settledAt = undefined;
	worker.state = "working";
}

/** A follow-up can resume the same generation after its held idle boundary. */
export function markWorkerRunActive(worker: WorkerLifecycle): void {
	if (isTerminal(worker.state)) return;
	worker.state = "working";
	if (worker.backgroundSettlementHeldRun === worker.run) worker.backgroundSettlementHeldRun = undefined;
}

/**
 * agent_settled is terminal for a Pi run, but final text can require one last
 * get_last_assistant_text RPC. Keep the worker non-steerable until that lookup
 * has either reported or been invalidated by stop/exit.
 */
export function beginWorkerSettlement(worker: WorkerLifecycle): number | undefined {
	if (isTerminal(worker.state) || worker.settlingRun === worker.run || worker.reportedRun === worker.run) return undefined;
	worker.settlingRun = worker.run;
	return worker.run;
}

/** Complete the current, still-live settlement after its final-text lookup. */
export function finishWorkerSettlement(worker: WorkerLifecycle, run: number): boolean {
	if (worker.settlingRun !== run || worker.run !== run || isTerminal(worker.state)) return false;
	worker.settlingRun = undefined;
	worker.backgroundSettlementHeldRun = undefined;
	worker.state = "idle";
	worker.settledAt ??= new Date();
	return true;
}

/** Claim a non-settlement error result without allowing a stopped worker to report. */
export function claimWorkerReport(worker: WorkerLifecycle): boolean {
	if (worker.state === "stopped" || worker.reportedRun === worker.run || worker.reportingRun === worker.run) return false;
	worker.reportedRun = worker.run;
	return true;
}

/** A delivered terminal run is safe to reap only if steering has not started a newer run. */
/** A Pi worker's first idle boundary must wait for its own background jobs. */
export function shouldHoldWorkerSettlement(worker: WorkerLifecycle): boolean {
	return !isTerminal(worker.state) && (worker.pendingBackgroundJobIds?.size ?? 0) > 0;
}

/** A held boundary has no active Pi turn to abort, even if its jobs just finished. */
export function shouldAbortPiWorkerRun(worker: WorkerLifecycle): boolean {
	return worker.state === "working" && worker.backgroundSettlementHeldRun !== worker.run;
}

export function shouldAutoStopReportedWorker(worker: WorkerLifecycle): boolean {
	return (worker.state === "idle" || worker.state === "failed") &&
		worker.reportedRun === worker.run && worker.settlingRun === undefined;
}

/** Stop invalidates any in-flight settlement lookup before the child is killed. */
export function stopWorker(worker: WorkerLifecycle): void {
	worker.state = "stopped";
	worker.settlingRun = undefined;
	worker.backgroundSettlementHeldRun = undefined;
	clearBackgroundJobs(worker);
	worker.reportingRun = undefined;
	worker.settledAt ??= new Date();
}

/** A stale idle state is not enough: the child process itself must still be live. */
export function canSteerWorker(worker: WorkerLifecycle, process: WorkerProcessState): boolean {
	return !isTerminal(worker.state) && worker.settlingRun === undefined &&
		process.exitCode === null && process.signalCode === null && !process.killed &&
		process.stdin.writable && !process.stdin.destroyed;
}

export function selectFinalWorkerText(cached?: string, latest?: string): string | undefined {
	return latest?.trim() || cached?.trim() || undefined;
}
