export const ORCHESTRATOR_TOOL_NAMES = ["orchestrator_delegate", "orchestrator_steer", "orchestrator_workers", "orchestrator_stop", "orchestrator_takeover"] as const;
import { fileURLToPath } from "node:url";
import { WORKTREE_LIFECYCLE_CONTRACT } from "./orchestrator-delegation-contract.ts";
import type { TaskCategory } from "./orchestrator-stats.ts";

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
export const OPUS_5_MEDIUM_MODEL = "opus";
export const WORKER_PROFILES = {
	Terra: { backend: "pi-rpc", model: "openai-codex/gpt-5.6-terra", thinking: "high", selfPlanning: true },
	[OPUS_5_MEDIUM_WORKER]: { backend: "claude-code", model: OPUS_5_MEDIUM_MODEL, thinking: "medium", selfPlanning: true },
	"GPT-5.5 Off": { backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "off" },
	"GPT-5.5 Minimal": { backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "minimal" },
	"GPT-5.5 Low": { backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "low" },
	"GPT-5.5 Medium": { backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "medium" },
	"GPT-5.5 High": { backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "high" },
	"GPT-5.5 xHigh": { backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "xhigh" },
	"GPT-5.5 Max": { backend: "pi-rpc", model: "openai-codex/gpt-5.5", thinking: "max" },
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
	/** A supplied task category can omit implementation-only defaults for research and documentation work. */
	category?: TaskCategory;
	/** The worker needs a task-specific worktree. Ordinary implementation defaults to true. */
	needsWorktree?: boolean;
	/** The worker needs heavy-command and resource guidance. Ordinary implementation defaults to true. */
	needsHeavyWork?: boolean;
	/** The worker needs browser guidance. */
	needsBrowser?: boolean;
	/** The worker needs the existing local secret policy summary. */
	needsSecrets?: boolean;
	/** The user explicitly asked to create or update a pull request. Never infer this from task text. */
	prCreationRequested?: boolean;
	/** Focused validation commands supplied separately from the task prose. */
	validationCommands?: string[];
	/** Facts already established by the coordinator. */
	knownFacts?: string[];
};

export type WorkerPromptMetrics = {
	taskBytes: number;
	policyBytes: number;
	totalBytes: number;
};

/** Measure the final worker prompt without assuming that JavaScript characters equal UTF-8 bytes. */
export function measureWorkerPrompt(task: string, prompt: string): WorkerPromptMetrics {
	const taskBytes = Buffer.byteLength(task, "utf8");
	const totalBytes = Buffer.byteLength(prompt, "utf8");
	return { taskBytes, policyBytes: Math.max(0, totalBytes - taskBytes), totalBytes };
}

export const PR_CREATION_GUIDANCE = "When explicitly creating or updating a pull request, ensure the branch has a newly pushed commit representing the final PR contents before `gh pr create`: stage only intended uncommitted changes, commit, and push. If a clean branch already has the intended contents pushed but the request implies a fresh PR/build/CI trigger, make and push a deliberate empty trigger commit such as `chore: trigger preview build for <topic>` before or immediately after `gh pr create`. Never use it to bypass safety checks: do not create an empty trigger commit in a dirty, detached, shared, or uncertain worktree, and do not include unrelated files. Honor an explicit no-empty-commit or no-CI-trigger request; do not deploy or merge.";
export const RESOURCE_EXECUTION_GUIDANCE = "Run bounded, low-resource commands directly. Use `/home/kyle/bin/run-heavy` for heavy or long work, builds, installs, full suites, browser or evaluation workloads, and when project rules require it. Do not repeat valid evidence or use a background job only to avoid waiting. Repository, host, and resource rules always win.";
export const LOCAL_SECRET_POLICY_SUMMARY = "If this task needs secrets, do not read Infisical, raw tokens, `.env`, or `/etc/agent-secrets/*`. Use the local secret store and broker. Ask the user to add secrets with `sudo secret global <service>` or `sudo secret <project> <service>`. Use only localhost services or approved broker commands. Agents may read only `~/.config/agent/gateway.token`.";
export const BROWSER_GUIDANCE = "Use browser tools only when the task needs browser access. Prefer the lightest available tool and do not expose credentials or private page data.";
export const PI_BACKGROUND_JOB_GUIDANCE = "For heavy local commands expected to take more than two minutes, use background_job instead of bash. Do not pass the bash timeout field and do not invoke GNU timeout. After starting a background job, immediately continue any other independent useful work when possible and never poll it. End the turn to await its completion only when no useful independent work remains. When the background_job completion follow-up arrives, inspect its log path and continue that work before finishing.";

