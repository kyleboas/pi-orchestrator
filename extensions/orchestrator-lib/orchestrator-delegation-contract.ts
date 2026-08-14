const INTERNAL_DELEGATION_CONTRACT_MARKER = "[INTERNAL ORCHESTRATOR DELEGATION CONTRACT v1]";

export const WORKTREE_LIFECYCLE_CONTRACT = `Worktree lifecycle contract:
- Before creating or selecting a worktree, inspect \`git worktree list --porcelain\`.
- Reuse only a clean, inactive, unlocked, unshared, certain, task-specific worktree from this same root-task lineage and branch. On continuation or correction of this same live root, reuse that owned worktree rather than creating another. Never reuse a completed worktree for a distinct task.
- Otherwise create a fresh task-specific worktree with \`/home/kyle/bin/wt-new <branch>\` run from inside the repository. Never place a worktree under \`/tmp\`: it is a different filesystem from \`/home/kyle/code\`, so \`node_modules\` cannot be hardlink-seeded and every worktree pays a full dependency install. Only install dependencies yourself when wt-new reports that it could not seed them.
- Before a successful final report, preserve useful work on the task branch or in a commit, verify the worktree is clean, remove the owned worktree with \`git worktree remove <exact-path>\` without force, and run \`git worktree prune\`.
- Never use \`rm -rf\`, delete branch refs, or remove a dirty, shared, locked, uncertain, or user-owned worktree. If cleanup is blocked, report the exact path and blocker.`;

export type DelegationContractMetadata = {
	/** True when the worker must only investigate and report a plan. */
	planOnly?: boolean;
	/** The worker needs a task-specific worktree. Ordinary implementation defaults to true. */
	needsWorktree?: boolean;
	/** Explicit user intent to create or update a pull request. */
	prCreationRequested?: boolean;
};

const FINAL_REQUEST_SECTION_RE = /^(?:Verbatim user operative request(?:s|\(s\))?|Faithful excerpt of user operative request(?:s|\(s\))?):[ \t]*(?:\r)?$/gm;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delegationContract(rootTaskId: string, metadata: DelegationContractMetadata): string {
	const header = `${INTERNAL_DELEGATION_CONTRACT_MARKER}\nRoot task ID: ${rootTaskId}`;
	return metadata.planOnly || metadata.needsWorktree === false ? header : `${header}\n\n${WORKTREE_LIFECYCLE_CONTRACT}`;
}

/** Return the final exact, newline-delimited user-request section marker. */
function finalRequestMarker(task: string): RegExpExecArray | undefined {
	let final: RegExpExecArray | undefined;
	let match: RegExpExecArray | null;
	while ((match = FINAL_REQUEST_SECTION_RE.exec(task)) !== null) final = match;
	return final;
}

/** Recognize an existing internal contract immediately before the final request section. */
function hasContractAtBoundary(task: string, markerIndex: number): boolean {
	const beforeMarker = task.slice(0, markerIndex);
	const pattern = new RegExp(
		`\\n\\n${escapeRegExp(INTERNAL_DELEGATION_CONTRACT_MARKER)}\\nRoot task ID: [^\\r\\n]+(?:\\n\\n${escapeRegExp(WORKTREE_LIFECYCLE_CONTRACT)})?\\n\\n$`,
	);
	return pattern.test(beforeMarker);
}

/** Insert the mode-specific internal contract before the exact final request section once. */
export function withOrchestratorDelegationContract(
	task: string,
	rootTaskId: string,
	metadata: DelegationContractMetadata = {},
): string {
	const marker = finalRequestMarker(task);
	if (!marker || marker.index === undefined) {
		throw new Error("Cannot wrap delegated task: missing final section: 'Verbatim user operative request(s):' or 'Faithful excerpt of user operative request(s):'.");
	}
	if (hasContractAtBoundary(task, marker.index)) return task;
	const insertion = `\n\n${delegationContract(rootTaskId, metadata)}\n\n`;
	return `${task.slice(0, marker.index)}${insertion}${task.slice(marker.index)}`;
}

export { INTERNAL_DELEGATION_CONTRACT_MARKER };
