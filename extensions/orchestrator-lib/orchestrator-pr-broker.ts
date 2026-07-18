import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

/** The deliberately small opt-in authority delegated to a sandboxed worker. */
export type PullRequestsConfig = { repositories: string[]; branchPrefixes: string[] };
/** `branch` is deliberately absent until the first successful publish. */
type PinnedFileState = { path: string; device: number; inode: number; hash: string };
type GitMetadata = { entryDevice: number; entryInode: number; gitDir: string; objectsDevice: number; objectsInode: number; objectInfoDevice: number; objectInfoInode: number; files: PinnedFileState[] };
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
	for (const value of raw.branchPrefixes) { if (!text(value, 81)) return undefined; const prefix = value.trim(); if ((prefix !== "*" && !PREFIX.test(prefix)) || seenPrefixes.has(prefix.toLowerCase())) return undefined; seenPrefixes.add(prefix.toLowerCase()); branchPrefixes.push(prefix); }
	return { repositories, branchPrefixes };
}

/** Accept only canonical GitHub HTTPS/SSH origin forms; never a user-selected remote. */
export function normalizeGitHubRemote(value: string): { repository: string; remoteUrl: string } | undefined {
	const raw = value.trim();
	let match = /^git@github\.com:([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw) ?? /^ssh:\/\/git@github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw);
	if (!match) try { const url = new URL(raw); if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return undefined; match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url.pathname); } catch { return undefined; }
	if (!match) return undefined;
	const repository = normalizedRepository(`${match[1]}/${match[2]}`);
	return repository ? { repository, remoteUrl: `https://github.com/${repository}.git` } : undefined;
}
export function branchAllowed(branch: string, config: PullRequestsConfig, defaultBranch?: string): boolean { return BRANCH.test(branch) && branch !== defaultBranch && config.branchPrefixes.some((prefix) => prefix === "*" || branch.startsWith(prefix)); }

