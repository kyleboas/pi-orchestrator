import { WORKER_PROFILES } from "./orchestrator-core.js";

/** Pi-RPC model tiers supported by the canonical orchestrator registry. */
export const WORKER_MODELS = {
	Sol: WORKER_PROFILES["Sol-Low"].model,
	Terra: WORKER_PROFILES.Terra.model,
} as const;
