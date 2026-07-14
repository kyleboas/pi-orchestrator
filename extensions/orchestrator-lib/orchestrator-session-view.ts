import type { TranscriptEntry } from "./orchestrator-transcript.ts";
import type { WorkerPanelState } from "./orchestrator-ui.ts";

/**
 * Raw-input key matching. Covers legacy CSI, SS3, and kitty CSI-u encodings so
 * arrow navigation works across terminals without depending on pi-tui's
 * keybindings manager from inside an extension.
 */
const ESC = "\u001b";

export function isUpKey(data: string): boolean {
	return data === `${ESC}[A` || data === `${ESC}OA` || /^\u001b\[1;\d+A$/.test(data);
}

export function isDownKey(data: string): boolean {
	return data === `${ESC}[B` || data === `${ESC}OB` || /^\u001b\[1;\d+B$/.test(data);
}

export function isEnterKey(data: string): boolean {
	return data === "\r" || data === "\n" || data === `${ESC}[13u`;
}

export function isEscapeKey(data: string): boolean {
	return data === ESC || data === `${ESC}[27u`;
}

export function isPageUpKey(data: string): boolean {
	return data === `${ESC}[5~`;
}

export function isPageDownKey(data: string): boolean {
	return data === `${ESC}[6~`;
}

export type SelectableWorker = {
	id: string;
	state: WorkerPanelState;
};

/**
 * Footer row selection: down from the editor enters the list, up past the
 * first row returns to the editor (returns undefined).
 */
export function moveSelection(
	workerIds: readonly string[],
	selectedId: string | undefined,
	direction: "up" | "down",
): string | undefined {
	if (workerIds.length === 0) return undefined;
	const index = selectedId === undefined ? -1 : workerIds.indexOf(selectedId);
	if (index === -1) return direction === "down" ? workerIds[0] : workerIds[workerIds.length - 1];
	if (direction === "down") return workerIds[Math.min(workerIds.length - 1, index + 1)];
	return index === 0 ? undefined : workerIds[index - 1];
}

function wrapLine(line: string, width: number): string[] {
	if (width <= 0) return [line];
	const chars = Array.from(line);
	if (chars.length <= width) return [line];
	const lines: string[] = [];
	for (let start = 0; start < chars.length; start += width) lines.push(chars.slice(start, start + width).join(""));
	return lines;
}

function rolePrefix(role: TranscriptEntry["role"]): string {
	switch (role) {
		case "user":
			return "❯";
		case "assistant":
			return "●";
		case "tool":
			return "⚒";
		case "system":
			return "!";
	}
}

export type ViewerTheme = {
	fg(color: string, text: string): string;
};

export type ViewerWorkerView = {
	name: string;
	id: string;
	state: WorkerPanelState;
	task: string;
	transcript: readonly TranscriptEntry[];
};

/**
 * Render the worker session view. `scrollUp` counts wrapped lines up from the
 * bottom (0 = follow live output). Returns the lines plus the maximum
 * meaningful scrollUp so callers can clamp.
 */
export function renderWorkerSession(
	worker: ViewerWorkerView,
	width: number,
	height: number,
	scrollUp: number,
	theme: ViewerTheme,
): { lines: string[]; maxScrollUp: number } {
	const innerWidth = Math.max(20, width - 2);
	const body: string[] = [];
	for (const entry of worker.transcript) {
		const prefix = `${rolePrefix(entry.role)} `;
		const entryLines = entry.text.split(/\r?\n/);
		entryLines.forEach((line, index) => {
			for (const wrapped of wrapLine(index === 0 ? prefix + line : `  ${line}`, innerWidth)) {
				const styled = entry.role === "assistant" ? theme.fg("text", wrapped) : theme.fg("dim", wrapped);
				body.push(styled);
			}
		});
		body.push("");
	}
	if (body.length === 0) body.push(theme.fg("dim", "No output yet."));

	const viewport = Math.max(3, height - 3);
	const maxScrollUp = Math.max(0, body.length - viewport);
	const clamped = Math.min(Math.max(0, scrollUp), maxScrollUp);
	const end = body.length - clamped;
	const visible = body.slice(Math.max(0, end - viewport), end);

	const title = ` ${worker.name} · ${worker.state} · ${worker.id} `;
	const hints = clamped > 0 ? "↑/↓ scroll · end: follow · esc: back" : "↑/↓ scroll · esc: back";
	return {
		lines: [
			theme.fg("text", title.slice(0, width)),
			theme.fg("dim", "─".repeat(Math.max(0, width))),
			...visible,
			theme.fg("dim", hints.slice(0, width)),
		],
		maxScrollUp,
	};
}
