import { formatDuration, type DurationEstimate } from "./orchestrator-stats.ts";
import type { TranscriptEntry } from "./orchestrator-transcript.ts";

/** Base interval for passive worker assessment; healthy workers extend to 2x. */
export const DEFAULT_CHECKIN_MINUTES = 15;

export type CheckInWorkerView = {
	name: string;
	id: string;
	state: string;
	task: string;
	transcript?: readonly TranscriptEntry[];
	startedAt: Date;
	lastCheckinAt?: Date;
	lastCheckinRevision?: number;
	lastAlertAt?: Date;
	lastAlertRevision?: number;
	transcriptRevision?: number;
	healthStreak?: number;
	pendingBackgroundJobIds?: ReadonlySet<string>;
};

/**
 * A completion estimate built only from the outcome ledger, never from the
 * worker: asking a running worker where it stands would mean an RPC round trip,
 * which the passive check exists to avoid.
 */
export function buildPaceLine(elapsedMs: number, estimate?: DurationEstimate): string {
	const elapsed = `running ${formatDuration(Math.max(0, elapsedMs))}`;
	if (!estimate) return `Pace: ${elapsed}; too few comparable recent runs to estimate completion.`;
	const { p50DurationMs: p50, p95DurationMs: p95 } = estimate;
	// Name the reference class so a widened basis is never read as an exact match.
	const reference = `its 7d ${estimate.label} finish at p50 ${formatDuration(p50)}, p95 ${formatDuration(p95)} over ${estimate.samples} samples`;
	const verdict = elapsedMs < p50
		? `about ${formatDuration(p50 - elapsedMs)} to p50`
		: elapsedMs <= p95
			? `past p50, about ${formatDuration(p95 - elapsedMs)} to p95`
			: `${formatDuration(elapsedMs - p95)} past p95, so it is an outlier for this class`;
	return `Pace: ${elapsed}; ${reference} — ${verdict}.`;
}

export type CheckInAssessment = {
	status: "healthy" | "suspicious";
	signals: string[];
	lastWorkerActivityAt?: number;
};

/** Healthy workers get one base-interval backoff, while suspicious workers reset to base. */
export function checkInCadenceMs(worker: Pick<CheckInWorkerView, "healthStreak">, baseIntervalMs: number): number {
	if (!Number.isFinite(baseIntervalMs) || baseIntervalMs <= 0) return 0;
	return baseIntervalMs * (worker.healthStreak && worker.healthStreak > 0 ? 2 : 1);
}

/**
 * The first assessment is based on launch. A healthy check extends routine
 * polling to 2x, but silence since that check is still reassessed at base.
 */
export function isCheckInDue(worker: CheckInWorkerView, baseIntervalMs: number, now = Date.now()): boolean {
	if (!Number.isFinite(baseIntervalMs) || baseIntervalMs <= 0 || worker.state !== "working") return false;
	const checkAnchor = worker.lastCheckinAt?.getTime() ?? worker.startedAt.getTime();
	const adaptiveDueAt = checkAnchor + checkInCadenceMs(worker, baseIntervalMs);
	if (!worker.lastCheckinAt || !worker.healthStreak) return now >= adaptiveDueAt;
	const lastActivityAfterCheck = workerActivity(worker).filter((entry) => entry.at >= checkAnchor).at(-1)?.at;
	const silenceDueAt = (lastActivityAfterCheck ?? checkAnchor) + baseIntervalMs;
	return now >= Math.min(adaptiveDueAt, silenceDueAt);
}

function clip(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	const chars = Array.from(oneLine);
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : oneLine;
}

function workerActivity(worker: CheckInWorkerView): TranscriptEntry[] {
	return (worker.transcript ?? []).filter((entry) =>
		(entry.role === "assistant" || entry.role === "tool") && entry.text.trim(),
	);
}

