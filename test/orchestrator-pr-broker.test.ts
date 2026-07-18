import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import net from "node:net";
import test from "node:test";
import {
	branchAllowed,
	gitMetadataForTesting,
	normalizeGitHubRemote,
	parsePullRequestsConfig,
	repositoryAllowed,
	PR_MAX_REQUESTS,
	PR_REQUEST_LIMIT,
	PR_RESPONSE_LIMIT,
	pinPullRequestTarget,
	pinPullRequestTargetSync,
	publishPullRequest,
	startPullRequestBroker,
	type PinnedPullRequestTarget,
} from "../extensions/orchestrator-lib/orchestrator-pr-broker.ts";

const policy = { repositories: ["owner/repository"], branchPrefixes: ["feat/", "fix/"] };

function gitCommand(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

/** A genuine repository with no network access: origin and origin/HEAD are local refs. */
function gitWorkspace(prefix: string): string {
	const workspace = mkdtempSync(join(tmpdir(), prefix));
	gitCommand(workspace, ["init", "--initial-branch=main"]);
	gitCommand(workspace, ["config", "user.name", "PR Broker Test"]);
	gitCommand(workspace, ["config", "user.email", "broker@example.invalid"]);
	writeFileSync(join(workspace, "tracked.txt"), "initial\n");
	gitCommand(workspace, ["add", "tracked.txt"]);
	gitCommand(workspace, ["commit", "-m", "initial"]);
	gitCommand(workspace, ["remote", "add", "origin", "git@github.com:owner/repository.git"]);
	gitCommand(workspace, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
	gitCommand(workspace, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
	return workspace;
}

function actualRunner(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
	const result = spawnSync(command, args, { cwd: options.cwd, env: options.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	return Promise.resolve({ ok: result.status === 0, stdout: result.stdout ?? "" });
}

function trustedPinRunner(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
	if (command === "gh" && args.join("\0") === "api\0--method=GET\0repos/owner/repository\0--jq=.default_branch") return Promise.resolve({ ok: true, stdout: "main\n" });
	return actualRunner(command, args, options);
}

/** Minimal destination for pure protocol tests whose injected runner fakes clone. */
function fakeTrustedClone(args: string[]): void {
	if (!args.includes("clone")) return;
	const destination = args.at(-1)!;
	mkdirSync(join(destination, "objects", "info"), { recursive: true });
	writeFileSync(join(destination, "config"), "[core]\n\tbare = true\n");
}

function request(path: string, value: unknown): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(path); let output = "";
		socket.on("connect", () => socket.write(`${JSON.stringify(value)}\n`));
		socket.on("data", (chunk) => { output += chunk.toString("utf8"); });
		socket.on("end", () => { try { resolve(JSON.parse(output) as Record<string, unknown>); } catch { resolve({ ok: false }); } });
		socket.on("error", reject);
	});
}

test("PR policy is opt-in, bounded, normalized, and fails closed", () => {
	assert.deepEqual(parsePullRequestsConfig({ repositories: ["Owner/Repository"], branchPrefixes: ["feat/"] }), { repositories: ["owner/repository"], branchPrefixes: ["feat/"] });
	for (const value of [undefined, {}, { repositories: ["owner/repository", "OWNER/repository"], branchPrefixes: ["feat/"] }, { repositories: ["owner/repository"], branchPrefixes: ["../"] }, { repositories: ["owner/repository"], branchPrefixes: ["feat/"], extra: true }]) assert.equal(parsePullRequestsConfig(value), undefined);
});

test("owner wildcard entries parse only as the exact owner/* form and match only that owner", () => {
	assert.deepEqual(parsePullRequestsConfig({ repositories: ["Owner/*"], branchPrefixes: ["feat/"] }), { repositories: ["owner/*"], branchPrefixes: ["feat/"] });
	// Anything other than a full exact repository or a full owner wildcard
	// rejects the block: authority is never broadened by a typo.
	for (const bad of ["*", "*/repository", "owner/*x", "owner/x*", "owner/*/", "*/*", "owner /*"]) {
		assert.equal(parsePullRequestsConfig({ repositories: [bad], branchPrefixes: ["feat/"] }), undefined, bad);
	}
	const wildcard = parsePullRequestsConfig({ repositories: ["owner/*", "other/exact"], branchPrefixes: ["feat/"] })!;
	assert.equal(repositoryAllowed("owner/anything", wildcard), true);
	assert.equal(repositoryAllowed("owner/another-repo", wildcard), true);
	assert.equal(repositoryAllowed("other/exact", wildcard), true);
	assert.equal(repositoryAllowed("other/unlisted", wildcard), false);
	assert.equal(repositoryAllowed("third/anything", wildcard), false);
	const exact = parsePullRequestsConfig({ repositories: ["owner/repository"], branchPrefixes: ["feat/"] })!;
	assert.equal(repositoryAllowed("owner/repository", exact), true);
	assert.equal(repositoryAllowed("owner/other", exact), false);
});

test("only canonical GitHub origins and safe non-default prefix branches qualify", () => {
	assert.deepEqual(normalizeGitHubRemote("git@github.com:Owner/Repository.git"), { repository: "owner/repository", remoteUrl: "https://github.com/owner/repository.git" });
	assert.deepEqual(normalizeGitHubRemote("https://github.com/owner/repository"), { repository: "owner/repository", remoteUrl: "https://github.com/owner/repository.git" });
	for (const remote of ["https://token@github.com/owner/repository", "https://github.com/owner/repository/extra", "git@gitlab.com:owner/repository.git"]) assert.equal(normalizeGitHubRemote(remote), undefined);
	assert.equal(branchAllowed("feat/broker", policy, "main"), true);
	for (const branch of ["main", "fix/../main", "other/work", "feat//bad"]) assert.equal(branchAllowed(branch, policy, "main"), false);
});

test("broker socket is generation-bound, mode-restricted, and exposes no arbitrary operation", async () => {
	const workspace = gitWorkspace("pio-pr-socket-");
	gitCommand(workspace, ["switch", "-c", "feat/broker"]);
	const pinned = await pinPullRequestTarget(workspace, policy, trustedPinRunner);
	assert.ok(pinned?.git);
	const target: PinnedPullRequestTarget = { ...pinned, branch: "feat/broker", generation: "one" };
	const broker = startPullRequestBroker(target, policy);
	try {
		await broker.ready;
		assert.equal(statSync(broker.directory).mode & 0o777, 0o700);
		assert.equal(statSync(`${broker.directory}/broker.sock`).mode & 0o777, 0o600);
		assert.equal((await request(`${broker.directory}/broker.sock`, { generation: "one", action: "status" })).ok, true);
		assert.equal((await request(`${broker.directory}/broker.sock`, { generation: "old", action: "status" })).ok, false);
		assert.equal((await request(`${broker.directory}/broker.sock`, { generation: "one", action: "merge" })).ok, false);
		assert.equal((await request(`${broker.directory}/broker.sock`, { generation: "one", action: "publish", title: "x", body: "", remote: "evil" })).ok, false);
	} finally { await broker.cleanup(); rmSync(workspace, { recursive: true, force: true }); }
});

test("publish uses HTTPS, fixed credential-free argv, and a host-only askpass", async () => {
	const workspace = gitWorkspace("pio-pr-test-"), ghBin = mkdtempSync(join(tmpdir(), "pio-pr-gh-")), record = join(ghBin, "record");
	const identity = statSync(workspace);
	const target: PinnedPullRequestTarget = { workspace, repository: "owner/repository", remoteUrl: "https://github.com/owner/repository.git", defaultBranch: "main", generation: "one", device: identity.dev, inode: identity.ino, git: gitMetadataForTesting(workspace)! };
	const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }> = [];
	const saved = Object.fromEntries(["GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_SSH_COMMAND"].map((key) => [key, process.env[key]]));
	for (const key of Object.keys(saved)) process.env[key] = "never-forward";
	let askpass: string | undefined;
	writeFileSync(join(ghBin, "gh"), "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.GH_TEST_RECORD, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(process.env.GH_TEST_OUTPUT ?? 'test_token');\n", { mode: 0o700 });
	const runner = async (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number } = {}) => {
		calls.push({ command, args, env: options.env, cwd: options.cwd });
		fakeTrustedClone(args);
		if (command === "git" && args.includes("fetch")) {
			askpass = options.env?.GIT_ASKPASS;
			assert.ok(askpass && (statSync(askpass).mode & 0o777) === 0o700 && (statSync(dirname(askpass)).mode & 0o777) === 0o700);
			assert.match(readFileSync(askpass, "utf8"), /spawnSync\("gh", \["auth", "token", "--hostname", "github.com"\]/);
			assert.equal(readFileSync(join(options.cwd!, "config"), "utf8"), "[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectformat = sha256\n");
			const env = { ...options.env, PATH: `${ghBin}:${process.env.PATH}`, GH_TEST_RECORD: record };
			assert.deepEqual(spawnSync(askpass, ["Username for 'https://github.com': "], { env, encoding: "utf8" }).stdout, "x-access-token\n");
			assert.deepEqual(spawnSync(askpass, ["Password for 'https://x-access-token@github.com': "], { env, encoding: "utf8" }).stdout, "test_token\n");
			assert.notEqual(spawnSync(askpass, ["unexpected prompt"], { env, encoding: "utf8" }).status, 0);
			assert.notEqual(spawnSync(askpass, ["Password for 'https://x-access-token@github.com': "], { env: { ...env, GH_TEST_OUTPUT: "bad\nsecond\n" }, encoding: "utf8" }).status, 0);
			assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), ["auth", "token", "--hostname", "github.com"]);
		}
		const joined = args.join(" ");
		if (joined.includes("--is-inside-work-tree")) return { ok: true, stdout: "true" };
		if (joined.includes("--show-toplevel")) return { ok: true, stdout: workspace };
		if (joined.includes("remote get-url origin")) return { ok: true, stdout: "https://github.com/owner/repository.git" };
		if (joined.includes("symbolic-ref --quiet --short HEAD")) return { ok: true, stdout: "feat/broker" };
		if (joined.includes("refs/remotes/origin/HEAD")) return { ok: true, stdout: "origin/main" };
		if (joined.includes("status --porcelain")) return { ok: true, stdout: "" };
		if (joined.includes("rev-parse --verify")) return { ok: true, stdout: "a".repeat(64) };
		if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository") return { ok: true, stdout: "main\n" };
		if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository/pulls") return { ok: true, stdout: "[]" };
		if (command === "gh" && args[0] === "api" && args.includes("--method=POST")) return { ok: true, stdout: "https://github.com/owner/repository/pull/42\n" };
		return { ok: true, stdout: "" };
	};
	try {
		const title = "- Safe title with spaces", body = "- leading punctuation\nwith a newline";
		const result = await publishPullRequest(target, policy, title, body, runner);
		assert.equal(result.ok, true);
		assert.equal(target.branch, "feat/broker", "first successful publish pins the worker-created branch");
		const clone = calls.find((call) => call.command === "git" && call.args.includes("clone"));
		assert.ok(clone && clone.cwd !== workspace && clone.env?.GIT_ALLOW_PROTOCOL === "file" && clone.args.includes("protocol.ssh.allow=never"));
		const network = calls.filter((call) => call.command === "git" && (call.args.includes("fetch") || call.args.includes("ls-remote") || call.args.includes("push")));
		assert.ok(network.length && network.every((call) => call.args.includes("credential.helper=") && call.args.includes("https://github.com/owner/repository.git") && call.env?.GIT_ASKPASS && call.env.GIT_TERMINAL_PROMPT === "0"));
		assert.ok(calls.filter((call) => call.command === "git" && !network.includes(call)).every((call) => call.env?.GIT_ASKPASS === undefined));
		const query = calls.find((call) => call.command === "gh" && call.args[2] === "repos/owner/repository/pulls");
		assert.deepEqual(query?.args, ["api", "--method=GET", "repos/owner/repository/pulls", "--raw-field=state=open", "--raw-field=head=owner:feat/broker", "--raw-field=base=main", "--raw-field=per_page=2", "--jq=[.[] | {number: .number, headRefName: .head.ref, baseRefName: .base.ref, isCrossRepository: (.head.repo.full_name != .base.repo.full_name), headRepository: {nameWithOwner: .head.repo.full_name}, headRepositoryOwner: {login: .head.repo.owner.login}}]"]);
		assert.equal(calls.some((call) => call.args[0] === "pr"), false);
		const create = calls.find((call) => call.command === "gh" && call.args[0] === "api" && call.args.includes("--method=POST"));
		assert.deepEqual(create?.args, ["api", "--method=POST", "repos/owner/repository/pulls", `--raw-field=title=${title}`, `--raw-field=body=${body}`, "--raw-field=head=feat/broker", "--raw-field=base=main", "--jq=.html_url"]);
		assert.match(result.message, /^Created an open pull request: https:\/\/github\.com\/owner\/repository\/pull\/42$/);
		assert.ok(!calls.some((call) => call.args.some((arg) => arg.startsWith("--field=") || arg.startsWith("--input=") || arg.startsWith("--raw-field=@") || arg === "pr" && (call.args.includes("create") || call.args.includes("edit")))));
		assert.ok(calls.every((call) => call.command === "git" || call.command === "gh"));
		assert.ok(calls.every((call) => Object.keys(saved).every((key) => call.env?.[key] === undefined)));
		assert.ok(!calls.some((call) => call.args.includes("test_token") || Object.values(call.env ?? {}).includes("test_token") || call.args.join(" ").includes("test_token")));
		assert.ok(askpass && !existsSync(askpass), "temp askpass is removed after publication");
	} finally { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; rmSync(ghBin, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); }
});

