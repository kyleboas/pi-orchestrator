import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ClaudeAccountsConfig } from "./orchestrator-accounts.ts";
import { defaultClaudeAccountStatePath } from "./orchestrator-accounts.ts";
import { DEFAULT_CHECKIN_MINUTES } from "./orchestrator-checkin.ts";
import type { PiThinkingLevel, WorkerProfile } from "./orchestrator-core.ts";
import { DEFAULT_SANDBOX_CONFIG, INVALID_SANDBOX_CONFIG, parseSandboxConfig, type SandboxConfig } from "./orchestrator-sandbox.ts";

export type CoordinatorConfig = { provider?: string; id?: string; thinking: PiThinkingLevel };
export type OrchestratorConfig = {
	coordinator: CoordinatorConfig;
	commands: { pi: string; claude: string };
	workers: Record<string, WorkerProfile>;
	/** Worker process containment policy; defaults to off for backward compatibility. */
	sandbox: SandboxConfig;
	/** When set, Claude workers rotate across these accounts and fail over on usage limits. */
	claudeAccounts?: ClaudeAccountsConfig;
	/** Initial/base passive assessment interval in minutes; 0 disables. Healthy workers back off to 2x. */
	checkInMinutes: number;
	/** Context-use percentage for outcome-boundary rollover; 0 disables. */
	rolloverContextPercent: number;
	warning?: string;
};

type Json = Record<string, unknown>;
const NAME = /^[A-Za-z][A-Za-z0-9 -]{0,48}$/;
const THINKING = new Set<PiThinkingLevel>(["low", "medium", "high"]);

export const DEFAULT_WORKERS: Record<string, WorkerProfile> = {
	Luna: { backend: "pi-rpc", model: "openai-codex/gpt-5.6-luna", thinking: "low", description: "Fast and cheap; the default for routine bounded work: narrow searches, small mechanical edits, config changes, verification runs." },
	"Sol-Low": { backend: "pi-rpc", model: "openai-codex/gpt-5.6-sol", thinking: "low", description: "Mid tier for ordinary single-file implementation when Luna would be out of its depth." },
	"Sol-Medium": { backend: "pi-rpc", model: "openai-codex/gpt-5.6-sol", thinking: "medium", description: "Mid tier with more thinking for multi-step changes with edge cases." },
	Terra: { backend: "pi-rpc", model: "openai-codex/gpt-5.6-terra", thinking: "high", description: "Heavy tier; reserve for genuinely hard multi-file work, tricky debugging, or design-sensitive changes." },
	Opus: { backend: "claude-code", model: "opus" },
	Sonnet: { backend: "claude-code", model: "sonnet" },
	Haiku: { backend: "claude-code", model: "haiku" },
	Fable: { backend: "claude-code", model: "fable" },
};

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
function object(value: unknown): value is Json {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}
function command(value: unknown, fallback: string): string {
	return nonempty(value) && !/[\r\n\0]/.test(value) ? value.trim() : fallback;
}
function piModel(value: unknown): value is string {
	return nonempty(value) && /^[^/\s]+\/[^/\s]+$/.test(value.trim());
}
function description(value: unknown): { description?: string } {
	if (!nonempty(value)) return {};
	const cleaned = value.replace(/\s+/g, " ").trim().slice(0, 300);
	return cleaned ? { description: cleaned } : {};
}
function profile(value: unknown): WorkerProfile | undefined {
	if (!object(value)) return undefined;
	if (value.backend === "pi-rpc") {
		if (!THINKING.has(value.thinking as PiThinkingLevel) || !piModel(value.model)) return undefined;
		return { backend: "pi-rpc", model: value.model.trim(), thinking: value.thinking as PiThinkingLevel, ...description(value.description) };
	}
	if (value.backend === "claude-code" && nonempty(value.model)) return { backend: "claude-code", model: value.model.trim(), ...description(value.description) };
	return undefined;
}
function workers(value: unknown): Record<string, WorkerProfile> | undefined {
	const entries: [string, unknown][] = Array.isArray(value)
		? value.map((item): [string, unknown] | undefined => object(item) && nonempty(item.name) ? [item.name.trim(), item] : undefined).filter((item): item is [string, unknown] => !!item)
		: object(value) ? Object.entries(value) : [];
	if (!entries.length || (Array.isArray(value) && entries.length !== value.length)) return undefined;
	const seen = new Set<string>();
	const output: Record<string, WorkerProfile> = {};
	for (const [name, raw] of entries) {
		const key = name.toLowerCase();
		const parsed = profile(raw);
		if (!NAME.test(name) || seen.has(key) || !parsed) return undefined;
		seen.add(key);
		output[name] = parsed;
	}
	return output;
}
function claudeAccounts(value: unknown): ClaudeAccountsConfig | undefined {
	if (!object(value) || !object(value.accounts)) return undefined;
	const accounts: Record<string, string> = {};
	for (const [name, dir] of Object.entries(value.accounts)) {
		if (!NAME.test(name) || !nonempty(dir)) return undefined;
		accounts[name] = expandHome(dir.trim());
	}
	if (!Object.keys(accounts).length) return undefined;
	return {
		accounts,
		statePath: nonempty(value.state) ? expandHome(value.state.trim()) : defaultClaudeAccountStatePath(),
	};
}
function checkInMinutes(value: unknown): number {
	if (value === undefined) return DEFAULT_CHECKIN_MINUTES;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_CHECKIN_MINUTES;
}
export const DEFAULT_ROLLOVER_CONTEXT_PERCENT = 38;
function rolloverContextPercent(value: unknown): number {
	if (value === undefined) return DEFAULT_ROLLOVER_CONTEXT_PERCENT;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : DEFAULT_ROLLOVER_CONTEXT_PERCENT;
}
const SANDBOX_INVALID_WARNING = "Sandbox configuration was invalid; worker delegation is disabled until it is corrected.";
/**
 * Sandbox parsing is fail-closed and independent of the generic
 * invalid-config-uses-defaults recovery: a present-but-malformed sandbox block
 * must never quietly become "off", even when the rest of the file is rejected.
 */
