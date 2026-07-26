import assert from "node:assert/strict";
import test from "node:test";
import {
	claudeAssistantText,
	claudeCodeArgs,
	drainClaudeStreamBuffer,
	claudeResultSettlement,
	claudeUsageTokenTotal,
	claudeUserEvent,
	parseClaudeStreamLine,
} from "../extensions/orchestrator-lib/orchestrator-claude.ts";
import {
	beginWorkerRun,
	beginWorkerSettlement,
	claimWorkerReport,
	finishWorkerSettlement,
	stopWorker,
	selectFinalWorkerText,
	type WorkerLifecycle,
} from "../extensions/orchestrator-lib/worker-lifecycle.ts";

function lifecycle(overrides: Partial<WorkerLifecycle> = {}): WorkerLifecycle {
	return { state: "working", run: 1, ...overrides };
}

test("all Claude profiles use the shared persistent stream-json backend", () => {
	assert.deepEqual(claudeCodeArgs("haiku"), [
		"-p",
		"--model", "haiku",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--permission-mode", "bypassPermissions",
	]);
	for (const profile of ["opus", "sonnet", "haiku", "Fable"]) {
		assert.equal(claudeCodeArgs(profile)[2], profile);
		assert.deepEqual(claudeCodeArgs(profile).slice(3), claudeCodeArgs("haiku").slice(3));
	}
});

test("Claude user instructions use the stream-json user event envelope", () => {
	assert.deepEqual(claudeUserEvent("MARKER"), {
		type: "user",
		message: { role: "user", content: "MARKER" },
	});
});

test("Claude stream parser accepts object and top-level-array event lines", () => {
	const object = parseClaudeStreamLine('{"type":"result","result":"done"}');
	assert.equal(object.ok, true);
	if (object.ok) assert.deepEqual(object.events, [{ type: "result", result: "done" }]);

	const array = parseClaudeStreamLine('[{"type":"system"},{"type":"result","result":"done"}]');
	assert.equal(array.ok, true);
	if (array.ok) assert.deepEqual(array.events.map((event) => event.type), ["system", "result"]);
});

test("Claude stream parser rejects malformed or non-event output without retaining it", () => {
	assert.deepEqual(parseClaudeStreamLine("not-json"), { ok: false });
	assert.deepEqual(parseClaudeStreamLine("[]"), { ok: false });
	assert.deepEqual(parseClaudeStreamLine('[{"type":"result"}, 3]'), { ok: false });
});

test("Claude stream drain handles split chunks and a final result without a newline", () => {
	let remainder = "";
	const events: Record<string, unknown>[] = [];
	for (const chunk of [
		'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done',
		'"}]}}\n{"type":"result","result":"done","is_error":false}',
	]) {
		const drained = drainClaudeStreamBuffer(remainder + chunk);
		assert.equal(drained.ok, true);
		if (!drained.ok) return;
		remainder = drained.remainder;
		events.push(...drained.events);
	}
	assert.equal(remainder, "");
	assert.deepEqual(events.map((event) => event.type), ["assistant", "result"]);
});

test("an incomplete Claude chunk stays buffered until it becomes complete", () => {
	const partial = drainClaudeStreamBuffer('{"type":"result","result":"do');
	assert.equal(partial.ok, true);
	assert.equal(partial.remainder, '{"type":"result","result":"do');
	const complete = drainClaudeStreamBuffer(`${partial.remainder}ne","is_error":false}`);
	assert.equal(complete.ok, true);
	if (complete.ok) assert.deepEqual(complete.events, [{ type: "result", result: "done", is_error: false }]);
});

test("final Claude result captures final text, error status, session ID, and safe usage", () => {
	const settlement = claudeResultSettlement({
		type: "result",
		result: " final report ",
		is_error: false,
		session_id: "safe-session-id",
		usage: {
			input_tokens: 10,
			output_tokens: 20,
			cache_creation_input_tokens: 30,
			cache_read_input_tokens: 40,
			ignored: "not retained",
		},
	});
	assert.deepEqual(settlement, {
		result: "final report",
		isError: false,
		sessionId: "safe-session-id",
		usage: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40 },
	});
	assert.equal(claudeUsageTokenTotal(settlement!.usage), 100);
});

test("Claude result retains total_cost_usd as an API-equivalent estimate", () => {
	assert.equal(claudeResultSettlement({ type: "result", result: "done", is_error: false, total_cost_usd: 0.123 })!.estimatedCostUsd, 0.123);
	assert.equal(claudeResultSettlement({ type: "result", result: "done", total_cost_usd: "unknown" })!.estimatedCostUsd, undefined);
});

test("Claude error results and empty result events remain terminal settlements", () => {
	assert.deepEqual(claudeResultSettlement({ type: "result", result: "request failed", is_error: true }), {
		result: "request failed",
		isError: true,
		sessionId: undefined,
		usage: {},
	});
	assert.deepEqual(claudeResultSettlement({ type: "result", result: "   ", is_error: false }), {
		result: undefined,
		isError: false,
		sessionId: undefined,
		usage: {},
	});
	assert.equal(claudeResultSettlement({ type: "assistant" }), undefined);
	const assistant = claudeAssistantText({
		type: "assistant",
		message: { role: "assistant", content: [{ type: "text", text: "assistant final report" }] },
	});
	const missingDirectText = claudeResultSettlement({ type: "result", result: "   ", is_error: false });
	assert.equal(selectFinalWorkerText(assistant, missingDirectText?.result), "assistant final report");
});

test("a successful Claude result settles and reports exactly once across a second stream turn", () => {
	const worker = lifecycle();
	const firstRun = beginWorkerSettlement(worker);
	assert.equal(finishWorkerSettlement(worker, firstRun!), true);
	assert.equal(claimWorkerReport(worker), true);
	assert.equal(claimWorkerReport(worker), false);

	beginWorkerRun(worker); // steering creates a fresh live stream generation
	const secondRun = beginWorkerSettlement(worker);
	assert.equal(secondRun, 2);
	assert.equal(finishWorkerSettlement(worker, secondRun!), true);
	assert.equal(claimWorkerReport(worker), true);
	assert.equal(claimWorkerReport(worker), false);
});

test("stop race suppresses a stale Claude result and early exit has one error claim", () => {
	const stopped = lifecycle();
	const run = beginWorkerSettlement(stopped);
	stopWorker(stopped);
	assert.equal(finishWorkerSettlement(stopped, run!), false);
	assert.equal(claimWorkerReport(stopped), false);

	const earlyExit = lifecycle({ state: "starting" });
	earlyExit.state = "failed";
	assert.equal(claimWorkerReport(earlyExit), true);
	assert.equal(claimWorkerReport(earlyExit), false);
});
