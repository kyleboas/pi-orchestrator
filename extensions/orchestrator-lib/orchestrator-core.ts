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
/** A worker strong enough to plan its own approach from a goal-level brief; every other worker requires a complete plan from the coordinator. */
export type SelfPlanning = { selfPlanning?: boolean };
export type PiRpcWorkerProfile = { backend: "pi-rpc"; model: string; thinking: PiThinkingLevel; description?: string } & SelfPlanning;
export type ClaudeCodeWorkerProfile = { backend: "claude-code"; model: string; thinking?: ClaudeEffort; description?: string } & SelfPlanning;
export type WorkerProfile = PiRpcWorkerProfile | ClaudeCodeWorkerProfile;
export type WorkerCatalog = Record<string, WorkerProfile>;

/** Worker result text is bounded before it is retained or delivered. */
export const MAX_WORKER_RESULT_BYTES = 64_000;
export type BoundedWorkerText = { text: string; truncated: boolean; error?: "result-too-large" };
export function appendBoundedWorkerText(current: BoundedWorkerText, value: string, limit = MAX_WORKER_RESULT_BYTES): BoundedWorkerText {
	if (current.truncated) return current;
	const bytes = Buffer.from(value, "utf8");
	const remaining = Math.max(0, limit - Buffer.byteLength(current.text, "utf8"));
	if (bytes.byteLength <= remaining) return { ...current, text: current.text + value };
	let clippedBytes = bytes.subarray(0, remaining);
	let clipped = clippedBytes.toString("utf8");
	while (clipped.endsWith("\uFFFD") && clippedBytes.byteLength > 0) {
		clippedBytes = clippedBytes.subarray(0, clippedBytes.byteLength - 1);
		clipped = clippedBytes.toString("utf8");
	}
	return { text: current.text + clipped, truncated: true, error: "result-too-large" };
}

/** Compatibility catalog used by installed-Pi checks and extensions that import the canonical worker set. */
export const OPUS_5_MEDIUM_WORKER = "Opus 5 Medium";
export const OPUS_5_MEDIUM_MODEL = "anthropic/claude-opus-5-medium";
export const WORKER_PROFILES = {
	Terra: { backend: "pi-rpc", model: "openai-codex/gpt-5.6-terra", thinking: "high", selfPlanning: true },
	[OPUS_5_MEDIUM_WORKER]: { backend: "pi-rpc", model: OPUS_5_MEDIUM_MODEL, thinking: "medium", selfPlanning: true },
	"Sol-Medium": { backend: "pi-rpc", model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
	"Sol-Low": { backend: "pi-rpc", model: "openai-codex/gpt-5.6-sol", thinking: "low" },
	Opus: { backend: "claude-code", model: "opus" },
	Sonnet: { backend: "claude-code", model: "sonnet" },
	Haiku: { backend: "claude-code", model: "haiku" },
	Fable: { backend: "claude-code", model: "fable" },
} as const satisfies WorkerCatalog;
export type WorkerName = keyof typeof WORKER_PROFILES;

export function isPiRpcWorkerProfile(profile: WorkerProfile): profile is PiRpcWorkerProfile { return profile.backend === "pi-rpc"; }
export function workerNames(catalog: WorkerCatalog): string[] { return Object.keys(catalog); }
export function selfPlanningWorkerNames(catalog: WorkerCatalog): string[] { return workerNames(catalog).filter((name) => catalog[name]?.selfPlanning === true); }
/** Resolve the advisor tier by capability rather than an exact literal, since a catalog routinely versions the same tier as "GPT-5.6 Sol High". */
const ADVISOR_TIER = "Sol-High";
function normalizeName(name: string): string { return name.toLowerCase().replace(/[^a-z0-9]/g, ""); }
export function advisorWorkerName(catalog: WorkerCatalog): string | undefined {
	const names = workerNames(catalog);
	const target = normalizeName(ADVISOR_TIER);
	return names.find((name) => name === ADVISOR_TIER) ?? names.find((name) => normalizeName(name).endsWith(target));
}
export function workerDescription(name: string, profile: WorkerProfile): string {
	const base = profile.backend === "pi-rpc"
		? `${name}: Pi RPC implementation worker (${profile.model}, ${profile.thinking} thinking).`
		: `${name}: persistent Claude Code implementation worker (${profile.model}${profile.thinking ? `, ${profile.thinking} effort` : ""}).`;
	return profile.description ? `${base} ${profile.description}` : base;
}
export function nameList(names: readonly string[]): string { return names.length < 2 ? names[0] ?? "workers" : `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`; }
export function catalogText(catalog: WorkerCatalog): string { return nameList(workerNames(catalog)); }
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
	/** The brief states a goal and leaves the approach to this worker; otherwise it carries a plan to execute. */
	selfPlan?: boolean;
	/** The plan itself is the deliverable: investigate and report an approach, changing nothing. */
	planOnly?: boolean;
};

