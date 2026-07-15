export type RolloverWorkerState = { state: string };
export type RolloverState = { outcomeVersion: number; outcomePending: boolean; rolloverInFlight?: number; rolloverCompletedVersion?: number };
export type ContextUse = { percent: number | null } | undefined;

/** Only settle-boundary, sufficiently large contexts may pay for a compaction. */
export function isOutcomeRolloverEligible(
	boundary: "agent_end" | "agent_settled",
	workers: Iterable<RolloverWorkerState>,
	state: RolloverState,
	usage: ContextUse,
	thresholdPercent: number,
): boolean {
	// agent_end can still auto-retry, compact/retry, or deliver queued follow-ups.
	if (boundary !== "agent_settled") return false;
	if (!Number.isFinite(thresholdPercent) || thresholdPercent <= 0 || !usage || usage.percent === null || usage.percent < thresholdPercent) return false;
	if (!state.outcomePending || state.rolloverInFlight !== undefined || state.rolloverCompletedVersion === state.outcomeVersion) return false;
	for (const worker of workers) if (worker.state === "starting" || worker.state === "working" || worker.state === "settling") return false;
	return true;
}

export const OUTCOME_ROLLOVER_INSTRUCTIONS = "Create a concise outcome-boundary handoff. Preserve the user's goal, decisions, authoritative repository paths, changed files, validation commands/results, commits or PRs, and unresolved blockers. Drop routine tool output, passive status chatter, and superseded progress updates.";

export function beginOutcomeRollover(state: RolloverState): number | undefined {
	if (!state.outcomePending || state.rolloverInFlight !== undefined) return undefined;
	state.rolloverInFlight = state.outcomeVersion;
	return state.outcomeVersion;
}
export function completeOutcomeRollover(state: RolloverState, version: number): void {
	if (state.rolloverInFlight === version) state.rolloverInFlight = undefined;
	state.rolloverCompletedVersion = version;
	if (state.outcomeVersion === version) state.outcomePending = false;
}
export function failOutcomeRollover(state: RolloverState, version: number): void {
	if (state.rolloverInFlight === version) state.rolloverInFlight = undefined;
}
