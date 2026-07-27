export const ORCHESTRATOR_TOOL_NAMES = ["orchestrator_delegate", "orchestrator_steer", "orchestrator_workers", "orchestrator_stop", "orchestrator_takeover"] as const;
import { fileURLToPath } from "node:url";

export const RPC_WORKER_TOOL_NAMES = ["read", "bash", "edit", "write", "background_job"] as const;
/** Loaded explicitly after --no-extensions so only Pi RPC workers get this tool. */
export const BACKGROUND_JOB_WORKER_EXTENSION_PATH = fileURLToPath(new URL("../worker-background-job.ts", import.meta.url));
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];
/** Claude Code accepts only these effort values. */
export const CLAUDE_EFFORTS = ["low", "medium", "high"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];
export type PiRpcWorkerProfile = { backend: "pi-rpc"; model: string; thinking: PiThinkingLevel; description?: string };
export type ClaudeCodeWorkerProfile = { backend: "claude-code"; model: string; thinking?: ClaudeEffort; description?: string };
export type WorkerProfile = PiRpcWorkerProfile | ClaudeCodeWorkerProfile;
export type WorkerCatalog = Record<string, WorkerProfile>;

export function isPiRpcWorkerProfile(profile: WorkerProfile): profile is PiRpcWorkerProfile { return profile.backend === "pi-rpc"; }
export function workerNames(catalog: WorkerCatalog): string[] { return Object.keys(catalog); }
export function workerDescription(name: string, profile: WorkerProfile): string {
	const base = profile.backend === "pi-rpc"
		? `${name}: Pi RPC implementation worker (${profile.model}, ${profile.thinking} thinking).`
		: `${name}: persistent Claude Code implementation worker (${profile.model}${profile.thinking ? `, ${profile.thinking} effort` : ""}).`;
	return profile.description ? `${base} ${profile.description}` : base;
}
export function catalogText(catalog: WorkerCatalog): string { const names = workerNames(catalog); return names.length < 2 ? names[0] ?? "workers" : `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`; }
export function workerRpcArgs(model: string, thinking: PiThinkingLevel, backgroundJobExtensionPath = BACKGROUND_JOB_WORKER_EXTENSION_PATH): string[] {
	return ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", backgroundJobExtensionPath, "--tools", RPC_WORKER_TOOL_NAMES.join(","), "--model", model, "--thinking", thinking];
}
/** Build Pi launch arguments solely from the worker's explicit profile. */
export function piRpcWorkerArgs(profile: PiRpcWorkerProfile): string[] {
	return workerRpcArgs(profile.model, profile.thinking);
}

export type WorkerPromptOptions = {
	worker: string;
	task: string;
	cwd: string;
	backend?: WorkerProfile["backend"];
};

/** Build the complete implementation brief shared by every worker backend. */
export function buildWorkerPrompt({ worker, task, cwd, backend }: WorkerPromptOptions): string {
	const guidance = `You are ${worker}, an implementation worker. Work directly in ${cwd}.

The coordinator brief is your starting map. Open the named files and relevant symbols to confirm what you will edit; source files remain the truth. Do not repeat broad repository discovery or reread unrelated documentation unless the brief is missing a necessary fact, looks stale, or validation exposes a new problem. Inspect adjacent callers, tests, configuration, documentation, and user-facing behavior only as needed for the named change, and prefer root-cause fixes over symptom patches.

Interpret generic or underspecified requests from the brief, repository context, and desired outcome. Before asking questions, infer from the code, conventions, syntax, and prior instructions. Proceed with reversible work that is clearly implied. On recoverable failures, gather facts and retry. Avoid speculative expansion; ask only when interpretations materially conflict, an action is destructive, or user-only input is required. Before finishing, audit every promise and all obviously required in-scope work, and stop only when the outcome is complete or blocked on user-only input.

Implement the task and run validation proportional to its risk and changed surface: use focused tests or checks for narrow changes, wider suites only when the changed surface justifies them, and do not run an unrelated full suite for documentation-only work. You own actual implementation: do not delegate and do not merely propose a patch. Delegated workers must never merge pull requests; pull request merging remains coordinator-only after explicit user authorization. Keep your final response concise and include changed files, validation run, and any blocker. Write it as plain sentences leading with the content — never open with a label prefix such as "Checkpoint:" or "Status:". Sol receives your final response directly and may send follow-up instructions while you work.`;
	const backgroundJobGuidance = backend === "pi-rpc"
		? `For heavy local commands expected to take more than two minutes, use background_job instead of bash. Do not pass the bash timeout field and do not invoke GNU timeout. After starting a background job, immediately continue any other independent useful work when possible and never poll it. End the turn to await its completion only when no useful independent work remains. When the background_job completion follow-up arrives, inspect its log path and continue the work before finishing.`
		: undefined;
	return [guidance, backgroundJobGuidance, task.trim()].filter((part): part is string => Boolean(part)).join("\n\n");
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
