import assert from "node:assert/strict";
import test from "node:test";
import { buildCheckInDigest, isCheckInDue } from "../extensions/orchestrator-lib/orchestrator-checkin.ts";
import type { TranscriptEntry } from "../extensions/orchestrator-lib/orchestrator-transcript.ts";

const startedAt = new Date("2026-07-15T12:00:00.000Z");
const MIN = 60_000;

function worker(overrides: Record<string, unknown> = {}) {
	return {
		name: "Opus",
		id: "opus-1",
		state: "working",
		task: "Implement the migration and run its tests.",
		startedAt,
		transcript: [] as TranscriptEntry[],
		...overrides,
	};
}

test("check-ins come due only after a quiet full interval of continuous work", () => {
	const interval = 15 * MIN;
	const base = startedAt.getTime();
	assert.equal(isCheckInDue(worker(), interval, base + 14 * MIN), false);
	assert.equal(isCheckInDue(worker(), interval, base + 15 * MIN), true);
	assert.equal(isCheckInDue(worker({ state: "idle" }), interval, base + 20 * MIN), false);
	assert.equal(isCheckInDue(worker(), 0, base + 20 * MIN), false);
	const steered = worker({ lastActivityAt: new Date(base + 10 * MIN) });
	assert.equal(isCheckInDue(steered, interval, base + 20 * MIN), false);
	assert.equal(isCheckInDue(steered, interval, base + 25 * MIN), true);
	const checked = worker({ lastCheckinAt: new Date(base + 16 * MIN) });
	assert.equal(isCheckInDue(checked, interval, base + 20 * MIN), false);
	assert.equal(isCheckInDue(checked, interval, base + 31 * MIN), true);
});

test("digest is compact: task, recent tools, latest words, no demands on the worker", () => {
	const base = startedAt.getTime();
	const transcript: TranscriptEntry[] = [
		{ at: base + 1 * MIN, role: "assistant", text: "Starting with the schema." },
		{ at: base + 5 * MIN, role: "tool", text: "bash: npm test" },
		{ at: base + 9 * MIN, role: "tool", text: "edit: src/migrate.ts" },
		{ at: base + 12 * MIN, role: "assistant", text: "Migration written; fixing the failing regression test now." },
	];
	const digest = buildCheckInDigest(worker({ transcript }), 15 * MIN, base + 15 * MIN);
	assert.match(digest, /Opus progress check — opus-1, working 15m/);
	assert.match(digest, /edit: src\/migrate\.ts/);
	assert.match(digest, /fixing the failing regression test/);
	assert.match(digest, /worker was not interrupted/);
	assert.match(digest, /Do not ask it for status reports, metrics, or ETAs\./);
	assert.ok(digest.length < 1_200);
});

test("digest notes silence when nothing new was captured", () => {
	const base = startedAt.getTime();
	const transcript: TranscriptEntry[] = [{ at: base, role: "assistant", text: "On it." }];
	const digest = buildCheckInDigest(worker({ transcript, lastCheckinAt: new Date(base + 16 * MIN) }), 15 * MIN, base + 31 * MIN);
	assert.match(digest, /No new activity captured/);
});