test("async pinning ignores stale origin/HEAD and trusts only bounded REST repository metadata", async () => {
	const workspace = gitWorkspace("pio-pr-pin-");
	gitCommand(workspace, ["update-ref", "refs/remotes/origin/fix/detect-scheduled-lock", "HEAD"]);
	gitCommand(workspace, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/fix/detect-scheduled-lock"]);
	const identity = statSync(workspace), metadataArgs = ["api", "--method=GET", "repos/owner/repository", "--jq=.default_branch"];
	try {
		const pin = async (response: { ok: boolean; stdout: string }) => {
			const calls: Array<{ command: string; args: string[]; options?: { env?: NodeJS.ProcessEnv; timeout?: number } }> = [];
			const runner = async (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; timeout?: number }) => {
				calls.push({ command, args, options });
				assert.equal(args.includes("refs/remotes/origin/HEAD"), false, "worker-visible origin/HEAD is never queried");
				const joined = args.join(" ");
				if (joined.includes("--is-inside-work-tree")) return { ok: true, stdout: "true" };
				if (joined.includes("--show-toplevel")) return { ok: true, stdout: workspace };
				if (joined.includes("remote get-url origin")) return { ok: true, stdout: "https://github.com/owner/repository.git" };
				if (command === "gh" && args.join("\0") === metadataArgs.join("\0")) return response;
				return { ok: false, stdout: "" };
			};
			return { target: await pinPullRequestTarget(workspace, policy, runner), calls };
		};
		const success = await pin({ ok: true, stdout: "master\n" });
		assert.deepEqual(success.target && { workspace: success.target.workspace, repository: success.target.repository, defaultBranch: success.target.defaultBranch, device: success.target.device, inode: success.target.inode, branch: success.target.branch }, { workspace, repository: "owner/repository", defaultBranch: "master", device: identity.dev, inode: identity.ino, branch: undefined });
		const metadata = success.calls.find((call) => call.command === "gh");
		assert.deepEqual(metadata?.args, metadataArgs);
		assert.equal(metadata?.options?.timeout, 15_000);
		for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "GIT_CONFIG_GLOBAL"]) assert.equal(metadata?.options?.env?.[key], undefined);
		for (const response of [{ ok: false, stdout: "master\n" }, { ok: true, stdout: "bad branch\n" }, { ok: true, stdout: "x".repeat(PR_RESPONSE_LIMIT + 1) }, { ok: true, stdout: "" }]) assert.equal((await pin(response)).target, undefined);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("synchronous pinning uses exact REST metadata argv and never falls back to stale origin/HEAD", () => {
	const workspace = gitWorkspace("pio-pr-sync-pin-"), bin = mkdtempSync(join(tmpdir(), "pio-pr-sync-gh-")), record = join(bin, "record"), gh = join(bin, "gh");
	gitCommand(workspace, ["update-ref", "refs/remotes/origin/fix/malicious", "HEAD"]);
	gitCommand(workspace, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/fix/malicious"]);
	const oldPath = process.env.PATH;
	try {
		writeFileSync(gh, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2))); process.stdout.write("master\\n");\n`, { mode: 0o700 });
		process.env.PATH = `${bin}:${oldPath}`;
		const target = pinPullRequestTargetSync(workspace, policy);
		assert.equal(target?.defaultBranch, "master");
		assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), ["api", "--method=GET", "repos/owner/repository", "--jq=.default_branch"]);
		writeFileSync(gh, "#!/usr/bin/env node\nprocess.exit(1);\n", { mode: 0o700 });
		assert.equal(pinPullRequestTargetSync(workspace, policy), undefined, "REST failure does not use local origin/HEAD");
		writeFileSync(gh, "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(9000));\n", { mode: 0o700 });
		assert.equal(pinPullRequestTargetSync(workspace, policy), undefined, "oversized metadata fails closed");
	} finally { oldPath === undefined ? delete process.env.PATH : process.env.PATH = oldPath; rmSync(bin, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); }
});

test("disallowed first branch is rejected and a later branch change is rejected", async () => {
	const workspace = gitWorkspace("pio-pr-branch-"); const stat = statSync(workspace);
	const target: PinnedPullRequestTarget = { workspace, repository: "owner/repository", remoteUrl: "https://github.com/owner/repository.git", defaultBranch: "main", generation: "one", device: stat.dev, inode: stat.ino, git: gitMetadataForTesting(workspace)! };
	let branch = "other/nope";
	const runner = async (command: string, args: string[]) => {
		fakeTrustedClone(args);
		const joined = args.join(" ");
		if (joined.includes("--is-inside-work-tree")) return { ok: true, stdout: "true" };
		if (joined.includes("--show-toplevel")) return { ok: true, stdout: workspace };
		if (joined.includes("remote get-url origin")) return { ok: true, stdout: "https://github.com/owner/repository.git" };
		if (joined.includes("refs/remotes/origin/HEAD")) return { ok: true, stdout: "origin/main" };
		if (joined.includes("symbolic-ref --quiet --short HEAD")) return { ok: true, stdout: branch };
		if (joined.includes("status --porcelain")) return { ok: true, stdout: "" };
		if (joined.includes("rev-parse --verify")) return { ok: true, stdout: "b".repeat(40) };
		if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository") return { ok: true, stdout: "main\n" };
		if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository/pulls") return { ok: true, stdout: "[]" };
		if (command === "gh" && args[0] === "api" && args.includes("--method=POST")) return { ok: true, stdout: "https://github.com/owner/repository/pull/9\n" };
		return { ok: true, stdout: "" };
	};
	try {
		assert.equal((await publishPullRequest(target, policy, "t", "b", runner)).ok, false);
		assert.equal(target.branch, undefined);
		branch = "feat/created-by-worker";
		assert.equal((await publishPullRequest(target, policy, "t", "b", runner)).ok, true);
		assert.equal(target.branch, branch);
		branch = "fix/different";
		assert.equal((await publishPullRequest(target, policy, "t", "b", runner)).ok, false);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("failed PR create after push keeps the first branch pinned", async () => {
	const workspace = gitWorkspace("pio-pr-failed-create-"); const stat = statSync(workspace);
	const target: PinnedPullRequestTarget = { workspace, repository: "owner/repository", remoteUrl: "https://github.com/owner/repository.git", defaultBranch: "main", generation: "one", device: stat.dev, inode: stat.ino, git: gitMetadataForTesting(workspace)! };
	let branch = "feat/first", pushes = 0;
	const runner = async (command: string, args: string[]) => {
		fakeTrustedClone(args);
		const joined = args.join(" ");
		if (joined.includes("--is-inside-work-tree")) return { ok: true, stdout: "true" };
		if (joined.includes("--show-toplevel")) return { ok: true, stdout: workspace };
		if (joined.includes("remote get-url origin")) return { ok: true, stdout: "https://github.com/owner/repository.git" };
		if (joined.includes("refs/remotes/origin/HEAD")) return { ok: true, stdout: "origin/main" };
		if (joined.includes("symbolic-ref --quiet --short HEAD")) return { ok: true, stdout: branch };
		if (joined.includes("status --porcelain")) return { ok: true, stdout: "" };
		if (joined.includes("rev-parse --verify")) return { ok: true, stdout: "c".repeat(40) };
		if (args.includes("push")) { pushes++; return { ok: true, stdout: "" }; }
		if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository") return { ok: true, stdout: "main\n" };
		if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository/pulls") return { ok: true, stdout: "[]" };
		if (command === "gh" && args[0] === "api" && args.includes("--method=POST")) return { ok: false, stdout: "" };
		return { ok: true, stdout: "" };
	};
	try {
		assert.equal((await publishPullRequest(target, policy, "t", "b", runner)).ok, false);
		assert.equal(target.branch, "feat/first"); assert.equal(pushes, 1);
		branch = "fix/second";
		assert.equal((await publishPullRequest(target, policy, "t", "b", runner)).ok, false);
		assert.equal(pushes, 1, "a different branch never reaches push after a failed PR operation");
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("REST discovery projection rejects fork, owner, repository, base, head, null, and ambiguous PR rows", async () => {
	const workspace = gitWorkspace("pio-pr-pr-row-"); const stat = statSync(workspace);
	const row = (extra: Record<string, unknown>) => [{ number: 7, headRefName: "feat/branch", baseRefName: "main", isCrossRepository: false, headRepository: { nameWithOwner: "owner/repository" }, headRepositoryOwner: { login: "owner" }, ...extra }];
	const makeRunner = (rows: unknown, calls: string[][]) => async (command: string, args: string[]) => {
		fakeTrustedClone(args); calls.push(args);
		const joined = args.join(" ");
		if (joined.includes("--is-inside-work-tree")) return { ok: true, stdout: "true" }; if (joined.includes("--show-toplevel")) return { ok: true, stdout: workspace };
		if (joined.includes("remote get-url origin")) return { ok: true, stdout: "https://github.com/owner/repository.git" }; if (joined.includes("refs/remotes/origin/HEAD")) return { ok: true, stdout: "origin/main" };
		if (joined.includes("symbolic-ref --quiet --short HEAD")) return { ok: true, stdout: "feat/branch" }; if (joined.includes("status --porcelain")) return { ok: true, stdout: "" }; if (joined.includes("rev-parse --verify")) return { ok: true, stdout: "d".repeat(40) };
		if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository") return { ok: true, stdout: "main\n" };
		if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository/pulls") return { ok: true, stdout: JSON.stringify(rows) }; return { ok: true, stdout: "" };
	};
	try {
		const invalid = [
			row({ isCrossRepository: true, headRepository: { nameWithOwner: "fork/repository" }, headRepositoryOwner: { login: "fork" } }), row({ headRepository: { nameWithOwner: "other/repository" } }), row({ headRepositoryOwner: { login: "other" } }), row({ baseRefName: "release" }), row({ headRefName: "feat/other" }), row({ headRepository: null, headRepositoryOwner: null }),
			[row({})[0], { ...row({})[0], number: 8 }],
		];
		for (const rows of invalid) {
			const calls: string[][] = [], target: PinnedPullRequestTarget = { workspace, repository: "owner/repository", remoteUrl: "https://github.com/owner/repository.git", defaultBranch: "main", generation: "one", device: stat.dev, inode: stat.ino, git: gitMetadataForTesting(workspace)! };
			assert.equal((await publishPullRequest(target, policy, "t", "b", makeRunner(rows, calls))).ok, false);
			assert.equal(calls.some((args) => args[0] === "api" && (args.includes("--method=POST") || args.includes("--method=PATCH"))), false, "a mismatched or ambiguous PR is never mutated");
		}
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("projected REST PR #1194 data updates through PATCH, never high-level gh PR commands", async () => {
	const workspace = gitWorkspace("pio-pr-rest-patch-"), stat = statSync(workspace), calls: string[][] = [];
	const target: PinnedPullRequestTarget = { workspace, repository: "owner/repository", remoteUrl: "https://github.com/owner/repository.git", defaultBranch: "main", generation: "one", device: stat.dev, inode: stat.ino, git: gitMetadataForTesting(workspace)! };
	const runner = async (command: string, args: string[]) => {
		fakeTrustedClone(args); calls.push(args); const joined = args.join(" ");
		if (joined.includes("--is-inside-work-tree")) return { ok: true, stdout: "true" }; if (joined.includes("--show-toplevel")) return { ok: true, stdout: workspace };
		if (joined.includes("remote get-url origin")) return { ok: true, stdout: "https://github.com/owner/repository.git" }; if (joined.includes("refs/remotes/origin/HEAD")) return { ok: true, stdout: "origin/main" };
		if (joined.includes("symbolic-ref --quiet --short HEAD")) return { ok: true, stdout: "feat/rest" }; if (joined.includes("status --porcelain")) return { ok: true, stdout: "" }; if (joined.includes("rev-parse --verify")) return { ok: true, stdout: "a".repeat(40) };
		if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository") return { ok: true, stdout: "main\n" };
		if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository/pulls") return { ok: true, stdout: JSON.stringify([{ number: 1194, headRefName: "feat/rest", baseRefName: "main", isCrossRepository: false, headRepository: { nameWithOwner: "owner/repository" }, headRepositoryOwner: { login: "owner" } }]) };
		return { ok: true, stdout: "" };
	};
	try {
		const title = "Leading - title", body = "- literal body\nwith spaces";
		assert.equal((await publishPullRequest(target, policy, title, body, runner)).ok, true);
		assert.deepEqual(calls.find((args) => args[0] === "api" && args.includes("--method=PATCH")), ["api", "--method=PATCH", "repos/owner/repository/pulls/1194", `--raw-field=title=${title}`, `--raw-field=body=${body}`, "--silent"]);
		assert.equal(calls.some((args) => args[0] === "pr"), false);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("failed REST POST re-queries exactly once and updates only a revalidated exact PR", async () => {
	const workspace = gitWorkspace("pio-pr-rest-race-"), stat = statSync(workspace), calls: string[][] = [];
	const target: PinnedPullRequestTarget = { workspace, repository: "owner/repository", remoteUrl: "https://github.com/owner/repository.git", defaultBranch: "main", generation: "one", device: stat.dev, inode: stat.ino, git: gitMetadataForTesting(workspace)! };
	let queries = 0;
	const runner = async (command: string, args: string[]) => {
		fakeTrustedClone(args); calls.push(args); const joined = args.join(" ");
		if (joined.includes("--is-inside-work-tree")) return { ok: true, stdout: "true" }; if (joined.includes("--show-toplevel")) return { ok: true, stdout: workspace };
		if (joined.includes("remote get-url origin")) return { ok: true, stdout: "https://github.com/owner/repository.git" }; if (joined.includes("refs/remotes/origin/HEAD")) return { ok: true, stdout: "origin/main" };
		if (joined.includes("symbolic-ref --quiet --short HEAD")) return { ok: true, stdout: "feat/race" }; if (joined.includes("status --porcelain")) return { ok: true, stdout: "" }; if (joined.includes("rev-parse --verify")) return { ok: true, stdout: "b".repeat(40) };
		if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository") return { ok: true, stdout: "main\n" };
		if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository/pulls") return { ok: true, stdout: JSON.stringify(++queries === 1 ? [] : [{ number: 91, headRefName: "feat/race", baseRefName: "main", isCrossRepository: false, headRepository: { nameWithOwner: "owner/repository" }, headRepositoryOwner: { login: "owner" } }]) };
		if (command === "gh" && args[0] === "api" && args.includes("--method=POST")) return { ok: false, stdout: "" };
		return { ok: true, stdout: "" };
	};
	try {
		assert.equal((await publishPullRequest(target, policy, "t", "b", runner)).ok, true);
		const discovery = calls.filter((args) => args.includes("--method=GET") && args[2] === "repos/owner/repository/pulls");
		assert.equal(queries, 2); assert.equal(discovery.length, 2); assert.ok(discovery.every((args) => args.includes("repos/owner/repository/pulls") && args.includes("--raw-field=head=owner:feat/race")));
		assert.equal(calls.filter((args) => args[0] === "api" && args.includes("--method=POST")).length, 1);
		assert.ok(calls.some((args) => args[0] === "api" && args.includes("--method=PATCH") && args.includes("repos/owner/repository/pulls/91")));
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("failed or invalid REST POST fails closed without an exact re-query match", async () => {
	const workspace = gitWorkspace("pio-pr-rest-closed-"), stat = statSync(workspace);
	const exact = { number: 2, headRefName: "feat/closed", baseRefName: "main", isCrossRepository: false, headRepository: { nameWithOwner: "owner/repository" }, headRepositoryOwner: { login: "owner" } };
	try {
		for (const [post, fresh] of [[{ ok: false, stdout: "" }, []], [{ ok: false, stdout: "" }, [{ ...exact, baseRefName: "release" }]], [{ ok: false, stdout: "" }, [exact, { ...exact, number: 3 }]], [{ ok: true, stdout: "https://github.com/owner/repository/issues/2\n" }, []]] as const) {
			const calls: string[][] = []; let queries = 0;
			const target: PinnedPullRequestTarget = { workspace, repository: "owner/repository", remoteUrl: "https://github.com/owner/repository.git", defaultBranch: "main", generation: "one", device: stat.dev, inode: stat.ino, git: gitMetadataForTesting(workspace)! };
			const runner = async (command: string, args: string[]) => {
				fakeTrustedClone(args); calls.push(args); const joined = args.join(" ");
				if (joined.includes("--is-inside-work-tree")) return { ok: true, stdout: "true" }; if (joined.includes("--show-toplevel")) return { ok: true, stdout: workspace };
				if (joined.includes("remote get-url origin")) return { ok: true, stdout: "https://github.com/owner/repository.git" }; if (joined.includes("refs/remotes/origin/HEAD")) return { ok: true, stdout: "origin/main" };
				if (joined.includes("symbolic-ref --quiet --short HEAD")) return { ok: true, stdout: "feat/closed" }; if (joined.includes("status --porcelain")) return { ok: true, stdout: "" }; if (joined.includes("rev-parse --verify")) return { ok: true, stdout: "c".repeat(40) };
				if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository") return { ok: true, stdout: "main\n" };
				if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository/pulls") return { ok: true, stdout: JSON.stringify(++queries === 1 ? [] : fresh) };
				if (command === "gh" && args[0] === "api" && args.includes("--method=POST")) return post;
				return { ok: true, stdout: "" };
			};
			const result = await publishPullRequest(target, policy, "t", "b", runner);
			assert.deepEqual(result, { ok: false, message: "Pull request create/update failed." }); assert.equal(queries, 2);
			assert.equal(calls.some((args) => args[0] === "api" && args.includes("--method=PATCH")), false);
		}
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("rejecting handlers, concurrent publish, and total request exhaustion are bounded", async () => {
	const workspace = gitWorkspace("pio-pr-bounds-"), stat = statSync(workspace);
	const target: PinnedPullRequestTarget = { workspace, repository: "owner/repository", remoteUrl: "https://github.com/owner/repository.git", defaultBranch: "main", generation: "one", device: stat.dev, inode: stat.ino, git: gitMetadataForTesting(workspace)!, branch: "feat/held" };
	let release!: () => void, rejectStatus = true; const held = new Promise<void>((resolve) => { release = resolve; });
	const broker = startPullRequestBroker(target, policy, async (command, args) => {
		fakeTrustedClone(args);
		const joined = args.join(" ");
		if (rejectStatus && joined.includes("symbolic-ref --quiet --short HEAD")) throw new Error("must not leak");
		if (joined.includes("--is-inside-work-tree")) return { ok: true, stdout: "true" }; if (joined.includes("--show-toplevel")) return { ok: true, stdout: workspace };
		if (joined.includes("remote get-url origin")) return { ok: true, stdout: "https://github.com/owner/repository.git" }; if (joined.includes("refs/remotes/origin/HEAD")) return { ok: true, stdout: "origin/main" };
		if (joined.includes("symbolic-ref --quiet --short HEAD")) return { ok: true, stdout: "feat/held" }; if (joined.includes("status --porcelain")) return { ok: true, stdout: "" }; if (joined.includes("rev-parse --verify")) return { ok: true, stdout: "e".repeat(40) };
		if (args.includes("push")) await held; if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository") return { ok: true, stdout: "main\n" }; if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository/pulls") return { ok: true, stdout: "[]" }; return { ok: true, stdout: "" };
	});
	try {
		await broker.ready;
		const path = `${broker.directory}/broker.sock`;
		assert.equal((await request(path, { generation: "one", action: "status" })).ok, false, "runner rejection receives generic failure");
		rejectStatus = false;
		const first = request(path, { generation: "one", action: "publish", title: "t", body: "b" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal((await request(path, { generation: "one", action: "publish", title: "t", body: "b" })).ok, false);
		release(); await first;
		for (let index = 0; index < PR_MAX_REQUESTS; index++) await request(path, { generation: "one", action: "status" });
		assert.equal((await request(path, { generation: "one", action: "status" })).ok, false);
	} finally { release?.(); await broker.cleanup(); rmSync(workspace, { recursive: true, force: true }); }
});

test("cleanup during a publish is idempotent and waits for the active handler", async () => {
	const workspace = gitWorkspace("pio-pr-cleanup-"), stat = statSync(workspace);
	const target: PinnedPullRequestTarget = { workspace, repository: "owner/repository", remoteUrl: "https://github.com/owner/repository.git", defaultBranch: "main", generation: "one", device: stat.dev, inode: stat.ino, git: gitMetadataForTesting(workspace)!, branch: "feat/held" };
	let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
	const broker = startPullRequestBroker(target, policy, async (command, args) => {
		fakeTrustedClone(args);
		const joined = args.join(" "); if (joined.includes("--is-inside-work-tree")) return { ok: true, stdout: "true" }; if (joined.includes("--show-toplevel")) return { ok: true, stdout: workspace };
		if (joined.includes("remote get-url origin")) return { ok: true, stdout: "https://github.com/owner/repository.git" }; if (joined.includes("refs/remotes/origin/HEAD")) return { ok: true, stdout: "origin/main" }; if (joined.includes("symbolic-ref --quiet --short HEAD")) return { ok: true, stdout: "feat/held" };
		if (joined.includes("status --porcelain")) return { ok: true, stdout: "" }; if (joined.includes("rev-parse --verify")) return { ok: true, stdout: "f".repeat(40) }; if (args.includes("push")) await held; if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository") return { ok: true, stdout: "main\n" }; if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository/pulls") return { ok: true, stdout: "[]" }; return { ok: true, stdout: "" };
	});
	try {
		await broker.ready; const pending = request(`${broker.directory}/broker.sock`, { generation: "one", action: "publish", title: "t", body: "b" }); await new Promise((resolve) => setTimeout(resolve, 10));
		const first = broker.cleanup(), second = broker.cleanup(); assert.strictEqual(first, second); release(); await first; await pending.catch(() => {});
		assert.equal(existsSync(broker.directory), false);
	} finally { release?.(); await broker.cleanup(); rmSync(workspace, { recursive: true, force: true }); }
});

test("a real repository pins and ordinary commits and refs do not change metadata", async () => {
	const workspace = gitWorkspace("pio-pr-real-pin-");
	try {
		const target = await pinPullRequestTarget(workspace, policy, trustedPinRunner);
		assert.ok(target?.git);
		const metadata = target.git;
		gitCommand(workspace, ["switch", "-c", "feat/ordinary"]);
		appendFileSync(join(workspace, "tracked.txt"), "next\n");
		gitCommand(workspace, ["add", "tracked.txt"]);
		gitCommand(workspace, ["commit", "-m", "ordinary change"]);
		gitCommand(workspace, ["update-ref", "refs/remotes/origin/main", "HEAD~1"]);
		assert.deepEqual(gitMetadataForTesting(workspace), metadata);
		const repinned = await pinPullRequestTarget(workspace, policy, trustedPinRunner);
		assert.ok(repinned?.git);
		assert.deepEqual(repinned.git, metadata);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("real linked worktrees fail closed because the sandbox cannot mount their gitdir", async () => {
	const workspace = gitWorkspace("pio-pr-worktree-main-");
	const parent = mkdtempSync(join(tmpdir(), "pio-pr-worktree-linked-"));
	const linked = join(parent, "checkout");
	try {
		gitCommand(workspace, ["worktree", "add", "-b", "feat/linked", linked]);
		assert.equal(statSync(join(linked, ".git")).isFile(), true);
		assert.equal(gitMetadataForTesting(linked), undefined);
		assert.equal(await pinPullRequestTarget(linked, policy, trustedPinRunner), undefined);
	} finally { rmSync(parent, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); }
});

test("replacement or symlink conversion of .git is rejected before broker commands", async () => {
	for (const symlink of [false, true]) {
		const workspace = gitWorkspace("pio-pr-git-entry-"); let calls = 0;
		try {
			const target = await pinPullRequestTarget(workspace, policy, trustedPinRunner); assert.ok(target);
			const saved = join(workspace, ".git-saved"); renameSync(join(workspace, ".git"), saved);
			if (symlink) symlinkSync(saved, join(workspace, ".git"), "dir");
			else { mkdirSync(join(workspace, ".git")); writeFileSync(join(workspace, ".git", "config"), readFileSync(join(saved, "config"))); }
			const workspaceIdentity = statSync(workspace); assert.equal(workspaceIdentity.ino, target.inode);
			const result = await publishPullRequest(target, policy, "t", "b", async () => { calls++; return { ok: false, stdout: "" }; });
			assert.equal(result.ok, false); assert.equal(calls, 0);
		} finally { rmSync(workspace, { recursive: true, force: true }); }
	}
});

test("in-place config changes are rejected before broker commands", async () => {
	const workspace = gitWorkspace("pio-pr-config-change-"); let calls = 0;
	try {
		const target = await pinPullRequestTarget(workspace, policy, trustedPinRunner); assert.ok(target);
		const config = join(workspace, ".git", "config"), inode = statSync(config).ino;
		appendFileSync(config, "\n[core]\n\tbare = false\n");
		assert.equal(statSync(config).ino, inode, "the test mutates the pinned config inode in place");
		assert.equal((await publishPullRequest(target, policy, "t", "b", async () => { calls++; return { ok: false, stdout: "" }; })).ok, false);
		assert.equal(calls, 0);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("local include and includeIf config are rejected at pin time", async () => {
	for (const section of ["[include]\npath = /tmp/evil\n", "[includeIf \"gitdir:/tmp/**\"]\npath = /tmp/evil\n"]) {
		const workspace = gitWorkspace("pio-pr-include-");
		try { appendFileSync(join(workspace, ".git", "config"), section); assert.equal(await pinPullRequestTarget(workspace, policy, trustedPinRunner), undefined); }
		finally { rmSync(workspace, { recursive: true, force: true }); }
	}
});

test("object alternates are rejected at pin time and when created or changed after pinning", async () => {
	for (const name of ["alternates", "http-alternates"]) {
		const present = gitWorkspace("pio-pr-alternates-present-");
		try {
			writeFileSync(join(present, ".git", "objects", "info", name), "/untrusted/objects\n");
			assert.equal(await pinPullRequestTarget(present, policy, trustedPinRunner), undefined);
		} finally { rmSync(present, { recursive: true, force: true }); }

		const changed = gitWorkspace("pio-pr-alternates-changed-"); let calls = 0;
		try {
			const target = await pinPullRequestTarget(changed, policy, trustedPinRunner); assert.ok(target);
			const path = join(changed, ".git", "objects", "info", name);
			writeFileSync(path, "/first/untrusted/objects\n");
			assert.equal((await publishPullRequest(target, policy, "t", "b", async () => { calls++; return { ok: false, stdout: "" }; })).ok, false);
			writeFileSync(path, "/second/untrusted/objects\n");
			assert.equal((await publishPullRequest(target, policy, "t", "b", async () => { calls++; return { ok: false, stdout: "" }; })).ok, false);
			assert.equal(calls, 0, "alternates changes reject before Git, push, or gh commands");
		} finally { rmSync(changed, { recursive: true, force: true }); }
	}
});

test("explicit real status finds untracked files despite status.showUntrackedFiles=no", async () => {
	const workspace = gitWorkspace("pio-pr-untracked-"); const mutations: string[] = [];
	try {
		gitCommand(workspace, ["config", "status.showUntrackedFiles", "no"]);
		gitCommand(workspace, ["switch", "-c", "feat/untracked"]);
		const target = await pinPullRequestTarget(workspace, policy, trustedPinRunner); assert.ok(target);
		writeFileSync(join(workspace, "untracked.txt"), "must be detected\n");
		const runner = async (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
			if (command === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository") return { ok: true, stdout: "main\n" };
			if (command === "gh" || args.includes("clone") || args.includes("push")) { mutations.push(`${command}:${args.join(" ")}`); return { ok: false, stdout: "" }; }
			return actualRunner(command, args, options);
		};
		const result = await publishPullRequest(target, policy, "t", "b", runner);
		assert.equal(result.ok, false); assert.match(result.message, /tracked and untracked/); assert.deepEqual(mutations, []);
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("hostile local Git config cannot execute commands or influence trusted clone", async () => {
	const workspace = gitWorkspace("pio-pr-hostile-");
	const markerRoot = mkdtempSync(join(tmpdir(), "pio-pr-marker-")), marker = join(markerRoot, "executed"), command = join(markerRoot, "marker-command");
	const hooks = join(markerRoot, "hooks"); mkdirSync(hooks);
	const script = `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')\n`;
	writeFileSync(command, script, { mode: 0o700 }); writeFileSync(join(hooks, "post-checkout"), script, { mode: 0o700 });
	const calls: Array<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
	try {
		gitCommand(workspace, ["switch", "-c", "feat/hostile"]);
		gitCommand(workspace, ["config", "url.file:///definitely-not-a-remote.insteadOf", "marker:"]);
		gitCommand(workspace, ["config", "core.sshCommand", command]);
		gitCommand(workspace, ["config", "core.hooksPath", hooks]);
		gitCommand(workspace, ["config", "core.fsmonitor", command]);
		gitCommand(workspace, ["config", "uploadpack.packObjectsHook", command]);
		const target = await pinPullRequestTarget(workspace, policy, trustedPinRunner); assert.ok(target);
		const runner = async (cmd: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
			calls.push({ command: cmd, args, cwd: options.cwd, env: options.env });
			if (args.includes("fetch")) {
				assert.equal(readFileSync(join(options.cwd!, "config"), "utf8"), "[core]\n\trepositoryformatversion = 0\n\tbare = true\n");
				assert.equal(options.env?.GIT_ASKPASS !== undefined, true);
				return { ok: false, stdout: "" };
			}
			if (cmd === "gh" && args.includes("--method=GET") && args[2] === "repos/owner/repository") return { ok: true, stdout: "main\n" };
			if (cmd === "gh" || args.includes("ls-remote") || args.includes("push")) return { ok: false, stdout: "" };
			return actualRunner(cmd, args, options);
		};
		assert.equal((await publishPullRequest(target, policy, "t", "b", runner)).ok, false);
		const clone = calls.find((call) => call.command === "git" && call.args.includes("clone"));
		assert.ok(clone && clone.cwd !== workspace && clone.env?.GIT_ALLOW_PROTOCOL === "file" && clone.env.GIT_PROTOCOL_FROM_USER === "0");
		assert.ok(clone.args.includes("--local") && clone.args.includes("--no-hardlinks") && !clone.args.includes("--no-local"), "snapshot creation cannot invoke source-side upload-pack");
		assert.ok(clone.args.includes("protocol.file.allow=always") && clone.args.includes("protocol.ssh.allow=never") && clone.args.includes("protocol.https.allow=never"));
		assert.equal(existsSync(marker), false);
		assert.equal(calls.some((call) => call.args.includes("push") || call.command === "gh" && call.args[2] !== "repos/owner/repository"), false);
	} finally { rmSync(markerRoot, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); }
});

test("broker request bound is finite", () => {
	assert.ok(PR_REQUEST_LIMIT < 100_000);
	assert.ok(PR_MAX_REQUESTS < 100);
});
