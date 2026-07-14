import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkerProfile } from "./orchestrator-core.ts";
import type { TranscriptEntry } from "./orchestrator-transcript.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";

/** Process-wide key: extension modules are replaced by /reload, globalThis is not. */
const ORCHESTRATOR_RUNTIME = Symbol.for("com.kyleboas.pi.orchestrator.runtime.v1");

export type PendingRpc = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

export type OrchestratorWorker = WorkerLifecycle & {
	id: string;
	name: string;
	profile: WorkerProfile;
	task: string;
	cwd: string;
	process: ChildProcessWithoutNullStreams;
	startedAt: Date;
	lastResult?: string;
	lastError?: string;
	claudeSessionId?: string;
	tokens?: number;
	buffer: string;
	transcript: TranscriptEntry[];
	rpcNextId: number;
	rpcPending: Map<string, PendingRpc>;
};

export type OrchestratorRuntime = {
	workers: Map<string, OrchestratorWorker>;
	api?: ExtensionAPI;
	onStateChange?: () => void;
	headlessReap: boolean;
	exitHookInstalled: boolean;
	/** Worker session view is open: hold result reports so no coordinator turn starts and rewrites the screen. */
	reportsHeld?: boolean;
	generation?: symbol;
	disposeUi?: () => void;
};

function createRuntime(): OrchestratorRuntime {
	return {
		workers: new Map(),
		headlessReap: false,
		exitHookInstalled: false,
	};
}

/** Exported for isolated lifecycle tests; production callers use the global getter. */
export function createOrchestratorRuntimeForTesting(): OrchestratorRuntime {
	return createRuntime();
}

/** Get the one runtime shared by every loaded generation of the extension. */
export function getOrchestratorRuntime(): OrchestratorRuntime {
	const root = globalThis as typeof globalThis & Record<symbol, OrchestratorRuntime | undefined>;
	return root[ORCHESTRATOR_RUNTIME] ??= createRuntime();
}

function disposeCurrentUi(runtime: OrchestratorRuntime): void {
	try {
		runtime.disposeUi?.();
	} catch {
		// A destroyed TUI must not prevent the replacement generation from binding.
	}
	runtime.disposeUi = undefined;
}

/** A newly loaded extension takes delivery ownership and retires the old UI safely. */
export function bindOrchestratorApi(runtime: OrchestratorRuntime, api: ExtensionAPI): symbol {
	disposeCurrentUi(runtime);
	const generation = Symbol("orchestrator-extension-generation");
	runtime.generation = generation;
	runtime.api = api;
	runtime.onStateChange = undefined;
	// Do not reap during the factory/session_start handoff. The new session sets
	// its actual mode below.
	runtime.headlessReap = false;
	return generation;
}

/** Bind UI ownership only if this extension generation is still current. */
export function bindOrchestratorSession(
	runtime: OrchestratorRuntime,
	generation: symbol,
	api: ExtensionAPI,
	onStateChange: () => void,
	headlessReap: boolean,
	disposeUi: () => void,
): boolean {
	if (runtime.generation !== generation) return false;
	runtime.api = api;
	runtime.onStateChange = onStateChange;
	runtime.headlessReap = headlessReap;
	runtime.disposeUi = disposeUi;
	return true;
}

/** A stale unload must not detach a newer extension generation's targets. */
export function releaseOrchestratorSession(runtime: OrchestratorRuntime, generation: symbol): boolean {
	if (runtime.generation !== generation) return false;
	disposeCurrentUi(runtime);
	runtime.api = undefined;
	runtime.onStateChange = undefined;
	runtime.headlessReap = false;
	runtime.generation = undefined;
	return true;
}

export function notifyOrchestratorStateChange(runtime: OrchestratorRuntime): void {
	try {
		runtime.onStateChange?.();
	} catch {
		// UI teardown/reload must not break a child-process event handler.
	}
}

/**
 * Send one result only after the current target accepts it. Missing or failed
 * targets intentionally leave the run pending for the next generation.
 */
export function deliverWorkerReport(runtime: OrchestratorRuntime, worker: OrchestratorWorker, text: string): boolean {
	if (runtime.reportsHeld) return false;
	if (worker.state === "stopped" || worker.reportedRun === worker.run || worker.reportingRun === worker.run) return false;
	const api = runtime.api;
	if (!api) return false;
	worker.reportingRun = worker.run;
	try {
		api.sendUserMessage(text, { deliverAs: "followUp" });
		worker.reportedRun = worker.run;
		return true;
	} catch {
		return false;
	} finally {
		worker.reportingRun = undefined;
	}
}

/** Register process cleanup once even when /reload evaluates the module again. */
export function ensureOrchestratorExitHook(
	runtime: OrchestratorRuntime,
	register: (event: "exit", listener: () => void) => unknown = (event, listener) => process.once(event, listener),
): boolean {
	if (runtime.exitHookInstalled) return false;
	runtime.exitHookInstalled = true;
	register("exit", () => {
		const activeRuntime = getOrchestratorRuntime();
		for (const worker of activeRuntime.workers.values()) {
			if (worker.state === "starting" || worker.state === "working") worker.process.kill("SIGTERM");
		}
	});
	return true;
}
