import test from "node:test";
import assert from "node:assert/strict";
import {
	hasAnimatingWorker,
	isExpiredWorker,
	panelWorkers,
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

test("settled workers freeze their duration instead of ticking forever", () => {
	const settledAt = new Date(startedAt.getTime() + 30_000);
	const [line] = renderWorkerPanel(
		[worker({ state: "idle", settledAt })],
		startedAt.getTime() + 600_000,
		80,
		{ includeSettled: true },
	)!;
	assert.match(line, /30s$/);
});

test("selection lists only recent settled workers, capped and TTL-bound", () => {
	const now = startedAt.getTime() + 1_000;
	const fresh = (id: string, offsetMs: number) =>
		worker({ id, state: "idle" as const, settledAt: new Date(now - offsetMs) });
	const stale = fresh("stale", 61 * 60 * 1_000);
	const recents = Array.from({ length: 7 }, (_v, i) => fresh(`recent-${i}`, i * 1_000));
	const live = worker({ id: "live", state: "working" as const });
	const shown = panelWorkers([stale, ...recents, live], true, now).map((w) => w.id);
	assert.ok(!shown.includes("stale"));
	assert.ok(shown.includes("live"));
	assert.equal(shown.filter((id) => id.startsWith("recent-")).length, 5);
	assert.deepEqual(panelWorkers([stale, ...recents, live], false, now).map((w) => w.id), ["live"]);
});

test("workers expire only after report delivery and the review window", () => {
	const now = startedAt.getTime();
	const old = new Date(now - 2 * 60 * 60 * 1_000);
	const base = { ...worker({ state: "idle" as const, settledAt: old }), run: 1 };
	assert.equal(isExpiredWorker({ ...base, reportedRun: 1 }, now), true);
	assert.equal(isExpiredWorker({ ...base, reportedRun: undefined }, now), false);
	assert.equal(isExpiredWorker({ ...base, state: "stopped" }, now), true);
	assert.equal(isExpiredWorker({ ...base, state: "working", reportedRun: 1 }, now), false);
	assert.equal(isExpiredWorker({ ...base, settledAt: new Date(now - 1_000), reportedRun: 1 }, now), false);
});