function normalizedPromptText(value: string): string { return value.replace(/\s+/g, " ").trim(); }

/** Build optional context sections without repeating validation commands already present in task prose. */
export function buildWorkerPromptSections(task: string, options: Pick<WorkerPromptOptions, "knownFacts" | "validationCommands"> = {}): string[] {
	const facts = (options.knownFacts ?? []).map((fact) => fact.trim()).filter(Boolean);
	const knownFacts = facts.length
		? `Known facts. Do not rediscover these facts unless evidence is stale, contradictory, or validation fails:\n${facts.map((fact) => `- ${fact}`).join("\n")}`
		: undefined;
	const taskText = normalizedPromptText(task);
	const commands = [...new Set((options.validationCommands ?? []).map((command) => command.trim()).filter(Boolean))]
		.filter((command) => !task.includes(command) && !taskText.includes(normalizedPromptText(command)));
	const validation = commands.length
		? `Focused validation commands:\n${commands.map((command) => `- ${command}`).join("\n")}`
		: undefined;
	return [knownFacts, validation].filter((section): section is string => Boolean(section));
}

/** Warn about duplicated generic policy while leaving every delegation valid. */
export type WorkerTaskPolicyWarning = { kind: "worktree" | "pr" | "resource" | "background"; message: string };
const FINAL_USER_REQUEST_MARKER = /^(?:Verbatim user operative request(?:s|\(s\))?|Faithful excerpt of user operative request(?:s|\(s\))?):[ \t]*(?:\r)?$/gm;
export function lintWorkerTaskPolicyDuplication(task: string): WorkerTaskPolicyWarning[] {
	let finalMarker: RegExpExecArray | undefined;
	let match: RegExpExecArray | null;
	while ((match = FINAL_USER_REQUEST_MARKER.exec(task)) !== null) finalMarker = match;
	const suppliedBrief = finalMarker?.index === undefined ? task : task.slice(0, finalMarker.index);
	const warnings: WorkerTaskPolicyWarning[] = [];
	if (/Worktree lifecycle contract|git worktree list --porcelain|\/home\/kyle\/bin\/wt-new|git worktree prune/i.test(suppliedBrief)) warnings.push({ kind: "worktree", message: "Task repeats generic worktree lifecycle policy already supplied to the worker." });
	if (/When explicitly creating or updating a pull request|newly pushed commit representing the final PR contents|gh pr create|no-empty-commit or no-CI-trigger/i.test(suppliedBrief)) warnings.push({ kind: "pr", message: "Task repeats generic pull-request creation policy already supplied to the worker." });
	if (/Run bounded, low-resource|Resource execution is direct by default|\/home\/kyle\/bin\/run-heavy|resource-execution policy/i.test(suppliedBrief)) warnings.push({ kind: "resource", message: "Task repeats generic resource-execution policy already supplied to the worker." });
	if (/background_job|Do not pass the bash timeout field|never poll it|background job merely to avoid waiting/i.test(suppliedBrief)) warnings.push({ kind: "background", message: "Task repeats generic background-job policy already supplied to the worker." });
	return warnings;
}

