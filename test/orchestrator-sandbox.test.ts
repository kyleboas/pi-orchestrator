import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	DEFAULT_SANDBOX_CONFIG,
	INVALID_SANDBOX_CONFIG,
	SAFE_ENV_NAMES,
	buildBwrapArgs,
	parseSandboxConfig,
	probeBwrap,
	resetSandboxProbeCacheForTesting,
	cleanupWorkerHomeDir,
	createWorkerHomeDir,
	piWorkerSandboxPlan,
	resolveWorkerCommand,
	resolveWorkerLaunch,
	workerHomeDirPath,
	type CommandFs,
	type SandboxConfig,
	type WorkerLaunchRequest,
} from "../extensions/orchestrator-lib/orchestrator-sandbox.ts";
import { loadOrchestratorConfig } from "../extensions/orchestrator-lib/orchestrator-config.ts";

function configFile(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-orchestrator-sandbox-"));
	const file = join(dir, "config.json");
	writeFileSync(file, text);
	return file;
}
function remove(file: string) {
	rmSync(join(file, ".."), { recursive: true, force: true });
}

function sandbox(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
	return { ...DEFAULT_SANDBOX_CONFIG, ...overrides };
}

const fakeFs: CommandFs = {
	existsSync: (path) =>
		path === "/home/user/.nvm/versions/node/v24.15.0/bin/pi" ||
		path === "/home/user/.local/bin/claude" ||
		path === "/home/user/.local/share/claude/versions/2.1.211/claude",
	realpathSync: (path) =>
		path === "/home/user/.local/bin/claude" ? "/home/user/.local/share/claude/versions/2.1.211/claude" : path,
};
const fakeEnv: NodeJS.ProcessEnv = {
	PATH: "/home/user/.nvm/versions/node/v24.15.0/bin:/home/user/.local/bin:/usr/bin",
	HOME: "/home/user",
	SECRET_TOKEN: "do-not-leak",
	TERM: "xterm-256color",
};

function request(overrides: Partial<WorkerLaunchRequest> = {}): WorkerLaunchRequest {
	return {
		command: "pi",
		args: ["--mode", "rpc"],
		cwd: "/work/repo",
		envOverrides: { PI_ORCHESTRATOR_WORKER: "1" },
		homeDir: "/home/user/.cache/pi-orchestrator/worker-homes/w1",
		...overrides,
	};
}

test("parseSandboxConfig accepts valid blocks and applies defaults", () => {
	assert.deepEqual(parseSandboxConfig({}), sandbox());
	assert.deepEqual(
		parseSandboxConfig({ mode: "required", network: "none", env: "allowlist", envAllow: ["ANTHROPIC_BASE_URL"], readOnlyPaths: ["~/runtime"], command: "bwrap" }),
		sandbox({ mode: "required", network: "none", env: "allowlist", envAllow: ["ANTHROPIC_BASE_URL"], readOnlyPaths: [join(homedir(), "runtime")] }),
	);
	// Enabling the sandbox flips the env default to the credential-safe
	// allowlist; only explicit config opts back into full inheritance.
	assert.deepEqual(parseSandboxConfig({ mode: "preferred" }), sandbox({ mode: "preferred", env: "allowlist" }));
	assert.deepEqual(parseSandboxConfig({ mode: "required" }), sandbox({ mode: "required", env: "allowlist" }));
	assert.deepEqual(parseSandboxConfig({ mode: "required", env: "inherit" }), sandbox({ mode: "required", env: "inherit" }));
	assert.equal(parseSandboxConfig({})!.env, "inherit");
});

test("parseSandboxConfig rejects every malformed field without echoing values", () => {
	for (const bad of [
		null,
		[],
		{ mode: "on" },
		{ mode: "requried" },
		{ network: "gateway" },
		{ env: "passthrough" },
		{ envAllow: "PATH" },
		{ envAllow: ["BAD NAME"] },
		{ envAllow: ["A=b"] },
		{ readOnlyPaths: ["relative/path"] },
		{ readOnlyPaths: ["/ok\npath"] },
		{ readOnlyPaths: "~/x" },
		{ command: "" },
		{ command: "bwrap\n--evil" },
	]) {
		assert.equal(parseSandboxConfig(bad), undefined, JSON.stringify(bad));
	}
});

