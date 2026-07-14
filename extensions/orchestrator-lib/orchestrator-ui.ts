export type WorkerPanelState = "starting" | "working" | "idle" | "failed" | "stopped";

export type WorkerPanelItem = {
	id: string;
	name: string;
	task: string;
	state: WorkerPanelState;
	startedAt: Date;
	tokens?: number;
};

/** Low-frequency local redraw: enough for elapsed time without wasting VPS CPU. */
export const WORKER_WIDGET_TICK_MS = 2_000;

export function hasAnimatingWorker(workers: Iterable<WorkerPanelItem>): boolean {
	for (const worker of workers) {
		if (worker.state === "starting" || worker.state === "working") return true;
	}
	return false;
}

function elapsed(startedAt: Date, now: number): string {
	const seconds = Math.max(0, Math.floor((now - startedAt.getTime()) / 1_000));
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
	const duration = elapsed(worker.startedAt, now);
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

/** Workers shown by the panel, in stable row order, for selection to walk. */
export function panelWorkers(workers: WorkerPanelItem[], includeSettled = false): WorkerPanelItem[] {
	return workers.filter((worker) => includeSettled || worker.state === "starting" || worker.state === "working");
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
	const visible = panelWorkers(workers, options.includeSettled ?? false);
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
