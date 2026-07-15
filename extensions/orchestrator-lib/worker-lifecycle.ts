export type WorkerState = "starting" | "working" | "idle" | "failed" | "stopped";

export type WorkerLifecycle = {
	state: WorkerState;
	run: number;
	settlingRun?: number;
	reportedRun?: number;
	/** A synchronous report send is in progress; failed sends clear this for retry. */
	reportingRun?: number;
	/** When the worker last left the live states; freezes the row timer and ages it out of selection. */
	settledAt?: Date;
};

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
	worker.reportingRun = undefined;
	worker.settledAt = undefined;
	worker.state = "working";
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

/** Stop invalidates any in-flight settlement lookup before the child is killed. */
export function stopWorker(worker: WorkerLifecycle): void {
	worker.state = "stopped";
	worker.settlingRun = undefined;
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
