import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Claude account rotation, compatible with claude-select/claude-auto state:
 * a JSON file mapping account names to config dirs plus per-account
 * cooldown_until timestamps. The orchestrator picks the account itself (so a
 * usage-limited worker can be attributed to one) and launches the Claude
 * command with CLAUDE_CONFIG_DIR preset.
 */
export type ClaudeAccountsConfig = {
	/** Ordered account name → config dir (with ~ already expanded). */
	accounts: Record<string, string>;
	/** claude-select-compatible state file path. */
	statePath: string;
};

export type ClaudeAccountPick = {
	name: string;
	configDir: string;
};

type AccountState = {
	next?: number;
	accounts?: Record<string, { runs?: number; last_used?: number | null; cooldown_until?: number }>;
};

export function defaultClaudeAccountStatePath(): string {
	return resolve(homedir(), ".claude-account-state.json");
}

function loadAccountState(statePath: string): AccountState {
	try {
		if (!existsSync(statePath)) return {};
		const raw: unknown = JSON.parse(readFileSync(statePath, "utf8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as AccountState) : {};
	} catch {
		return {};
	}
}

function saveAccountState(statePath: string, state: AccountState): void {
	try {
		writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	} catch {
		// Account rotation is best-effort; a read-only state file must not block launches.
	}
}

/**
 * Round-robin pick skipping accounts in cooldown — the same policy as
 * claude-auto — bumping the shared state so the two stay in step. Returns
 * undefined when every account is cooling down.
 */
export function pickClaudeAccount(config: ClaudeAccountsConfig, now = Date.now() / 1_000): ClaudeAccountPick | undefined {
	const names = Object.keys(config.accounts);
	if (!names.length) return undefined;
	const state = loadAccountState(config.statePath);
	state.next ??= 0;
	state.accounts ??= {};
	for (const name of names) state.accounts[name] ??= { runs: 0, last_used: null, cooldown_until: 0 };
	for (let offset = 0; offset < names.length; offset += 1) {
		const index = (state.next + offset) % names.length;
		const name = names[index]!;
		if ((state.accounts[name]!.cooldown_until ?? 0) > now) continue;
		state.next = (index + 1) % names.length;
		state.accounts[name]!.runs = (state.accounts[name]!.runs ?? 0) + 1;
		state.accounts[name]!.last_used = now;
		saveAccountState(config.statePath, state);
		return { name, configDir: config.accounts[name]! };
	}
	return undefined;
}

/** Earliest cooldown expiry across accounts, for actionable failure messages. */
export function earliestAccountReset(config: ClaudeAccountsConfig, now = Date.now() / 1_000): number | undefined {
	const state = loadAccountState(config.statePath);
	const expiries = Object.keys(config.accounts)
		.map((name) => state.accounts?.[name]?.cooldown_until ?? 0)
		.filter((until) => until > now);
	return expiries.length ? Math.min(...expiries) : undefined;
}

/** Default cooldown when the limit message carries no parseable reset time. */
export const DEFAULT_LIMIT_COOLDOWN_SECONDS = 90 * 60;

export function markClaudeAccountLimited(
	config: ClaudeAccountsConfig,
	name: string,
	resetAtEpochSeconds?: number,
	now = Date.now() / 1_000,
): void {
	if (!(name in config.accounts)) return;
	const state = loadAccountState(config.statePath);
	state.accounts ??= {};
	state.accounts[name] ??= { runs: 0, last_used: null, cooldown_until: 0 };
	const until = resetAtEpochSeconds && resetAtEpochSeconds > now ? resetAtEpochSeconds : now + DEFAULT_LIMIT_COOLDOWN_SECONDS;
	state.accounts[name]!.cooldown_until = Math.max(state.accounts[name]!.cooldown_until ?? 0, until);
	saveAccountState(config.statePath, state);
}

const USAGE_LIMIT_PATTERNS = [
	/usage limit reached/i,
	/\busage limit\b/i,
	/\b(?:5|five)-hour limit\b/i,
	/hit your limit/i,
	/reached your (?:usage )?limit/i,
	/limit will reset/i,
];

/** True when a Claude worker error text is a usage/plan limit, not a task failure. */
export function isUsageLimitText(text: string | undefined): boolean {
	if (!text) return false;
	return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Claude Code's classic limit format is "Claude AI usage limit reached|<epoch>".
 * Returns epoch seconds when present and plausible.
 */
export function parseUsageLimitReset(text: string | undefined, now = Date.now() / 1_000): number | undefined {
	const match = text?.match(/\|(\d{10,13})\b/);
	if (!match) return undefined;
	let epoch = Number(match[1]);
	if (epoch > 1e12) epoch /= 1_000;
	// Accept resets up to 8 days out; anything else is noise.
	return epoch > now && epoch < now + 8 * 24 * 3_600 ? epoch : undefined;
}