test("config without a sandbox block stays off for backward compatibility", () => {
	const file = configFile(JSON.stringify({ checkInMinutes: 5 }));
	try {
		const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: file });
		assert.deepEqual(config.sandbox, DEFAULT_SANDBOX_CONFIG);
		assert.equal(config.warning, undefined);
	} finally {
		remove(file);
	}
});

test("valid sandbox block is loaded alongside the rest of the config", () => {
	const file = configFile(JSON.stringify({ sandbox: { mode: "required", network: "host", env: "allowlist" } }));
	try {
		const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: file });
		assert.equal(config.sandbox.mode, "required");
		assert.equal(config.sandbox.env, "allowlist");
		assert.equal(config.sandbox.invalid, undefined);
	} finally {
		remove(file);
	}
});

test("malformed sandbox block fails closed instead of becoming off", () => {
	for (const block of [{ mode: "required", network: "gateway" }, { mode: "preferred", envAllow: [42] }, { mode: "off", command: "" }]) {
		const file = configFile(JSON.stringify({ sandbox: block }));
		try {
			const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: file });
			assert.equal(config.sandbox.invalid, true);
			assert.equal(config.sandbox.mode, "required");
			assert.match(config.warning ?? "", /Sandbox configuration was invalid/);
			const launch = resolveWorkerLaunch(config.sandbox, request(), fakeEnv, () => ({ ok: true, unshareNet: true }), fakeFs);
			assert.equal(launch.ok, false);
		} finally {
			remove(file);
		}
	}
});

test("otherwise-invalid config never downgrades a requested sandbox to off", () => {
	const file = configFile(JSON.stringify({ workers: { "!bad name": {} }, sandbox: { mode: "required" } }));
	try {
		const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: file });
		assert.equal(config.sandbox.mode, "required");
		assert.equal(config.sandbox.invalid, undefined);
		assert.match(config.warning ?? "", /invalid/);
	} finally {
		remove(file);
	}
});

test("unparseable JSON mentioning sandbox fails closed generically", () => {
	const file = configFile('{ "sandbox": { "mode": "required" }, ');
	try {
		const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: file });
		assert.equal(config.sandbox.invalid, true);
		assert.match(config.warning ?? "", /Sandbox configuration was invalid/);
	} finally {
		remove(file);
	}
	const legacy = configFile('{ "checkInMinutes": ');
	try {
		const config = loadOrchestratorConfig({ PI_ORCHESTRATOR_CONFIG: legacy });
		assert.deepEqual(config.sandbox, DEFAULT_SANDBOX_CONFIG);
	} finally {
		remove(legacy);
	}
});

test("probeBwrap runs a functional namespace probe and caches per binary", () => {
	resetSandboxProbeCacheForTesting();
	const calls: string[][] = [];
	const probe = probeBwrap("bwrap-test", (_bin, args) => {
		calls.push(args);
		return !args.includes("--unshare-net");
	});
	assert.deepEqual(probe, { ok: true, unshareNet: false });
	assert.equal(calls.length, 2);
	assert.ok(calls[0]!.includes("--unshare-pid"));
	assert.equal(calls[1]![0], "--unshare-net");
	// Cached: the runner must not be consulted again.
	const again = probeBwrap("bwrap-test", () => {
		throw new Error("must not re-run");
	});
	assert.deepEqual(again, probe);
	resetSandboxProbeCacheForTesting();
	const missing = probeBwrap("bwrap-test", () => false);
	assert.equal(missing.ok, false);
	resetSandboxProbeCacheForTesting();
});

test("resolveWorkerCommand handles nvm-style and standalone layouts without hardcoded users", () => {
	const pi = resolveWorkerCommand("pi", fakeEnv, fakeFs);
	assert.ok(pi);
	assert.equal(pi.execPath, "/home/user/.nvm/versions/node/v24.15.0/bin/pi");
	// bin parent widens to the version root so lib/node_modules stays reachable.
	assert.deepEqual(pi.readOnlyRoots, ["/home/user/.nvm/versions/node/v24.15.0"]);
	assert.ok(pi.pathDirs.includes("/home/user/.nvm/versions/node/v24.15.0/bin"));

	const claude = resolveWorkerCommand("claude", fakeEnv, fakeFs);
	assert.ok(claude);
	assert.equal(claude.execPath, "/home/user/.local/share/claude/versions/2.1.211/claude");
	assert.deepEqual(claude.readOnlyRoots, ["/home/user/.local/share/claude/versions/2.1.211"]);
	assert.deepEqual(claude.pathDirs, ["/home/user/.local/bin", "/home/user/.local/share/claude/versions/2.1.211"]);

	assert.equal(resolveWorkerCommand("missing-cmd", fakeEnv, fakeFs), undefined);
	assert.equal(resolveWorkerCommand("relative/path", fakeEnv, fakeFs), undefined);
});