/** Score only obvious extra-work markers. This scaffold does not affect worker lifecycle or acceptance. */
export type WorkerExtraWorkScore = { score: number; markers: string[] };
export function scoreWorkerExtraWork(report: string, options: { prCreationRequested?: boolean } = {}): WorkerExtraWorkScore {
	const markers: string[] = [];
	if (/\b(?:full|entire|whole)\s+(?:test|lint|check|validation)\s+(?:suite|run|set)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|check)\b/i.test(report)) markers.push("full-suite");
	if (options.prCreationRequested !== true && /\b(?:created|opened|submitted)\s+(?:a\s+)?(?:pull request|PR)\b|\bgh pr create\b/i.test(report)) markers.push("unrequested-pr");
	if (/\b(?:re-?discover(?:ed|ing)?|searched the entire repository|scanned the whole repository|broad repository discovery)\b/i.test(report)) markers.push("broad-rediscovery");
	return { score: markers.length, markers };
}

/** Build the complete implementation brief shared by every worker backend. */
export function buildWorkerPrompt({ worker, task, cwd, backend, selfPlan, planOnly, category, needsWorktree, needsHeavyWork, needsBrowser, needsSecrets, prCreationRequested, validationCommands, knownFacts }: WorkerPromptOptions): string {
	const researchLike = category === "research" || category === "documentation";
	const implementationGuidance = !planOnly && (!researchLike || needsWorktree === true);
	const includeHeavyGuidance = needsHeavyWork ?? (!planOnly && !researchLike);
	const role = planOnly ? "a planning worker" : implementationGuidance ? "an implementation worker" : category === "documentation" ? "a documentation worker" : "a research worker";
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
		: implementationGuidance
			? "You own actual implementation: do not delegate and do not merely propose a patch. Delegated workers must never merge pull requests; pull request merging remains coordinator-only after explicit user authorization. Ask only when interpretations materially conflict, an action is destructive, or user-only input is required."
			: "You own the assigned research or documentation work: do not delegate and do not merely restate the brief. Report evidence and conclusions clearly. Ask only when interpretations materially conflict or user-only input is required.";
	const finalResponse = planOnly
		? "include the concrete change you propose, the files it touches, edge cases, how it should be validated, and any blocker"
		: implementationGuidance
			? "include changed files, validation run, any blocker, and any point where you departed from the brief's plan and why"
			: "include sources or files inspected, findings, validation run, any blocker, and any point where you departed from the brief's plan and why";
	const guidance = `You are ${worker}, ${role}. Work directly in ${cwd}.\n\n${briefGuidance}\n\n${ownership}\n\nSol receives your final response directly and may send follow-up instructions while you work. Keep it concise and ${finalResponse}. Write it as plain sentences leading with the content itself — never open with a label prefix such as "Checkpoint:" or "Status:".`;
	const policySections = [
		includeHeavyGuidance ? RESOURCE_EXECUTION_GUIDANCE : undefined,
		needsBrowser ? BROWSER_GUIDANCE : undefined,
		needsSecrets ? LOCAL_SECRET_POLICY_SUMMARY : undefined,
		!planOnly && prCreationRequested ? PR_CREATION_GUIDANCE : undefined,
		includeHeavyGuidance && backend === "pi-rpc" ? PI_BACKGROUND_JOB_GUIDANCE : undefined,
	];
	return [guidance, ...policySections, ...buildWorkerPromptSections(task, { knownFacts, validationCommands }), task].filter((part): part is string => Boolean(part)).join("\n\n");
}

/**
 * Flip a live worker between planning and implementing. The launch prompt gave
 * it the opposite standing order, so the switch has to revoke that order
 * explicitly rather than merely state the new one. Turning implementation off
 * never asks for a revert: work already on disk is reported, not destroyed.
 */
