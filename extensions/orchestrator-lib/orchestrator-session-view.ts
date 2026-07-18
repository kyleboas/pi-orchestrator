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
 * Render the worker session view as a full-screen takeover, like entering a
 * subagent in Claude Code. Pi extensions cannot replace the core chat view,
 * so this is a full-terminal overlay: every row must be padded to the full
 * width and the view must fill the full height, because the compositor
 * replaces exactly the cells a component emits — anything narrower or
 * shorter lets the chat behind it bleed through.
 *
 * `bodyLines` are prerendered (already themed/wrapped) transcript lines, so
 * callers can build them with pi's own message components for a native look.
 * `scrollUp` counts lines up from the bottom (0 = follow live output).
 * Returns the lines plus the maximum meaningful scrollUp so callers can
 * clamp.
 */
export function renderSessionScreen(
	title: string,
	bodyLines: readonly string[],
	width: number,
	height: number,
	scrollUp: number,
	theme: ViewerTheme,
	input?: string,
): { lines: string[]; maxScrollUp: number } {
	const fullWidth = Math.max(24, width);
	const body = bodyLines.length ? bodyLines : ["No output yet."];

	const inputRows = input === undefined ? 0 : 1;
	const viewport = Math.max(3, height - 3 - inputRows);
	const maxScrollUp = Math.max(0, body.length - viewport);
	const clamped = Math.min(Math.max(0, scrollUp), maxScrollUp);
	const end = body.length - clamped;
	const visible = body.slice(Math.max(0, end - viewport), end).map((line) => padVisible(line, fullWidth));
	while (visible.length < viewport) visible.push(" ".repeat(fullWidth));

	const hints = input === undefined
		? `↑/↓ scroll${clamped > 0 ? ` (+${clamped})` : ""} · esc to go back`
		: `↑/↓ scroll${clamped > 0 ? ` (+${clamped})` : ""} · type + enter to message the coordinator · esc to go back`;
	const lines = [
		theme.fg("text", padVisible(` ${title}`, fullWidth)),
		theme.fg("dim", "─".repeat(fullWidth)),
		...visible,
		// Coordinator message line: keep the cursor end visible when the typed
		// text outgrows the row by trimming from the left, code-point safe.
		...(input === undefined ? [] : (() => {
			const room = Math.max(4, fullWidth - 5);
			const chars = Array.from(input);
			const shown = chars.length > room ? `…${chars.slice(chars.length - room + 1).join("")}` : input;
			return [theme.fg("text", padVisible(` › ${shown}▌`, fullWidth))];
		})()),
		theme.fg("dim", padVisible(` ${hints}`, fullWidth)),
	];
	return { lines, maxScrollUp };
}
