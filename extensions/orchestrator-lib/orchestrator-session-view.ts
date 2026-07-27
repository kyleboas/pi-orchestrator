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

export function isHomeKey(data: string): boolean {
	return data === `${ESC}[H` || data === `${ESC}OH` || data === `${ESC}[1~` || data === `${ESC}[7~`;
}

export function isEndKey(data: string): boolean {
	return data === `${ESC}[F` || data === `${ESC}OF` || data === `${ESC}[4~` || data === `${ESC}[8~`;
}

/**
 * Hold a scrolled viewport on the content it is showing. `scrollUp` counts
 * lines up from the bottom, so appended output would otherwise slide the
 * window down and drag the reader toward live output mid-sentence. Growing
 * the offset by the number of appended lines keeps the same lines on screen.
 *
 * A viewport that is already following (0) stays at the bottom by design, and
 * entries trimmed off the front of a bounded transcript need no adjustment
 * because the offset is measured from the bottom.
 */
export function anchorScrollUp(scrollUp: number, previousBodyLength: number, bodyLength: number): number {
	if (scrollUp <= 0) return 0;
	const appended = bodyLength - previousBodyLength;
	return appended > 0 ? scrollUp + appended : scrollUp;
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
): { lines: string[]; maxScrollUp: number; viewport: number; bodyLength: number } {
	const fullWidth = Math.max(24, width);
	const body = bodyLines.length ? bodyLines : ["No output yet."];

	const viewport = Math.max(3, height - 3);
	const maxScrollUp = Math.max(0, body.length - viewport);
	const clamped = Math.min(Math.max(0, scrollUp), maxScrollUp);
	const end = body.length - clamped;
	const visible = body.slice(Math.max(0, end - viewport), end).map((line) => padVisible(line, fullWidth));
	while (visible.length < viewport) visible.push(" ".repeat(fullWidth));

	// Say plainly that a scrolled view is no longer following, and how to resume.
	const hints = clamped > 0
		? `↑/↓ scroll · ${clamped} line${clamped === 1 ? "" : "s"} back, paused · end to follow · esc to go back`
		: "↑/↓ scroll · following live · esc to go back";
	const lines = [
		theme.fg("text", padVisible(` ${title}`, fullWidth)),
		theme.fg("dim", "─".repeat(fullWidth)),
		...visible,
		theme.fg("dim", padVisible(` ${hints}`, fullWidth)),
	];
	return { lines, maxScrollUp, viewport, bodyLength: body.length };
}
