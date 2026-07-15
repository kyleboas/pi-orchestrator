import assert from "node:assert/strict";
import test from "node:test";
import { assessWorkerCheckIn, buildCheckInDigest, checkInCadenceMs, deliverCheckIn, isCheckInDue, shouldWakeForCheckIn } from "../extensions/orchestrator-lib/orchestrator-checkin.ts";
import type { TranscriptEntry } from "../extensions/orchestrator-lib/orchestrator-transcript.ts";

const startedAt = new Date("2026-07-15T12:00:00.000Z"); const MIN = 60_000;
function worker(overrides: Record<string, unknown> = {}) { return { name: "Luna", id: "luna-1", state: "working", task: "Implement the migration and run its tests.", startedAt, transcript: [] as TranscriptEntry[], ...overrides }; }

test("initial base assessment is due at 15 minutes and healthy checks back off to 30", () => {
	const base = 15 * MIN; const at = startedAt.getTime();
	assert.equal(isCheckInDue(worker(), base, at + 14 * MIN), false); assert.equal(isCheckInDue(worker(), base, at + 15 * MIN), true);
	const healthy = worker({ lastCheckinAt: new Date(at + 15 * MIN), healthStreak: 1, transcript: [{ at: at + 30 * MIN, role: "assistant", text: "Continuing implementation." }] });
	assert.equal(checkInCadenceMs({ healthStreak: 1 }, base), 30 * MIN); assert.equal(isCheckInDue(healthy, base, at + 44 * MIN), false); assert.equal(isCheckInDue(healthy, base, at + 45 * MIN), true);
	const reset = worker({ lastCheckinAt: new Date(at + 15 * MIN), healthStreak: 0 });
	assert.equal(isCheckInDue(reset, base, at + 30 * MIN), true); assert.equal(isCheckInDue(worker(), 0, at + 30 * MIN), false);
	const silentAfterHealthy = worker({ lastCheckinAt: new Date(at + 15 * MIN), healthStreak: 1, transcript: [{ at: at + 15 * MIN, role: "assistant", text: "Still working." }] });
	assert.equal(isCheckInDue(silentAfterHealthy, base, at + 29 * MIN), false);
	assert.equal(isCheckInDue(silentAfterHealthy, base, at + 30 * MIN), true, "silence returns to the 15-minute base cadence rather than waiting 30 minutes");
});

test("assessment deterministically identifies stalls, blocking language, and repeated activity", () => {
	const at = startedAt.getTime(); const base = 15 * MIN;
	assert.deepEqual(assessWorkerCheckIn(worker(), base, at + base).signals, ["no assistant or tool activity for 15m"]);
	const blocked = assessWorkerCheckIn(worker({ transcript: [{ at: at + 14 * MIN, role: "assistant", text: "Blocked: permission denied by the repository." }] }), base, at + base);
	assert.equal(blocked.status, "suspicious"); assert.match(blocked.signals.join(" "), /possible blockage/);
	const repeated = assessWorkerCheckIn(worker({ transcript: [1, 2, 3].map((n) => ({ at: at + n * MIN, role: "tool" as const, text: "bash: npm test" })) }), base, at + base);
	assert.match(repeated.signals.join(" "), /repeated recent tool activity 3 times/);
	assert.equal(assessWorkerCheckIn(worker({ transcript: [{ at: at + 14 * MIN, role: "assistant", text: "Implementing the test now." }] }), base, at + base).status, "healthy");
	assert.equal(assessWorkerCheckIn(worker({ transcript: [{ at: at + 14 * MIN, role: "assistant", text: "Validation passed: 0 failures and no errors." }] }), base, at + base).status, "healthy");
	assert.equal(assessWorkerCheckIn(worker({ transcript: [{ at: at + 14 * MIN, role: "assistant", text: "No failed checks; validation is healthy." }] }), base, at + base).status, "healthy");
});

test("check-in delivery integration uses triggerTurn:false for healthy work and wakes only suspicious work without touching worker", () => {
	const calls: Array<{ kind: string; options: unknown }> = []; const original = worker();
	const api = { sendMessage: (_message: unknown, options: unknown) => calls.push({ kind: "custom", options }), sendUserMessage: (_text: string, options: unknown) => calls.push({ kind: "user", options }) };
	const healthy = { status: "healthy" as const, signals: [] };
	assert.equal(deliverCheckIn(api, "healthy", healthy), "silent");
	assert.deepEqual(calls, [{ kind: "custom", options: { triggerTurn: false, deliverAs: "nextTurn" } }]);
	assert.equal(deliverCheckIn(api, "stalled", { status: "suspicious", signals: ["no activity"] }), "wake");
	assert.deepEqual(calls[1], { kind: "user", options: { deliverAs: "followUp" } });
	assert.equal(shouldWakeForCheckIn({ lastAlertAt: new Date(), lastAlertRevision: 2, transcriptRevision: 2 }, { status: "suspicious", signals: ["same stall"] }), false, "unchanged alerts are not duplicated");
	assert.equal(shouldWakeForCheckIn({ lastAlertAt: new Date(), lastAlertRevision: 2, transcriptRevision: 3 }, { status: "suspicious", signals: ["new output"] }), true);
	assert.deepEqual(original.transcript, [], "delivery does not interrupt or mutate the worker");
});

test("digest is compact and gives concrete suspicious steering guidance", () => {
	const at = startedAt.getTime(); const transcript: TranscriptEntry[] = [{ at: at + 14 * MIN, role: "assistant", text: "Blocked: rate limit reached." }];
	const assessment = assessWorkerCheckIn(worker({ transcript }), 15 * MIN, at + 15 * MIN);
	const digest = buildCheckInDigest(worker({ transcript }), 15 * MIN, at + 15 * MIN, assessment);
	assert.match(digest, /Luna passive progress check/); assert.match(digest, /rate limit/i); assert.match(digest, /steer only if correction is needed/); assert.ok(digest.length < 1_200);
});
