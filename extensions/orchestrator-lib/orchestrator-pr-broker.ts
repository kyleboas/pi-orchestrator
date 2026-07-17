import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

/** The deliberately small opt-in authority delegated to a sandboxed worker. */
export type PullRequestsConfig = { repositories: string[]; branchPrefixes: string[] };
export type PinnedPullRequestTarget = { workspace: string; repository: string; remoteUrl: string; branch: string; defaultBranch: string; generation: string; device: number; inode: number };
export type BrokerResult = { ok: boolean; message: string; repository?: string; branch?: string; defaultBranch?: string };
export const PR_REQUEST_LIMIT = 16_384;
export const PR_RESPONSE_LIMIT = 8_192;
export const PR_TITLE_LIMIT = 256;
export const PR_BODY_LIMIT = 32_000;
const REPOSITORY = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d][a-z\d._-]{0,99}$/i;
const PREFIX = /^(?!.*(?:^|\/)\.?\.?\/(?:|$))(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,79}\/$/;
const BRANCH = /^(?!-)(?!.*(?:^|\/)\.?\.?\/(?:|$))(?!.*\.\.)(?!.*\/\/)(?!.*\.lock(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function text(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
}
function normalizedRepository(value: string): string | undefined {
	const candidate = value.trim().toLowerCase();
	return REPOSITORY.test(candidate) ? candidate : undefined;
}

/** Strict parser: a present malformed block means no broker, never a broadened policy. */
export function parsePullRequestsConfig(value: unknown): PullRequestsConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (Object.keys(raw).some((key) => key !== "repositories" && key !== "branchPrefixes")) return undefined;
	if (!Array.isArray(raw.repositories) || !Array.isArray(raw.branchPrefixes) || raw.repositories.length === 0 || raw.branchPrefixes.length === 0 || raw.repositories.length > 32 || raw.branchPrefixes.length > 32) return undefined;
	const repositories: string[] = [], branchPrefixes: string[] = [];
	const seenRepositories = new Set<string>(), seenPrefixes = new Set<string>();
	for (const value of raw.repositories) {
		if (!text(value, 140)) return undefined;
		const repository = normalizedRepository(value);
		if (!repository || seenRepositories.has(repository)) return undefined;
		seenRepositories.add(repository); repositories.push(repository);
	}
	for (const value of raw.branchPrefixes) {
		if (!text(value, 81)) return undefined;
		const prefix = value.trim();
		if (!PREFIX.test(prefix) || seenPrefixes.has(prefix.toLowerCase())) return undefined;
		seenPrefixes.add(prefix.toLowerCase()); branchPrefixes.push(prefix);
	}
	return { repositories, branchPrefixes };
}

/** Accept only canonical GitHub HTTPS/SSH origin forms; no userinfo, ports, paths, or remotes. */
export function normalizeGitHubRemote(value: string): { repository: string; remoteUrl: string } | undefined {
	const raw = value.trim();
	let match = /^git@github\.com:([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw)
		?? /^ssh:\/\/git@github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw);
	if (!match) {
		try {
			const url = new URL(raw);
			if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return undefined;
			match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url.pathname);
		} catch { return undefined; }
	}
	if (!match) return undefined;
	const repository = normalizedRepository(`${match[1]}/${match[2]}`);
	return repository ? { repository, remoteUrl: `git@github.com:${repository}.git` } : undefined;
}

export function branchAllowed(branch: string, config: PullRequestsConfig, defaultBranch?: string): boolean {
	return BRANCH.test(branch) && branch !== defaultBranch && config.branchPrefixes.some((prefix) => branch.startsWith(prefix));
}