function trustedEnv(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	// gh reads its host login from HOME. Deliberately retain no SSH or Git
	// transport state, and never inherit token-shaped environment variables.
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM"]) if (host[key] !== undefined) env[key] = host[key];
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
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_PAGER: "cat" };
const ASKPASS_SOURCE = `import { spawnSync } from "node:child_process";
const prompt = process.argv[2];
if (prompt === "Username for 'https://github.com': ") process.stdout.write("x-access-token\\n");
else if (prompt === "Password for 'https://x-access-token@github.com': ") {
  const result = spawnSync("gh", ["auth", "token", "--hostname", "github.com"], { shell: false, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 10000, maxBuffer: 1025 });
  const output = typeof result.stdout === "string" ? result.stdout : "";
  const match = result.status === 0 && !result.error && !result.signal && /^([A-Za-z0-9_]{1,512})\\n?$/.exec(output);
  if (!match) process.exit(1);
  else process.stdout.write(match[1] + "\\n");
} else process.exit(1);
`;
function createAskpass(tempParent: string): string {
	const path = join(tempParent, "git-askpass");
	// Use this process's resolved Node binary rather than PATH in the shebang.
	writeFileSync(path, `#!${process.execPath}\n${ASKPASS_SOURCE}`, { mode: 0o700 });
	chmodSync(path, 0o700);
	return path;
}
function trustedBareConfig(head: string): string {
	return head.length === 64
		? "[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectformat = sha256\n"
		: "[core]\n\trepositoryformatversion = 0\n\tbare = true\n";
}
function replaceTrustedCloneConfig(gitDir: string, head: string): boolean {
	try {
		const config = trustedBareConfig(head), destination = join(gitDir, "config"), replacement = join(gitDir, "config.broker-new");
		writeFileSync(replacement, config, { mode: 0o600 }); chmodSync(replacement, 0o600);
		renameSync(replacement, destination);
		return trustedCloneSafe(gitDir, config);
	} catch { return false; }
}
function networkGitOptions(cwd: string, askpass: string): { cwd: string; env: NodeJS.ProcessEnv; timeout: number } {
	return { cwd, env: { ...trustedEnv(process.env), ...GIT_ENV, GIT_ALLOW_PROTOCOL: "https", GIT_PROTOCOL_FROM_USER: "0", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: askpass }, timeout: 30_000 };
}
function networkGitArgs(...args: string[]): string[] { return gitArgs("-c", "credential.helper=", ...args); }
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
		const objects = join(gitDir, "objects"), objectsStat = lstatSync(objects), objectInfo = join(objects, "info"), objectInfoStat = lstatSync(objectInfo);
		if (!objectsStat.isDirectory() || objectsStat.isSymbolicLink() || !objectInfoStat.isDirectory() || objectInfoStat.isSymbolicLink()) return undefined;
		const state = (path: string, required: boolean, rejectIncludes = false): PinnedFileState => {
			try {
				const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe repository metadata");
				const contents = readFileSync(path);
				if (rejectIncludes && /^\s*\[include(?:If)?\b/im.test(contents.toString("utf8"))) throw new Error("included config is not permitted");
				return { path, device: stat.dev, inode: stat.ino, hash: createHash("sha256").update(contents).digest("hex") };
			} catch (error) {
				if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return { path, device: -1, inode: -1, hash: "absent" };
				throw error;
			}
		};
		const absent = (path: string): PinnedFileState => { const value = state(path, false); if (value.hash !== "absent") throw new Error("object alternates are not permitted"); return value; };
		const files = [state(join(gitDir, "config"), true, true), absent(join(objectInfo, "alternates")), absent(join(objectInfo, "http-alternates"))];
		return { entryDevice: entryStat.dev, entryInode: entryStat.ino, gitDir, objectsDevice: objectsStat.dev, objectsInode: objectsStat.ino, objectInfoDevice: objectInfoStat.dev, objectInfoInode: objectInfoStat.ino, files };
	} catch { return undefined; }
}
function identity(cwd: string): { workspace: string; device: number; inode: number; git?: GitMetadata } | undefined { try { const workspace = realpathSync(cwd), stat = statSync(workspace), git = metadata(workspace); return stat.isDirectory() && !lstatSync(cwd).isSymbolicLink() ? { workspace, device: stat.dev, inode: stat.ino, ...(git ? { git } : {}) } : undefined; } catch { return undefined; } }
/** Test-only inspection helper; production eligibility always obtains this through pinPullRequestTarget. */
export function gitMetadataForTesting(workspace: string): GitMetadata | undefined { return metadata(workspace); }
function sameMetadata(left: GitMetadata, right: GitMetadata | undefined): boolean { return !!right && left.entryDevice === right.entryDevice && left.entryInode === right.entryInode && left.gitDir === right.gitDir && left.objectsDevice === right.objectsDevice && left.objectsInode === right.objectsInode && left.objectInfoDevice === right.objectInfoDevice && left.objectInfoInode === right.objectInfoInode && left.files.length === right.files.length && left.files.every((file, index) => file.path === right.files[index]?.path && file.device === right.files[index]?.device && file.inode === right.files[index]?.inode && file.hash === right.files[index]?.hash); }
function trustedCloneSafe(gitDir: string, expectedConfig?: string): boolean {
	try {
		const configPath = join(gitDir, "config"), config = lstatSync(configPath), objects = join(gitDir, "objects"), objectStat = lstatSync(objects);
		if (!config.isFile() || config.isSymbolicLink() || (expectedConfig !== undefined && readFileSync(configPath, "utf8") !== expectedConfig) || !objectStat.isDirectory() || objectStat.isSymbolicLink()) return false;
		const safeTree = (path: string): boolean => {
			for (const name of readdirSync(path)) {
				const child = join(path, name), stat = lstatSync(child);
				if (stat.isSymbolicLink()) return false;
				if (stat.isDirectory()) { if (!safeTree(child)) return false; }
				else if (!stat.isFile()) return false;
			}
			return true;
		};
		if (!safeTree(objects)) return false;
		for (const name of ["alternates", "http-alternates"]) try { lstatSync(join(objects, "info", name)); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
		return true;
	} catch { return false; }
}
function defaultBranchArgs(repository: string): string[] { return ["api", "--method=GET", `repos/${repository}`, "--jq=.default_branch"]; }
function syncDefaultBranch(repository: string): string | undefined {
	try {
		const result = spawnSync("gh", defaultBranchArgs(repository), { shell: false, env: trustedEnv(process.env), stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 15_000, maxBuffer: PR_RESPONSE_LIMIT });
		const branch = result.status === 0 && !result.error && !result.signal ? (result.stdout ?? "").trim() : "";
		return BRANCH.test(branch) ? branch : undefined;
	} catch { return undefined; }
}
async function resolveDefaultBranch(repository: string, runner: BrokerRunner): Promise<string | undefined> {
	const result = await runner("gh", defaultBranchArgs(repository), { env: trustedEnv(process.env), timeout: 15_000 });
	const branch = result.ok && result.stdout.length <= PR_RESPONSE_LIMIT ? result.stdout.trim() : "";
	return BRANCH.test(branch) ? branch : undefined;
}

/** Pin workspace identity, exact origin and default branch before worker code. Branch is intentionally deferred. */
export function pinPullRequestTargetSync(cwd: string, policy: PullRequestsConfig): PinnedPullRequestTarget | undefined {
	const file = identity(cwd); if (!file || !file.git) return undefined;
	const get = (...args: string[]): string | undefined => { try { const result = spawnSync("git", gitArgs(...args), { cwd: file.workspace, env: { ...trustedEnv(process.env), ...GIT_ENV }, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, encoding: "utf8", maxBuffer: PR_RESPONSE_LIMIT }); const value = result.status === 0 ? (result.stdout ?? "").trim() : ""; return value && value.length <= 512 && !/[\0\r\n]/.test(value) ? value : undefined; } catch { return undefined; } };
	if (get("rev-parse", "--is-inside-work-tree") !== "true" || get("rev-parse", "--show-toplevel") !== file.workspace) return undefined;
	const remote = get("remote", "get-url", "origin"), parsed = remote && normalizeGitHubRemote(remote);
	if (!parsed || !policy.repositories.includes(parsed.repository)) return undefined;
	const defaultBranch = syncDefaultBranch(parsed.repository);
	return defaultBranch ? { ...file, git: file.git, repository: parsed.repository, remoteUrl: parsed.remoteUrl, defaultBranch, generation: randomUUID() } : undefined;
}
export async function pinPullRequestTarget(cwd: string, policy: PullRequestsConfig, runner: BrokerRunner = defaultRunner): Promise<PinnedPullRequestTarget | undefined> {
	const file = identity(cwd); if (!file || !file.git || (await line(runner, file.workspace, "rev-parse", "--is-inside-work-tree")) !== "true" || (await line(runner, file.workspace, "rev-parse", "--show-toplevel")) !== file.workspace) return undefined;
	const remote = await line(runner, file.workspace, "remote", "get-url", "origin"), parsed = remote && normalizeGitHubRemote(remote);
	if (!parsed || !policy.repositories.includes(parsed.repository)) return undefined;
	const defaultBranch = await resolveDefaultBranch(parsed.repository, runner);
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
type OpenPullRequest = { kind: "none" } | { kind: "one"; number: number } | { kind: "error"; message: string };

// Project only the identity fields required below. Null/deleted head repositories
// remain null-valued and are rejected by the same strict validation.
const OPEN_PULL_REQUEST_JQ = "[.[] | {number: .number, headRefName: .head.ref, baseRefName: .base.ref, isCrossRepository: (.head.repo.full_name != .base.repo.full_name), headRepository: {nameWithOwner: .head.repo.full_name}, headRepositoryOwner: {login: .head.repo.owner.login}}]";
/** gh 2.45 has incompatible PR-list JSON; REST is both stable and explicitly query-encoded. */
async function findOpenPullRequest(target: PinnedPullRequestTarget, branch: string, runner: BrokerRunner, env: NodeJS.ProcessEnv): Promise<OpenPullRequest> {
	const owner = target.repository.split("/")[0]!;
	const open = await runner("gh", ["api", "--method=GET", `repos/${target.repository}/pulls`, "--raw-field=state=open", `--raw-field=head=${owner}:${branch}`, `--raw-field=base=${target.defaultBranch}`, "--raw-field=per_page=2", `--jq=${OPEN_PULL_REQUEST_JQ}`], { env, timeout: 30_000 });
	if (!open.ok || open.stdout.length > PR_RESPONSE_LIMIT) return { kind: "error", message: "Could not query the existing pull request." };
	try {
		const rows = JSON.parse(open.stdout) as unknown;
		if (!Array.isArray(rows)) return { kind: "error", message: "Could not parse pull request status." };
		if (rows.length > 1) return { kind: "error", message: "More than one open pull request matches this branch." };
		if (!rows.length) return { kind: "none" };
		const row = rows[0];
		if (!row || typeof row !== "object") return { kind: "error", message: "Existing pull request does not match the pinned branch and base." };
		const value = row as Record<string, unknown>, repository = value.headRepository as { nameWithOwner?: unknown } | null, repositoryOwner = value.headRepositoryOwner as { login?: unknown } | null;
		const headRepository = repository?.nameWithOwner, headOwner = repositoryOwner?.login;
		if (typeof value.number !== "number" || !Number.isSafeInteger(value.number) || value.number <= 0 || value.headRefName !== branch || value.baseRefName !== target.defaultBranch || value.isCrossRepository !== false || typeof headRepository !== "string" || typeof headOwner !== "string" || headRepository.toLowerCase() !== target.repository || headOwner.toLowerCase() !== owner.toLowerCase()) return { kind: "error", message: "Existing pull request does not match the pinned branch and base." };
		return { kind: "one", number: value.number };
	} catch { return { kind: "error", message: "Could not parse pull request status." }; }
}
function createdPullRequestUrl(repository: string, output: string): string | undefined {
	const match = /^https:\/\/github\.com\/([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d][a-z\d._-]{0,99})\/pull\/([1-9]\d*)\n?$/.exec(output);
	return match && match[1] === repository ? output.endsWith("\n") ? output.slice(0, -1) : output : undefined;
}

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
	if (!head || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) return { ok: false, message: "A committed HEAD is required." };
	const tempParent = mkdtempSync(join(tmpdir(), "pio-pr-trusted-")), temp = join(tempParent, "view.git");
	chmodSync(tempParent, 0o700);
	try {
		// Recheck immediately before snapshotting. A local no-hardlinks clone copies
		// repository files directly; unlike file:// transport, it never invokes a
		// worker-configured upload-pack service.
		if (!sameMetadata(target.git, metadata(target.workspace))) return { ok: false, message: "Repository metadata no longer matches the delegated target." };
		const cloneEnv = { ...trustedEnv(process.env), ...GIT_ENV, GIT_ALLOW_PROTOCOL: "file", GIT_PROTOCOL_FROM_USER: "0" };
		if (!(await runner("git", gitArgs("-c", "protocol.file.allow=always", "-c", "protocol.ssh.allow=never", "-c", "protocol.http.allow=never", "-c", "protocol.https.allow=never", "clone", "--bare", "--local", "--no-hardlinks", target.workspace, temp), { cwd: tempParent, env: cloneEnv, timeout: 30_000 })).ok || !trustedCloneSafe(temp)) return { ok: false, message: "Could not prepare a trusted Git view." };
		// The snapshot copied worker-controlled config. Replace it before a network
		// command so URL rewrites, credential helpers, proxies, TLS settings, and
		// askpass hooks cannot influence authenticated Git.
		if (!replaceTrustedCloneConfig(temp, head)) return { ok: false, message: "Could not prepare a trusted Git view." };
		const localTrustedOptions = { cwd: temp, env: { ...trustedEnv(process.env), ...GIT_ENV }, timeout: 30_000 };
		if (!(await runner("git", gitArgs("cat-file", "-e", `${head}^{commit}`), localTrustedOptions)).ok) return { ok: false, message: "Could not prepare a trusted Git view." };
		const trustedOptions = networkGitOptions(temp, createAskpass(tempParent));
		const fetched = await runner("git", networkGitArgs("fetch", "--no-tags", target.remoteUrl, `refs/heads/${branch}:refs/remotes/pinned/${branch}`), trustedOptions);
		if (!fetched.ok) { const remote = await runner("git", networkGitArgs("ls-remote", "--heads", target.remoteUrl, `refs/heads/${branch}`), trustedOptions); if (!remote.ok) return { ok: false, message: "Could not verify the pinned branch." }; }
		else if (!(await runner("git", gitArgs("merge-base", "--is-ancestor", `refs/remotes/pinned/${branch}`, head), localTrustedOptions)).ok) return { ok: false, message: "The branch is not a fast-forward update." };
		// Recheck after all worker-controlled checkout reads, then pin before any
		// network mutation. A failed push/gh operation still permits only this branch.
		if ((await currentAllowedBranch(target, policy, runner)) !== branch) return { ok: false, message: "The branch changed during publishing." };
		target.branch ??= branch;
		if (!(await runner("git", networkGitArgs("push", "--porcelain", target.remoteUrl, `${head}:refs/heads/${branch}`), { ...trustedOptions, timeout: 45_000 })).ok) return { ok: false, message: "Push was rejected." };
		const env = trustedEnv(process.env), existing = await findOpenPullRequest(target, branch, runner, env);
		if (existing.kind === "error") return { ok: false, message: existing.message };
		const update = async (number: number): Promise<boolean> => (await runner("gh", ["api", "--method=PATCH", `repos/${target.repository}/pulls/${number}`, `--raw-field=title=${title}`, `--raw-field=body=${body}`, "--silent"], { env, timeout: 45_000 })).ok;
		if (existing.kind === "one") {
			if (!(await update(existing.number))) return { ok: false, message: "Pull request create/update failed." };
			return { ok: true, message: "Updated the open pull request.", repository: target.repository, branch, defaultBranch: target.defaultBranch };
		}
		const created = await runner("gh", ["api", "--method=POST", `repos/${target.repository}/pulls`, `--raw-field=title=${title}`, `--raw-field=body=${body}`, `--raw-field=head=${branch}`, `--raw-field=base=${target.defaultBranch}`, "--jq=.html_url"], { env, timeout: 45_000 });
		const url = created.ok ? createdPullRequestUrl(target.repository, created.stdout) : undefined;
		if (url) return { ok: true, message: `Created an open pull request: ${url}`, repository: target.repository, branch, defaultBranch: target.defaultBranch };
		// A POST can have succeeded remotely despite a local failure. Query once and
		// update only a freshly revalidated exact match; never repeat the POST.
		const raced = await findOpenPullRequest(target, branch, runner, env);
		if (raced.kind === "one" && await update(raced.number)) return { ok: true, message: "Updated the open pull request.", repository: target.repository, branch, defaultBranch: target.defaultBranch };
		return { ok: false, message: "Pull request create/update failed." };
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
