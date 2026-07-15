export type WorkerPanelState = "starting" | "working" | "idle" | "failed" | "stopped";

export type WorkerPanelItem = {
	id: string;
	name: string;
	task: string;
	state: WorkerPanelState;
	startedAt: Date;
	lastActivityAt?: Date;
	settledAt?: Date;
	tokens?: number;
};

/** Low-frequency local redraw: enough for elapsed time without wasting VPS CPU. */
export const WORKER_WIDGET_TICK_MS = 2_000;

/** Settled workers stay reviewable this long before leaving the selection list. */
export const SETTLED_WORKER_TTL_MS = 60 * 60 * 1_000;

/** At most this many settled workers stay selectable, newest first. */
export const SETTLED_WORKER_LIMIT = 5;

export function hasAnimatingWorker(workers: Iterable<WorkerPanelItem>): boolean {
	for (const worker of workers) {
		if (worker.state === "starting" || worker.state === "working") return true;
	}
	return false;
}

function elapsed(worker: WorkerPanelItem, now: number): string {
	// Time since the worker was last steered, not total runtime; frozen once settled.
	const start = worker.lastActivityAt?.getTime() ?? worker.startedAt.getTime();
	const end = worker.settledAt?.getTime() ?? now;
	const seconds = Math.max(0, Math.floor((end - start) / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function formatTokens(tokens: number): string {
	if (tokens < 1_000) return `${Math.max(0, Math.round(tokens))}`;
	if (tokens < 1_000_000) {
		const value = tokens / 1_000;
		return `${value >= 10 ? value.toFixed(1) : value.toFixed(1)}k`;
	}
	return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function conciseActivity(task: string): string {
	const firstLine = task.trim().split(/\r?\n/, 1)[0] ?? "";
	const firstSentence = firstLine.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim();
	return firstSentence || firstLine || "Working";
}

function textWidth(text: string): number {
	return Array.from(text).length;
}

function truncate(text: string, width: number): string {
	if (width <= 0) return "";
	const chars = Array.from(text);
	if (chars.length <= width) return text;
	if (width === 1) return "…";
	return `${chars.slice(0, width - 1).join("")}…`;
}

function glyphFor(state: WorkerPanelState): string {
	switch (state) {
		case "starting":
		case "working":
			// Claude Code uses a compact hollow activity marker rather than a tree.
			return "○";
		case "idle":
			return "✓";
		case "failed":
			return "✗";
		case "stopped":
			return "–";
	}
}

function statusFor(worker: WorkerPanelItem, now: number): string {
	const duration = elapsed(worker, now);
	if (worker.state === "failed") return `${duration} · failed`;
	if (worker.state === "stopped") return `${duration} · stopped`;
	if (worker.tokens !== undefined && worker.tokens > 0) {
		return `${duration} · ↑ ${formatTokens(worker.tokens)} tokens`;
	}
	return duration;
}

export type WorkerPanelOptions = {
	/** Worker id highlighted by footer keyboard selection. */
	selectedId?: string;
	/** Include settled workers so finished sessions stay enterable while selecting. */
	includeSettled?: boolean;
};

/**
 * Workers shown by the panel, in stable row order, for selection to walk.
 * Settled workers stay reviewable only while recent (newest few, within the
 * TTL) so old delegations do not pile up in the list forever.
 */
export function panelWorkers(workers: WorkerPanelItem[], includeSettled = false, now = Date.now()): WorkerPanelItem[] {
	const live = workers.filter((worker) => worker.state === "starting" || worker.state === "working");
	if (!includeSettled) return live;
	const settled = workers
		.filter((worker) => worker.state !== "starting" && worker.state !== "working")
		.filter((worker) => now - (worker.settledAt?.getTime() ?? worker.startedAt.getTime()) <= SETTLED_WORKER_TTL_MS)
		.sort((a, b) => (b.settledAt?.getTime() ?? 0) - (a.settledAt?.getTime() ?? 0))
		.slice(0, SETTLED_WORKER_LIMIT);
	// Preserve original row order so selection walking stays stable.
	const keep = new Set([...live, ...settled].map((worker) => worker.id));
	return workers.filter((worker) => keep.has(worker.id));
}

/** True once a settled worker's report is delivered and its review window passed. */
export function isExpiredWorker(
	worker: WorkerPanelItem & { run: number; reportedRun?: number },
	now = Date.now(),
): boolean {
	if (worker.state === "starting" || worker.state === "working") return false;
	if (worker.state !== "stopped" && worker.reportedRun !== worker.run) return false;
	return now - (worker.settledAt?.getTime() ?? worker.startedAt.getTime()) > SETTLED_WORKER_TTL_MS;
}

/**
 * Claude-style one-line subagent rows:
 *   ○ Terra  Inspect the repository                         2s · ↑ 21.7k tokens
 *
 * `width` comes from Pi's Component.render(width), allowing the trailing
 * status to be genuinely right-aligned rather than padded for one terminal.
 */
export function renderWorkerPanel(
	workers: WorkerPanelItem[],
	now: number,
	width = 80,
	options: WorkerPanelOptions = {},
): string[] | undefined {
	const visible = panelWorkers(workers, options.includeSettled ?? false, now);
	if (visible.length === 0) return undefined;

	return visible.map((worker) => {
		const selected = options.selectedId !== undefined && worker.id === options.selectedId;
		const glyph = selected ? "❯" : glyphFor(worker.state);
		const prefix = `${glyph} ${worker.name}  `;
		const status = statusFor(worker, now);
		const minimumGap = 2;
		const available = Math.max(1, width - textWidth(prefix) - textWidth(status) - minimumGap);
		const activity = truncate(conciseActivity(worker.task), available);
		const gap = " ".repeat(Math.max(minimumGap, width - textWidth(prefix) - textWidth(activity) - textWidth(status)));

		return `${prefix}${activity}${gap}${status}`;
	});
}

/** Paint each complete live-worker row with the normal readable theme foreground. */
export function renderWorkerFooterRows(
	rows: readonly string[] | undefined,
	theme: { fg(color: "text", text: string): string },
): string[] {
	return rows?.map((row) => theme.fg("text", row)) ?? [];
}
