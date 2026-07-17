import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

/** The deliberately small opt-in authority delegated to a sandboxed worker. */
export type PullRequestsConfig = { repositories: string[]; branchPrefixes: string[] };
/** `branch` is deliberately absent until the first successful publish. */
type GitMetadata = { entryDevice: number; entryInode: number; gitDir: string; configs: Array<{ path: string; device: number; inode: number; hash: string }> };
export type PinnedPullRequestTarget = { workspace: string; repository: string; remoteUrl: string; defaultBranch: string; generation: string; device: number; inode: number; git: GitMetadata; branch?: string };
export type BrokerResult = { ok: boolean; message: string; repository?: string; branch?: string; defaultBranch?: string };
export const PR_REQUEST_LIMIT = 16_384;
export const PR_RESPONSE_LIMIT = 8_192;
export const PR_TITLE_LIMIT = 256;
export const PR_BODY_LIMIT = 32_000;
export const PR_MAX_CONNECTIONS = 8;
export const PR_MAX_REQUESTS = 32;
const REPOSITORY = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d][a-z\d._-]{0,99}$/i;
const PREFIX = /^(?!.*(?:^|\/)\.?\.?\/(?:|$))(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,79}\/$/;
const BRANCH = /^(?!-)(?!.*(?:^|\/)\.?\.?\/(?:|$))(?!.*\.\.)(?!.*\/\/)(?!.*\.lock(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

type CommandResult = { ok: boolean; stdout: string };
export type BrokerRunner = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; signal?: AbortSignal }) => Promise<CommandResult>;
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
function normalizedRepository(value: string): string | undefined { const repository = value.trim().toLowerCase(); return REPOSITORY.test(repository) ? repository : undefined; }

/** Strict parser: a present malformed block means no broker, never broadened authority. */
export function parsePullRequestsConfig(value: unknown): PullRequestsConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (Object.keys(raw).some((key) => key !== "repositories" && key !== "branchPrefixes") || !Array.isArray(raw.repositories) || !Array.isArray(raw.branchPrefixes) || !raw.repositories.length || !raw.branchPrefixes.length || raw.repositories.length > 32 || raw.branchPrefixes.length > 32) return undefined;
	const repositories: string[] = [], branchPrefixes: string[] = [], seenRepositories = new Set<string>(), seenPrefixes = new Set<string>();
	for (const value of raw.repositories) { if (!text(value, 140)) return undefined; const repository = normalizedRepository(value); if (!repository || seenRepositories.has(repository)) return undefined; seenRepositories.add(repository); repositories.push(repository); }
	for (const value of raw.branchPrefixes) { if (!text(value, 81)) return undefined; const prefix = value.trim(); if (!PREFIX.test(prefix) || seenPrefixes.has(prefix.toLowerCase())) return undefined; seenPrefixes.add(prefix.toLowerCase()); branchPrefixes.push(prefix); }
	return { repositories, branchPrefixes };
}

/** Accept only canonical GitHub HTTPS/SSH origin forms; never a user-selected remote. */
export function normalizeGitHubRemote(value: string): { repository: string; remoteUrl: string } | undefined {
	const raw = value.trim();
	let match = /^git@github\.com:([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw) ?? /^ssh:\/\/git@github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw);
	if (!match) try { const url = new URL(raw); if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return undefined; match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url.pathname); } catch { return undefined; }
	if (!match) return undefined;
	const repository = normalizedRepository(`${match[1]}/${match[2]}`);
	return repository ? { repository, remoteUrl: `git@github.com:${repository}.git` } : undefined;
}
export function branchAllowed(branch: string, config: PullRequestsConfig, defaultBranch?: string): boolean { return BRANCH.test(branch) && branch !== defaultBranch && config.branchPrefixes.some((prefix) => branch.startsWith(prefix)); }

