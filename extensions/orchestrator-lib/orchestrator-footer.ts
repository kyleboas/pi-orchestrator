import { isAbsolute, relative, resolve, sep } from "node:path";

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function visibleWidth(text: string): number {
	return Array.from(stripAnsi(text)).length;
}

function truncateToWidth(text: string, width: number, ellipsis = "..."): string {
	const plain = stripAnsi(text);
	if (visibleWidth(plain) <= width) return plain;
	if (width <= 0) return "";
	const suffix = Array.from(ellipsis).slice(0, width).join("");
	return Array.from(plain).slice(0, Math.max(0, width - visibleWidth(suffix))).join("") + suffix;
}

interface FooterTheme {
	fg(color: string, text: string): string;
}

interface FooterData {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(callback: () => void): () => void;
}

interface FooterContext {
	cwd: string;
	model?: { id?: string; provider?: string; reasoning?: boolean; contextWindow?: number };
	sessionManager: {
		getEntries(): readonly unknown[];
		getCwd(): string;
		getSessionName(): string | undefined;
	};
	modelRegistry: { isUsingOAuth(model: unknown): boolean };
	getContextUsage(): { contextWindow?: number; percent?: number | null } | undefined;
}

export function formatFooterTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function footerCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const inside = relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!inside) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function usageFromEntry(entry: unknown) {
	if (!entry || typeof entry !== "object") return undefined;
	const candidate = entry as { type?: unknown; message?: { role?: unknown; usage?: Record<string, unknown> } };
	if (candidate.type !== "message" || candidate.message?.role !== "assistant") return undefined;
	return candidate.message.usage;
}

function numeric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Reproduce Pi's built-in footer, then the orchestrator appends worker rows below it. */
export function renderBaseFooter(
	ctx: FooterContext,
	footerData: FooterData,
	theme: FooterTheme,
	thinkingLevel: string,
	width: number,
): string[] {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let latestCacheHitRate: number | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		const usage = usageFromEntry(entry);
		if (!usage) continue;
		input += numeric(usage.input);
		output += numeric(usage.output);
		cacheRead += numeric(usage.cacheRead);
		cacheWrite += numeric(usage.cacheWrite);
		const usageCost = usage.cost;
		if (usageCost && typeof usageCost === "object") cost += numeric((usageCost as { total?: unknown }).total);
		const promptTokens = numeric(usage.input) + numeric(usage.cacheRead) + numeric(usage.cacheWrite);
		latestCacheHitRate = promptTokens > 0 ? (numeric(usage.cacheRead) / promptTokens) * 100 : undefined;
	}

	let pwd = footerCwd(ctx.sessionManager.getCwd?.() || ctx.cwd);
	const branch = footerData.getGitBranch();
	if (branch) pwd += ` (${branch})`;
	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) pwd += ` • ${sessionName}`;

	const stats: string[] = [];
	if (input) stats.push(`↑${formatFooterTokens(input)}`);
	if (output) stats.push(`↓${formatFooterTokens(output)}`);
	if (cacheRead) stats.push(`R${formatFooterTokens(cacheRead)}`);
	if (cacheWrite) stats.push(`W${formatFooterTokens(cacheWrite)}`);
	if ((cacheRead || cacheWrite) && latestCacheHitRate !== undefined) stats.push(`CH${latestCacheHitRate.toFixed(1)}%`);
	let subscription = false;
	try {
		if (ctx.model) subscription = ctx.modelRegistry.isUsingOAuth(ctx.model);
	} catch {
		// Footer rendering must never disrupt the session.
	}
	if (cost || subscription) stats.push(`$${cost.toFixed(3)}${subscription ? " (sub)" : ""}`);

	const context = ctx.getContextUsage();
	const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextPercent = context?.percent;
	const contextText = contextPercent == null
		? `?/${formatFooterTokens(contextWindow)} (auto)`
		: `${contextPercent.toFixed(1)}%/${formatFooterTokens(contextWindow)} (auto)`;
	stats.push(contextText);

	let left = stats.join(" ");
	if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");
	const modelName = ctx.model?.id || "no-model";
	let right = ctx.model?.reasoning
		? `${modelName} • ${thinkingLevel === "off" ? "thinking off" : thinkingLevel}`
		: modelName;
	if (footerData.getAvailableProviderCount() > 1 && ctx.model?.provider) {
		const withProvider = `(${ctx.model.provider}) ${right}`;
		if (visibleWidth(left) + 2 + visibleWidth(withProvider) <= width) right = withProvider;
	}
	const availableRight = Math.max(0, width - visibleWidth(left) - 2);
	if (visibleWidth(right) > availableRight) right = truncateToWidth(right, availableRight, "");
	const gap = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));

	const lines = [
		theme.fg("dim", truncateToWidth(pwd, width, "...")),
		theme.fg("dim", left) + theme.fg("dim", gap + right),
	];
	const extensionStatuses = [...footerData.getExtensionStatuses().entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, value]) => value.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
	if (extensionStatuses.length) lines.push(truncateToWidth(extensionStatuses.join(" "), width, "..."));
	return lines;
}
