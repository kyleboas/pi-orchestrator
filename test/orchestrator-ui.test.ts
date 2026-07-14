import test from "node:test";
import assert from "node:assert/strict";
import {
	hasAnimatingWorker,
	renderWorkerFooterRows,
	renderWorkerPanel,
	WORKER_WIDGET_TICK_MS,
	type WorkerPanelItem,
} from "../extensions/orchestrator-lib/orchestrator-ui.ts";

const startedAt = new Date("2026-07-13T12:00:00.000Z");
const now = startedAt.getTime() + 2_000;

function worker(overrides: Partial<WorkerPanelItem> = {}): WorkerPanelItem {
	return {
		id: "terra-1",
		name: "Terra",
		task: "Simple delegation test",
		state: "working",
		startedAt,
		...overrides,
	};
}

test("renders the compact Claude-style row without header, tree, or state prose", () => {
	const [line] = renderWorkerPanel([worker({ tokens: 21_700 })], now, 80)!;
	assert.equal(Array.from(line).length, 80);
	assert.match(line, /^○ Terra  Simple delegation test\s+2s · ↑ 21\.7k tokens$/);
	assert.doesNotMatch(line, /Workers|[├└]||working|\$/);
});

test("uses terminal width to right-align status and truncates long activity", () => {
	const [line] = renderWorkerPanel([
		worker({ task: "A very long task description that must not push the status off screen" }),
	], now, 52)!;
	assert.equal(Array.from(line).length, 52);
	assert.match(line, /^○ Terra  A very long task description that must…  2s$/);
});

test("settled workers leave the live footer instead of accumulating", () => {
	assert.equal(renderWorkerPanel([worker({ state: "idle", tokens: 999 })], now, 60), undefined);
	assert.equal(renderWorkerPanel([worker({ state: "failed" })], now, 60), undefined);
	assert.equal(renderWorkerPanel([worker({ state: "stopped" })], now, 60), undefined);
});

test("uses the first sentence as concise activity", () => {
	const [line] = renderWorkerPanel([
		worker({ task: "Inspect the widget. Then perform unrelated detail." }),
	], now, 70)!;
	assert.match(line, /Inspect the widget\./);
	assert.doesNotMatch(line, /unrelated/);
});

test("footer adapter applies the theme text paint once to each complete unstyled worker row", () => {
	const [row] = renderWorkerPanel([worker({ tokens: 21_700 })], now, 80)!;
	const calls: Array<[string, string]> = [];
	const painted = renderWorkerFooterRows([row], {
		fg: (color, text) => {
			calls.push([color, text]);
			return `<${color}>${text}</${color}>`;
		},
	});

	assert.doesNotMatch(row, /\u001b/);
	assert.deepEqual(calls, [["text", row]]);
	assert.deepEqual(painted, [`<text>${row}</text>`]);
});

test("only active workers animate and the cadence stays low overhead", () => {
	assert.equal(WORKER_WIDGET_TICK_MS, 2_000);
	assert.equal(hasAnimatingWorker([worker({ state: "starting" })]), true);
	assert.equal(hasAnimatingWorker([worker({ state: "working" })]), true);
	assert.equal(hasAnimatingWorker([worker({ state: "idle" })]), false);
	assert.equal(hasAnimatingWorker([worker({ state: "failed" })]), false);
});
