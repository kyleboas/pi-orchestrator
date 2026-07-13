export const ORCHESTRATOR_TOOL_NAMES = ["orchestrator_delegate", "orchestrator_steer", "orchestrator_workers", "orchestrator_stop", "orchestrator_takeover"] as const;
export const RPC_WORKER_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;
export type PiThinkingLevel = "low" | "medium" | "high";
export type PiRpcWorkerProfile = { backend: "pi-rpc"; model?: string; thinking: PiThinkingLevel };
export type ClaudeCodeWorkerProfile = { backend: "claude-code"; model: string };
export type WorkerProfile = PiRpcWorkerProfile | ClaudeCodeWorkerProfile;
export type WorkerCatalog = Record<string, WorkerProfile>;

export function isPiRpcWorkerProfile(profile: WorkerProfile): profile is PiRpcWorkerProfile { return profile.backend === "pi-rpc"; }
/** An unpinned Pi worker inherits the model captured when orchestration activated. */
export function resolveWorkerModel(profile: WorkerProfile, inheritedModel?: string): string | undefined { return profile.backend === "pi-rpc" ? profile.model ?? inheritedModel : profile.model; }
export function workerNames(catalog: WorkerCatalog): string[] { return Object.keys(catalog); }
export function workerDescription(name: string, profile: WorkerProfile): string { return profile.backend === "pi-rpc" ? `${name}: Pi RPC implementation worker (${profile.thinking} thinking${profile.model ? `, ${profile.model}` : ", current coordinator model"}).` : `${name}: persistent Claude Code implementation worker (${profile.model}).`; }
export function catalogText(catalog: WorkerCatalog): string { const names = workerNames(catalog); return names.length < 2 ? names[0] ?? "workers" : `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`; }
export function workerRpcArgs(model: string, thinking: PiThinkingLevel): string[] {
	return ["--mode", "rpc", "--no-session", "--no-extensions", "--tools", RPC_WORKER_TOOL_NAMES.join(","), "--model", model, "--thinking", thinking];
}
export const SOL_PLANNING_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export function solRestrictedTools(allTools: readonly string[]): string[] { const available = new Set(allTools); return [...ORCHESTRATOR_TOOL_NAMES, ...SOL_PLANNING_TOOL_NAMES.filter((name) => available.has(name))]; }
const STANDARD_IMPLEMENTATION_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const SOLO_TAKEOVER_RE = /\b(?:do it yourself|without delegating|sol\s+fix\s+it)\b/i;
export function isSoloTakeoverPrompt(prompt: string): boolean { return SOLO_TAKEOVER_RE.test(prompt); }
export function implementationToolNames(activeTools: readonly string[], allTools: readonly string[]): string[] {
	const available = new Set(allTools); const restricted = new Set<string>(ORCHESTRATOR_TOOL_NAMES);
	const tools = activeTools.filter((name) => available.has(name) && !restricted.has(name));
	for (const name of STANDARD_IMPLEMENTATION_TOOL_NAMES) if (available.has(name) && !tools.includes(name)) tools.push(name);
	return tools;
}
export class SolToolMode {
	#normalTools: string[] | undefined; #allTools: string[] = []; #takeoverActive = false;
	get takeoverActive(): boolean { return this.#takeoverActive; }
	activate(activeTools: readonly string[], allTools: readonly string[]): string[] { this.#normalTools ??= [...activeTools]; this.#allTools = [...allTools]; this.#takeoverActive = false; return solRestrictedTools(this.#allTools); }
	beginTakeover(prompt: string, currentTools: readonly string[], allTools: readonly string[]): string[] | undefined { return isSoloTakeoverPrompt(prompt) ? this.beginTakeoverTool(currentTools, allTools) : undefined; }
	beginTakeoverTool(currentTools: readonly string[], allTools: readonly string[]): string[] { this.#takeoverActive = true; return implementationToolNames(this.#normalTools ?? currentTools, allTools); }
	settle(): string[] | undefined { if (!this.#takeoverActive) return undefined; this.#takeoverActive = false; return solRestrictedTools(this.#allTools); }
}
