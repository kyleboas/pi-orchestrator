import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_SANDBOX_CONFIG,
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
	try {
		const launch = resolveWorkerLaunch(
			{ ...DEFAULT_SANDBOX_CONFIG, mode: "required", env: "allowlist" },
			{ command: "sh", args: ["-c", "echo sandbox-ok; test ! -e /root; echo $HOME; pwd"], cwd, envOverrides: {}, homeDir: home },
		);
		assert.ok(launch.ok && launch.sandboxed);
		const run = spawnSync(launch.spec.command, launch.spec.args, { env: launch.spec.env, encoding: "utf8", timeout: 30_000 });
		assert.equal(run.status, 0, run.stderr);
		const lines = run.stdout.trim().split("\n");
		assert.equal(lines[0], "sandbox-ok");
		assert.equal(lines[1], home, "HOME is the isolated home");
		assert.equal(lines[2], cwd, "cwd is the workspace");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
	resetSandboxProbeCacheForTesting();
});