type CommandResult = { ok: boolean; stdout: string };
export type BrokerRunner = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }) => Promise<CommandResult>;
function trustedEnv(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	// gh normally reads its host config from HOME. Tokens are intentionally not
	// inherited: only the trusted process may use config/SSH-agent authentication.
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_SSH_COMMAND"]) if (host[key] !== undefined) env[key] = host[key];
	return env;
}
function defaultRunner(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<CommandResult> {
	return new Promise((resolve) => {
		let output = "", done = false;
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
		const finish = (ok: boolean) => { if (!done) { done = true; resolve({ ok, stdout: output.slice(0, PR_RESPONSE_LIMIT) }); } };
		const timer = setTimeout(() => { child.kill("SIGTERM"); finish(false); }, options.timeout ?? 30_000);
		child.stdout.on("data", (chunk: Buffer) => { if (output.length < PR_RESPONSE_LIMIT) output += chunk.toString("utf8").slice(0, PR_RESPONSE_LIMIT - output.length); });
		// stderr can contain remote/auth diagnostics. Deliberately neither retain nor return it.
		child.on("error", () => { clearTimeout(timer); finish(false); });
		child.on("exit", (code) => { clearTimeout(timer); finish(code === 0); });
	});
}
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" };
function gitArgs(...args: string[]): string[] { return ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", ...args]; }

async function git(runner: BrokerRunner, cwd: string, ...args: string[]): Promise<CommandResult> {
	return runner("git", gitArgs(...args), { cwd, env: { ...trustedEnv(process.env), ...GIT_ENV }, timeout: 30_000 });
}
async function line(runner: BrokerRunner, cwd: string, ...args: string[]): Promise<string | undefined> {
	const result = await git(runner, cwd, ...args);
	const value = result.stdout.trim();
	return result.ok && value && value.length <= 512 && !/[\0\r\n]/.test(value) ? value : undefined;
}

/** Pin all policy-relevant git facts before a worker can alter the checkout. */
export function pinPullRequestTargetSync(cwd: string, policy: PullRequestsConfig): PinnedPullRequestTarget | undefined {
	let workspace: string, identity: ReturnType<typeof statSync>;
	try { workspace = realpathSync(cwd); identity = statSync(workspace); if (!identity.isDirectory() || lstatSync(cwd).isSymbolicLink()) return undefined; } catch { return undefined; }
	const get = (...args: string[]): string | undefined => { try { const result = spawnSync("git", gitArgs(...args), { cwd: workspace, env: { ...trustedEnv(process.env), ...GIT_ENV }, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, encoding: "utf8" }); const value = result.status === 0 ? (result.stdout ?? "").trim() : ""; return value && value.length <= 512 && !/[\0\r\n]/.test(value) ? value : undefined; } catch { return undefined; } };
	if (get("rev-parse", "--is-inside-work-tree") !== "true") return undefined;
	const top = get("rev-parse", "--show-toplevel"), remote = get("remote", "get-url", "origin"), branch = get("symbolic-ref", "--quiet", "--short", "HEAD"), defaultRef = get("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
	const parsed = remote && normalizeGitHubRemote(remote), defaultBranch = defaultRef?.startsWith("origin/") ? defaultRef.slice("origin/".length) : undefined;
	if (top !== workspace || !parsed || !branch || !defaultBranch || !BRANCH.test(defaultBranch) || !policy.repositories.includes(parsed.repository) || !branchAllowed(branch, policy, defaultBranch)) return undefined;
	return { workspace, repository: parsed.repository, remoteUrl: parsed.remoteUrl, branch, defaultBranch, generation: randomUUID(), device: identity.dev, inode: identity.ino };
}

export async function pinPullRequestTarget(cwd: string, policy: PullRequestsConfig, runner: BrokerRunner = defaultRunner): Promise<PinnedPullRequestTarget | undefined> {
	let workspace: string, identity: ReturnType<typeof statSync>;
	try { workspace = realpathSync(cwd); identity = statSync(workspace); if (!identity.isDirectory() || lstatSync(cwd).isSymbolicLink()) return undefined; } catch { return undefined; }
	if ((await line(runner, workspace, "rev-parse", "--is-inside-work-tree")) !== "true") return undefined;
	const top = await line(runner, workspace, "rev-parse", "--show-toplevel");
	if (top !== workspace) return undefined;
	const remote = await line(runner, workspace, "remote", "get-url", "origin");
	const parsed = remote && normalizeGitHubRemote(remote);
	const branch = await line(runner, workspace, "symbolic-ref", "--quiet", "--short", "HEAD");
	const defaultRef = await line(runner, workspace, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
	const defaultBranch = defaultRef?.startsWith("origin/") ? defaultRef.slice("origin/".length) : undefined;
	if (!parsed || !branch || !defaultBranch || !BRANCH.test(defaultBranch) || !policy.repositories.includes(parsed.repository) || !branchAllowed(branch, policy, defaultBranch)) return undefined;
	return { workspace, repository: parsed.repository, remoteUrl: parsed.remoteUrl, branch, defaultBranch, generation: randomUUID(), device: identity.dev, inode: identity.ino };
}

function clientProgram(generation: string): string {
	return `#!/usr/bin/env node
import net from "node:net";
const [action, ...rest] = process.argv.slice(2);
if (!['status','publish'].includes(action) || (action === 'status' && rest.length) || (action === 'publish' && rest.length !== 2) || rest.some(x => x.length > 32000)) process.exitCode = 2;
else { const socket = net.createConnection('/pr/broker.sock'); let out = ''; const request = JSON.stringify({ generation: ${JSON.stringify(generation)}, action, ...(action === 'publish' ? { title: rest[0], body: rest[1] } : {}) }) + '\\n'; socket.setTimeout(35000); socket.on('connect', () => socket.write(request)); socket.on('data', c => { out += c; if (out.length > 8192) socket.destroy(); }); socket.on('end', () => { try { const r = JSON.parse(out); process.stdout.write((r.message || 'Broker request failed') + '\\n'); process.exitCode = r.ok ? 0 : 1; } catch { process.exitCode = 1; } }); socket.on('error', () => { process.exitCode = 1; }); }
`;
}

export type PullRequestBroker = { directory: string; target: PinnedPullRequestTarget; ready: Promise<void>; cleanup: () => Promise<void> };
function validPublish(request: Record<string, unknown>): request is { generation: string; action: "publish"; title: string; body: string } {
	return Object.keys(request).every((key) => key === "generation" || key === "action" || key === "title" || key === "body") && request.action === "publish" && typeof request.generation === "string" && typeof request.title === "string" && request.title.length > 0 && request.title.length <= PR_TITLE_LIMIT && !/[\0\r\n]/.test(request.title) && typeof request.body === "string" && request.body.length <= PR_BODY_LIMIT && !/\0/.test(request.body);
}

export async function publishPullRequest(target: PinnedPullRequestTarget, policy: PullRequestsConfig, title: string, body: string, runner: BrokerRunner): Promise<BrokerResult> {
	const repinned = await pinPullRequestTarget(target.workspace, policy, runner);
	if (!repinned || repinned.workspace !== target.workspace || repinned.device !== target.device || repinned.inode !== target.inode || repinned.repository !== target.repository || repinned.remoteUrl !== target.remoteUrl || repinned.branch !== target.branch || repinned.defaultBranch !== target.defaultBranch) return { ok: false, message: "Repository state no longer matches the delegated target." };
	const dirty = await git(runner, target.workspace, "status", "--porcelain=v1", "--untracked-files=all");
	if (!dirty.ok || dirty.stdout.trim()) return { ok: false, message: "Commit or remove all tracked and untracked changes before publishing." };
	const head = await line(runner, target.workspace, "rev-parse", "--verify", "HEAD^{commit}");
	if (!head || !/^[a-f0-9]{40,64}$/i.test(head)) return { ok: false, message: "A committed HEAD is required." };
	const temp = mkdtempSync(join(tmpdir(), "pio-pr-bare-"));
	try {
		// This bare clone receives objects but never uses the worker checkout's
		// remote/config/hooks to push. Every network operation uses remoteUrl.
		if (!(await runner("git", gitArgs("clone", "--bare", "--no-local", "--no-hardlinks", target.workspace, temp), { env: { ...trustedEnv(process.env), ...GIT_ENV }, timeout: 30_000 })).ok) return { ok: false, message: "Could not prepare a trusted Git view." };
		const fetched = await runner("git", gitArgs("-C", temp, "fetch", "--no-tags", target.remoteUrl, `refs/heads/${target.branch}:refs/remotes/pinned/${target.branch}`), { env: { ...trustedEnv(process.env), ...GIT_ENV }, timeout: 30_000 });
		// A missing remote branch is allowed; any other fetch failure is not.
		if (!fetched.ok) {
			const remote = await runner("git", gitArgs("ls-remote", "--heads", target.remoteUrl, `refs/heads/${target.branch}`), { env: { ...trustedEnv(process.env), ...GIT_ENV }, timeout: 30_000 });
			if (!remote.ok) return { ok: false, message: "Could not verify the pinned branch." };
		} else {
			const ancestor = await runner("git", gitArgs("-C", temp, "merge-base", "--is-ancestor", `refs/remotes/pinned/${target.branch}`, head), { env: { ...trustedEnv(process.env), ...GIT_ENV }, timeout: 30_000 });
			if (!ancestor.ok) return { ok: false, message: "The branch is not a fast-forward update." };
		}
		if (!(await runner("git", gitArgs("-C", temp, "push", "--porcelain", target.remoteUrl, `${head}:refs/heads/${target.branch}`), { env: { ...trustedEnv(process.env), ...GIT_ENV }, timeout: 45_000 })).ok) return { ok: false, message: "Push was rejected." };
		const env = trustedEnv(process.env);
		const open = await runner("gh", ["pr", "list", "--repo", target.repository, "--head", target.branch, "--state", "open", "--json", "number", "--limit", "2"], { env, timeout: 30_000 });
		if (!open.ok || open.stdout.length > PR_RESPONSE_LIMIT) return { ok: false, message: "Could not query the existing pull request." };
		let number: number | undefined;
		try { const rows = JSON.parse(open.stdout) as unknown; if (Array.isArray(rows) && rows.length === 1 && typeof rows[0] === "object" && rows[0] && Number.isSafeInteger((rows[0] as { number?: unknown }).number)) number = (rows[0] as { number: number }).number; else if (Array.isArray(rows) && rows.length > 1) return { ok: false, message: "More than one open pull request matches this branch." }; } catch { return { ok: false, message: "Could not parse pull request status." }; }
		const ghArgs = number
			? ["pr", "edit", String(number), `--repo=${target.repository}`, `--title=${title}`, `--body=${body}`]
			: ["pr", "create", `--repo=${target.repository}`, `--base=${target.defaultBranch}`, `--head=${target.branch}`, `--title=${title}`, `--body=${body}`];
		if (!(await runner("gh", ghArgs, { env, timeout: 45_000 })).ok) return { ok: false, message: "Pull request create/update failed." };
		return { ok: true, message: number ? "Updated the open pull request." : "Created an open pull request.", repository: target.repository, branch: target.branch, defaultBranch: target.defaultBranch };
	} finally { try { rmSync(temp, { recursive: true, force: true }); } catch {} }
}

export function startPullRequestBroker(target: PinnedPullRequestTarget, policy: PullRequestsConfig, runner: BrokerRunner = defaultRunner): PullRequestBroker {
	const directory = mkdtempSync(join(tmpdir(), "pio-pr-broker-")); chmodSync(directory, 0o700);
	const socketPath = join(directory, "broker.sock"), client = join(directory, "pio-pr");
	writeFileSync(client, clientProgram(target.generation), { mode: 0o700 }); chmodSync(client, 0o700);
	const server = net.createServer((socket) => {
		let data = "";
		socket.setTimeout(50_000);
		socket.on("data", (chunk) => { data += chunk.toString("utf8"); if (data.length > PR_REQUEST_LIMIT || !data.endsWith("\n")) { if (data.length > PR_REQUEST_LIMIT) socket.end(JSON.stringify({ ok: false, message: "Invalid broker request." })); return; }
			void (async () => { let request: Record<string, unknown> | undefined; try { request = JSON.parse(data) as Record<string, unknown>; } catch {} let result: BrokerResult;
				if (!request || request.generation !== target.generation) result = { ok: false, message: "Broker generation is unavailable." };
				else if (request.action === "status" && Object.keys(request).every((key) => key === "generation" || key === "action")) result = { ok: true, message: `Ready for ${target.repository} ${target.branch}.`, repository: target.repository, branch: target.branch, defaultBranch: target.defaultBranch };
				else if (validPublish(request)) result = await publishPullRequest(target, policy, request.title, request.body, runner);
				else result = { ok: false, message: "Unsupported broker request." };
				const body = JSON.stringify(result); socket.end(body.length <= PR_RESPONSE_LIMIT ? body : JSON.stringify({ ok: false, message: "Broker response was too large." })); })();
		});
		socket.on("timeout", () => socket.destroy());
	});
	const ready = new Promise<void>((resolve, reject) => server.once("listening", () => { try { chmodSync(socketPath, 0o600); resolve(); } catch (error) { reject(error); } }).once("error", reject));
	server.listen(socketPath); // The client retries through normal socket scheduling; ready is exposed for lifecycle tests/callers.
	return { directory, target, ready, cleanup: async () => { if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); try { rmSync(directory, { recursive: true, force: true }); } catch {} } };
}
