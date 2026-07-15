import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	SolToolMode,
	catalogText,
	workerDescription,
	workerNames,
	piRpcWorkerArgs,
	type WorkerCatalog,
	type WorkerProfile,
} from "./orchestrator-lib/orchestrator-core.ts";
import {
	claudeCodeArgs,
	claudeResultSettlement,
	claudeUsageTokenTotal,
	claudeUserEvent,
	parseClaudeStreamLine,
} from "./orchestrator-lib/orchestrator-claude.ts";
import { loadOrchestratorConfig, type OrchestratorConfig } from "./orchestrator-lib/orchestrator-config.ts";
import {
	beginWorkerRun,
	beginWorkerSettlement,
	canSteerWorker,
	completeClaudeTurn,
	finishWorkerSettlement,
	queueClaudeTurn,
	selectFinalWorkerText,
	stopWorker,
} from "./orchestrator-lib/worker-lifecycle.ts";
import {
	bindOrchestratorApi,
	bindOrchestratorSession,
	deliverWorkerReport,
	ensureOrchestratorExitHook,
	getOrchestratorRuntime,
	notifyOrchestratorStateChange,
	releaseOrchestratorSession,
	type OrchestratorWorker as Worker,
} from "./orchestrator-lib/orchestrator-runtime.ts";
import { renderBaseFooter } from "./orchestrator-lib/orchestrator-footer.ts";
import {
	hasAnimatingWorker,
	isExpiredWorker,
	panelWorkers,
	renderWorkerFooterRows,
	renderWorkerPanel,
	WORKER_WIDGET_TICK_MS,
	type WorkerPanelOptions,
} from "./orchestrator-lib/orchestrator-ui.ts";
import {
	appendTranscript,
	mergeTranscriptEntry,
	transcriptFromClaudeEvent,
	transcriptFromRpcEvent,
	type TranscriptEntry,
} from "./orchestrator-lib/orchestrator-transcript.ts";
import {
	isDownKey,
	isEnterKey,
	isEscapeKey,
	isPageDownKey,
	isPageUpKey,
	isUpKey,
	moveSelection,
	renderSessionScreen,
	wrapPlainText,
} from "./orchestrator-lib/orchestrator-session-view.ts";

const LEGACY_WORKER_WIDGET_ID = "orchestrator-workers";

export function createWorkerSchema(catalog: WorkerCatalog) {
	return Type.Union(workerNames(catalog).map((name) => Type.Literal(name, { description: workerDescription(name, catalog[name]!) })));
}

export function coordinatorInstructions(catalog: WorkerCatalog): string {
	const names = catalogText(catalog);
	return `You are the orchestration lead. You investigate, think, and plan yourself, then hand implementation to workers; you never mutate anything.

Before delegating, use your read-only tools to inspect the relevant files, locate the root cause, and decide the approach. Then delegate with orchestrator_delegate, choosing one of: ${names}. Give a precise implementation brief: files to change, the change and why, edge cases, and validation. Workers implement your plan — do not send them off to investigate what you could determine yourself. Configured names are intentional: natural requests such as ${workerNames(catalog).map((name) => `“ask ${name}”`).join(", ")} select that worker.

Workers are persistent: use orchestrator_steer for corrections or follow-up instructions. Completed worker results arrive as follow-up messages; review them and steer or delegate fixes. Do not use /end or request an end-of-task summary.

If the user explicitly asks you to do a task yourself without delegating, call orchestrator_takeover once with a short reason. That enables direct implementation tools for exactly this task; orchestration resumes automatically afterward. Only use it for an explicit takeover request.`;
}

function workerWidgetLines(now = Date.now(), width = 80, options: WorkerPanelOptions = {}): string[] | undefined {
	return renderWorkerPanel([...getOrchestratorRuntime().workers.values()], now, width, options);
}


const TAKEOVER_SYSTEM_INSTRUCTIONS = (reason: string) => `
The user explicitly requested a one-task Sol takeover (${reason}). Implement
this task yourself using the available normal implementation tools. Do not
delegate or use orchestrator worker controls. Complete the work and validation
directly; orchestration resumes after this task settles.`.trim();

