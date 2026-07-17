import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	DEFAULT_SANDBOX_CONFIG,
	piWorkerSandboxPlan,
	probeBwrap,
	resetSandboxProbeCacheForTesting,
	resolveWorkerCommand,
	resolveWorkerLaunch,
} from "../extensions/orchestrator-lib/orchestrator-sandbox.ts";
import { GATEWAY_PLACEHOLDER, startGatewayRelay } from "../extensions/orchestrator-lib/orchestrator-gateway.ts";

/**
 * Opt-in smoke test against a real bubblewrap install:
 *   npm run smoke:bwrap
 * Regular `npm test` skips it so CI and hosts without bwrap stay green.
 */
const enabled = process.env.PI_ORCHESTRATOR_BWRAP_SMOKE === "1";
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
function waitForFile(path: string): void {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) { try { readFileSync(path); return; } catch {} Atomics.wait(waitBuffer, 0, 0, 10); }
	throw new Error("smoke helper readiness timed out");
}

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

test("real bwrap: a selected repo is writable while an ancestor home sentinel stays invisible", { skip: !enabled }, () => {
	resetSandboxProbeCacheForTesting();
	assert.ok(probeBwrap("bwrap").ok, "bwrap must be functional for this smoke test");

	// Layout mirrors the live incident: a home-like ancestor holding a secret
	// sentinel, a code root under it, and a selected repo inside that root.
	// Only the repo may be mounted; the ancestor must stay invisible even
	// though the repo bind comes after the isolated-home/token submounts.
	const fakeHostHome = mkdtempSync(join(tmpdir(), "pi-orchestrator-smoke-anchome-"));
	const sentinel = join(fakeHostHome, "SECRET-SENTINEL.txt");
	writeFileSync(sentinel, "must-not-be-visible\n");
	const repo = join(fakeHostHome, "code", "myrepo");
	mkdirSync(repo, { recursive: true });
	const tokenSource = join(fakeHostHome, ".config", "agent", "gateway.token");
	mkdirSync(dirname(tokenSource), { recursive: true });
	writeFileSync(tokenSource, "fake-smoke-token\n");
	const home = mkdtempSync(join(tmpdir(), "pi-orchestrator-smoke-home-"));
	try {
		const launch = resolveWorkerLaunch(
			{ ...DEFAULT_SANDBOX_CONFIG, mode: "required", env: "allowlist", workspaceRoots: [join(fakeHostHome, "code")] },
			{
				command: "sh",
				args: ["-c", [
					`pwd`,
					`echo repo-write > written.txt && cat written.txt`,
					`test ! -e '${sentinel}' && echo sentinel-invisible`,
					`cat "$HOME/.config/agent/gateway.token"`,
				].join("; ")],
				cwd: repo,
				envOverrides: {},
				homeDir: home,
				...piWorkerSandboxPlan(home, fakeHostHome),
			},
		);
		assert.ok(launch.ok && launch.sandboxed, launch.ok ? "" : launch.error);
		const run = spawnSync(launch.spec.command, launch.spec.args, { env: launch.spec.env, encoding: "utf8", timeout: 30_000 });
		assert.equal(run.status, 0, run.stderr);
		const lines = run.stdout.trim().split("\n");
		assert.equal(lines[0], repo, "worker starts in the selected repo");
		assert.equal(lines[1], "repo-write", "the selected repo is writable");
		assert.equal(lines[2], "sentinel-invisible", "the ancestor home sentinel is not exposed");
		assert.equal(lines[3], "fake-smoke-token", "the isolated-home token survives the workspace bind order");
		assert.equal(readFileSync(join(repo, "written.txt"), "utf8"), "repo-write\n", "the write landed on the host repo");
	} finally {
		rmSync(fakeHostHome, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
	resetSandboxProbeCacheForTesting();
});


test("real bwrap: gateway-only loopback has zero caps, streaming relay, blocked egress, immutable UDS, and no secrets", { skip: !enabled }, async () => {
	resetSandboxProbeCacheForTesting();
	assert.ok(probeBwrap("bwrap").ok, "bwrap must be functional");
	const root = mkdtempSync(join(tmpdir(), "pio-gateway-smoke-"));
	const cwd = join(root, "work"); const home = join(root, "home"); const runtime = join(root, "runtime");
	mkdirSync(cwd); mkdirSync(home); mkdirSync(runtime);
	const tokenFile = join(root, "token"); writeFileSync(tokenFile, "fake-only-smoke-token\n", { mode: 0o600 }); chmodSync(tokenFile, 0o600);
	const sentinel = join(root, "SECRET-HOST-FILE"); writeFileSync(sentinel, "invisible\n");
	const ready = join(root, "upstream-ready");
	const port = 20_000 + Math.floor(Math.random() * 20_000);
	const upstreamScript = join(root, "upstream.mjs");
	writeFileSync(upstreamScript, `import http from "node:http";import{writeFileSync}from"node:fs";const s=http.createServer((q,r)=>{if(q.headers.authorization!=="Bearer fake-only-smoke-token"){r.writeHead(401);r.end();return}let b="";q.on("data",c=>b+=c);q.on("end",()=>{r.writeHead(200,{"content-type":"text/event-stream"});r.write("data: "+b+"\\n\\n");setTimeout(()=>r.end("data: done\\n\\n"),10)})});s.listen(${port},"127.0.0.1",()=>writeFileSync(${JSON.stringify(ready)},"ready"));`);
	const upstream = spawn(process.execPath, [upstreamScript], { stdio: "ignore" });
	let relay: ReturnType<typeof startGatewayRelay> | undefined;
	try {
		// Kernel-level proof for this host: root in the same user/net namespace
		// shape reaches a read-only-mounted UDS as Kyle's host uid via SO_PEERCRED.
		const peerDir = join(root, "peer"); mkdirSync(peerDir, { mode: 0o700 });
		const peerSocket = join(peerDir, "s"); const peerResult = join(root, "peer-result"); const peerReady = join(root, "peer-ready");
		const peerServer = join(root, "peer.py");
		writeFileSync(peerServer, `import socket,struct\ns=socket.socket(socket.AF_UNIX);s.bind(${JSON.stringify(peerSocket)});s.listen(1);open(${JSON.stringify(peerReady)},'w').write('1');c,_=s.accept();p=c.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12);open(${JSON.stringify(peerResult)},'w').write(str(struct.unpack('3i',p)[1]));c.close();s.close()\n`);
		const peer = spawn("/usr/bin/python3", [peerServer], { stdio: "ignore" }); waitForFile(peerReady);
		assert.deepEqual(readdirSync(peerDir), ["s"]);
		const peerRun = spawnSync("bwrap", ["--die-with-parent", "--unshare-user", "--uid", "0", "--gid", "0", "--unshare-net", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64", "--ro-bind", peerDir, "/peer", "--proc", "/proc", "--dev", "/dev", "/usr/bin/python3", "-c", "import socket;s=socket.socket(socket.AF_UNIX);s.connect('/peer/s');s.close()"]);
		assert.equal(peerRun.status, 0); waitForFile(peerResult); assert.equal(Number(readFileSync(peerResult, "utf8")), process.getuid?.()); peer.kill();
		waitForFile(ready);
		relay = startGatewayRelay("smoke", { upstreamUrl: `http://127.0.0.1:${port}`, tokenFile }, runtime);
		const workerScript = join(cwd, "worker.mjs");
		writeFileSync(workerScript, `import http from"node:http";import{readFileSync,writeFileSync}from"node:fs";const caps=Object.fromEntries(readFileSync("/proc/self/status","utf8").split("\\n").filter(x=>x.startsWith("Cap")).map(x=>x.split(":").map(y=>y.trim())));const request=(host,port,timeout=500)=>new Promise(ok=>{const q=http.request({host,port,path:"/v1/messages",method:"POST",timeout},r=>{let b="";r.on("data",c=>b+=c);r.on("end",()=>ok({ok:true,b}))});q.on("timeout",()=>q.destroy());q.on("error",()=>ok({ok:false}));q.end("stream")});const good=await request("127.0.0.1",4000);const external=await request("192.0.2.1",80);const other=await request("127.0.0.1",4001);let immutable=false;try{writeFileSync("/g/x","x")}catch{immutable=true}let secret=false;try{readFileSync(${JSON.stringify(sentinel)}) ;secret=true}catch{}console.log(JSON.stringify({caps,good,external,other,immutable,secret,placeholder:process.env.ANTHROPIC_AUTH_TOKEN}));`);
		const node = resolveWorkerCommand(process.execPath)!;
		const config = { ...DEFAULT_SANDBOX_CONFIG, mode: "required", network: "gateway", env: "allowlist", gateway: { upstreamUrl: `http://127.0.0.1:${port}`, tokenFile } } as const;
		const launch = resolveWorkerLaunch(config, {
			command: process.execPath, args: [workerScript], cwd, homeDir: home,
			envOverrides: { ANTHROPIC_AUTH_TOKEN: GATEWAY_PLACEHOLDER },
			gateway: { relayDirectory: relay.directory, nodePath: process.execPath, nodeRoot: node.readOnlyRoots[0]!, bootstrapPath: relay.bootstrapPath, entrypointPath: relay.entrypointPath },
		}, process.env);
		assert.ok(launch.ok && launch.sandboxed, launch.ok ? "" : launch.error);
		const run = spawnSync(launch.spec.command, launch.spec.args, { env: launch.spec.env, encoding: "utf8", timeout: 30_000 });
		assert.equal(run.status, 0, run.stderr);
		const result = JSON.parse(run.stdout.trim());
		assert.deepEqual(Object.values(result.caps), ["0000000000000000", "0000000000000000", "0000000000000000", "0000000000000000", "0000000000000000"]);
		assert.deepEqual(result.good, { ok: true, b: "data: stream\n\ndata: done\n\n" });
		assert.equal(result.external.ok, false); assert.equal(result.other.ok, false);
		assert.equal(result.immutable, true); assert.equal(result.secret, false); assert.equal(result.placeholder, GATEWAY_PLACEHOLDER);
	} finally {
		if (relay) await relay.cleanup(); upstream.kill(); rmSync(root, { recursive: true, force: true }); resetSandboxProbeCacheForTesting();
	}
});