function trustedEnv(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	// gh reads only its host configuration here. Tokens are intentionally not
	// inherited; SSH-agent access remains exclusively in this trusted process.
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_SSH_COMMAND"]) if (host[key] !== undefined) env[key] = host[key];
	return env;
}
function defaultRunner(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
	return new Promise((resolve) => {
		let output = "", settled = false;
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const finish = (ok: boolean) => { if (!settled) { settled = true; if (timeout) clearTimeout(timeout); options.signal?.removeEventListener("abort", terminate); resolve({ ok, stdout: output.slice(0, PR_RESPONSE_LIMIT) }); } };
		let terminating = false;
		const terminate = () => {
			if (settled || terminating) return;
			terminating = true;
			// This is a validated direct child only; never signal a group, PID 1, or ourselves.
			if (child.pid && child.pid > 1 && child.pid !== process.pid && child.exitCode === null) child.kill("SIGTERM");
			setTimeout(() => { if (child.exitCode === null && child.pid && child.pid > 1 && child.pid !== process.pid) child.kill("SIGKILL"); }, 1_000).unref();
			// Await direct-child exit when possible; KILL gives this bounded fallback
			// so broker cleanup never resolves while its normal child is still live.
			setTimeout(() => finish(false), 1_200).unref();
		};
		if (options.signal?.aborted) { terminate(); return; }
		options.signal?.addEventListener("abort", terminate, { once: true });
		timeout = setTimeout(terminate, options.timeout ?? 30_000);
		child.stdout.on("data", (chunk: Buffer) => { if (output.length < PR_RESPONSE_LIMIT) output += chunk.toString("utf8").slice(0, PR_RESPONSE_LIMIT - output.length); });
		child.stderr.on("data", () => {}); // Never retain auth/remote diagnostics and avoid pipe backpressure.
		child.on("error", () => finish(false));
		child.on("exit", (code) => finish(code === 0));
	});
}
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" };
function gitArgs(...args: string[]): string[] { return ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", ...args]; }
async function git(runner: BrokerRunner, cwd: string, ...args: string[]): Promise<CommandResult> { return runner("git", gitArgs(...args), { cwd, env: { ...trustedEnv(process.env), ...GIT_ENV }, timeout: 30_000 }); }
async function line(runner: BrokerRunner, cwd: string, ...args: string[]): Promise<string | undefined> { const result = await git(runner, cwd, ...args); const value = result.stdout.trim(); return result.ok && value && value.length <= 512 && !/[\0\r\n]/.test(value) ? value : undefined; }
function metadata(workspace: string): GitMetadata | undefined {
	try {
		const entry = join(workspace, ".git"), entryStat = lstatSync(entry);
		if (entryStat.isSymbolicLink()) return undefined;
		// A linked worktree's .git file points outside the mounted workspace. It is
		// unusable in the worker sandbox, so broker eligibility fails closed.
		if (!entryStat.isDirectory()) return undefined;
		const gitDir = realpathSync(entry);
		if (!statSync(gitDir).isDirectory()) return undefined;
		const state = (path: string, required: boolean) => { try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe config"); const contents = readFileSync(path); if (/^\s*\[include(?:If)?\b/im.test(contents.toString("utf8"))) throw new Error("included config is not permitted"); return { path, device: stat.dev, inode: stat.ino, hash: createHash("sha256").update(contents).digest("hex") }; } catch { if (required) throw new Error("missing config"); return { path, device: -1, inode: -1, hash: "absent" }; } };
		const configs = [state(join(gitDir, "config"), true)];
		return { entryDevice: entryStat.dev, entryInode: entryStat.ino, gitDir, configs };
	} catch { return undefined; }
}
function identity(cwd: string): { workspace: string; device: number; inode: number; git?: GitMetadata } | undefined { try { const workspace = realpathSync(cwd), stat = statSync(workspace), git = metadata(workspace); return stat.isDirectory() && !lstatSync(cwd).isSymbolicLink() ? { workspace, device: stat.dev, inode: stat.ino, ...(git ? { git } : {}) } : undefined; } catch { return undefined; } }
/** Test-only inspection helper; production eligibility always obtains this through pinPullRequestTarget. */
export function gitMetadataForTesting(workspace: string): GitMetadata | undefined { return metadata(workspace); }
function sameMetadata(left: GitMetadata, right: GitMetadata | undefined): boolean { return !!right && left.entryDevice === right.entryDevice && left.entryInode === right.entryInode && left.gitDir === right.gitDir && left.configs.length === right.configs.length && left.configs.every((config, index) => config.path === right.configs[index]?.path && config.device === right.configs[index]?.device && config.inode === right.configs[index]?.inode && config.hash === right.configs[index]?.hash); }
function localDefault(ref: string | undefined): string | undefined { const branch = ref?.startsWith("origin/") ? ref.slice("origin/".length) : undefined; return branch && BRANCH.test(branch) ? branch : undefined; }
function syncDefaultBranch(repository: string, local: string | undefined): string | undefined {
	if (local) return local;
	try { const result = spawnSync("gh", ["repo", "view", repository, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], { env: trustedEnv(process.env), stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 15_000, maxBuffer: PR_RESPONSE_LIMIT }); const value = result.status === 0 ? (result.stdout ?? "").trim() : ""; return value && BRANCH.test(value) ? value : undefined; } catch { return undefined; }
}
async function resolveDefaultBranch(repository: string, local: string | undefined, runner: BrokerRunner): Promise<string | undefined> {
	if (local) return local;
	const result = await runner("gh", ["repo", "view", repository, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], { env: trustedEnv(process.env), timeout: 15_000 });
	const branch = result.ok && result.stdout.length <= 512 ? result.stdout.trim() : "";
	return BRANCH.test(branch) ? branch : undefined;
}

/** Pin workspace identity, exact origin and default branch before worker code. Branch is intentionally deferred. */
export function pinPullRequestTargetSync(cwd: string, policy: PullRequestsConfig): PinnedPullRequestTarget | undefined {
	const file = identity(cwd); if (!file || !file.git) return undefined;
	const get = (...args: string[]): string | undefined => { try { const result = spawnSync("git", gitArgs(...args), { cwd: file.workspace, env: { ...trustedEnv(process.env), ...GIT_ENV }, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, encoding: "utf8", maxBuffer: PR_RESPONSE_LIMIT }); const value = result.status === 0 ? (result.stdout ?? "").trim() : ""; return value && value.length <= 512 && !/[\0\r\n]/.test(value) ? value : undefined; } catch { return undefined; } };
	if (get("rev-parse", "--is-inside-work-tree") !== "true" || get("rev-parse", "--show-toplevel") !== file.workspace) return undefined;
	const remote = get("remote", "get-url", "origin"), parsed = remote && normalizeGitHubRemote(remote);
	if (!parsed || !policy.repositories.includes(parsed.repository)) return undefined;
	const defaultBranch = syncDefaultBranch(parsed.repository, localDefault(get("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")));
	return defaultBranch ? { ...file, git: file.git, repository: parsed.repository, remoteUrl: parsed.remoteUrl, defaultBranch, generation: randomUUID() } : undefined;
}
export async function pinPullRequestTarget(cwd: string, policy: PullRequestsConfig, runner: BrokerRunner = defaultRunner): Promise<PinnedPullRequestTarget | undefined> {
	const file = identity(cwd); if (!file || !file.git || (await line(runner, file.workspace, "rev-parse", "--is-inside-work-tree")) !== "true" || (await line(runner, file.workspace, "rev-parse", "--show-toplevel")) !== file.workspace) return undefined;
	const remote = await line(runner, file.workspace, "remote", "get-url", "origin"), parsed = remote && normalizeGitHubRemote(remote);
	if (!parsed || !policy.repositories.includes(parsed.repository)) return undefined;
	const ref = await line(runner, file.workspace, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"), defaultBranch = await resolveDefaultBranch(parsed.repository, localDefault(ref), runner);
	return defaultBranch ? { ...file, git: file.git, repository: parsed.repository, remoteUrl: parsed.remoteUrl, defaultBranch, generation: randomUUID() } : undefined;
}
async function currentAllowedBranch(target: PinnedPullRequestTarget, policy: PullRequestsConfig, runner: BrokerRunner): Promise<string | undefined> { const branch = await line(runner, target.workspace, "symbolic-ref", "--quiet", "--short", "HEAD"); return branch && branchAllowed(branch, policy, target.defaultBranch) ? branch : undefined; }

function clientProgram(generation: string): string { return `#!/usr/bin/env node
import net from "node:net";
const [action, ...rest] = process.argv.slice(2);
if (!['status','publish'].includes(action) || (action === 'status' && rest.length) || (action === 'publish' && rest.length !== 2) || rest.some(x => x.length > 32000)) process.exitCode = 2;
else { let tries = 0; const run = () => { const socket = net.createConnection('/pr/broker.sock'); let out = ''; socket.setTimeout(90000); socket.on('connect', () => socket.write(JSON.stringify({ generation: ${JSON.stringify(generation)}, action, ...(action === 'publish' ? { title: rest[0], body: rest[1] } : {}) }) + '\\n')); socket.on('data', c => { out += c; if (out.length > 8192) socket.destroy(); }); socket.on('end', () => { try { const r = JSON.parse(out); process.stdout.write((r.message || 'Broker request failed') + '\\n'); process.exitCode = r.ok ? 0 : 1; } catch { process.exitCode = 1; } }); socket.on('error', () => { if (++tries < 20) setTimeout(run, 50); else process.exitCode = 1; }); }; run(); }
`; }
export type PullRequestBroker = { directory: string; target: PinnedPullRequestTarget; ready: Promise<void>; cleanup: () => Promise<void> };
function validPublish(request: Record<string, unknown>): request is { generation: string; action: "publish"; title: string; body: string } { return Object.keys(request).every((key) => key === "generation" || key === "action" || key === "title" || key === "body") && request.action === "publish" && typeof request.generation === "string" && typeof request.title === "string" && request.title.length > 0 && request.title.length <= PR_TITLE_LIMIT && !/[\0\r\n]/.test(request.title) && typeof request.body === "string" && request.body.length <= PR_BODY_LIMIT && !/\0/.test(request.body); }

export async function publishPullRequest(target: PinnedPullRequestTarget, policy: PullRequestsConfig, title: string, body: string, runner: BrokerRunner): Promise<BrokerResult> {
	// Do this before any checkout Git command: .git and its config are
	// worker-controlled paths after delegation.
	if (!sameMetadata(target.git, metadata(target.workspace))) return { ok: false, message: "Repository metadata no longer matches the delegated target." };
	const repinned = await pinPullRequestTarget(target.workspace, policy, runner);
	if (!repinned || repinned.workspace !== target.workspace || repinned.device !== target.device || repinned.inode !== target.inode || !sameMetadata(target.git, repinned.git) || repinned.repository !== target.repository || repinned.remoteUrl !== target.remoteUrl || repinned.defaultBranch !== target.defaultBranch) return { ok: false, message: "Repository state no longer matches the delegated target." };
	const branch = await currentAllowedBranch(target, policy, runner);
	if (!branch || (target.branch && target.branch !== branch)) return { ok: false, message: target.branch ? "The pinned branch changed." : "Switch to an allowed non-default branch before publishing." };
	const dirty = await git(runner, target.workspace, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none");
	if (!dirty.ok || dirty.stdout.trim()) return { ok: false, message: "Commit or remove all tracked and untracked changes before publishing." };
	const head = await line(runner, target.workspace, "rev-parse", "--verify", "HEAD^{commit}");
	if (!head || !/^[a-f0-9]{40,64}$/i.test(head)) return { ok: false, message: "A committed HEAD is required." };
	const tempParent = mkdtempSync(join(tmpdir(), "pio-pr-trusted-")), temp = join(tempParent, "view.git");
	try {
		// Clone is deliberately launched from a host-owned directory, never the
		// checkout: local file transport is the only protocol permitted here.
		const cloneEnv = { ...trustedEnv(process.env), ...GIT_ENV, GIT_ALLOW_PROTOCOL: "file", GIT_PROTOCOL_FROM_USER: "0" };
		if (!(await runner("git", gitArgs("-c", "protocol.file.allow=always", "-c", "protocol.ssh.allow=never", "-c", "protocol.http.allow=never", "-c", "protocol.https.allow=never", "clone", "--bare", "--no-local", "--no-hardlinks", target.workspace, temp), { cwd: tempParent, env: cloneEnv, timeout: 30_000 })).ok) return { ok: false, message: "Could not prepare a trusted Git view." };
		const trustedOptions = { cwd: temp, env: { ...trustedEnv(process.env), ...GIT_ENV }, timeout: 30_000 };
		const fetched = await runner("git", gitArgs("fetch", "--no-tags", target.remoteUrl, `refs/heads/${branch}:refs/remotes/pinned/${branch}`), trustedOptions);
		if (!fetched.ok) { const remote = await runner("git", gitArgs("ls-remote", "--heads", target.remoteUrl, `refs/heads/${branch}`), trustedOptions); if (!remote.ok) return { ok: false, message: "Could not verify the pinned branch." }; }
		else if (!(await runner("git", gitArgs("merge-base", "--is-ancestor", `refs/remotes/pinned/${branch}`, head), trustedOptions)).ok) return { ok: false, message: "The branch is not a fast-forward update." };
		// Recheck after all worker-controlled checkout reads, then pin before any
		// network mutation. A failed push/gh operation still permits only this branch.
		if ((await currentAllowedBranch(target, policy, runner)) !== branch) return { ok: false, message: "The branch changed during publishing." };
		target.branch ??= branch;
		if (!(await runner("git", gitArgs("push", "--porcelain", target.remoteUrl, `${head}:refs/heads/${branch}`), { cwd: temp, env: { ...trustedEnv(process.env), ...GIT_ENV }, timeout: 45_000 })).ok) return { ok: false, message: "Push was rejected." };
		const env = trustedEnv(process.env), owner = target.repository.split("/")[0]!, open = await runner("gh", ["pr", "list", `--repo=${target.repository}`, `--head=${owner}:${branch}`, "--state=open", "--json=number,headRefName,baseRefName,isCrossRepository,headRepository,headRepositoryOwner", "--limit=2"], { env, timeout: 30_000 });
		if (!open.ok || open.stdout.length > PR_RESPONSE_LIMIT) return { ok: false, message: "Could not query the existing pull request." };
		let number: number | undefined;
		try {
			const rows = JSON.parse(open.stdout) as unknown;
			if (!Array.isArray(rows)) return { ok: false, message: "Could not parse pull request status." };
			if (rows.length > 1) return { ok: false, message: "More than one open pull request matches this branch." };
			if (rows.length === 1) {
				const row = rows[0] as Record<string, unknown>;
				const repository = row.headRepository as { nameWithOwner?: unknown } | null;
				const repositoryOwner = row.headRepositoryOwner as { login?: unknown } | null;
				const headRepository = repository?.nameWithOwner, headOwner = repositoryOwner?.login;
				if (!row || typeof row !== "object" || !Number.isSafeInteger(row.number) || row.headRefName !== branch || row.baseRefName !== target.defaultBranch || row.isCrossRepository !== false || typeof headRepository !== "string" || typeof headOwner !== "string" || headRepository.toLowerCase() !== target.repository || headOwner.toLowerCase() !== owner.toLowerCase()) return { ok: false, message: "Existing pull request does not match the pinned branch and base." };
				number = row.number as number;
			}
		} catch { return { ok: false, message: "Could not parse pull request status." }; }
		const args = number ? ["pr", "edit", String(number), `--repo=${target.repository}`, `--title=${title}`, `--body=${body}`] : ["pr", "create", `--repo=${target.repository}`, `--base=${target.defaultBranch}`, `--head=${branch}`, `--title=${title}`, `--body=${body}`];
		if (!(await runner("gh", args, { env, timeout: 45_000 })).ok) return { ok: false, message: "Pull request create/update failed." };
		return { ok: true, message: number ? "Updated the open pull request." : "Created an open pull request.", repository: target.repository, branch, defaultBranch: target.defaultBranch };
	} finally { try { rmSync(tempParent, { recursive: true, force: true }); } catch {} }
}
async function brokerStatus(target: PinnedPullRequestTarget, policy: PullRequestsConfig, runner: BrokerRunner): Promise<BrokerResult> {
	if (target.branch) {
		const current = await line(runner, target.workspace, "symbolic-ref", "--quiet", "--short", "HEAD");
		return current === target.branch
			? { ok: true, message: `Ready for pinned branch ${target.branch}.`, repository: target.repository, branch: target.branch, defaultBranch: target.defaultBranch }
			: { ok: true, message: `Branch ${target.branch} is pinned, but the current branch does not match; publish will be rejected.`, repository: target.repository, branch: target.branch, defaultBranch: target.defaultBranch };
	}
	const branch = await currentAllowedBranch(target, policy, runner);
	return branch ? { ok: true, message: `No branch is pinned; ${branch} is eligible for first publish.`, repository: target.repository, branch, defaultBranch: target.defaultBranch } : { ok: true, message: "No branch is pinned; switch to an allowed non-default branch before publishing.", repository: target.repository, defaultBranch: target.defaultBranch };
}

export function startPullRequestBroker(target: PinnedPullRequestTarget, policy: PullRequestsConfig, runner: BrokerRunner = defaultRunner): PullRequestBroker {
	const directory = mkdtempSync(join(tmpdir(), "pio-pr-broker-")); chmodSync(directory, 0o700);
	const socketPath = join(directory, "broker.sock"), client = join(directory, "pio-pr"); writeFileSync(client, clientProgram(target.generation), { mode: 0o700 }); chmodSync(client, 0o700);
	let sockets = 0, requests = 0, publishing = false, closing = false, cleanupPromise: Promise<void> | undefined;
	const connections = new Set<net.Socket>(), handlers = new Set<Promise<void>>(), abort = new AbortController();
	const brokerRunner: BrokerRunner = async (command, args, options = {}) => {
		if (closing || abort.signal.aborted) return { ok: false, stdout: "" };
		const result = await runner(command, args, { ...options, signal: abort.signal });
		return closing || abort.signal.aborted ? { ok: false, stdout: "" } : result;
	};
	const server = net.createServer((socket) => {
		if (closing || ++sockets > PR_MAX_CONNECTIONS) { if (!closing) sockets--; socket.end(JSON.stringify({ ok: false, message: "Broker is unavailable." })); return; }
		connections.add(socket);
		let data = "", handled = false, timer = setTimeout(() => socket.destroy(), 20_000);
		const done = (result: BrokerResult) => { clearTimeout(timer); if (!socket.destroyed && !closing) { const body = JSON.stringify(result); socket.end(body.length <= PR_RESPONSE_LIMIT ? body : JSON.stringify({ ok: false, message: "Broker response was too large." })); } };
		socket.once("close", () => { sockets--; connections.delete(socket); clearTimeout(timer); });
		socket.on("data", (chunk) => {
			if (handled || closing) return; data += chunk.toString("utf8");
			if (data.length > PR_REQUEST_LIMIT) { handled = true; done({ ok: false, message: "Invalid broker request." }); return; }
			if (!data.endsWith("\n")) return; handled = true;
			if (++requests > PR_MAX_REQUESTS) { done({ ok: false, message: "Broker request limit reached." }); return; }
			const handler = (async () => {
				try {
					let request: Record<string, unknown> | undefined; try { request = JSON.parse(data) as Record<string, unknown>; } catch {}
					if (!request || request.generation !== target.generation) return done({ ok: false, message: "Broker generation is unavailable." });
					if (request.action === "status" && Object.keys(request).every((key) => key === "generation" || key === "action")) return done(await brokerStatus(target, policy, brokerRunner));
					if (!validPublish(request)) return done({ ok: false, message: "Unsupported broker request." });
					if (publishing) return done({ ok: false, message: "A publish is already in progress." });
					clearTimeout(timer); timer = setTimeout(() => socket.destroy(), 90_000);
					publishing = true; try { done(await publishPullRequest(target, policy, request.title, request.body, brokerRunner)); } finally { publishing = false; }
				} catch { done({ ok: false, message: "Broker operation failed." }); }
			})();
			handlers.add(handler); void handler.finally(() => handlers.delete(handler));
		});
	});
	const ready = new Promise<void>((resolve, reject) => server.once("listening", () => { try { chmodSync(socketPath, 0o600); resolve(); } catch (error) { reject(error); } }).once("error", reject));
	server.listen(socketPath);
	const cleanup = (): Promise<void> => cleanupPromise ??= (async () => {
		closing = true; abort.abort(); for (const socket of connections) socket.destroy();
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		// Default-runner children receive direct TERM then KILL through abort. An
		// injected runner is also gated after abort, so it cannot trigger later mutations.
		await Promise.race([Promise.allSettled([...handlers]).then(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 6_000))]);
		try { rmSync(directory, { recursive: true, force: true }); } catch {}
	})();
	// Observe readiness internally too: a late listen/chmod failure never becomes
	// an unhandled rejection and promptly removes broker authority.
	void ready.catch(() => cleanup());
	return { directory, target, ready, cleanup };
}
