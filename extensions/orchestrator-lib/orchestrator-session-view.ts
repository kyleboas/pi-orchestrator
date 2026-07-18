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

const ANSI_PATTERN = /\u001b\[[0-?]*[ -\/]*[@-~]/g;

function visibleLength(text: string): number {
	return Array.from(text.replace(ANSI_PATTERN, "")).length;
}

/** Word-aware wrap for plain (non-ANSI) text. */
export function wrapPlainText(line: string, width: number): string[] {
	if (width <= 0 || Array.from(line).length <= width) return [line];
	const lines: string[] = [];
	let current = "";
	for (const word of line.split(" ")) {
		const candidate = current ? `${current} ${word}` : word;
		if (Array.from(candidate).length <= width) {
			current = candidate;
			continue;
		}
		if (current) lines.push(current);
		current = word;
		while (Array.from(current).length > width) {
			const chars = Array.from(current);
			lines.push(chars.slice(0, width).join(""));
			current = chars.slice(width).join("");
		}
	}
	if (current) lines.push(current);
	return lines.length ? lines : [""];
}

export type ViewerTheme = {
	fg(color: string, text: string): string;
};

function padVisible(text: string, width: number): string {
	const pad = width - visibleLength(text);
	return pad > 0 ? text + " ".repeat(pad) : text;
}

/**
 * Render the worker session pane shown as a widget above pi's own editor.
 * Deliberately NOT a full-terminal takeover: pi's chat and input stay live
 * below the pane, so typing, history, paste, and submit all behave natively
 * and a submitted message reaches the coordinator (tagged with the viewed
 * worker by the caller's input hook).
 *
 * `bodyLines` are prerendered (already themed/wrapped) transcript lines, so
 * callers can build them with pi's own message components for a native look.
 * `scrollUp` counts lines up from the bottom (0 = follow live output). The
 * pane shrinks below `viewportRows` when the transcript is short rather than
 * padding empty rows. Returns the lines plus the maximum meaningful scrollUp
 * so callers can clamp.
 */
export function renderWorkerPane(
	title: string,
	bodyLines: readonly string[],
	width: number,
	viewportRows: number,
	scrollUp: number,
	theme: ViewerTheme,
): { lines: string[]; maxScrollUp: number } {
	const fullWidth = Math.max(24, width);
	const body = bodyLines.length ? bodyLines : ["No output yet."];

	const viewport = Math.max(3, viewportRows);
	const maxScrollUp = Math.max(0, body.length - viewport);
	const clamped = Math.min(Math.max(0, scrollUp), maxScrollUp);
	const end = body.length - clamped;
	const visible = body.slice(Math.max(0, end - viewport), end).map((line) => padVisible(line, fullWidth));

	// Title and hints are plain text built here, so truncate before theming;
	// prerendered body lines keep their own width handling.
	const fit = (text: string): string => {
		const chars = Array.from(text);
		return padVisible(chars.length > fullWidth ? `${chars.slice(0, fullWidth - 1).join("")}…` : text, fullWidth);
	};
	const hints = `pgup/pgdn scroll${clamped > 0 ? ` (+${clamped})` : ""} · esc to close · the input below messages the coordinator`;
	const lines = [
		theme.fg("text", fit(` ${title}`)),
		theme.fg("dim", "─".repeat(fullWidth)),
		...visible,
		theme.fg("dim", "─".repeat(fullWidth)),
		theme.fg("dim", fit(` ${hints}`)),
	];
	return { lines, maxScrollUp };
}
