export type ClaudeUsageTotals = { inputTokens?: number; outputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number };
export type ClaudeResultSettlement = { result?: string; isError: boolean; sessionId?: string; usage: ClaudeUsageTotals };
export type ClaudeStreamParse = { ok: true; events: Record<string, unknown>[] } | { ok: false };
/** Arguments for one persistent Claude Code stream-json worker process. */
export function claudeCodeArgs(model: string): string[] { return ["-p", "--model", model, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"]; }
export function claudeUserEvent(instructions: string): Record<string, unknown> { return { type: "user", message: { role: "user", content: instructions } }; }
/** Accept the documented object form plus Claude Code's top-level event-array variant. */
export function parseClaudeStreamLine(line: string): ClaudeStreamParse {
	let parsed: unknown; try { parsed = JSON.parse(line); } catch { return { ok: false }; }
	const values = Array.isArray(parsed) ? parsed : [parsed];
	return values.length && !values.some((value) => !value || typeof value !== "object" || Array.isArray(value)) ? { ok: true, events: values as Record<string, unknown>[] } : { ok: false };
}
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function usageTotals(value: unknown): ClaudeUsageTotals { if (!value || typeof value !== "object" || Array.isArray(value)) return {}; const usage = value as Record<string, unknown>; return { inputTokens: finiteNumber(usage.input_tokens ?? usage.inputTokens), outputTokens: finiteNumber(usage.output_tokens ?? usage.outputTokens), cacheCreationInputTokens: finiteNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens), cacheReadInputTokens: finiteNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens) }; }
export function claudeResultSettlement(event: Record<string, unknown>): ClaudeResultSettlement | undefined { if (event.type !== "result") return undefined; const rawResult = typeof event.result === "string" ? event.result.trim() : ""; return { result: rawResult || undefined, isError: event.is_error === true, sessionId: typeof event.session_id === "string" ? event.session_id : undefined, usage: usageTotals(event.usage) }; }
export function claudeUsageTokenTotal(usage: ClaudeUsageTotals): number | undefined { const values = [usage.inputTokens, usage.outputTokens, usage.cacheCreationInputTokens, usage.cacheReadInputTokens].filter((value): value is number => value !== undefined); return values.length ? values.reduce((total, value) => total + value, 0) : undefined; }
