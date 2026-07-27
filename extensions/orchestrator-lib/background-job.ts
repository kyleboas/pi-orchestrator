export const BACKGROUND_JOB_MARKER_PREFIX = "[[pi-background-job:";
export const BACKGROUND_JOB_MARKER_SUFFIX = "]]";
export const BACKGROUND_JOB_MAX_PENDING = 8;
export const BACKGROUND_JOB_MAX_REMEMBERED = 32;
export const BACKGROUND_JOB_MAX_COMMAND_LENGTH = 16_000;
export const BACKGROUND_JOB_MAX_NAME_LENGTH = 64;
export const BACKGROUND_JOB_CLASSES = ["pipeline", "eval", "dev"] as const;
export type BackgroundJobClass = (typeof BACKGROUND_JOB_CLASSES)[number];

export type BackgroundJobStarted = {
	kind: "started";
	jobId: string;
	name: string;
	logPath: string;
};

export type BackgroundJobCompleted = {
	kind: "completed";
	jobId: string;
	logPath: string;
	exitCode: number | null;
	signal: string | null;
};

export type BackgroundJobEvent = BackgroundJobStarted | BackgroundJobCompleted;

export type BackgroundJobTracking = {
	pendingBackgroundJobIds?: Set<string>;
	/** Completion can beat the start tool-result on a very fast job. */
	backgroundJobCompletionsBeforeStart?: string[];
};

const JOB_ID = /^[a-z0-9][a-z0-9-]{7,95}$/;
const JOB_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function isBackgroundJobName(value: unknown): value is string {
	return typeof value === "string" && JOB_NAME.test(value) && value.length <= BACKGROUND_JOB_MAX_NAME_LENGTH;
}

export function isBackgroundJobClass(value: unknown): value is BackgroundJobClass {
	return typeof value === "string" && (BACKGROUND_JOB_CLASSES as readonly string[]).includes(value);
}

export function isBackgroundJobCommand(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= BACKGROUND_JOB_MAX_COMMAND_LENGTH && !/[\0]/.test(value);
}

export function backgroundJobArgs(jobClass: BackgroundJobClass, name: string, command: string): string[] {
	return ["--class", jobClass, "--name", name, "--", "bash", "-lc", command];
}

export function backgroundJobMarker(event: BackgroundJobEvent): string {
	return `${BACKGROUND_JOB_MARKER_PREFIX}${JSON.stringify(event)}${BACKGROUND_JOB_MARKER_SUFFIX}`;
}

function eventFromValue(value: unknown): BackgroundJobEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const event = value as Record<string, unknown>;
	if (!JOB_ID.test(typeof event.jobId === "string" ? event.jobId : "")) return undefined;
	if (typeof event.logPath !== "string" || event.logPath.length === 0 || event.logPath.length > 1_024) return undefined;
	if (event.kind === "started" && isBackgroundJobName(event.name)) {
		return { kind: "started", jobId: event.jobId as string, name: event.name, logPath: event.logPath };
	}
	if (event.kind === "completed" &&
		(event.exitCode === null || (typeof event.exitCode === "number" && Number.isInteger(event.exitCode))) &&
		(event.signal === null || (typeof event.signal === "string" && event.signal.length <= 64))) {
		return { kind: "completed", jobId: event.jobId as string, logPath: event.logPath, exitCode: event.exitCode as number | null, signal: event.signal as string | null };
	}
	return undefined;
}

/** Parse only the compact structured markers emitted by the worker extension. */
export function parseBackgroundJobMarkers(text: string): BackgroundJobEvent[] {
	const events: BackgroundJobEvent[] = [];
	let start = 0;
	while (events.length < BACKGROUND_JOB_MAX_REMEMBERED) {
		const prefix = text.indexOf(BACKGROUND_JOB_MARKER_PREFIX, start);
		if (prefix < 0) break;
		const end = text.indexOf(BACKGROUND_JOB_MARKER_SUFFIX, prefix + BACKGROUND_JOB_MARKER_PREFIX.length);
		if (end < 0) break;
		const json = text.slice(prefix + BACKGROUND_JOB_MARKER_PREFIX.length, end);
		start = end + BACKGROUND_JOB_MARKER_SUFFIX.length;
		if (json.length > 2_048) continue;
		try {
			const event = eventFromValue(JSON.parse(json));
			if (event) events.push(event);
		} catch {
			// Text from the model or a tool is never trusted as a lifecycle event.
		}
	}
	return events;
}

function boundedRemember(values: string[], id: string): void {
	if (values.includes(id)) return;
	values.push(id);
	if (values.length > BACKGROUND_JOB_MAX_REMEMBERED) values.splice(0, values.length - BACKGROUND_JOB_MAX_REMEMBERED);
}

export type BackgroundJobTrackingChange = "started" | "completed" | "already-completed" | "duplicate" | "unknown" | "limit";

/**
 * Update one worker's bounded pending-job state. Unknown completions are kept
 * briefly only to handle a completion that arrives before its start marker.
 */
export function trackBackgroundJobEvent(worker: BackgroundJobTracking, event: BackgroundJobEvent): BackgroundJobTrackingChange {
	const pending = worker.pendingBackgroundJobIds ??= new Set();
	const early = worker.backgroundJobCompletionsBeforeStart ??= [];
	if (event.kind === "started") {
		if (pending.has(event.jobId)) return "duplicate";
		const earlyIndex = early.indexOf(event.jobId);
		if (earlyIndex >= 0) {
			early.splice(earlyIndex, 1);
			return "already-completed";
		}
		if (pending.size >= BACKGROUND_JOB_MAX_PENDING) return "limit";
		pending.add(event.jobId);
		return "started";
	}
	if (pending.delete(event.jobId)) return "completed";
	boundedRemember(early, event.jobId);
	return "unknown";
}

export function hasPendingBackgroundJobs(worker: BackgroundJobTracking): boolean {
	return (worker.pendingBackgroundJobIds?.size ?? 0) > 0;
}

export function clearBackgroundJobs(worker: BackgroundJobTracking): void {
	worker.pendingBackgroundJobIds?.clear();
	worker.backgroundJobCompletionsBeforeStart?.splice(0);
}
