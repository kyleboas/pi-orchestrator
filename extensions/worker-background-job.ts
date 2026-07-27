import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	BACKGROUND_JOB_MAX_PENDING,
	BACKGROUND_JOB_CLASSES,
	backgroundJobArgs,
	backgroundJobMarker,
	isBackgroundJobClass,
	isBackgroundJobCommand,
	isBackgroundJobName,
	type BackgroundJobClass,
	type BackgroundJobCompleted,
	type BackgroundJobStarted,
} from "./orchestrator-lib/background-job.ts";

const RUN_HEAVY = "/home/kyle/bin/run-heavy";
const LOG_DIRECTORY_NAME = "pi-background-jobs";

export type BackgroundJobStartInput = {
	command: string;
	name: string;
	runHeavyClass?: BackgroundJobClass;
	cwd: string;
};

export type BackgroundJobChild = Pick<ChildProcess, "once">;
export type BackgroundJobSpawn = (command: string, args: string[], options: { cwd: string; stdio: ["ignore", number, number]; detached: false; env: NodeJS.ProcessEnv }) => BackgroundJobChild;
export type BackgroundJobNotifier = (text: string) => void;

export class BackgroundJobManager {
	readonly pending = new Map<string, { name: string; logPath: string }>();
	#notify: BackgroundJobNotifier;
	#spawn: BackgroundJobSpawn;
	#logDirectory: string;

	constructor(notify: BackgroundJobNotifier, spawnJob: BackgroundJobSpawn = spawn as unknown as BackgroundJobSpawn, logDirectory = join(tmpdir(), LOG_DIRECTORY_NAME)) {
		this.#notify = notify;
		this.#spawn = spawnJob;
		this.#logDirectory = logDirectory;
	}

	setNotifier(notify: BackgroundJobNotifier): void {
		this.#notify = notify;
	}

	async start(input: BackgroundJobStartInput): Promise<BackgroundJobStarted> {
		if (!isBackgroundJobCommand(input.command)) throw new Error(`Command must be between 1 and ${16_000} characters and cannot contain a NUL byte.`);
		if (!isBackgroundJobName(input.name)) throw new Error("Job name must start with a letter or number and use only letters, numbers, dots, underscores, or hyphens (up to 64 characters).");
		const jobClass = input.runHeavyClass ?? "dev";
		if (!isBackgroundJobClass(jobClass)) throw new Error(`Run-heavy class must be one of: ${BACKGROUND_JOB_CLASSES.join(", ")}.`);
		if (this.pending.size >= BACKGROUND_JOB_MAX_PENDING) throw new Error(`Only ${BACKGROUND_JOB_MAX_PENDING} background jobs can be pending at once.`);

		mkdirSync(this.#logDirectory, { recursive: true, mode: 0o700 });
		const jobId = `job-${randomUUID()}`;
		const logPath = join(this.#logDirectory, `${jobId}.log`);
		let logFile: number | undefined;
		try {
			logFile = openSync(logPath, "w", 0o600);
			const child = this.#spawn(RUN_HEAVY, backgroundJobArgs(jobClass, input.name, input.command), {
				cwd: input.cwd,
				stdio: ["ignore", logFile, logFile],
				// A systemd scope would detach the real command from this worker's
				// process tree. Keep run-heavy as its foreground parent so worker
				// stop and sandbox teardown terminate the complete job tree.
				env: { ...process.env, RUN_HEAVY_SYSTEMD_SCOPE: "0" },
				detached: false,
			});
			return await new Promise<BackgroundJobStarted>((resolve, reject) => {
				let started = false;
				let settled = false;
				const closeLog = () => {
					if (logFile === undefined) return;
					try { closeSync(logFile); } catch { /* already closed */ }
					logFile = undefined;
				};
				child.once("error", (error: Error) => {
					if (settled) return;
					settled = true;
					closeLog();
					reject(new Error(`Could not start background job: ${error.message}`));
				});
				child.once("spawn", () => {
					if (settled) return;
					started = true;
					this.pending.set(jobId, { name: input.name, logPath });
					closeLog();
					settled = true;
					resolve({ kind: "started", jobId, name: input.name, logPath });
				});
				child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
					closeLog();
					if (!started) return;
					if (!this.pending.delete(jobId)) return;
					const event: BackgroundJobCompleted = { kind: "completed", jobId, logPath, exitCode, signal };
					try {
						this.#notify(`${backgroundJobMarker(event)}\nBackground job ${input.name} finished with exit status ${exitCode ?? "none"}${signal ? ` (${signal})` : ""}. Job ID: ${jobId}. Log: ${logPath}`);
					} catch {
						// The worker is shutting down. Its child is still tied to the worker tree.
					}
				});
			});
		} catch (error) {
			if (logFile !== undefined) {
				try { closeSync(logFile); } catch { /* already closed */ }
			}
			throw error;
		}
	}
}

const GLOBAL_MANAGER = Symbol.for("com.kyleboas.pi.worker-background-job.manager.v1");

function managerFor(pi: ExtensionAPI): BackgroundJobManager {
	const root = globalThis as typeof globalThis & Record<symbol, BackgroundJobManager | undefined>;
	const notify = (text: string) => pi.sendUserMessage(text, { deliverAs: "followUp" });
	const manager = root[GLOBAL_MANAGER] ??= new BackgroundJobManager(notify);
	manager.setNotifier(notify);
	return manager;
}

export default function workerBackgroundJob(pi: ExtensionAPI) {
	// This file sits in the global extension directory but is loaded explicitly
	// only by Pi RPC workers. Never add this capability to coordinator sessions.
	if (process.env.PI_ORCHESTRATOR_WORKER !== "1") return;
	const manager = managerFor(pi);
	pi.registerTool({
		name: "background_job",
		label: "Run background job",
		description: "Start a heavy local command through run-heavy and return immediately. The same worker receives a follow-up with its job ID, exit status, and log path when it finishes. Use the log path to inspect results after that follow-up.",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run with bash -lc. Do not wrap it in timeout." }),
			name: Type.String({ description: "Short job name using letters, numbers, dots, underscores, or hyphens." }),
			runHeavyClass: Type.Optional(Type.Union(BACKGROUND_JOB_CLASSES.map((value) => Type.Literal(value)))),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				const started = await manager.start({
					command: params.command,
					name: params.name,
					...(params.runHeavyClass ? { runHeavyClass: params.runHeavyClass } : {}),
					cwd: ctx.cwd,
				});
				return {
					content: [{ type: "text" as const, text: `${backgroundJobMarker(started)}\nStarted background job ${started.name}. Job ID: ${started.jobId}. Log: ${started.logPath}` }],
					details: { jobId: started.jobId, logPath: started.logPath },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text" as const, text: `Background job did not start: ${message}` }], details: {}, isError: true };
			}
		},
	});
}
