export type TranscriptRole = "user" | "assistant" | "tool" | "system";

export type TranscriptEntry = {
	at: number;
	role: TranscriptRole;
	text: string;
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
	transcript.push({ at, role, text: trimmed });
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
			// Tool results echo back as user text parts in stream-json; keep them as tool output.
			if (text?.trim()) entries.push({ at: Date.now(), role: role === "assistant" ? "assistant" : "user", text: text.trim() });
		} else if (type === "toolCall" || type === "tool_use") {
			entries.push({ at: Date.now(), role: "tool", text: toolLabel(part.name, part.arguments ?? part.input) });
		} else if (type === "tool_result" || type === "toolResult") {
			const text = partsOf(part.content).map(textOf).filter(Boolean).join("\n").trim()
				|| (typeof part.content === "string" ? part.content.trim() : "");
			if (text) entries.push({ at: Date.now(), role: "tool", text: text.length > 600 ? `${text.slice(0, 600)}…` : text });
		}
	}
	return entries;
}

/**
 * Entries from one Pi RPC event line. Only message_end carries a full message,
 * and user entries are recorded at delegate/steer time, so assistant messages
 * (text + tool calls) are the only ones taken from the stream.
 */
export function transcriptFromRpcEvent(event: Record<string, unknown>): TranscriptEntry[] {
	if (event.type !== "message_end") return [];
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
