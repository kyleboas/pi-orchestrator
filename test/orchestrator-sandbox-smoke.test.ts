import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	DEFAULT_SANDBOX_CONFIG,
	piWorkerSandboxPlan,
	probeBwrap,
	resetSandboxProbeCacheForTesting,
	resolveWorkerLaunch,
} from "../extensions/orchestrator-lib/orchestrator-sandbox.ts";

/**
 * Opt-in smoke test against a real bubblewrap install:
 *   npm run smoke:bwrap
 * Regular `npm test` skips it so CI and hosts without bwrap stay green.
 */
const enabled = process.env.PI_ORCHESTRATOR_BWRAP_SMOKE === "1";

test("real bwrap probe and sandboxed launch", { skip: !enabled }, () => {
	resetSandboxProbeCacheForTesting();
	const probe = probeBwrap("bwrap");
	assert.ok(probe.ok, "bwrap must be installed and able to create namespaces for this smoke test");

	const cwd = mkdtempSync(join(tmpdir(), "pi-orchestrator-smoke-cwd-"));
	const home = mkdtempSync(join(tmpdir(), "pi-orchestrator-smoke-home-"));
	// A file mounted at a nested destination whose parent does not exist inside
	// the namespace: the argument plan must create the parent explicitly.
	const sourceDir = mkdtempSync(join(tmpdir(), "pi-orchestrator-smoke-src-"));
	const sourceFile = join(sourceDir, "auth.json");
	writeFileSync(sourceFile, "smoke-secret\n");
	const nestedDest = join(home, "pi-agent", "auth.json");
	try {
		const launch = resolveWorkerLaunch(
			{ ...DEFAULT_SANDBOX_CONFIG, mode: "required", env: "allowlist" },
			{
				command: "sh",
				args: ["-c", `echo sandbox-ok; test ! -e /root; echo $HOME; pwd; cat '${nestedDest}'; if echo overwrite > '${nestedDest}' 2>/dev/null; then echo writable; else echo read-only; fi`],
				cwd,
				envOverrides: {},
				homeDir: home,
				fileMountsReadOnlyTry: [{ source: sourceFile, dest: nestedDest }],
			},
		);
		assert.ok(launch.ok && launch.sandboxed);
		const run = spawnSync(launch.spec.command, launch.spec.args, { env: launch.spec.env, encoding: "utf8", timeout: 30_000 });
		assert.equal(run.status, 0, run.stderr);
		const lines = run.stdout.trim().split("\n");
		assert.equal(lines[0], "sandbox-ok");
		assert.equal(lines[1], home, "HOME is the isolated home");
		assert.equal(lines[2], cwd, "cwd is the workspace");
		assert.equal(lines[3], "smoke-secret", "nested file mount is readable despite a missing parent");
		assert.equal(lines[4], "read-only", "nested file mount must reject writes");
		assert.equal(readFileSync(sourceFile, "utf8"), "smoke-secret\n", "source file remains unchanged");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
		rmSync(sourceDir, { recursive: true, force: true });
	}
	resetSandboxProbeCacheForTesting();
});

test("real bwrap: gateway token resolves at $HOME/.config/agent/gateway.token, not a host-home path", { skip: !enabled }, () => {
	resetSandboxProbeCacheForTesting();
	assert.ok(probeBwrap("bwrap").ok, "bwrap must be functional for this smoke test");

	const cwd = mkdtempSync(join(tmpdir(), "pi-orchestrator-smoke-cwd-"));
	const home = mkdtempSync(join(tmpdir(), "pi-orchestrator-smoke-home-"));
	// A fake host home carrying a fake token: the real token is never read.
	const fakeHostHome = mkdtempSync(join(tmpdir(), "pi-orchestrator-smoke-host-"));
	const fakeTokenSource = join(fakeHostHome, ".config", "agent", "gateway.token");
	mkdirSync(dirname(fakeTokenSource), { recursive: true });
	writeFileSync(fakeTokenSource, "fake-smoke-token\n");
	try {
		const plan = piWorkerSandboxPlan(home, fakeHostHome);
		const sandboxToken = join(home, ".config", "agent", "gateway.token");
		const launch = resolveWorkerLaunch(
			{ ...DEFAULT_SANDBOX_CONFIG, mode: "required", env: "allowlist" },
			{
				command: "sh",
				// The platform contract path: consumers resolve ~/.config/agent/gateway.token against $HOME.
				args: ["-c", [
					`cat "$HOME/.config/agent/gateway.token"`,
					`if echo x > "$HOME/.config/agent/gateway.token" 2>/dev/null; then echo writable; else echo read-only; fi`,
					`test ! -e '${fakeTokenSource}' && echo no-host-style-dest`,
				].join("; ")],
				cwd,
				envOverrides: {},
				homeDir: home,
				...plan,
			},
		);
		assert.ok(launch.ok && launch.sandboxed);
		assert.equal(launch.spec.env.HOME, home);
		const run = spawnSync(launch.spec.command, launch.spec.args, { env: launch.spec.env, encoding: "utf8", timeout: 30_000 });
		assert.equal(run.status, 0, run.stderr);
		const lines = run.stdout.trim().split("\n");
		assert.equal(lines[0], "fake-smoke-token", "token is readable at the $HOME-relative contract path");
		assert.equal(lines[1], "read-only", "token mount must reject writes");
		assert.equal(lines[2], "no-host-style-dest", "no host-home-style token destination is exposed");
		assert.equal(readFileSync(fakeTokenSource, "utf8"), "fake-smoke-token\n", "fake source remains unchanged");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
		rmSync(fakeHostHome, { recursive: true, force: true });
	}
	resetSandboxProbeCacheForTesting();
});
