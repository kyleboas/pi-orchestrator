/** Stable machine-readable worker status sent through Pi's RPC UI channel. */
export const WORKER_STATUS_WIDGET_ID = "mi-orchestrator-workers-v1";
const MAX_WORKERS = 64;
const MAX_ACTIVITY_LENGTH = 120;

type WorkerStatusInput = {
	id: string;
	name: string;
	state: string;
	startedAt: Date;
	lastActivityAt?: Date;
	settledAt?: Date;
	rootTaskId?: string;
	runId?: string;
};

export type WorkerStatusMetadata = {
	revision: number;
	sessionId: string;
	emittedAt: Date;
};

export type WorkerStatusEntry = {
	id: string;
	name: string;
	state: string;
	activity: string;
	startedAt: string;
	lastActivityAt?: string;
	settledAt?: string;
	rootTaskId?: string;
	runId?: string;
};

export type WorkerStatusSnapshot = {
	version: 1;
	revision: number;
	sessionId: string;
	emittedAt: string;
	workers: WorkerStatusEntry[];
};

function dateText(value: Date | undefined): string | undefined {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) return undefined;
	return value.toISOString();
}

function activityFor(state: string): string {
	switch (state) {
		case "starting": return "Starting worker";
		case "working": return "Working on assigned task";
		case "idle": return "Waiting for review";
		case "failed": return "Worker failed";
		case "stopped": return "Worker stopped";
		default: return "Worker status updated";
	}
}

/** Build a bounded snapshot without copying task prompts or worker transcripts. */
export function workerStatusSnapshot(workers: Iterable<WorkerStatusInput>, metadata: WorkerStatusMetadata): WorkerStatusSnapshot {
	return {
		version: 1,
		revision: metadata.revision,
		sessionId: metadata.sessionId,
		emittedAt: dateText(metadata.emittedAt) ?? new Date(0).toISOString(),
		workers: [...workers].slice(0, MAX_WORKERS).map((worker) => ({
			id: worker.id,
			name: worker.name,
			state: worker.state,
			activity: activityFor(worker.state).slice(0, MAX_ACTIVITY_LENGTH),
			startedAt: dateText(worker.startedAt) ?? new Date(0).toISOString(),
			...(dateText(worker.lastActivityAt) ? { lastActivityAt: dateText(worker.lastActivityAt) } : {}),
			...(dateText(worker.settledAt) ? { settledAt: dateText(worker.settledAt) } : {}),
			...(typeof worker.rootTaskId === "string" ? { rootTaskId: worker.rootTaskId } : {}),
			...(typeof worker.runId === "string" ? { runId: worker.runId } : {}),
		})),
	};
}

/** Pi RPC accepts widget lines; one JSON line keeps this channel machine-readable. */
export function workerStatusWidgetLines(workers: Iterable<WorkerStatusInput>, metadata: WorkerStatusMetadata): string[] {
	return [JSON.stringify(workerStatusSnapshot(workers, metadata))];
}
