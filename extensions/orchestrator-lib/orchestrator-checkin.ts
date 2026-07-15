import type { TranscriptEntry } from "./orchestrator-transcript.ts";

/**
 * Periodic worker check-ins. The coordinator must not steer workers just to
 * ask for status (that interrupts the work); instead the orchestrator peers
 * into the transcript it already captures and delivers a compact digest of
 * recent activity, so the coordinator can verify direction and steer only to
 * correct course.
 */
export const DEFAULT_CHECKIN_MINUTES = 15;

export type CheckInWorkerView = {
	name: string;
	id: string;
	state: string;
	task: string;
	transcript?: readonly TranscriptEntry[];
	lastActivityAt?: Date;
	startedAt: Date;
	lastCheckinAt?: Date;
};

/** Due when the worker has been continuously working for a full interval since the last instruction or check-in. */
export function isCheckInDue(worker: CheckInWorkerView, intervalMs: number, now = Date.now()): boolean {
	if (!Number.isFinite(intervalMs) || intervalMs <= 0 || worker.state !== "working") return false;
	const anchor = Math.max(
		worker.lastCheckinAt?.getTime() ?? 0,
		worker.lastActivityAt?.getTime() ?? 0,
		worker.startedAt.getTime(),
	);
	return now - anchor >= intervalMs;
}

function clip(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	const chars = Array.from(oneLine);
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : oneLine;
}

/**
 * A short factual digest of the window since the last check-in: how much
 * activity, the recent tool calls, and the worker's latest words. No demands
 * are placed on the worker; it is never interrupted.
 */
export function buildCheckInDigest(worker: CheckInWorkerView, sinceMs: number, now = Date.now()): string {
	const since = Math.max(
		worker.lastCheckinAt?.getTime() ?? 0,
		now - sinceMs,
	);
	const recent = (worker.transcript ?? []).filter((entry) => entry.at >= since);
	const signalLines = recent
		.filter((entry) => (entry.role === "tool" || entry.role === "assistant") && entry.text.trim())
		.slice(-3)
		.map((entry) => `  ${entry.role === "tool" ? "tool" : "worker"}: ${clip(entry.text, 100)}`);
	const lastWords = [...(worker.transcript ?? [])]
		.reverse()
		.find((entry) => entry.role === "assistant" && entry.text.trim());
	const minutes = Math.max(1, Math.round((now - (worker.lastActivityAt?.getTime() ?? worker.startedAt.getTime())) / 60_000));

	const lines = [
		`[${worker.name} progress check — ${worker.id}, working ${minutes}m since its last instructions]`,
		`Task: ${clip(worker.task, 140)}`,
	];
	if (recent.length === 0) {
		lines.push("No new activity captured since the last check.");
	} else {
		lines.push(`Recent activity (${recent.length} transcript entr${recent.length === 1 ? "y" : "ies"}${signalLines.length ? ", latest signals:" : ""})`);
		lines.push(...signalLines);
	}
	if (lastWords) lines.push(`Latest from the worker: ${clip(lastWords.text, 200)}`);
	lines.push(
		"This is a passive digest; the worker was not interrupted. If it is on track, acknowledge in one short sentence and do nothing else. Steer only if it has drifted from the task. Do not ask it for status reports, metrics, or ETAs.",
	);
	return lines.join("\n");
}