export function buildModeChangeDirective(planOnly: boolean, includeWorktreePolicy = true): string {
	return planOnly
		? "Mode change: stop implementing this task. Make no further edits, commits, or other changes. Do not revert or clean up what you have already changed. The plan is now the deliverable: report exactly what you already changed, then the remaining approach you propose, the files it would touch, edge cases, and how it should be validated."
		: [
			"Mode change: implementation is now authorized for this task. Carry out the approach you reported, adjusting it only where the source proves it wrong. You own actual implementation: do not delegate and do not merely propose a patch. Delegated workers must never merge pull requests; pull request merging remains coordinator-only after explicit user authorization. Your final response should include changed files, validation run, any blocker, and any point where you departed from the approach you reported and why.",
			includeWorktreePolicy ? WORKTREE_LIFECYCLE_CONTRACT : undefined,
		].filter((part): part is string => Boolean(part)).join("\n\n");
}

/** Return PR guidance only when a live worker receives explicit PR-creation intent for the first time. */
export function buildPrCreationDirective(): string {
	return PR_CREATION_GUIDANCE;
}

export type WorkerPolicyState = {
	planOnly?: boolean;
	prCreationRequested?: boolean;
	prCreationGuidanceSent?: boolean;
	implementationPolicySent?: boolean;
	needsWorktree?: boolean;
	needsHeavyWork?: boolean;
	needsBrowser?: boolean;
	needsSecrets?: boolean;
	heavyGuidanceSent?: boolean;
	browserGuidanceSent?: boolean;
	secretsGuidanceSent?: boolean;
	backgroundGuidanceSent?: boolean;
};

/** Apply mode and policy-intent changes, and return only sections the worker has not received. */
export function applyWorkerPolicyTransition(
	state: WorkerPolicyState,
	request: { planOnly?: boolean; prCreationRequested?: boolean; needsWorktree?: boolean; needsHeavyWork?: boolean; needsBrowser?: boolean; needsSecrets?: boolean; backend?: WorkerProfile["backend"] },
): { directives: string[]; modeChanged: boolean; requestedMode?: boolean } {
	const requestedMode = typeof request.planOnly === "boolean" ? request.planOnly : undefined;
	const modeChanged = requestedMode !== undefined && requestedMode !== (state.planOnly === true);
	for (const key of ["needsWorktree", "needsHeavyWork", "needsBrowser", "needsSecrets"] as const) {
		if (typeof request[key] === "boolean") state[key] = request[key];
	}
	if (request.prCreationRequested === true) state.prCreationRequested = true;
	const implementationAuthorized = requestedMode === false || (requestedMode === undefined && state.planOnly !== true);
	const directives: string[] = [];
	if (modeChanged) {
		const includeWorktreePolicy = requestedMode === false && state.implementationPolicySent !== true && state.needsWorktree !== false;
		directives.push(buildModeChangeDirective(requestedMode!, includeWorktreePolicy));
		if (includeWorktreePolicy) state.implementationPolicySent = true;
		state.planOnly = requestedMode;
	}
	if (state.needsHeavyWork === true && state.heavyGuidanceSent !== true) {
		directives.push(RESOURCE_EXECUTION_GUIDANCE);
		state.heavyGuidanceSent = true;
		if (request.backend === "pi-rpc" && state.backgroundGuidanceSent !== true) {
			directives.push(PI_BACKGROUND_JOB_GUIDANCE);
			state.backgroundGuidanceSent = true;
		}
	}
	if (state.needsBrowser === true && state.browserGuidanceSent !== true) {
		directives.push(BROWSER_GUIDANCE);
		state.browserGuidanceSent = true;
	}
	if (state.needsSecrets === true && state.secretsGuidanceSent !== true) {
		directives.push(LOCAL_SECRET_POLICY_SUMMARY);
		state.secretsGuidanceSent = true;
	}
	if (implementationAuthorized && state.prCreationRequested === true && state.prCreationGuidanceSent !== true) {
		directives.push(buildPrCreationDirective());
		state.prCreationGuidanceSent = true;
	}
	return { directives, modeChanged, ...(requestedMode !== undefined ? { requestedMode } : {}) };
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
