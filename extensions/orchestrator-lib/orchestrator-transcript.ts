export type TranscriptRole = "user" | "assistant" | "tool" | "system";

export type ToolResultPayload = {
	content: { type: string; text?: string }[];
	isError: boolean;
};

export type TranscriptToolCall = {
	name: string;
	callId?: string;
	args?: unknown;
	result?: ToolResultPayload;
};

export type TranscriptEntry = {
	at: number;
	role: TranscriptRole;
	/** Plain-text fallback when a native component cannot render the entry. */
	text: string;
	tool?: TranscriptToolCall;
};

/** Bounded per-worker history: enough to review a session without unbounded growth. */
export const TRANSCRIPT_MAX_ENTRIES = 400;

export function appendTranscript(
	transcript: TranscriptEntry[],
	role: TranscriptRole,
	text: string,
	at = Date.now(),
): void {
	const trimmed = text.trim();
	if (!trimmed) return;
	mergeTranscriptEntry(transcript, { at, role, text: trimmed });
}

/**
 * Add one extracted entry. A tool-result entry attaches to the pending tool
 * call with the same callId (how pi pairs them) instead of appending a row;
 * everything else appends, bounded to TRANSCRIPT_MAX_ENTRIES.
 */
export function mergeTranscriptEntry(transcript: TranscriptEntry[], entry: TranscriptEntry): void {
	const result = entry.tool?.result;
	if (result && entry.tool?.callId && !entry.tool.name) {
		for (let index = transcript.length - 1; index >= 0; index -= 1) {
			const candidate = transcript[index]!;
			if (candidate.tool && candidate.tool.callId === entry.tool.callId && !candidate.tool.result) {
				candidate.tool.result = result;
				return;
			}
		}
		// No matching call (e.g. trimmed out): keep the output as plain text.
		if (!entry.text.trim()) return;
	}
	if (!entry.text.trim() && !entry.tool) return;
	transcript.push(entry);
	if (transcript.length > TRANSCRIPT_MAX_ENTRIES) transcript.splice(0, transcript.length - TRANSCRIPT_MAX_ENTRIES);
}

type ContentPart = Record<string, unknown>;

function partsOf(content: unknown): ContentPart[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	return content.filter((part): part is ContentPart => !!part && typeof part === "object" && !Array.isArray(part));
}

function textOf(part: ContentPart): string | undefined {
	return typeof part.text === "string" ? part.text : undefined;
}

function toolLabel(name: unknown, input: unknown): string {
	const tool = typeof name === "string" && name ? name : "tool";
	if (input && typeof input === "object" && !Array.isArray(input)) {
		const record = input as Record<string, unknown>;
		const hint = [record.command, record.path, record.file_path, record.pattern, record.description]
			.find((value): value is string => typeof value === "string" && value.trim().length > 0);
		if (hint) {
			const firstLine = hint.trim().split(/\r?\n/, 1)[0] ?? "";
			return `${tool}: ${firstLine}`;
		}
	}
	return tool;
}

function resultPayload(content: unknown, isError: boolean): ToolResultPayload {
	const parts = partsOf(content)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => ({ type: "text", text: part.text as string }));
	if (!parts.length && typeof content === "string") parts.push({ type: "text", text: content });
	return { content: parts, isError };
}

function resultText(payload: ToolResultPayload): string {
	const text = payload.content.map((part) => part.text ?? "").join("\n").trim();
	return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

/** Extract displayable transcript entries from one message-shaped object. */
export function transcriptFromMessage(message: unknown): TranscriptEntry[] {
	if (!message || typeof message !== "object") return [];
	const { role, content } = message as { role?: unknown; content?: unknown };
	if (role !== "assistant" && role !== "user") return [];
	const entries: TranscriptEntry[] = [];
	for (const part of partsOf(content)) {
		const type = part.type;
		if (type === "text") {
			const text = textOf(part);
			if (text?.trim()) entries.push({ at: Date.now(), role: role === "assistant" ? "assistant" : "user", text: text.trim() });
		} else if (type === "toolCall" || type === "tool_use") {
			const args = part.arguments ?? part.input;
			entries.push({
				at: Date.now(),
				role: "tool",
				text: toolLabel(part.name, args),
				tool: {
					name: typeof part.name === "string" ? part.name : "tool",
					callId: typeof part.id === "string" ? part.id : undefined,
					args,
				},
			});
		} else if (type === "tool_result" || type === "toolResult") {
			const payload = resultPayload(part.content, part.is_error === true || part.isError === true);
			entries.push({
				at: Date.now(),
				role: "tool",
				text: resultText(payload),
				tool: {
					name: "",
					callId: typeof part.tool_use_id === "string" ? part.tool_use_id : typeof part.toolCallId === "string" ? part.toolCallId : undefined,
					result: payload,
				},
			});
		}
	}
	return entries;
}

/** Extract a Pi RPC tool-result message ({role:"toolResult", toolCallId, content, isError}). */
function transcriptFromRpcToolResult(message: unknown): TranscriptEntry[] {
	if (!message || typeof message !== "object") return [];
	const record = message as { role?: unknown; toolCallId?: unknown; content?: unknown; isError?: unknown };
	if (record.role !== "toolResult") return [];
	const payload = resultPayload(record.content, record.isError === true);
	return [{
		at: Date.now(),
		role: "tool",
		text: resultText(payload),
		tool: {
			name: "",
			callId: typeof record.toolCallId === "string" ? record.toolCallId : undefined,
			result: payload,
		},
	}];
}

/**
 * Entries from one Pi RPC event line. Only message_end carries a full
 * message; user entries are recorded at delegate/steer time, so assistant
 * messages (text + tool calls) and tool results are taken from the stream.
 */
export function transcriptFromRpcEvent(event: Record<string, unknown>): TranscriptEntry[] {
	if (event.type !== "message_end") return [];
	const fromToolResult = transcriptFromRpcToolResult(event.message);
	if (fromToolResult.length) return fromToolResult;
	return transcriptFromMessage(event.message).filter((entry) => entry.role !== "user");
}

/** Entries from one Claude Code stream-json event. */
export function transcriptFromClaudeEvent(event: Record<string, unknown>): TranscriptEntry[] {
	if (event.type === "assistant" || event.type === "user") return transcriptFromMessage(event.message);
	if (event.type === "result" && typeof event.result === "string" && event.is_error === true) {
		return event.result.trim() ? [{ at: Date.now(), role: "system", text: event.result.trim() }] : [];
	}
	return [];
}
