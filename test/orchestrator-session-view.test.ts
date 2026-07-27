import test from "node:test";
import assert from "node:assert/strict";
import {
	isDownKey,
	isEnterKey,
	isEscapeKey,
	isUpKey,
	moveSelection,
	anchorScrollUp,
	renderSessionScreen,
	wrapPlainText,
} from "../extensions/orchestrator-lib/orchestrator-session-view.ts";
import {
	appendTranscript,
	mergeTranscriptEntry,
	TRANSCRIPT_MAX_ENTRIES,
	transcriptFromClaudeEvent,
	transcriptFromRpcEvent,
	type TranscriptEntry,
} from "../extensions/orchestrator-lib/orchestrator-transcript.ts";

const theme = { fg: (_color: string, text: string) => text };

test("key matchers cover legacy, SS3, and kitty encodings", () => {
	assert.ok(isUpKey("\u001b[A"));
	assert.ok(isUpKey("\u001bOA"));
	assert.ok(isDownKey("\u001b[B"));
	assert.ok(isDownKey("\u001b[1;5B"));
	assert.ok(isEnterKey("\r"));
	assert.ok(isEnterKey("\u001b[13u"));
	assert.ok(isEscapeKey("\u001b"));
	assert.ok(isEscapeKey("\u001b[27u"));
	assert.ok(!isUpKey("a"));
	assert.ok(!isEscapeKey("\u001b[A"));
});

test("moveSelection enters from the editor, walks rows, and exits past the top", () => {
	const ids = ["a", "b", "c"];
	assert.equal(moveSelection(ids, undefined, "down"), "a");
	assert.equal(moveSelection(ids, "a", "down"), "b");
	assert.equal(moveSelection(ids, "c", "down"), "c");
	assert.equal(moveSelection(ids, "b", "up"), "a");
	assert.equal(moveSelection(ids, "a", "up"), undefined);
	assert.equal(moveSelection([], undefined, "down"), undefined);
	assert.equal(moveSelection(ids, "gone", "up"), "c");
});

test("renderSessionScreen shows title, body tail, scrolls, and stays full-size", () => {
	const body = Array.from({ length: 30 }, (_value, index) => `line ${index}`);
	const followed = renderSessionScreen("Terra · working · terra-1", body, 60, 12, 0, theme);
	assert.match(followed.lines[0]!, /Terra · working · terra-1/);
	assert.equal(followed.lines.length, 12);
	for (const line of followed.lines) assert.equal(Array.from(line).length, 60);
	assert.ok(followed.lines.some((line) => line.includes("line 29")));
	assert.ok(followed.maxScrollUp > 0);
	const scrolled = renderSessionScreen("Terra · working · terra-1", body, 60, 12, followed.maxScrollUp, theme);
	assert.ok(scrolled.lines.some((line) => line.includes("line 0")));
	assert.ok(!scrolled.lines.some((line) => line.includes("line 29")));
});

test("a scrolled view keeps its place when the worker appends new output", () => {
	const body = Array.from({ length: 30 }, (_value, index) => `line ${index}`);
	const view = renderSessionScreen("Terra · working · terra-1", body, 60, 12, 0, theme);
	// Read 12 lines up from the bottom, then the worker emits 5 more lines.
	const held = anchorScrollUp(12, view.bodyLength, body.length + 5);
	assert.equal(held, 17, "the offset grows with the appended lines so the same content stays on screen");
	const grown = [...body, ...Array.from({ length: 5 }, (_v, i) => `new ${i}`)];
	const before = renderSessionScreen("t", body, 60, 12, 12, theme).lines;
	const after = renderSessionScreen("t", grown, 60, 12, held, theme).lines;
	assert.deepEqual(after.slice(2, -1), before.slice(2, -1), "the visible body is unchanged by output arriving below it");

	// A following viewport keeps following, and a resize is not new output.
	assert.equal(anchorScrollUp(0, 30, 35), 0);
	assert.equal(anchorScrollUp(12, 30, 24), 12, "entries trimmed off the front need no adjustment");
});

test("the hint line says whether the view is following or paused", () => {
	const body = Array.from({ length: 30 }, (_value, index) => `line ${index}`);
	assert.match(renderSessionScreen("t", body, 60, 12, 0, theme).lines.at(-1)!, /following live/);
	const paused = renderSessionScreen("t", body, 60, 12, 12, theme).lines.at(-1)!;
	assert.match(paused, /12 lines back, paused/);
	assert.match(paused, /end to follow/);
});

