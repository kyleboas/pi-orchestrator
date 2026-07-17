import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import test from "node:test";
import {
	branchAllowed,
	normalizeGitHubRemote,
	parsePullRequestsConfig,
	PR_MAX_REQUESTS,
	PR_REQUEST_LIMIT,
	pinPullRequestTarget,
	publishPullRequest,
	startPullRequestBroker,
	type PinnedPullRequestTarget,
} from "../extensions/orchestrator-lib/orchestrator-pr-broker.ts";

const policy = { repositories: ["owner/repository"], branchPrefixes: ["feat/", "fix/"] };

function request(path: string, value: unknown): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(path); let output = "";
		socket.on("connect", () => socket.end(`${JSON.stringify(value)}\n`));
		socket.on("data", (chunk) => { output += chunk.toString("utf8"); });
		socket.on("end", () => resolve(JSON.parse(output) as Record<string, unknown>));
		socket.on("error", reject);
	});
}

test("PR policy is opt-in, bounded, normalized, and fails closed", () => {
	assert.deepEqual(parsePullRequestsConfig({ repositories: ["Owner/Repository"], branchPrefixes: ["feat/"] }), { repositories: ["owner/repository"], branchPrefixes: ["feat/"] });
	for (const value of [undefined, {}, { repositories: ["owner/repository", "OWNER/repository"], branchPrefixes: ["feat/"] }, { repositories: ["owner/repository"], branchPrefixes: ["../"] }, { repositories: ["owner/repository"], branchPrefixes: ["feat/"], extra: true }]) assert.equal(parsePullRequestsConfig(value), undefined);
});

test("only canonical GitHub origins and safe non-default prefix branches qualify", () => {
	assert.deepEqual(normalizeGitHubRemote("git@github.com:Owner/Repository.git"), { repository: "owner/repository", remoteUrl: "git@github.com:owner/repository.git" });
	assert.deepEqual(normalizeGitHubRemote("https://github.com/owner/repository"), { repository: "owner/repository", remoteUrl: "git@github.com:owner/repository.git" });
	for (const remote of ["https://token@github.com/owner/repository", "https://github.com/owner/repository/extra", "git@gitlab.com:owner/repository.git"]) assert.equal(normalizeGitHubRemote(remote), undefined);
	assert.equal(branchAllowed("feat/broker", policy, "main"), true);
	for (const branch of ["main", "fix/../main", "other/work", "feat//bad"]) assert.equal(branchAllowed(branch, policy, "main"), false);
});

test("broker socket is generation-bound, mode-restricted, and exposes no arbitrary operation", async () => {
	const target: PinnedPullRequestTarget = { workspace: "/trusted/repo", repository: "owner/repository", remoteUrl: "git@github.com:owner/repository.git", branch: "feat/broker", defaultBranch: "main", generation: "one", device: 1, inode: 2 };
	const broker = startPullRequestBroker(target, policy);
	try {
		await broker.ready;
		assert.equal(statSync(broker.directory).mode & 0o777, 0o700);
		assert.equal(statSync(`${broker.directory}/broker.sock`).mode & 0o777, 0o600);
		assert.equal((await request(`${broker.directory}/broker.sock`, { generation: "one", action: "status" })).ok, true);
		assert.equal((await request(`${broker.directory}/broker.sock`, { generation: "old", action: "status" })).ok, false);
		assert.equal((await request(`${broker.directory}/broker.sock`, { generation: "one", action: "merge" })).ok, false);
		assert.equal((await request(`${broker.directory}/broker.sock`, { generation: "one", action: "publish", title: "x", body: "", remote: "evil" })).ok, false);
	} finally { await broker.cleanup(); }
});

