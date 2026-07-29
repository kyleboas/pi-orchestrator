import { randomUUID } from "node:crypto";

export const AUTONOMOUS_CAPABILITY_ENTRY = "diver-implement-capability";
export const AUTONOMOUS_LINEAGE_ENTRY = "diver-implement-lineage";
export const AUTONOMOUS_CAPABILITY_VERSION = 1;
export const FINAL_REVIEW_WORK_ITEM = "__final_review__";

export type AutonomousRole = "implementation" | "review" | "fix" | "replacement" | "continuation";
export interface AutonomousScope {
	capabilityId: string;
	runId: string;
	projectId: string;
	workItemId: string;
	dispatchId: string;
	generation: number;
	role: AutonomousRole;
}
export interface CapabilityGrant extends Omit<AutonomousScope, "role"> {
	version: 1;
	kind: "grant";
	dispatchId: string;
	allowedRoles: AutonomousRole[];
	status: "active";
	at: number;
}
export interface CapabilityRevoke {
	version: 1;
	kind: "revoke";
	capabilityId: string;
	runId: string;
	dispatchId: string;
	generation: number;
	status: "revoked";
	at: number;
}
export interface LineageBinding {
	version: 1;
	kind: "bind";
	capabilityId: string;
	runId: string;
	projectId: string;
	workItemId: string;
	rootTaskId: string;
	workerId: string;
	at: number;
}
export type CapabilityEvent = CapabilityGrant | CapabilityRevoke;
export type EntryLike = { type?: string; customType?: string; data?: unknown };

const ID = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,127}$/;
const ROLES: readonly AutonomousRole[] = ["implementation", "review", "fix", "replacement", "continuation"];
const exactKeys = (value: object, keys: string[]) => Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const id = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const roles = (value: unknown): value is AutonomousRole[] => Array.isArray(value) && value.length > 0 && new Set(value).size === value.length && value.every((role) => ROLES.includes(role));

export function capabilityId(): string { return randomUUID(); }
export function finalReviewCapabilityId(runId: string): string { return `final:${runId}`; }

export function isGrant(value: unknown): value is CapabilityGrant {
	if (!value || typeof value !== "object") return false;
	const v = value as any;
	return exactKeys(v, ["version", "kind", "capabilityId", "runId", "projectId", "workItemId", "dispatchId", "generation", "allowedRoles", "status", "at"]) &&
		v.version === 1 && v.kind === "grant" && v.status === "active" && id(v.capabilityId) && id(v.runId) && id(v.projectId) && id(v.workItemId) && id(v.dispatchId) && integer(v.generation) && roles(v.allowedRoles) && integer(v.at);
}
export function isRevoke(value: unknown): value is CapabilityRevoke {
	if (!value || typeof value !== "object") return false;
	const v = value as any;
	return exactKeys(v, ["version", "kind", "capabilityId", "runId", "dispatchId", "generation", "status", "at"]) &&
		v.version === 1 && v.kind === "revoke" && v.status === "revoked" && id(v.capabilityId) && id(v.runId) && id(v.dispatchId) && integer(v.generation) && integer(v.at);
}
export function isBinding(value: unknown): value is LineageBinding {
	if (!value || typeof value !== "object") return false;
	const v = value as any;
	return exactKeys(v, ["version", "kind", "capabilityId", "runId", "projectId", "workItemId", "rootTaskId", "workerId", "at"]) && v.version === 1 && v.kind === "bind" && [v.capabilityId, v.runId, v.projectId, v.workItemId, v.rootTaskId, v.workerId].every(id) && integer(v.at);
}

export interface CapabilityState {
	active: Map<string, CapabilityGrant>;
	all: Map<string, CapabilityGrant>;
	bindings: Map<string, LineageBinding>;
	error?: string;
}
const keyOf = (v: { runId: string; projectId: string; workItemId: string }) => `${v.runId}\0${v.projectId}\0${v.workItemId}`;

/** Strict append-order replay. Any malformed, duplicate, conflicting, stale or post-revoke event poisons the contract. */
export function replayCapabilities(entries: Iterable<EntryLike>): CapabilityState {
	const state: CapabilityState = { active: new Map(), all: new Map(), bindings: new Map() };
	const revoked = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === AUTONOMOUS_CAPABILITY_ENTRY) {
			const event = entry.data;
			if (!isGrant(event) && !isRevoke(event)) return { ...state, error: "Malformed autonomous capability entry." };
			if (isGrant(event)) {
				if (revoked.has(event.capabilityId)) return { ...state, error: `Reactivated revoked capability ${event.capabilityId}.` };
				const sameCapability = state.all.get(event.capabilityId);
				const priorForKey = [...state.all.values()].filter((g) => keyOf(g) === keyOf(event));
				if (sameCapability) {
					if (!state.active.has(event.capabilityId) || keyOf(sameCapability) !== keyOf(event) || event.generation <= sameCapability.generation || event.dispatchId === sameCapability.dispatchId || sameCapability.allowedRoles.join("|") !== event.allowedRoles.join("|")) return { ...state, error: `Duplicate, stale, or widened capability ${event.capabilityId}.` };
				} else if (priorForKey.some((g) => state.active.has(g.capabilityId) || event.generation <= g.generation || g.allowedRoles.join("|") !== event.allowedRoles.join("|"))) return { ...state, error: `Conflicting or stale capability grant for ${event.workItemId}.` };
				state.all.set(event.capabilityId, event); state.active.set(event.capabilityId, event);
			} else {
				const grant = state.active.get(event.capabilityId);
				if (!grant || grant.runId !== event.runId || grant.dispatchId !== event.dispatchId || grant.generation !== event.generation) return { ...state, error: `Stale or conflicting revoke for ${event.capabilityId}.` };
				state.active.delete(event.capabilityId); revoked.add(event.capabilityId);
			}
		} else if (entry.customType === AUTONOMOUS_LINEAGE_ENTRY) {
			if (!isBinding(entry.data)) return { ...state, error: "Malformed autonomous lineage entry." };
			const binding = entry.data;
			const grant = state.all.get(binding.capabilityId);
			if (!grant || keyOf(grant) !== keyOf(binding)) return { ...state, error: "Lineage binding has no matching source grant." };
			const key = keyOf(binding); const prior = state.bindings.get(key);
			if (prior && (prior.rootTaskId !== binding.rootTaskId || prior.workerId !== binding.workerId)) return { ...state, error: `Conflicting lineage binding for ${binding.workItemId}.` };
			state.bindings.set(key, binding);
		}
	}
	return state;
}

export function validateScope(entries: Iterable<EntryLike>, scope: AutonomousScope | undefined): { ok: true; grant: CapabilityGrant; binding?: LineageBinding } | { ok: false; active: boolean; error: string } {
	const state = replayCapabilities(entries);
	if (state.error) return { ok: false, active: true, error: state.error };
	const active = state.active.size > 0;
	if (!scope) return { ok: false, active, error: active ? "An active /implement run rejects every unscoped delegation." : "No autonomous scope supplied." };
	const grant = state.active.get(scope.capabilityId);
	if (!grant || grant.runId !== scope.runId || grant.projectId !== scope.projectId || grant.workItemId !== scope.workItemId || grant.dispatchId !== scope.dispatchId || grant.generation !== scope.generation || !grant.allowedRoles.includes(scope.role)) return { ok: false, active, error: "Autonomous scope is revoked, stale, conflicting, or outside its allowed role." };
	return { ok: true, grant, binding: state.bindings.get(keyOf(grant)) };
}
