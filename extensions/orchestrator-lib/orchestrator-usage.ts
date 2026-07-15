export type ReportedUsage = { tokens?: number; costUsd?: number };

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Extract only provider-reported Pi RPC turn usage; never infer a price. */
export function piMessageUsage(message: unknown): ReportedUsage {
	if (!message || typeof message !== "object") return {};
	const usage = (message as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object") return {};
	const record = usage as { totalTokens?: unknown; cost?: unknown };
	const cost = record.cost && typeof record.cost === "object" ? (record.cost as { total?: unknown }).total : undefined;
	const tokens = finite(record.totalTokens); const costUsd = finite(cost);
	return { ...(tokens === undefined ? {} : { tokens }), ...(costUsd === undefined ? {} : { costUsd }) };
}

/** Pi repeats the completed assistant message at message_end and turn_end. */
export function shouldAccumulatePiUsage(eventType: string): boolean { return eventType === "turn_end"; }

/** Provider values are per completed turn/result, so retain a lifetime sum. */
export function accumulateReportedUsage(total: ReportedUsage, next: ReportedUsage): ReportedUsage {
	return {
		...(total.tokens === undefined && next.tokens === undefined ? {} : { tokens: (total.tokens ?? 0) + (next.tokens ?? 0) }),
		...(total.costUsd === undefined && next.costUsd === undefined ? {} : { costUsd: (total.costUsd ?? 0) + (next.costUsd ?? 0) }),
	};
}