test("renderSessionScreen handles an empty body", () => {
	const view = renderSessionScreen("Terra · starting · terra-1", [], 60, 12, 0, theme);
	assert.ok(view.lines.some((line) => line.includes("No output yet.")));
});

test("wrapPlainText wraps at word boundaries and splits overlong words", () => {
	assert.deepEqual(wrapPlainText("the quick brown fox jumps", 10), ["the quick", "brown fox", "jumps"]);
	assert.deepEqual(wrapPlainText("short", 10), ["short"]);
	assert.deepEqual(wrapPlainText("abcdefghijkl", 5), ["abcde", "fghij", "kl"]);
	assert.deepEqual(wrapPlainText("", 10), [""]);
});

test("appendTranscript ignores blanks and stays bounded", () => {
	const transcript: TranscriptEntry[] = [];
	appendTranscript(transcript, "user", "   ");
	assert.equal(transcript.length, 0);
	for (let index = 0; index < TRANSCRIPT_MAX_ENTRIES + 25; index += 1) {
		appendTranscript(transcript, "assistant", `entry ${index}`);
	}
	assert.equal(transcript.length, TRANSCRIPT_MAX_ENTRIES);
	assert.equal(transcript[transcript.length - 1]!.text, `entry ${TRANSCRIPT_MAX_ENTRIES + 24}`);
});

test("rpc message_end yields assistant text and tool calls, never user echoes", () => {
	const entries = transcriptFromRpcEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "Working on it." },
				{ type: "toolCall", name: "bash", arguments: { command: "npm test\nsecond line" } },
			],
		},
	});
	assert.deepEqual(entries.map((entry) => [entry.role, entry.text]), [
		["assistant", "Working on it."],
		["tool", "bash: npm test"],
	]);
	assert.equal(transcriptFromRpcEvent({ type: "message_end", message: { role: "user", content: "echo" } }).length, 0);
	assert.equal(transcriptFromRpcEvent({ type: "turn_end", message: { role: "assistant", content: "x" } }).length, 0);
});

test("claude stream events yield assistant text, tool use, and tool results", () => {
	const assistant = transcriptFromClaudeEvent({
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "Reading files." },
				{ type: "tool_use", name: "Read", input: { file_path: "/tmp/a.ts" } },
			],
		},
	});
	assert.deepEqual(assistant.map((entry) => [entry.role, entry.text]), [
		["assistant", "Reading files."],
		["tool", "Read: /tmp/a.ts"],
	]);
	const toolResult = transcriptFromClaudeEvent({
		type: "user",
		message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "ok" }] }] },
	});
	assert.deepEqual(toolResult.map((entry) => [entry.role, entry.text]), [["tool", "ok"]]);
	const errorResult = transcriptFromClaudeEvent({ type: "result", result: "boom", is_error: true });
	assert.deepEqual(errorResult.map((entry) => [entry.role, entry.text]), [["system", "boom"]]);
	assert.equal(transcriptFromClaudeEvent({ type: "result", result: "fine", is_error: false }).length, 0);
});

test("tool results attach to their pending call instead of appending a row", () => {
	const transcript: TranscriptEntry[] = [];
	const [call] = transcriptFromClaudeEvent({
		type: "assistant",
		message: { role: "assistant", content: [{ type: "tool_use", id: "tc1", name: "bash", input: { command: "ls" } }] },
	});
	mergeTranscriptEntry(transcript, call!);
	const [result] = transcriptFromClaudeEvent({
		type: "user",
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tc1", content: [{ type: "text", text: "a.txt" }] }] },
	});
	mergeTranscriptEntry(transcript, result!);
	assert.equal(transcript.length, 1);
	assert.equal(transcript[0]!.tool!.name, "bash");
	assert.deepEqual(transcript[0]!.tool!.result, { content: [{ type: "text", text: "a.txt" }], isError: false });
});

test("pi rpc toolResult messages extract as attachable results", () => {
	const [entry] = transcriptFromRpcEvent({
		type: "message_end",
		message: { role: "toolResult", toolCallId: "tc9", content: [{ type: "text", text: "done" }], isError: false },
	});
	assert.equal(entry!.tool!.callId, "tc9");
	assert.equal(entry!.tool!.name, "");
	assert.equal(entry!.tool!.result!.isError, false);
});

test("assistant thinking blocks are captured and flagged", () => {
	const entries = transcriptFromRpcEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Plan the edit first." },
				{ type: "text", text: "Editing now." },
			],
		},
	});
	assert.deepEqual(entries.map((entry) => [entry.role, entry.text, entry.thinking ?? false]), [
		["assistant", "Plan the edit first.", true],
		["assistant", "Editing now.", false],
	]);
});