test("buildBwrapArgs is deterministic and never uses a whole-root policy or env values in argv", () => {
	const config = sandbox({ mode: "required", env: "allowlist", readOnlyPaths: ["/opt/runtime"] });
	const req = request({ readOnlyTryPaths: ["/home/user/.pi"], readWritePaths: ["/home/user/.claude-account1"] });
	const args = buildBwrapArgs(config, req, "/usr/bin/pi-real", ["/usr/lib/pi"]);
	assert.deepEqual(args, buildBwrapArgs(config, req, "/usr/bin/pi-real", ["/usr/lib/pi"]));
	const text = args.join(" ");
	assert.ok(!text.includes("--ro-bind / /"), "must not ro-bind the whole root");
	for (const flag of ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try"]) {
		assert.ok(args.includes(flag), flag);
	}
	assert.ok(text.includes("--proc /proc") && text.includes("--dev /dev") && text.includes("--tmpfs /tmp"));
	assert.ok(text.includes("--ro-bind /usr/lib/pi /usr/lib/pi"));
	assert.ok(text.includes("--ro-bind /opt/runtime /opt/runtime"), "configured paths are strict binds");
	assert.ok(text.includes("--ro-bind-try /home/user/.pi /home/user/.pi"));
	assert.ok(text.includes(`--bind ${req.homeDir} ${req.homeDir}`));
	assert.ok(text.includes("--bind /work/repo /work/repo") && text.includes("--chdir /work/repo"));
	assert.ok(text.includes("--bind /home/user/.claude-account1 /home/user/.claude-account1"));
	assert.ok(!args.includes("--unshare-net"), "host network omits --unshare-net");
	assert.ok(!args.includes("--setenv"), "env values never appear in argv");
	assert.ok(!text.includes("do-not-leak"));
	assert.equal(args.at(-3), "/usr/bin/pi-real");

	const netNone = buildBwrapArgs(sandbox({ network: "none" }), req, "/usr/bin/pi-real", []);
	assert.ok(netNone.includes("--unshare-net"), "network none actually unshares the namespace");
});

test("mode off preserves legacy direct launch with inherited environment", () => {
	const launch = resolveWorkerLaunch(sandbox(), request(), fakeEnv, () => {
		throw new Error("off must not probe");
	}, fakeFs);
	assert.ok(launch.ok && !launch.sandboxed && launch.warning === undefined);
	assert.equal(launch.spec.command, "pi");
	assert.deepEqual(launch.spec.args, ["--mode", "rpc"]);
	assert.equal(launch.spec.env.SECRET_TOKEN, "do-not-leak");
	assert.equal(launch.spec.env.PI_ORCHESTRATOR_WORKER, "1");
	assert.equal(launch.spec.env.HOME, "/home/user");
});

test("allowlist env policy strips unknown names and honors additions and overrides", () => {
	const launch = resolveWorkerLaunch(
		sandbox({ mode: "required", env: "allowlist", envAllow: ["EXTRA_OK"] }),
		request({ envOverrides: { PI_ORCHESTRATOR_WORKER: "1", CLAUDE_CONFIG_DIR: "/home/user/.claude-a" } }),
		{ ...fakeEnv, EXTRA_OK: "yes" },
		() => ({ ok: true, unshareNet: true }),
		fakeFs,
	);
	assert.ok(launch.ok && launch.sandboxed);
	assert.equal(launch.spec.env.SECRET_TOKEN, undefined);
	assert.equal(launch.spec.env.EXTRA_OK, "yes");
	assert.equal(launch.spec.env.TERM, "xterm-256color");
	assert.equal(launch.spec.env.CLAUDE_CONFIG_DIR, "/home/user/.claude-a");
	assert.equal(launch.spec.env.HOME, request().homeDir, "sandboxed HOME is the isolated home");
	assert.equal(launch.spec.env.TMPDIR, "/tmp");
	assert.ok(launch.spec.env.PATH!.startsWith("/home/user/.nvm/versions/node/v24.15.0/bin"));
	for (const name of SAFE_ENV_NAMES) assert.ok(!name.includes("KEY") && !name.includes("TOKEN") && !name.includes("SECRET"));
});