function workerSummary(worker: Worker): string {
	const age = Math.max(0, Math.floor((Date.now() - worker.startedAt.getTime()) / 1000));
	return `${worker.name} (${worker.id}) — ${worker.state}, ${age}s — ${worker.task}`;
}

function content(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function getText(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const candidate = message as { role?: unknown; content?: unknown };
	if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return undefined;
	const text = candidate.content
		.filter((part): part is { type: string; text: string } =>
			typeof part === "object" && part !== null &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text || undefined;
}

function getUsageTokens(message: unknown): number | undefined {
	if (!message || typeof message !== "object") return undefined;
	const usage = (message as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object") return undefined;
	const totalTokens = (usage as { totalTokens?: unknown }).totalTokens;
	return typeof totalTokens === "number" && Number.isFinite(totalTokens) ? totalTokens : undefined;
}

function recordWorkerActivity(worker: Worker, entry: TranscriptEntry): void {
	mergeTranscriptEntry(worker.transcript ??= [], entry);
	worker.transcriptRevision = (worker.transcriptRevision ?? 0) + 1;
	worker.lastActivityAt = new Date(entry.at);
}

function failWorker(worker: Worker, message: string): void {
	if (worker.state === "stopped" || worker.state === "failed") return;
	worker.state = "failed";
	worker.settledAt ??= new Date();
	worker.lastError = message;
	reportWorkerResult(worker);
	notifyOrchestratorStateChange(getOrchestratorRuntime());
}

function sendRpc(worker: Worker, message: Record<string, unknown>): boolean {
	if (!canSteerWorker(worker, worker.process)) return false;
	try {
		worker.process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
			if (error) failWorker(worker, "Pi RPC worker stdin failed.");
		});
		return true;
	} catch {
		return false;
	}
}

function sendClaudeInstruction(worker: Worker, instructions: string): boolean {
	if (!canSteerWorker(worker, worker.process)) return false;
	try {
		worker.process.stdin.write(`${JSON.stringify(claudeUserEvent(instructions))}\n`, (error) => {
			if (error) failWorker(worker, "Claude Code worker stdin failed.");
		});
		queueClaudeTurn(worker);
		return true;
	} catch {
		return false;
	}
}

function sendWorkerInstruction(worker: Worker, instructions: string, steering = false): boolean {
	if (worker.profile.backend === "claude-code") return sendClaudeInstruction(worker, instructions);
	return sendRpc(worker, {
		type: "prompt",
		id: `${worker.id}:${steering ? randomUUID().slice(0, 8) : "initial"}`,
		message: instructions,
		...(steering ? { streamingBehavior: "steer" } : {}),
	});
}

function requestWorkerRpc(worker: Worker, message: Record<string, unknown>): Promise<unknown> {
	if (worker.profile.backend !== "pi-rpc" || !canSteerWorker(worker, worker.process)) return Promise.reject(new Error("Worker is not live."));
	const id = `${worker.id}:rpc-${++worker.rpcNextId}`;
	return new Promise((resolve, reject) => {
		worker.rpcPending.set(id, { resolve, reject });
		try {
			worker.process.stdin.write(`${JSON.stringify({ ...message, id })}\n`, (error) => {
				if (!error) return;
				worker.rpcPending.delete(id);
				reject(error);
			});
		} catch (error) {
			worker.rpcPending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function rejectPendingRpc(worker: Worker, error: Error): void {
	for (const pending of worker.rpcPending.values()) pending.reject(error);
	worker.rpcPending.clear();
}

function reapIfHeadless(worker: Worker): void {
	const runtime = getOrchestratorRuntime();
	if (!runtime.headlessReap || worker.reportedRun !== worker.run) return;
	if (worker.state !== "idle" && worker.state !== "failed") return;
	stopWorker(worker);
	worker.process.kill();
}

function reportWorkerResult(worker: Worker): void {
	const result = worker.lastResult ?? worker.lastError ?? "Worker settled without a final text response.";
	deliverWorkerReport(
		getOrchestratorRuntime(),
		worker,
		`[${worker.name} worker result — ${worker.id}]\n${result}\n\nReview this result. If work remains, steer this worker or delegate a follow-up.`,
	);
	reapIfHeadless(worker);
}

/** Retry reports deferred while /reload had no live ExtensionAPI target. */
function flushDeferredWorkerReports(): void {
	for (const worker of getOrchestratorRuntime().workers.values()) {
		if (worker.state === "idle" || worker.state === "failed") reportWorkerResult(worker);
	}
}

async function settleWorker(worker: Worker): Promise<void> {
	const run = beginWorkerSettlement(worker);
	if (run === undefined) return;
	notifyOrchestratorStateChange(getOrchestratorRuntime());
	const response = await requestWorkerRpc(worker, { type: "get_last_assistant_text" }).catch(() => undefined);
	const latest = response && typeof response === "object" && typeof (response as { text?: unknown }).text === "string"
		? (response as { text: string }).text
		: undefined;
	const text = selectFinalWorkerText(worker.lastResult, latest);
	if (text) worker.lastResult = text;
	if (finishWorkerSettlement(worker, run)) reportWorkerResult(worker);
	notifyOrchestratorStateChange(getOrchestratorRuntime());
}

function settleClaudeResult(worker: Worker, event: Record<string, unknown>): void {
	const settlement = claudeResultSettlement(event);
	if (!settlement) return;
	worker.claudeSessionId = settlement.sessionId ?? worker.claudeSessionId;
	const tokens = claudeUsageTokenTotal(settlement.usage);
	if (tokens !== undefined) worker.tokens = Math.max(worker.tokens ?? 0, tokens);
	// A result for an earlier turn (one that was already streaming when a
	// steer queued another) must not settle the steered run: the worker is
	// still working on the follow-up instructions.
	if (!completeClaudeTurn(worker)) {
		notifyOrchestratorStateChange(getOrchestratorRuntime());
		return;
	}
	const run = beginWorkerSettlement(worker);
	if (run === undefined) return;
	if (settlement.isError || !settlement.result) {
		worker.settlingRun = undefined;
		worker.state = "failed";
		worker.settledAt ??= new Date();
		worker.lastError = settlement.result ?? "Claude Code returned a result event without final text.";
		reportWorkerResult(worker);
	} else {
		worker.lastResult = settlement.result;
		if (finishWorkerSettlement(worker, run)) reportWorkerResult(worker);
	}
	notifyOrchestratorStateChange(getOrchestratorRuntime());
}

function handleRpcLine(worker: Worker, line: string): void {
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(line) as Record<string, unknown>;
	} catch {
		failWorker(worker, "Invalid Pi RPC worker output.");
		return;
	}

	for (const entry of transcriptFromRpcEvent(event)) recordWorkerActivity(worker, entry);

	if (event.type === "response" && typeof event.id === "string") {
		const pending = worker.rpcPending.get(event.id);
		if (pending) {
			worker.rpcPending.delete(event.id);
			if (event.success === false) pending.reject(new Error("Worker RPC failed."));
			else pending.resolve(event.data);
		}
		return;
	}

	switch (event.type) {
		case "agent_start":
			if (worker.state !== "stopped" && worker.state !== "failed") worker.state = "working";
			break;
		case "message_end":
		case "turn_end": {
			const text = getText(event.message);
			if (text) worker.lastResult = text;
			const tokens = getUsageTokens(event.message);
			if (tokens !== undefined) worker.tokens = Math.max(worker.tokens ?? 0, tokens);
			break;
		}
		case "agent_settled":
			void settleWorker(worker);
			break;
		case "error":
			failWorker(worker, "Pi RPC worker reported an error.");
			break;
	}
	notifyOrchestratorStateChange(getOrchestratorRuntime());
}

function handleClaudeLine(worker: Worker, line: string): void {
	const parsed = parseClaudeStreamLine(line);
	if (!parsed.ok) {
		failWorker(worker, "Invalid Claude Code stream JSON.");
		return;
	}
	for (const event of parsed.events) {
		for (const entry of transcriptFromClaudeEvent(event)) recordWorkerActivity(worker, entry);
		settleClaudeResult(worker, event);
	}
}

function launchWorker(name: string, profile: WorkerProfile, task: string, cwd: string, config: OrchestratorConfig): Worker {
	const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 8)}`;
	const child = profile.backend === "pi-rpc"
		? spawn(config.commands.pi, piRpcWorkerArgs(profile), {
			cwd,
			env: { ...process.env, PI_ORCHESTRATOR_WORKER: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		})
		: spawn(config.commands.claude, claudeCodeArgs(profile.model), {
			cwd,
			env: { ...process.env, PI_ORCHESTRATOR_WORKER: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
	const worker: Worker = {
		id,
		name,
		profile,
		task,
		cwd,
		process: child,
		state: "starting",
		run: 1,
		startedAt: new Date(),
		buffer: "",
		transcript: [],
		rpcNextId: 0,
		rpcPending: new Map(),
	};
	getOrchestratorRuntime().workers.set(id, worker);
	notifyOrchestratorStateChange(getOrchestratorRuntime());

	child.stdout.on("data", (chunk: Buffer) => {
		worker.buffer += chunk.toString("utf8");
		let newline: number;
		while ((newline = worker.buffer.indexOf("\n")) >= 0) {
			const line = worker.buffer.slice(0, newline).trim();
			worker.buffer = worker.buffer.slice(newline + 1);
			if (line) {
				if (worker.profile.backend === "pi-rpc") handleRpcLine(worker, line);
				else handleClaudeLine(worker, line);
			}
		}
	});
	child.stderr.on("data", (chunk: Buffer) => {
		// Do not retain stderr: it can include local auth/config details. Exit and
		// stdin paths below report a safe, actionable status instead.
		if (chunk.length && worker.state !== "stopped") worker.lastError ??= `${worker.profile.backend === "claude-code" ? "Claude Code" : "Pi RPC"} worker reported stderr.`;
	});
	child.on("error", () => {
		rejectPendingRpc(worker, new Error("Worker process failed to start."));
		failWorker(worker, "Worker process failed to start.");
	});
	child.on("exit", (code, signal) => {
		rejectPendingRpc(worker, new Error("Worker process exited."));
		if (worker.state !== "stopped" && worker.state !== "idle") {
			failWorker(worker, code === 0
				? "Worker process exited before returning a result."
				: `Worker exited with code ${code ?? "null"} (${signal ?? "no signal"}).`);
		}
		notifyOrchestratorStateChange(getOrchestratorRuntime());
	});

	const prompt = `You are ${name}, an implementation worker. Work directly in ${cwd}.

${task}

Inspect the repository, implement the task, and run the relevant validation. You own actual implementation: do not delegate and do not merely propose a patch. Keep your final response concise and include changed files, validation run, and any blocker. Sol receives your final response directly and may send follow-up instructions while you work.`;
	recordWorkerActivity(worker, { at: Date.now(), role: "user", text: task });
	if (!sendWorkerInstruction(worker, prompt)) failWorker(worker, "Worker stdin was unavailable at startup.");
	return worker;
}

export default function orchestrator(pi: ExtensionAPI) {
	if (process.env.PI_ORCHESTRATOR_WORKER === "1") return;
	const config = loadOrchestratorConfig();
	const catalog = config.workers;
	const catalogNames = catalogText(catalog);
	const delegateWorkerSchema = createWorkerSchema(catalog);

	// Workers are unref'd so a settled -p host can exit; make sure that exit
	// also reaps any still-running worker processes instead of orphaning them.
	const runtime = getOrchestratorRuntime();
	const generation = bindOrchestratorApi(runtime, pi);
	ensureOrchestratorExitHook(runtime);
	flushDeferredWorkerReports();

	let refreshWorkerWidget = () => {};
	let stopWorkerWidgetTimer = () => {};
	let takeoverReason = "explicit user request";
	const solToolMode = new SolToolMode();

	const activate = async (ctx: { modelRegistry: { find(provider: string, id: string): unknown }; cwd: string }) => {
		if (config.coordinator.provider && config.coordinator.id) {
			const coordinator = ctx.modelRegistry.find(config.coordinator.provider, config.coordinator.id);
			if (coordinator) void pi.setModel(coordinator as never).catch(() => {});
		}
		pi.setThinkingLevel(config.coordinator.thinking);
		pi.setActiveTools(solToolMode.activate(pi.getActiveTools(), pi.getAllTools().map((tool) => tool.name)));
	};

	pi.on("session_start", async (_event, ctx) => {
		stopWorkerWidgetTimer();
		refreshWorkerWidget = () => {};
		await activate(ctx);
		// RPC workers never create footer components or timers.
		if (!ctx.hasUI || ctx.mode !== "tui") {
			bindOrchestratorSession(runtime, generation, pi, () => {}, true, () => {});
			flushDeferredWorkerReports();
			return;
		}

		// Remove the old above-footer widget if this session was reloaded.
		ctx.ui.setWidget(LEGACY_WORKER_WIDGET_ID, undefined);
		let timer: ReturnType<typeof setInterval> | undefined;
		let footerInstalled = false;
		let requestFooterRender = () => {};
		// Footer keyboard selection: down from an empty editor enters the worker
		// rows, enter opens that worker's session view, esc/up-past-top returns.
		let selectedWorkerId: string | undefined;
		let viewerOpen = false;
		// Only live workers are shown and selectable; settled ones leave the
		// list immediately but stay in memory (still steerable) until their
		// report is delivered and the retention window passes.
		const pruneExpiredWorkers = () => {
			for (const worker of [...runtime.workers.values()]) {
				if (worker.id !== selectedWorkerId && !viewerOpen && isExpiredWorker(worker)) runtime.workers.delete(worker.id);
			}
		};
		const selectableWorkerIds = () => {
			pruneExpiredWorkers();
			return panelWorkers([...runtime.workers.values()]).map((worker) => worker.id);
		};
		const stopTimer = () => {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
		};
		const removeFooter = () => {
			if (!footerInstalled) return;
			footerInstalled = false;
			requestFooterRender = () => {};
			ctx.ui.setFooter(undefined); // Restore Pi's native footer when workers settle.
		};
		const installFooter = () => {
			if (footerInstalled) {
				requestFooterRender();
				return;
			}
			footerInstalled = true;
			ctx.ui.setFooter((tui, theme, footerData) => {
				requestFooterRender = () => tui.requestRender();
				const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
				return {
					render: (width: number) => {
						const rows = renderWorkerFooterRows(
							workerWidgetLines(Date.now(), width, { selectedId: selectedWorkerId }),
							theme,
						);
						return [
							...renderBaseFooter(ctx as never, footerData as never, theme as never, pi.getThinkingLevel(), width),
							...rows,
						];
					},
					invalidate: () => tui.requestRender(),
					dispose: unsubscribe,
				};
			});
		};
		const render = () => {
			// A selected worker that settles leaves the list; drop the selection
			// with it (but not while its session view is open).
			if (selectedWorkerId !== undefined && !viewerOpen && !selectableWorkerIds().includes(selectedWorkerId)) {
				selectedWorkerId = undefined;
			}
			if (hasAnimatingWorker([...runtime.workers.values()]) || selectedWorkerId !== undefined) installFooter();
			else removeFooter();
		};
		const reconcileTimer = () => {
			if (!hasAnimatingWorker([...runtime.workers.values()])) {
				stopTimer();
				return;
			}
			if (timer === undefined) {
				timer = setInterval(() => {
					// Only redraw local in-memory state; no I/O, RPC, subprocess, or model call.
					render();
					if (!hasAnimatingWorker([...runtime.workers.values()])) stopTimer();
				}, WORKER_WIDGET_TICK_MS);
			}
		};
		const redraw = () => {
			render();
			requestFooterRender();
		};
		const openWorkerSession = (workerId: string) => {
			const opened = runtime.workers.get(workerId);
			if (!opened) return;
			// Workers launched by an older extension generation have no captured
			// transcript; best-effort seed it with the worker's latest reply.
			if (!opened.transcript?.length && opened.profile.backend === "pi-rpc" && canSteerWorker(opened, opened.process)) {
				void requestWorkerRpc(opened, { type: "get_last_assistant_text" })
					.then((response) => {
						const text = response && typeof response === "object" && typeof (response as { text?: unknown }).text === "string"
							? (response as { text: string }).text
							: undefined;
						if (text) appendTranscript(opened.transcript ??= [], "assistant", text);
					})
					.catch(() => {});
			}
			viewerOpen = true;
			// Minimize writes under the overlay: pi's overlay lives in a
			// line-indexed buffer, so any base-screen change rewrites the whole
			// viewport. Hide the streaming loader and hold worker reports (which
			// would start a coordinator turn) until the view closes.
			runtime.reportsHeld = true;
			ctx.ui.setWorkingVisible(false);
			void ctx.ui
				.custom<void>(
					(tui, theme, _keybindings, done) => {
						let scrollUp = 0;
						let cachedKey = "";
						let cachedBody: string[] = [];
						// Live view: poll local state only, and only redraw when the
						// transcript actually changed; no I/O or model calls.
						let lastSignature = "";
						const tick = setInterval(() => {
							const worker = runtime.workers.get(workerId);
							const signature = worker ? `${worker.transcriptRevision ?? worker.transcript?.length ?? 0}:${worker.state}` : "gone";
							if (signature !== lastSignature) {
								lastSignature = signature;
								tui.requestRender();
							}
						}, 500);
						// Native pi look: transcript entries render through pi's own
						// message components (markdown, theme colors, word wrap).
						const renderToolEntry = (entry: TranscriptEntry, width: number): string[] => {
							// Pi's own tool row: built-in tools (bash, read, edit, …) get
							// their exact native rendering, unknown tools the generic shell.
							const call = entry.tool!;
							const component = new ToolExecutionComponent(
								call.name,
								call.callId ?? "transcript",
								call.args ?? {},
								{ showImages: false },
								undefined,
								tui,
								runtime.workers.get(workerId)?.cwd ?? process.cwd(),
							);
							component.markExecutionStarted();
							component.setArgsComplete();
							if (call.result) component.updateResult(call.result, false);
							return component.render(width);
						};
						const buildBody = (worker: Worker, width: number): string[] => {
							const transcript = worker.transcript ?? [];
							const key = `${worker.transcriptRevision ?? transcript.length}:${width}`;
							if (key === cachedKey) return cachedBody;
							const markdownTheme = getMarkdownTheme();
							const lines: string[] = [];
							for (const entry of transcript) {
								try {
									if (entry.role === "user") {
										lines.push(...new UserMessageComponent(entry.text, markdownTheme).render(width));
									} else if (entry.role === "assistant") {
										const message = { content: [{ type: "text", text: entry.text }] };
										lines.push(...new AssistantMessageComponent(message as never, false, markdownTheme).render(width));
									} else if (entry.role === "tool" && entry.tool?.name) {
										lines.push(...renderToolEntry(entry, width));
									} else if (entry.role === "tool") {
										lines.push(...wrapPlainText(entry.text, width - 4).map((line) => theme.fg("toolOutput", `   ${line}`)));
									} else {
										lines.push(...wrapPlainText(entry.text, width - 2).map((line) => theme.fg("error", ` ${line}`)));
									}
								} catch {
									lines.push(...wrapPlainText(entry.text, width - 2).map((line) => ` ${line}`));
								}
								lines.push("");
							}
							cachedKey = key;
							cachedBody = lines;
							return lines;
						};
						return {
							render: (width: number) => {
								const worker = runtime.workers.get(workerId);
								if (!worker) return [theme.fg("dim", "Worker is gone.")];
								const height = Math.max(12, process.stdout.rows ?? 30);
								const title = `${worker.name} · ${worker.state} · ${worker.id}`;
								// Workers launched before this version predate the transcript field.
								const view = renderSessionScreen(title, buildBody(worker, width), width, height, scrollUp, theme);
								scrollUp = Math.min(scrollUp, view.maxScrollUp);
								return view.lines;
							},
							handleInput: (data: string) => {
								if (isUpKey(data)) scrollUp += 1;
								else if (isDownKey(data)) scrollUp = Math.max(0, scrollUp - 1);
								else if (isPageUpKey(data)) scrollUp += 10;
								else if (isPageDownKey(data)) scrollUp = Math.max(0, scrollUp - 10);
								else if (isEscapeKey(data) || data === "q") {
									done(undefined);
									return;
								} else return;
								tui.requestRender();
							},
							invalidate: () => {},
							dispose: () => clearInterval(tick),
						};
					},
					// Full-terminal takeover: extensions cannot swap pi's core chat
					// view, so the session view covers it edge to edge instead.
					{ overlay: true, overlayOptions: { width: "100%", anchor: "top-left", row: 0, col: 0 } },
				)
				.catch(() => {})
				.finally(() => {
					viewerOpen = false;
					runtime.reportsHeld = false;
					ctx.ui.setWorkingVisible(true);
					flushDeferredWorkerReports();
					redraw();
				});
		};
		const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			if (viewerOpen) return undefined;
			if (selectedWorkerId === undefined) {
				// Only an empty editor hands the down arrow over to the worker rows,
				// so history navigation and multi-line editing keep their keys.
				if (!isDownKey(data) || ctx.ui.getEditorText() !== "") return undefined;
				const ids = selectableWorkerIds();
				if (ids.length === 0) return undefined;
				selectedWorkerId = moveSelection(ids, undefined, "down");
				redraw();
				return { consume: true };
			}
			if (isUpKey(data) || isDownKey(data)) {
				selectedWorkerId = moveSelection(selectableWorkerIds(), selectedWorkerId, isUpKey(data) ? "up" : "down");
				redraw();
				return { consume: true };
			}
			if (isEnterKey(data)) {
				openWorkerSession(selectedWorkerId);
				redraw();
				return { consume: true };
			}
			if (isEscapeKey(data)) {
				selectedWorkerId = undefined;
				redraw();
				return { consume: true };
			}
			// Any other key returns focus to the editor and is handled normally.
			selectedWorkerId = undefined;
			redraw();
			return undefined;
		});
		const disposeUi = () => {
			unsubscribeInput();
			selectedWorkerId = undefined;
			runtime.reportsHeld = false;
			stopTimer();
			removeFooter();
			ctx.ui.setWidget(LEGACY_WORKER_WIDGET_ID, undefined);
		};
		stopWorkerWidgetTimer = disposeUi;
		refreshWorkerWidget = () => {
			render(); // Lifecycle transitions are reflected immediately.
			reconcileTimer();
		};
		if (!bindOrchestratorSession(runtime, generation, pi, refreshWorkerWidget, false, disposeUi)) return;
		flushDeferredWorkerReports();
		refreshWorkerWidget();
	});

	pi.on("session_shutdown", () => {
		// A stale /reload callback cannot detach the newer generation's bindings.
		releaseOrchestratorSession(runtime, generation);
	});

	pi.on("input", async (event) => {
		// Worker-result follow-ups are extension messages, not a user asking Sol
		// to take over. Only an explicit user/RPC request can enable this escape
		// hatch, and agent_settled restores orchestration afterward.
		if (event.source === "extension") return { action: "continue" };
		const takeoverTools = solToolMode.beginTakeover(
			event.text,
			pi.getActiveTools(),
			pi.getAllTools().map((tool) => tool.name),
		);
		if (!takeoverTools) return { action: "continue" };
		pi.setActiveTools(takeoverTools);
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${solToolMode.takeoverActive
			? TAKEOVER_SYSTEM_INSTRUCTIONS(takeoverReason)
			: coordinatorInstructions(catalog)}`,
	}));

	pi.on("agent_settled", async () => {
		const restrictedTools = solToolMode.settle();
		if (restrictedTools) pi.setActiveTools(restrictedTools);
		// Do not let a stale generation reap workers after a reload. Deferred
		// reports stay live until a current API target accepts them.
		if (runtime.generation !== generation || !runtime.headlessReap) return;
		for (const worker of runtime.workers.values()) reapIfHeadless(worker);
	});

	pi.registerCommand("orchestrator", {
		description: `Activate orchestration mode (${catalogNames} are persistent workers)`,
		handler: async (_args, ctx) => {
			await activate(ctx);
			ctx.ui.notify(`Orchestration mode is active. Delegate to ${catalogNames}.`, "info");
		},
	});

	pi.registerTool({
		name: "orchestrator_takeover",
		label: "Take over implementation",
		description: "Call once, exactly when the user has explicitly asked Sol to implement a task directly instead of delegating (any phrasing — 'do it yourself', 'fix it yourself', 'without delegating', etc). Judge intent yourself; do not wait for a fixed phrase. Enables normal implementation tools for exactly one task and starts a follow-up turn to do the work; orchestration resumes automatically once that task settles. Do not call this for routine implementation requests — those go through orchestrator_delegate.",
		parameters: Type.Object({
			reason: Type.String({ description: "Short paraphrase of the user's explicit request to skip delegation." }),
		}),
		execute: async (_toolCallId, params) => {
			takeoverReason = params.reason;
			pi.setActiveTools(solToolMode.beginTakeoverTool(pi.getActiveTools(), pi.getAllTools().map((tool) => tool.name)));
			pi.sendUserMessage(
				"Takeover enabled. Implement the task directly now with the available tools — do not delegate. Orchestration resumes automatically once this task settles.",
				{ deliverAs: "followUp" },
			);
			return content(`Takeover enabled (${params.reason}). Continuing in a follow-up turn with direct implementation tools.`);
		},
	});

	pi.registerTool({
		name: "orchestrator_delegate",
		label: "Delegate to worker",
		description: `Start a persistent ${catalogNames} implementation worker. Its final result is delivered to the coordinator.`,
		parameters: Type.Object({
			worker: delegateWorkerSchema,
			task: Type.String({ description: "Implementation brief built from YOUR OWN investigation: state the root cause or design you already determined, the exact files and changes to make, edge cases, and the validation to run. Never ask the worker to 'diagnose', 'investigate', or 'find' something you already read — hand it your conclusions and acceptance criteria." }),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const name = params.worker as string;
			const worker = launchWorker(name, catalog[name]!, params.task, ctx.cwd, config);
			return content(`Started ${worker.name} as ${worker.id}. It can be steered while active; its result will return directly to you.`, { workerId: worker.id });
		},
	});

	pi.registerTool({
		name: "orchestrator_steer",
		label: "Steer worker",
		description: `Send immediate follow-up instructions to a live configured worker (${catalogNames}). Use this to correct scope, request tests, or review fixes without ending it.`,
		parameters: Type.Object({
			workerId: Type.String({ description: "Worker ID returned by orchestrator_delegate." }),
			instructions: Type.String({ description: "Concrete follow-up instructions for the worker." }),
		}),
		execute: async (_toolCallId, params) => {
			const worker = runtime.workers.get(params.workerId);
			if (!worker) return content(`No worker exists with ID ${params.workerId}.`);
			if (!canSteerWorker(worker, worker.process)) {
				return content(`${worker.id} is not live or is still settling (state: ${worker.state}).`);
			}
			// A stream-json Claude turn (and a Pi RPC steer) belongs to a new
			// lifecycle generation before it is written, so a late prior result
			// cannot settle or report this follow-up.
			beginWorkerRun(worker);
			worker.lastResult = undefined;
			worker.lastError = undefined;
			recordWorkerActivity(worker, { at: Date.now(), role: "user", text: params.instructions });
			if (!sendWorkerInstruction(worker, params.instructions, true)) {
				failWorker(worker, "Worker stdin failed while sending follow-up instructions.");
				return content(`${worker.id} could not accept follow-up instructions.`);
			}
			refreshWorkerWidget();
			return content(`Sent follow-up instructions to ${worker.id}.`);
		},
	});

	pi.registerTool({
		name: "orchestrator_workers",
		label: "Worker status",
		description: `List persistent configured workers (${catalogNames}) and their current state.`,
		parameters: Type.Object({}),
		execute: async () => {
			const active = [...runtime.workers.values()];
			return content(active.length ? active.map(workerSummary).join("\n") : "No workers have been started.");
		},
	});

	pi.registerTool({
		name: "orchestrator_stop",
		label: "Stop worker",
		description: "Stop a persistent worker only when its work is no longer needed.",
		parameters: Type.Object({ workerId: Type.String() }),
		execute: async (_toolCallId, params) => {
			const worker = runtime.workers.get(params.workerId);
			if (!worker) return content(`No worker exists with ID ${params.workerId}.`);
			stopWorker(worker);
			worker.process.kill();
			refreshWorkerWidget();
			return content(`Stopped ${worker.id}.`);
		},
	});
}
