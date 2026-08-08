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
	/** Claude Code instructions written but not yet answered by a result event. */
	pendingTurns?: number;
	/** Turns Claude Code actually started (one system/init each) and has not yet ended with a result. */
	startedTurns?: number;
	/** Armed while a written instruction has not started its own turn and may have been merged into the finished one. */
	claudeMergeGraceTimer?: ReturnType<typeof setTimeout>;
	/** A Pi turn that has settled and is waiting for its background jobs. */
	backgroundSettlementHeldRun?: number;
};

/** One outstanding Claude turn's result: settles, belongs to an earlier turn, or awaits a merge verdict. */
export type ClaudeTurnCompletion = "settles" | "earlier-turn" | "unstarted";

/** Record that one more user turn was written to a Claude Code worker. */
export function queueClaudeTurn(worker: WorkerLifecycle): void {
	worker.pendingTurns = (worker.pendingTurns ?? 0) + 1;
}

/**
 * Record that Claude Code actually began a turn. Instructions written while a
 * turn is streaming are often merged into it instead of starting their own, so
 * a write alone never proves another result event is coming.
 */
export function startClaudeTurn(worker: WorkerLifecycle): void {
	worker.startedTurns = (worker.startedTurns ?? 0) + 1;
}

/**
 * Record one Claude Code result event. "settles" means it answered the last
 * outstanding instruction. "earlier-turn" means a later turn is already
 * running, so this result (a turn that was still streaming when a steer queued
 * another) must not settle the steered run. "unstarted" means an instruction
 * is outstanding that Claude has not begun a turn for: it either starts one
 * shortly or was merged into the turn that just ended, and only the absence of
 * a later turn-start event distinguishes the two.
 */
export function completeClaudeTurn(worker: WorkerLifecycle): ClaudeTurnCompletion {
	worker.pendingTurns = Math.max(0, (worker.pendingTurns ?? 1) - 1);
	worker.startedTurns = Math.max(0, (worker.startedTurns ?? 1) - 1);
	if (worker.pendingTurns === 0) return "settles";
	return worker.startedTurns > 0 ? "earlier-turn" : "unstarted";
}

/** Treat every outstanding instruction as merged into the turn that just ended. */
export function mergeOutstandingClaudeTurns(worker: WorkerLifecycle): void {
	worker.pendingTurns = 0;
	worker.startedTurns = 0;
}

/** Drop an armed merge verdict; a new instruction or a terminal state invalidates it. */
export function clearClaudeMergeGrace(worker: WorkerLifecycle): void {
	if (worker.claudeMergeGraceTimer === undefined) return;
	clearTimeout(worker.claudeMergeGraceTimer);
	worker.claudeMergeGraceTimer = undefined;
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
	clearClaudeMergeGrace(worker);
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