test("required mode fails closed on probe, network, resolution, and invalid config", () => {
	const req = request();
	const probeFail = resolveWorkerLaunch(sandbox({ mode: "required" }), req, fakeEnv, () => ({ ok: false, reason: "no namespaces" }), fakeFs);
	assert.ok(!probeFail.ok && /required but unavailable/.test(probeFail.error));
	const netFail = resolveWorkerLaunch(sandbox({ mode: "required", network: "none" }), req, fakeEnv, () => ({ ok: true, unshareNet: false }), fakeFs);
	assert.ok(!netFail.ok && /unshare-net/.test(netFail.error));
	const resolveFail = resolveWorkerLaunch(sandbox({ mode: "required" }), request({ command: "missing-cmd" }), fakeEnv, () => ({ ok: true, unshareNet: true }), fakeFs);
	assert.ok(!resolveFail.ok);
	const invalid = resolveWorkerLaunch(INVALID_SANDBOX_CONFIG, req, fakeEnv, () => ({ ok: true, unshareNet: true }), fakeFs);
	assert.ok(!invalid.ok && /invalid/.test(invalid.error));
});

test("preferred mode sandboxes when possible and falls back with an explicit warning", () => {
	const ok = resolveWorkerLaunch(sandbox({ mode: "preferred" }), request(), fakeEnv, () => ({ ok: true, unshareNet: true }), fakeFs);
	assert.ok(ok.ok && ok.sandboxed && ok.warning === undefined);
	assert.equal(ok.spec.command, "bwrap");
	assert.ok(ok.spec.args.includes("--unshare-pid"));

	const fallback = resolveWorkerLaunch(sandbox({ mode: "preferred" }), request(), fakeEnv, () => ({ ok: false, reason: "missing" }), fakeFs);
	assert.ok(fallback.ok && !fallback.sandboxed);
	assert.match(fallback.warning ?? "", /WITHOUT sandbox/);
	assert.equal(fallback.spec.command, "pi");

	const netFallback = resolveWorkerLaunch(sandbox({ mode: "preferred", network: "none" }), request(), fakeEnv, () => ({ ok: true, unshareNet: false }), fakeFs);
	assert.ok(netFallback.ok && !netFallback.sandboxed, "an unenforceable network:none must not pretend to be sandboxed");
	assert.match(netFallback.warning ?? "", /WITHOUT sandbox/);
});

test("launch specs cover every worker path shape: pi rpc, claude initial, claude resume", () => {
	const config = sandbox({ mode: "required" });
	const probe = () => ({ ok: true, unshareNet: true }) as const;
	const pi = resolveWorkerLaunch(config, request({ readOnlyTryPaths: ["/home/user/.pi"] }), fakeEnv, probe, fakeFs);
	assert.ok(pi.ok && pi.sandboxed);
	assert.deepEqual(pi.spec.args.slice(-3), ["/home/user/.nvm/versions/node/v24.15.0/bin/pi", "--mode", "rpc"]);

	const claudeInitial = resolveWorkerLaunch(
		config,
		request({ command: "claude", args: ["-p", "--model", "opus"], envOverrides: { PI_ORCHESTRATOR_WORKER: "1", CLAUDE_CONFIG_DIR: "/home/user/.claude-account1" }, readWritePaths: ["/home/user/.claude-account1"] }),
		fakeEnv,
		probe,
		fakeFs,
	);
	assert.ok(claudeInitial.ok && claudeInitial.sandboxed);
	assert.ok(claudeInitial.spec.args.join(" ").includes("--bind /home/user/.claude-account1 /home/user/.claude-account1"));

	const claudeResume = resolveWorkerLaunch(
		config,
		request({ command: "claude", args: ["-p", "--model", "opus", "--resume", "session-1"], envOverrides: { PI_ORCHESTRATOR_WORKER: "1", CLAUDE_CONFIG_DIR: "/home/user/.claude-account2" }, readWritePaths: ["/home/user/.claude-account2"] }),
		fakeEnv,
		probe,
		fakeFs,
	);
	assert.ok(claudeResume.ok && claudeResume.sandboxed);
	assert.deepEqual(claudeResume.spec.args.slice(-2), ["--resume", "session-1"]);
	assert.ok(claudeResume.spec.args.join(" ").includes("/home/user/.claude-account2"));
});