function sandboxFrom(raw: unknown): { sandbox: SandboxConfig; warning?: string } {
	if (!object(raw) || raw.sandbox === undefined) return { sandbox: { ...DEFAULT_SANDBOX_CONFIG } };
	const parsed = parseSandboxConfig(raw.sandbox);
	return parsed ? { sandbox: parsed } : { sandbox: { ...INVALID_SANDBOX_CONFIG }, warning: SANDBOX_INVALID_WARNING };
}
function joinWarnings(...warnings: (string | undefined)[]): string | undefined {
	const present = warnings.filter(nonempty);
	return present.length ? present.join(" ") : undefined;
}
function defaults(env: NodeJS.ProcessEnv, warning?: string, sandbox: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG }): OrchestratorConfig {
	return { coordinator: { thinking: "high" }, commands: { pi: command(env.PI_ORCHESTRATOR_PI_BIN, "pi"), claude: command(env.PI_ORCHESTRATOR_CLAUDE_BIN, "claude") }, workers: { ...DEFAULT_WORKERS }, sandbox, checkInMinutes: DEFAULT_CHECKIN_MINUTES, rolloverContextPercent: DEFAULT_ROLLOVER_CONTEXT_PERCENT, ...(warning ? { warning } : {}) };
}

/** Load once at extension initialization. Invalid files deliberately disclose no paths or contents. */
export function loadOrchestratorConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
	const requested = nonempty(env.PI_ORCHESTRATOR_CONFIG) ? expandHome(env.PI_ORCHESTRATOR_CONFIG.trim()) : resolve(homedir(), ".config/pi-orchestrator/config.json");
	const explicit = nonempty(env.PI_ORCHESTRATOR_CONFIG);
	if (!existsSync(requested)) return defaults(env, explicit ? "Orchestrator configuration was unavailable; using defaults." : undefined);
	let text: string;
	try {
		text = readFileSync(requested, "utf8");
	} catch {
		return defaults(env, "Orchestrator configuration was invalid; using defaults.");
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		// Unparseable JSON that mentions a sandbox block still fails closed: the
		// requested containment intent is unreadable, so delegation stays disabled.
		const wantedSandbox = /"sandbox"/.test(text);
		return defaults(
			env,
			joinWarnings("Orchestrator configuration was invalid; using defaults.", wantedSandbox ? SANDBOX_INVALID_WARNING : undefined),
			wantedSandbox ? { ...INVALID_SANDBOX_CONFIG } : undefined,
		);
	}
	const { sandbox, warning: sandboxWarning } = sandboxFrom(raw);
	const invalid = () => defaults(env, joinWarnings("Orchestrator configuration was invalid; using defaults.", sandboxWarning), sandbox);
	if (!object(raw)) return invalid();
	// A config without a workers key keeps its coordinator/commands and the
	// default catalog; only a present-but-invalid catalog rejects the file.
	const configuredWorkers = raw.workers === undefined ? { ...DEFAULT_WORKERS } : workers(raw.workers);
	if (!configuredWorkers) return invalid();
	const coordinatorRaw = raw.coordinator === undefined ? {} : raw.coordinator;
	if (!object(coordinatorRaw) || !THINKING.has((coordinatorRaw.thinking ?? "high") as PiThinkingLevel) ||
		(coordinatorRaw.provider !== undefined && !nonempty(coordinatorRaw.provider)) ||
		(coordinatorRaw.id !== undefined && !nonempty(coordinatorRaw.id))) return invalid();
	const commandsRaw = raw.commands === undefined ? {} : raw.commands;
	if (!object(commandsRaw)) return invalid();
	return {
		coordinator: {
			...(nonempty(coordinatorRaw.provider) ? { provider: coordinatorRaw.provider.trim() } : {}),
			...(nonempty(coordinatorRaw.id) ? { id: coordinatorRaw.id.trim() } : {}),
			thinking: (coordinatorRaw.thinking ?? "high") as PiThinkingLevel,
		},
		commands: {
			pi: command(env.PI_ORCHESTRATOR_PI_BIN, command(commandsRaw.pi, "pi")),
			claude: command(env.PI_ORCHESTRATOR_CLAUDE_BIN, command(commandsRaw.claude, "claude")),
		}, workers: configuredWorkers,
		sandbox,
		checkInMinutes: checkInMinutes(raw.checkInMinutes),
		rolloverContextPercent: rolloverContextPercent(raw.rolloverContextPercent),
		...(sandboxWarning ? { warning: sandboxWarning } : {}),
		...(raw.claudeAccounts !== undefined && claudeAccounts(raw.claudeAccounts) ? { claudeAccounts: claudeAccounts(raw.claudeAccounts) } : {}),
	};
}