const BLOCKED_LANGUAGE = /\b(blocked|blocker|cannot proceed|can't proceed|unable to|permission denied|access denied|not authorized|conflict|merge conflict|rate[ -]?limit|too many requests|\b429\b|error|failed|failure|exception)\b/i;
const NEGATED_HEALTHY_LANGUAGE = /\b(?:no|zero|0|without)\s+(?:known\s+)?(?:errors?|failures?|failed|blockers?)\b|\b(?:did not|didn't|not)\s+fail\b|\bnot blocked\b/i;

/**
 * Pure, transcript-only assessment. It deliberately performs no RPC/status
 * request, so observing a worker can never interrupt it.
 */
export function assessWorkerCheckIn(worker: CheckInWorkerView, baseIntervalMs: number, now = Date.now()): CheckInAssessment {
	const signals: string[] = [];
	if (worker.state !== "working") signals.push(`worker state is ${worker.state}`);
	const activity = workerActivity(worker);
	const last = activity.at(-1);
	const lastWorkerActivityAt = last?.at;
	const activityAnchor = lastWorkerActivityAt ?? worker.startedAt.getTime();
	const pendingBackgroundJobCount = worker.pendingBackgroundJobIds?.size ?? 0;
	if (pendingBackgroundJobCount === 0 && now - activityAnchor >= baseIntervalMs) {
		signals.push(`no assistant or tool activity for ${Math.max(1, Math.floor((now - activityAnchor) / 60_000))}m`);
	}
	const since = Math.max(worker.lastCheckinAt?.getTime() ?? 0, now - baseIntervalMs);
	const recent = activity.filter((entry) => entry.at >= since);
	const blocked = recent.find((entry) => BLOCKED_LANGUAGE.test(entry.text) && !NEGATED_HEALTHY_LANGUAGE.test(entry.text));
	if (blocked) signals.push(`${blocked.role} reported possible blockage: “${clip(blocked.text, 120)}”`);
	const normalized = new Map<string, number>();
	for (const entry of recent) {
		const key = `${entry.role}:${clip(entry.text, 180).toLowerCase()}`;
		normalized.set(key, (normalized.get(key) ?? 0) + 1);
	}
	const repeated = [...normalized.entries()].find(([, count]) => count >= 3);
	if (repeated) signals.push(`repeated recent ${repeated[0].split(":", 1)[0]} activity ${repeated[1]} times`);
	return { status: signals.length ? "suspicious" : "healthy", signals, ...(lastWorkerActivityAt === undefined ? {} : { lastWorkerActivityAt }) };
}

/** A compact factual digest from already-captured worker state only. */
export function buildCheckInDigest(worker: CheckInWorkerView, sinceMs: number, now = Date.now(), assessment = assessWorkerCheckIn(worker, sinceMs, now), estimate?: DurationEstimate): string {
	const since = Math.max(worker.lastCheckinAt?.getTime() ?? 0, now - sinceMs);
	const recent = (worker.transcript ?? []).filter((entry) => entry.at >= since);
	const signals = recent
		.filter((entry) => (entry.role === "tool" || entry.role === "assistant") && entry.text.trim())
		.slice(-3)
		.map((entry) => `${entry.role === "tool" ? "tool" : "worker"}: ${clip(entry.text, 100)}`);
	const pendingBackgroundJobCount = worker.pendingBackgroundJobIds?.size ?? 0;
	const lines = [
		`[${worker.name} passive progress check — ${worker.id}]`,
		`Task: ${clip(worker.task, 140)}`,
		buildPaceLine(now - worker.startedAt.getTime(), estimate),
		...(signals.length ? [`Recent: ${signals.join(" | ")}`] : ["Recent: no captured assistant or tool activity."]),
		...(pendingBackgroundJobCount > 0 ? [`Background: waiting for ${pendingBackgroundJobCount} tracked background job${pendingBackgroundJobCount === 1 ? "" : "s"}.`] : []),
	];
	if (assessment.status === "healthy") {
		lines.push(pendingBackgroundJobCount > 0
			? "Assessment: healthy/on track while the tracked background job runs; worker was not interrupted."
			: "Assessment: healthy/on track from captured activity; worker was not interrupted.");
	} else {
		lines.push(`Assessment: suspicious — ${assessment.signals.join("; ")}. Review only for actual drift; steer only if correction is needed. Worker was not interrupted.`);
	}
	return lines.join("\n");
}

/** Do not repeatedly wake Sol for an unchanged stall/error observation. */
export function shouldWakeForCheckIn(worker: Pick<CheckInWorkerView, "lastAlertAt" | "lastAlertRevision" | "transcriptRevision">, assessment: CheckInAssessment): boolean {
	return assessment.status === "suspicious" && !(worker.lastAlertAt && worker.lastAlertRevision === worker.transcriptRevision);
}

export type CheckInApi = {
	sendMessage: (message: { customType: string; content: string; display: boolean; details: Record<string, unknown> }, options: { triggerTurn: boolean; deliverAs: "nextTurn" }) => void;
	sendUserMessage: (content: string, options: { deliverAs: "followUp" }) => void;
};

/** Deliver healthy observations silently; only concrete suspicious signals wake Sol. */
export function deliverCheckIn(api: CheckInApi, digest: string, assessment: CheckInAssessment): "silent" | "wake" {
	if (assessment.status === "healthy") {
		api.sendMessage({ customType: "orchestrator-checkin", content: digest, display: false, details: { status: "healthy" } }, { triggerTurn: false, deliverAs: "nextTurn" });
		return "silent";
	}
	api.sendUserMessage(digest, { deliverAs: "followUp" });
	return "wake";
}