test("nvm npm-bin symlink shape mounts the Node version root, not the package dist dir", () => {
	// Real-filesystem regression for the actual VPS layout:
	// <home>/.nvm/versions/node/<v>/bin/pi -> ../lib/node_modules/<pkg>/dist/cli.js
	const home = mkdtempSync(join(tmpdir(), "pi-orchestrator-nvm-"));
	const versionRoot = join(home, ".nvm", "versions", "node", "v24.15.0");
	const distDir = join(versionRoot, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist");
	const binDir = join(versionRoot, "bin");
	try {
		mkdirSync(distDir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(distDir, "cli.js"), "#!/usr/bin/env node\n");
		writeFileSync(join(binDir, "node"), "");
		symlinkSync(join("..", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), join(binDir, "pi"));
		const resolved = resolveWorkerCommand("pi", { PATH: `${binDir}:/usr/bin` });
		assert.ok(resolved);
		assert.equal(resolved.execPath, join(distDir, "cli.js"));
		assert.deepEqual(resolved.readOnlyRoots, [versionRoot], "the whole Node version root must be mounted, not dist/");
		assert.ok(resolved.pathDirs.includes(binDir), "bin/node must be resolvable via PATH inside the sandbox");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("pi worker plan exposes only allowlisted files, never host .pi or broad config dirs", () => {
	const home = "/home/user";
	const homeDir = "/home/user/.cache/pi-orchestrator/worker-homes/luna-1";
	const plan = piWorkerSandboxPlan(homeDir, home);
	assert.deepEqual(plan.sandboxEnvOverrides, { PI_CODING_AGENT_DIR: join(homeDir, "pi-agent") });
	assert.deepEqual(plan.fileMountsReadOnlyTry, [
		{ source: "/home/user/.pi/agent/auth.json", dest: join(homeDir, "pi-agent", "auth.json") },
		{ source: "/home/user/.pi/agent/models.json", dest: join(homeDir, "pi-agent", "models.json") },
		{ source: "/home/user/.config/agent/gateway.token", dest: "/home/user/.config/agent/gateway.token" },
	]);

	const nvmFs: CommandFs = {
		existsSync: (path) => path === "/home/user/.nvm/versions/node/v24.15.0/bin/pi",
		realpathSync: () => "/home/user/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
	};
	const launch = resolveWorkerLaunch(
		sandbox({ mode: "required", env: "allowlist" }),
		request({ homeDir, ...plan }),
		fakeEnv,
		() => ({ ok: true, unshareNet: true }),
		nvmFs,
	);
	assert.ok(launch.ok && launch.sandboxed);
	const args = launch.spec.args;
	// Negative argv assertions: private host state must never be a bind source
	// or destination. (--dir targets are namespace-only creation, not mounts.)
	const mountTargets = args.filter((_, index) => /--(?:ro-)?bind(?:-try)?$/.test(args[index - 1] ?? "") || /--(?:ro-)?bind(?:-try)?$/.test(args[index - 2] ?? ""));
	for (const forbidden of [
		"/home/user/.pi",
		"/home/user/.pi/agent",
		"/home/user/.pi/agent/sessions",
		"/home/user/.pi/agent/chat",
		"/home/user/.pi/agent/secret-store",
		"/home/user/.config/agent",
		"/home/user/.config/pi",
	]) {
		assert.ok(!mountTargets.includes(forbidden), `must not mount ${forbidden}`);
	}
	assert.ok(mountTargets.includes("/home/user/.config/agent/gateway.token"), "only the exact token file is mounted");
	assert.ok(args.includes(join(homeDir, "pi-agent", "auth.json")));
	// nvm shape: the version root is the mounted runtime, and the isolated
	// agent dir is what the worker's Pi reads.
	assert.ok(args.join(" ").includes("--ro-bind /home/user/.nvm/versions/node/v24.15.0 /home/user/.nvm/versions/node/v24.15.0"));
	assert.equal(launch.spec.env.PI_CODING_AGENT_DIR, join(homeDir, "pi-agent"));
	// File mounts overlay the writable home, so they must come after its bind.
	assert.ok(args.indexOf(join(homeDir, "pi-agent", "auth.json")) > args.indexOf(homeDir));
});

test("file mount destination parents are created explicitly, deduplicated, and ordered before their binds", () => {
	const homeDir = "/home/user/.cache/pi-orchestrator/worker-homes/w1";
	const plan = piWorkerSandboxPlan(homeDir, "/home/user");
	const args = buildBwrapArgs(sandbox({ mode: "required" }), request({ homeDir, ...plan }), "/usr/bin/pi-real", []);
	const isolatedDir = join(homeDir, "pi-agent");
	// Two files share the isolated dir: exactly one --dir for it, plus one for
	// the token's parent (namespace-only; the host ~/.config is never touched).
	const dirTargets = args.flatMap((arg, index) => (arg === "--dir" ? [args[index + 1]!] : []));
	assert.deepEqual(dirTargets, [isolatedDir, "/home/user/.config/agent"]);
	// Ordering: home bind, then each destination's --dir strictly before its file bind.
	const homeBind = args.indexOf(homeDir);
	for (const mount of plan.fileMountsReadOnlyTry) {
		// lastIndexOf: for same-path mounts (gateway.token) the dest slot is the
		// later of the two identical source/dest argv entries.
		const dirIndex = args.indexOf(dirname(mount.dest));
		const bindIndex = args.lastIndexOf(mount.dest);
		assert.ok(homeBind < dirIndex && dirIndex < bindIndex, `--dir for ${mount.dest} must sit between the home bind and the file bind`);
		assert.equal(args[bindIndex - 2], "--ro-bind-try");
	}
});

test("sandbox-only env overrides never leak into unsandboxed launches", () => {
	const plan = piWorkerSandboxPlan("/home/user/.cache/pi-orchestrator/worker-homes/w1", "/home/user");
	const fallback = resolveWorkerLaunch(sandbox({ mode: "preferred" }), request(plan), fakeEnv, () => ({ ok: false, reason: "missing" }), fakeFs);
	assert.ok(fallback.ok && !fallback.sandboxed);
	assert.equal(fallback.spec.env.PI_CODING_AGENT_DIR, undefined, "an isolated dir that only exists inside the sandbox must not be set for direct spawns");
	const off = resolveWorkerLaunch(sandbox(), request(plan), fakeEnv, () => ({ ok: true, unshareNet: true }), fakeFs);
	assert.ok(off.ok && !off.sandboxed);
	assert.equal(off.spec.env.PI_CODING_AGENT_DIR, undefined);
});

test("worker home creation repairs permissions on pre-existing directories", () => {
	const base = mkdtempSync(join(tmpdir(), "pi-orchestrator-homes-"));
	const dir = join(base, "worker-homes", "w1");
	try {
		mkdirSync(dir, { recursive: true, mode: 0o755 });
		chmodSync(dir, 0o755);
		chmodSync(join(base, "worker-homes"), 0o755);
		createWorkerHomeDir(dir);
		assert.equal(statSync(dir).mode & 0o777, 0o700);
		assert.equal(statSync(join(base, "worker-homes")).mode & 0o777, 0o700);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("cleanup containment is path-component-safe, not a bare prefix match", () => {
	// A sibling of the allowed base that shares its string prefix must survive.
	const evil = mkdtempSync(join(homedir(), ".cache", "pi-orchestrator-evil-"));
	try {
		cleanupWorkerHomeDir(evil);
		assert.ok(statSync(evil).isDirectory(), "prefix-sharing sibling must not be deleted");
	} finally {
		rmSync(evil, { recursive: true, force: true });
	}
	// The allowed base itself is not a valid worker home either.
	cleanupWorkerHomeDir(join(homedir(), ".cache", "pi-orchestrator"));
	// A genuine worker home under tmpdir (smoke-test shape) is removable.
	const ok = mkdtempSync(join(tmpdir(), "pi-orchestrator-home-"));
	cleanupWorkerHomeDir(ok);
	assert.throws(() => statSync(ok));
});

test("worker home paths are stable, sanitized, and scoped to the orchestrator cache", () => {
	const path = workerHomeDirPath("luna-1a2b3c4d");
	assert.ok(path.startsWith(join(homedir(), ".cache", "pi-orchestrator")));
	assert.equal(workerHomeDirPath("../../etc"), join(homedir(), ".cache", "pi-orchestrator", "worker-homes", "-etc"));
});