test("publish uses only fixed git/gh argv and canonical remote with credential-free worker-facing output", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "pio-pr-test-"));
	const identity = statSync(workspace);
	const target: PinnedPullRequestTarget = { workspace, repository: "owner/repository", remoteUrl: "git@github.com:owner/repository.git", defaultBranch: "main", generation: "one", device: identity.dev, inode: identity.ino };
	const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
	const old = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = "never-forward";
	const runner = async (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number } = {}) => {
		calls.push({ command, args, env: options.env });
		const joined = args.join(" ");
		if (joined.includes("--is-inside-work-tree")) return { ok: true, stdout: "true" };
		if (joined.includes("--show-toplevel")) return { ok: true, stdout: workspace };
		if (joined.includes("remote get-url origin")) return { ok: true, stdout: "git@github.com:owner/repository.git" };
		if (joined.includes("symbolic-ref --quiet --short HEAD")) return { ok: true, stdout: "feat/broker" };
		if (joined.includes("refs/remotes/origin/HEAD")) return { ok: true, stdout: "origin/main" };
		if (joined.includes("status --porcelain")) return { ok: true, stdout: "" };
		if (joined.includes("rev-parse --verify")) return { ok: true, stdout: "a".repeat(40) };
		if (command === "gh" && joined.includes("pr list")) return { ok: true, stdout: "[]" };
		return { ok: true, stdout: "" };
	};
	try {
		const result = await publishPullRequest(target, policy, "Safe title", "Safe body", runner);
		assert.equal(result.ok, true);
		assert.equal(target.branch, "feat/broker", "first successful publish pins the worker-created branch");
		assert.ok(calls.some((call) => call.command === "git" && call.args.includes("push") && call.args.includes("git@github.com:owner/repository.git")));
		assert.ok(calls.some((call) => call.command === "gh" && call.args.includes("create") && call.args.includes("--base=main")));
		assert.ok(calls.every((call) => call.command === "git" || call.command === "gh"));
		assert.ok(calls.every((call) => call.env?.GITHUB_TOKEN === undefined));
	} finally { old === undefined ? delete process.env.GITHUB_TOKEN : process.env.GITHUB_TOKEN = old; rmSync(workspace, { recursive: true, force: true }); }
});

test("default-branch startup defers branch pinning and falls back to trusted gh default lookup", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "pio-pr-pin-"));
	const identity = statSync(workspace); const calls: string[] = [];
	const runner = async (command: string, args: string[]) => {
		calls.push(`${command} ${args.join(" ")}`); const joined = args.join(" ");
		if (joined.includes("--is-inside-work-tree")) return { ok: true, stdout: "true" };
		if (joined.includes("--show-toplevel")) return { ok: true, stdout: workspace };
		if (joined.includes("remote get-url origin")) return { ok: true, stdout: "git@github.com:owner/repository.git" };
		if (command === "gh") return { ok: true, stdout: "main" };
		return { ok: false, stdout: "" }; // origin/HEAD intentionally absent
	};
	try {
		const target = await pinPullRequestTarget(workspace, policy, runner);
		assert.deepEqual(target && { workspace: target.workspace, repository: target.repository, defaultBranch: target.defaultBranch, device: target.device, inode: target.inode, branch: target.branch }, { workspace, repository: "owner/repository", defaultBranch: "main", device: identity.dev, inode: identity.ino, branch: undefined });
		assert.ok(calls.some((call) => call.startsWith("gh repo view owner/repository")));
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("disallowed first branch is rejected and a later branch change is rejected", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "pio-pr-branch-")); const stat = statSync(workspace);
	const target: PinnedPullRequestTarget = { workspace, repository: "owner/repository", remoteUrl: "git@github.com:owner/repository.git", defaultBranch: "main", generation: "one", device: stat.dev, inode: stat.ino };
	let branch = "other/nope";
	const runner = async (command: string, args: string[]) => {
		const joined = args.join(" ");
		if (joined.includes("--is-inside-work-tree")) return { ok: true, stdout: "true" };
		if (joined.includes("--show-toplevel")) return { ok: true, stdout: workspace };
		if (joined.includes("remote get-url origin")) return { ok: true, stdout: "git@github.com:owner/repository.git" };
		if (joined.includes("refs/remotes/origin/HEAD")) return { ok: true, stdout: "origin/main" };
		if (joined.includes("symbolic-ref --quiet --short HEAD")) return { ok: true, stdout: branch };
		if (joined.includes("status --porcelain")) return { ok: true, stdout: "" };
		if (joined.includes("rev-parse --verify")) return { ok: true, stdout: "b".repeat(40) };
		if (command === "gh" && joined.includes("pr list")) return { ok: true, stdout: "[]" };
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

test("broker request bound is finite", () => {
	assert.ok(PR_REQUEST_LIMIT < 100_000);
	assert.ok(PR_MAX_REQUESTS < 100);
});