/** Build the complete implementation brief shared by every worker backend. */
export function buildWorkerPrompt({ worker, task, cwd, backend, selfPlan, planOnly }: WorkerPromptOptions): string {
	const role = planOnly ? "a planning worker" : "an implementation worker";
	const briefGuidance = planOnly
		? "The coordinator brief states the goal and the facts it already established. Investigate what you need and work the approach out against the source, which remains the truth."
		: selfPlan
			? "The coordinator brief states the goal and the facts it already established, and deliberately leaves the approach to you. Plan the change yourself and confirm it against the source before editing; source files remain the truth."
			: "The coordinator brief carries the plan to execute. Open the named files and symbols to confirm what you will edit; source files remain the truth. Do not re-plan the approach or repeat broad repository discovery unless the brief is missing a necessary fact, looks stale, or validation exposes a new problem.";
	// Producing a plan is never authorization to carry it out: the deliverable
	// was the plan, and implementing it anyway spends the review step the user
	// asked for by requesting a plan in the first place.
	const ownership = planOnly
		? "The plan is the entire deliverable. Do not implement it: make no edits, commits, or other changes, however obvious the change looks once you have worked it out. Read-only investigation is expected; anything that writes is not. Ask only when interpretations materially conflict or user-only input is required."
		: "You own actual implementation: do not delegate and do not merely propose a patch. Delegated workers must never merge pull requests; pull request merging remains coordinator-only after explicit user authorization. Ask only when interpretations materially conflict, an action is destructive, or user-only input is required.";
	const finalResponse = planOnly
		? "include the concrete change you propose, the files it touches, edge cases, how it should be validated, and any blocker"
		: "include changed files, validation run, any blocker, and any point where you departed from the brief's plan and why";
	const guidance = `You are ${worker}, ${role}. Work directly in ${cwd}.

${briefGuidance}

${ownership}

Sol receives your final response directly and may send follow-up instructions while you work. Keep it concise and ${finalResponse}. Write it as plain sentences leading with the content — never open with a label prefix such as "Checkpoint:" or "Status:".`;
	const backgroundJobGuidance = backend === "pi-rpc"
		? `For heavy local commands expected to take more than two minutes, use background_job instead of bash. Do not pass the bash timeout field and do not invoke GNU timeout. After starting a background job, immediately continue any other independent useful work when possible and never poll it. End the turn to await its completion only when no useful independent work remains. When the background_job completion follow-up arrives, inspect its log path and continue the work before finishing.`
		: undefined;
	return [guidance, backgroundJobGuidance, task.trim()].filter((part): part is string => Boolean(part)).join("\n\n");
}

/**
 * Flip a live worker between planning and implementing. The launch prompt gave
 * it the opposite standing order, so the switch has to revoke that order
 * explicitly rather than merely state the new one. Turning implementation off
 * never asks for a revert: work already on disk is reported, not destroyed.
 */
export function buildModeChangeDirective(planOnly: boolean): string {
	return planOnly
		? "Mode change: stop implementing this task. Make no further edits, commits, or other changes. Do not revert or clean up what you have already changed. The plan is now the deliverable: report exactly what you already changed, then the remaining approach you propose, the files it would touch, edge cases, and how it should be validated."
		: "Mode change: implementation is now authorized for this task. Carry out the approach you reported, adjusting it only where the source proves it wrong. You own actual implementation: do not delegate and do not merely propose a patch. Delegated workers must never merge pull requests; pull request merging remains coordinator-only after explicit user authorization. Your final response should include changed files, validation run, any blocker, and any point where you departed from the approach you reported and why.";
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
	activate(activeTools: readonly string[], allTools: readonly string[] = activeTools): string[] { this.#normalTools ??= [...activeTools]; this.#allTools = [...allTools]; this.#takeoverActive = false; return solRestrictedTools(this.#allTools); }
	beginTakeover(prompt: string, currentTools: readonly string[], allTools: readonly string[]): string[] | undefined { return isSoloTakeoverPrompt(prompt) ? this.beginTakeoverTool(currentTools, allTools) : undefined; }
	beginTakeoverTool(currentTools: readonly string[], allTools: readonly string[]): string[] { this.#takeoverActive = true; return implementationToolNames(this.#normalTools ?? currentTools, allTools); }
	settle(): string[] | undefined { if (!this.#takeoverActive) return undefined; this.#takeoverActive = false; return solRestrictedTools(this.#allTools); }
}
