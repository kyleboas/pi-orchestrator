export type PiUsage = { tokens?: number; costUsd?: number };

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Extract only provider-reported Pi RPC totals; never infer a price. */
export function piMessageUsage(message: unknown): PiUsage {
	if (!message || typeof message !== "object") return {};
	const usage = (message as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object") return {};
	const record = usage as { totalTokens?: unknown; cost?: unknown };
	const cost = record.cost && typeof record.cost === "object" ? (record.cost as { total?: unknown }).total : undefined;
	const tokens = finite(record.totalTokens); const costUsd = finite(cost);
	return { ...(tokens === undefined ? {} : { tokens }), ...(costUsd === undefined ? {} : { costUsd }) };
}
