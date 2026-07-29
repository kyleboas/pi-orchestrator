export type SteerKind = "correction" | "continuation";
export type DelegationRelationship = "new" | "continuation" | "replacement" | "correction" | "retry";

const correctionCounts = new Map<string, number>();

/**
 * Delegation relationship is intentionally explicit: runtime cannot infer
 * whether an unlinked task is a replacement from prose. Every relationship
 * other than `new` must identify an existing worker in the same root.
 */
export function validateDelegationRelationship(
	relationship: DelegationRelationship | undefined,
	retryOf: string | undefined,
	hasPriorWorker: boolean,
): { ok: true } | { ok: false; error: string } {
	if (!relationship) return { ok: false, error: "Delegation relationship is required; declare new or provide the prior worker ID for continuation, replacement, correction, or retry." };
	if (relationship === "new") {
		if (retryOf) return { ok: false, error: "A new task cannot carry retryOf; declare its actual relationship instead." };
		return { ok: true };
	}
	if (!retryOf) return { ok: false, error: `A ${relationship} delegation must carry retryOf with the prior worker's root identity; omission cannot reset the lineage budget.` };
	if (!hasPriorWorker) return { ok: false, error: `Cannot ${relationship} ${retryOf}: no such prior worker; report the blocker rather than creating an unlinked root.` };
	return { ok: true };
}

export function rootCorrectionAvailable(rootTaskId: string): boolean {
	return (correctionCounts.get(rootTaskId) ?? 0) < 1;
}

/** One substantive correction pass is shared by every worker in a root lineage. */
export function consumeRootCorrection(rootTaskId: string): { ok: true } | { ok: false; error: string } {
	const used = correctionCounts.get(rootTaskId) ?? 0;
	if (used >= 1) {
		return {
			ok: false,
			error: `Root-lineage correction budget is exhausted for ${rootTaskId}; report the blocker and ask the user rather than retrying silently.`,
		};
	}
	correctionCounts.set(rootTaskId, used + 1);
	return { ok: true };
}

/** Test/runtime isolation hook; distinct roots naturally have independent budgets. */
export function resetRootCorrectionBudgets(): void {
	correctionCounts.clear();
}

export function rootCorrectionCount(rootTaskId: string): number {
	return correctionCounts.get(rootTaskId) ?? 0;
}
