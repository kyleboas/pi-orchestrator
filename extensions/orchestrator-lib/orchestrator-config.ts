import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ClaudeAccountsConfig } from "./orchestrator-accounts.ts";
import { defaultClaudeAccountStatePath } from "./orchestrator-accounts.ts";
import type { PiThinkingLevel, WorkerProfile } from "./orchestrator-core.ts";

export type CoordinatorConfig = { provider?: string; id?: string; thinking: PiThinkingLevel };
export type OrchestratorConfig = {
	coordinator: CoordinatorConfig;
	commands: { pi: string; claude: string };
	workers: Record<string, WorkerProfile>;
	/** When set, Claude workers rotate across these accounts and fail over on usage limits. */
	claudeAccounts?: ClaudeAccountsConfig;
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
function defaults(env: NodeJS.ProcessEnv, warning?: string): OrchestratorConfig {
	return { coordinator: { thinking: "high" }, commands: { pi: command(env.PI_ORCHESTRATOR_PI_BIN, "pi"), claude: command(env.PI_ORCHESTRATOR_CLAUDE_BIN, "claude") }, workers: { ...DEFAULT_WORKERS }, ...(warning ? { warning } : {}) };
}

/** Load once at extension initialization. Invalid files deliberately disclose no paths or contents. */
export function loadOrchestratorConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
	const requested = nonempty(env.PI_ORCHESTRATOR_CONFIG) ? expandHome(env.PI_ORCHESTRATOR_CONFIG.trim()) : resolve(homedir(), ".config/pi-orchestrator/config.json");
	const explicit = nonempty(env.PI_ORCHESTRATOR_CONFIG);
	if (!existsSync(requested)) return defaults(env, explicit ? "Orchestrator configuration was unavailable; using defaults." : undefined);
	try {
		const raw: unknown = JSON.parse(readFileSync(requested, "utf8"));
		if (!object(raw)) return defaults(env, "Orchestrator configuration was invalid; using defaults.");
		// A config without a workers key keeps its coordinator/commands and the
		// default catalog; only a present-but-invalid catalog rejects the file.
		const configuredWorkers = raw.workers === undefined ? { ...DEFAULT_WORKERS } : workers(raw.workers);
		if (!configuredWorkers) return defaults(env, "Orchestrator configuration was invalid; using defaults.");
		const coordinatorRaw = raw.coordinator === undefined ? {} : raw.coordinator;
		if (!object(coordinatorRaw) || !THINKING.has((coordinatorRaw.thinking ?? "high") as PiThinkingLevel) ||
			(coordinatorRaw.provider !== undefined && !nonempty(coordinatorRaw.provider)) ||
			(coordinatorRaw.id !== undefined && !nonempty(coordinatorRaw.id))) return defaults(env, "Orchestrator configuration was invalid; using defaults.");
		const commandsRaw = raw.commands === undefined ? {} : raw.commands;
		if (!object(commandsRaw)) return defaults(env, "Orchestrator configuration was invalid; using defaults.");
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
			...(raw.claudeAccounts !== undefined && claudeAccounts(raw.claudeAccounts) ? { claudeAccounts: claudeAccounts(raw.claudeAccounts) } : {}),
		};
	} catch {
		return defaults(env, "Orchestrator configuration was invalid; using defaults.");
	}
}
