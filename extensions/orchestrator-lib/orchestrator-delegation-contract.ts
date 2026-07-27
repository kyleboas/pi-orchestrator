const INTERNAL_DELEGATION_CONTRACT_MARKER = "[INTERNAL ORCHESTRATOR DELEGATION CONTRACT v1]";

const CONTRACT_INSTRUCTIONS = `Worktree lifecycle contract:
- Before creating or selecting a worktree, inspect \`git worktree list --porcelain\`.
- Reuse only a clean, inactive, unlocked, unshared, certain, task-specific worktree from this same root-task lineage and branch. On continuation or correction of this same live root, reuse that owned worktree rather than creating another. Never reuse a completed worktree for a distinct task.
- Otherwise create a fresh task-specific worktree with \`/home/kyle/bin/wt-new <branch>\` run from inside the repository. Never place a worktree under \`/tmp\`: it is a different filesystem from \`/home/kyle/code\`, so \`node_modules\` cannot be hardlink-seeded and every worktree pays a full dependency install. Only install dependencies yourself when wt-new reports that it could not seed them.
- Before a successful final report, preserve useful work on the task branch or in a commit, verify the worktree is clean, remove the owned worktree with \`git worktree remove <exact-path>\` without force, and run \`git worktree prune\`.
- Never use \`rm -rf\`, delete branch refs, or remove a dirty, shared, locked, uncertain, or user-owned worktree. If cleanup is blocked, report the exact path and blocker.

Resource-execution policy:
- Run bounded, low-resource, foreground commands directly whenever practical, including narrow Git inspection, small scripts, focused unit tests, lint or static checks, and quick narrow type checks.
- Do not wrap every validation command in \`/home/kyle/bin/run-heavy\`, create a background job merely to avoid waiting, or repeat valid evidence.
- Use \`/home/kyle/bin/run-heavy\` for genuinely heavy or long-running work, background work, builds, installs, full suites, browser or evaluation workloads likely to sustain CPU or RAM pressure, and whenever repository or project instructions explicitly require it. Explicit safety, repository, host, and resource policies always win; do not weaken the existing background-job implementation.

Read-only tasks that create no worktree remain unaffected.`;

const FINAL_REQUEST_SECTION_RE = /^(?:Verbatim user operative requests?|Faithful excerpt of user operative requests?):[ \t]*(?:\r)?$/gm;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delegationContract(rootTaskId: string): string {
	return `${INTERNAL_DELEGATION_CONTRACT_MARKER}\nRoot task ID: ${rootTaskId}\n\n${CONTRACT_INSTRUCTIONS}`;
}

/** Return the final exact, newline-delimited user-request section marker. */
function finalRequestMarker(task: string): RegExpExecArray | undefined {
	let final: RegExpExecArray | undefined;
	let match: RegExpExecArray | null;
	while ((match = FINAL_REQUEST_SECTION_RE.exec(task)) !== null) final = match;
	return final;
}

/** Recognize only a complete contract immediately before the final request section. */
function hasContractAtBoundary(task: string, markerIndex: number): boolean {
	const beforeMarker = task.slice(0, markerIndex);
	const pattern = new RegExp(
		`\\n\\n${escapeRegExp(INTERNAL_DELEGATION_CONTRACT_MARKER)}\\nRoot task ID: [^\\r\\n]+\\n\\n${escapeRegExp(CONTRACT_INSTRUCTIONS)}\\n\\n$`,
	);
	return pattern.test(beforeMarker);
}

/** Insert the internal contract before the final user-request section exactly once. */
export function withOrchestratorDelegationContract(task: string, rootTaskId: string): string {
	const marker = finalRequestMarker(task);
	if (!marker || marker.index === undefined) {
		throw new Error("Cannot wrap delegated task: missing final section: 'Verbatim user operative request(s):' or 'Faithful excerpt of user operative request(s):'.");
	}
	if (hasContractAtBoundary(task, marker.index)) return task;
	const insertion = `\n\n${delegationContract(rootTaskId)}\n\n`;
	return `${task.slice(0, marker.index)}${insertion}${task.slice(marker.index)}`;
}

export { INTERNAL_DELEGATION_CONTRACT_MARKER };
