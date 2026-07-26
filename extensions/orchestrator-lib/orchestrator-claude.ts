export type ClaudeUsageTotals = { inputTokens?: number; outputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number };
export type ClaudeResultSettlement = { result?: string; isError: boolean; sessionId?: string; usage: ClaudeUsageTotals; /** API-equivalent estimate emitted by Claude Code, not subscription billing. */ estimatedCostUsd?: number };
export type ClaudeStreamParse = { ok: true; events: Record<string, unknown>[] } | { ok: false };
export type ClaudeStreamDrain = { ok: true; events: Record<string, unknown>[]; remainder: string } | { ok: false; remainder: string };
/** Arguments for one persistent Claude Code stream-json worker process. */
export function claudeCodeArgs(model: string, effort?: "low" | "medium" | "high"): string[] { return ["-p", "--model", model, ...(effort ? ["--effort", effort] : []), "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"]; }
export function claudeUserEvent(instructions: string): Record<string, unknown> { return { type: "user", message: { role: "user", content: instructions } }; }

/** Text from a complete Claude assistant event, safe as a final-result fallback. */
export function claudeAssistantText(event: Record<string, unknown>): string | undefined {
	if (event.type !== "assistant" || !event.message || typeof event.message !== "object") return undefined;
	const message = event.message as { role?: unknown; content?: unknown };
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const text = message.content
		.filter((part): part is { type?: unknown; text?: unknown } => !!part && typeof part === "object")
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n")
		.trim();
	return text || undefined;
}
/** Accept the documented object form plus Claude Code's top-level event-array variant. */
export function parseClaudeStreamLine(line: string): ClaudeStreamParse {
	let parsed: unknown; try { parsed = JSON.parse(line); } catch { return { ok: false }; }
	const values = Array.isArray(parsed) ? parsed : [parsed];
	return values.length && !values.some((value) => !value || typeof value !== "object" || Array.isArray(value)) ? { ok: true, events: values as Record<string, unknown>[] } : { ok: false };
}

/**
 * Take complete newline-delimited events from a persistent Claude stream.
 * Claude Code normally writes a newline after each event, but a final complete
 * JSON event may arrive without one while the reusable process stays alive.
 */
export function drainClaudeStreamBuffer(buffer: string): ClaudeStreamDrain {
	const events: Record<string, unknown>[] = [];
	let next = 0;
	let newline: number;
	while ((newline = buffer.indexOf("\n", next)) >= 0) {
		const line = buffer.slice(next, newline).trim();
		next = newline + 1;
		if (!line) continue;
		const parsed = parseClaudeStreamLine(line);
		if (!parsed.ok) return { ok: false, remainder: buffer.slice(next) };
		events.push(...parsed.events);
	}
	const remainder = buffer.slice(next);
	const final = remainder.trim();
	if (!final) return { ok: true, events, remainder };
	const parsed = parseClaudeStreamLine(final);
	// An incomplete JSON chunk is normal. A complete valid JSON event is safe
	// to consume before its optional trailing newline arrives.
	if (!parsed.ok) return { ok: true, events, remainder };
	return { ok: true, events: [...events, ...parsed.events], remainder: "" };
}
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function usageTotals(value: unknown): ClaudeUsageTotals { if (!value || typeof value !== "object" || Array.isArray(value)) return {}; const usage = value as Record<string, unknown>; return { inputTokens: finiteNumber(usage.input_tokens ?? usage.inputTokens), outputTokens: finiteNumber(usage.output_tokens ?? usage.outputTokens), cacheCreationInputTokens: finiteNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens), cacheReadInputTokens: finiteNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens) }; }
export function claudeResultSettlement(event: Record<string, unknown>): ClaudeResultSettlement | undefined { if (event.type !== "result") return undefined; const rawResult = typeof event.result === "string" ? event.result.trim() : ""; const estimatedCostUsd = finiteNumber(event.total_cost_usd); return { result: rawResult || undefined, isError: event.is_error === true, sessionId: typeof event.session_id === "string" ? event.session_id : undefined, usage: usageTotals(event.usage), ...(estimatedCostUsd === undefined || estimatedCostUsd < 0 ? {} : { estimatedCostUsd }) }; }
export function claudeUsageTokenTotal(usage: ClaudeUsageTotals): number | undefined { const values = [usage.inputTokens, usage.outputTokens, usage.cacheCreationInputTokens, usage.cacheReadInputTokens].filter((value): value is number => value !== undefined); return values.length ? values.reduce((total, value) => total + value, 0) : undefined; }
