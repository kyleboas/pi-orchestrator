import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GATEWAY_PLACEHOLDER, SANDBOX_GATEWAY_BASE_URL, buildHostRelayBwrapArgs, claudeGatewayEnv, startGatewayRelay, validateGatewayTokenFile, writeGatewayPiModels } from "../extensions/orchestrator-lib/orchestrator-gateway.ts";
import { buildBwrapArgs, DEFAULT_SANDBOX_CONFIG, parseSandboxConfig, piWorkerSandboxPlan, resolveWorkerLaunch } from "../extensions/orchestrator-lib/orchestrator-sandbox.ts";

function requestUds(socketPath: string, body: string, path = "/v1/messages", method = "POST"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method, headers: { authorization: "worker-secret", "proxy-authorization": "bad", "x-api-key": "bad", connection: "close", "content-type": "text/plain" } }, (res) => {
      let text = ""; res.on("data", (chunk) => text += chunk); res.on("end", () => resolve({ status: res.statusCode!, body: text }));
    });
    req.on("error", reject); req.end(body);
  });
}

test("gateway config accepts only an HTTP loopback origin and safe absolute token path", () => {
  const good = parseSandboxConfig({ mode: "required", network: "gateway", gateway: { upstreamUrl: "http://127.0.0.1:4000", tokenFile: "/home/user/.config/agent/gateway.token" } });
  assert.equal(good?.gateway?.upstreamUrl, "http://127.0.0.1:4000");
  assert.equal(parseSandboxConfig({ mode: "off", network: "gateway", gateway: { upstreamUrl: "http://127.0.0.1:4000", tokenFile: "/x" } }), undefined, "off+gateway is rejected before any relay can start");
  const preferred = parseSandboxConfig({ mode: "preferred", network: "gateway", gateway: { upstreamUrl: "http://127.0.0.1:4000", tokenFile: "/x" } })!;
  const failed = resolveWorkerLaunch(preferred, { command: "pi", args: [], cwd: "/work", homeDir: "/tmp/home", envOverrides: {} }, {}, () => ({ ok: false, reason: "probe failed" }));
  assert.ok(!failed.ok, "preferred gateway must never fall back to a direct spawn");
  for (const bad of [
    { network: "gateway" },
    { network: "host", gateway: { upstreamUrl: "http://127.0.0.1:4000", tokenFile: "/x" } },
    { network: "gateway", gateway: { upstreamUrl: "https://127.0.0.1:4000", tokenFile: "/x" } },
    { network: "gateway", gateway: { upstreamUrl: "http://localhost:4000", tokenFile: "/x" } },
    { network: "gateway", gateway: { upstreamUrl: "http://127.0.0.1:4000/path", tokenFile: "/x" } },
    { network: "gateway", gateway: { upstreamUrl: "http://127.0.0.1:4000", tokenFile: "relative" } },
    { network: "gateway", gateway: { upstreamUrl: "http://127.0.0.1:4000", tokenFile: "/x", token: "never" } },
  ]) assert.equal(parseSandboxConfig(bad), undefined);
});

test("host relay mount plan is minimal and token validation rejects links and loose permissions", () => {
  const args = buildHostRelayBwrapArgs("/node24", "/package/relay.mjs", "/safe/token", "/runtime/relay");
  assert.ok(!args.some((arg, i) => arg === "/" && args[i - 1] === "--ro-bind"), "never mount the host root");
  for (const forbidden of ["/home", "/root", "/run", "/etc", "/usr"]) assert.ok(!args.includes(forbidden));
  assert.ok(args.join(" ").includes("--ro-bind /node24 /runtime"));
  assert.ok(args.join(" ").includes("--ro-bind /package/relay.mjs /orchestrator/relay.mjs"));
  assert.ok(args.join(" ").includes("--ro-bind /safe/token /gateway.token"));
  assert.ok(args.includes("--cap-drop") && args.includes("ALL"));
  const root = mkdtempSync(join(tmpdir(), "pio-token-"));
  try {
    const token = join(root, "token"); writeFileSync(token, "fake\n", { mode: 0o600 });
    assert.equal(validateGatewayTokenFile(token), token);
    chmodSync(token, 0o644); assert.throws(() => validateGatewayTokenFile(token), /unsafe/); chmodSync(token, 0o600);
    const link = join(root, "link"); symlinkSync(token, link); assert.throws(() => validateGatewayTokenFile(link), /unsafe/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("gateway bwrap plan has exactly two bootstrap caps, argv-only bootstrap, UDS bind, and complete drop", () => {
  const home = "/home/user/.cache/pi-orchestrator/worker-homes/w";
  const plan = piWorkerSandboxPlan(home, "/home/user", true);
  const args = buildBwrapArgs({ ...DEFAULT_SANDBOX_CONFIG, mode: "required", network: "gateway", gateway: { upstreamUrl: "http://127.0.0.1:4000", tokenFile: "/token" } }, {
    command: "pi", args: ["--mode", "rpc"], cwd: "/work", envOverrides: {}, homeDir: home, ...plan,
    gateway: { relayDirectory: "/run/user/1000/pi-gw/w", nodePath: "/node/bin/node", nodeRoot: "/node", bootstrapPath: "/trusted/bootstrap.sh", entrypointPath: "/trusted/entrypoint.mjs" },
  }, "/node/bin/pi", ["/node"]);
  assert.equal(args.filter((x) => x === "--cap-add").length, 2);
  assert.deepEqual(args.slice(args.indexOf("--unshare-user"), args.indexOf("--proc")), ["--unshare-user", "--uid", "0", "--gid", "0", "--unshare-net", "--cap-add", "CAP_NET_ADMIN", "--cap-add", "CAP_SETPCAP"]);
  assert.ok(args.join(" ").includes("--ro-bind /run/user/1000/pi-gw/w /g"));
  assert.deepEqual(args.slice(-9), ["/bin/sh", "/orchestrator/bootstrap.sh", "--", "/node/bin/node", "/orchestrator/entrypoint.mjs", "/g/r", "/node/bin/pi", "--mode", "rpc"]);
  assert.ok(!args.includes("-c") && !args.includes("sh -c"));
  const bootstrap = readFileSync(new URL("../extensions/orchestrator-lib/gateway-bootstrap.sh", import.meta.url), "utf8");
  for (const drop of ["--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs"]) assert.ok(bootstrap.includes(drop));
  assert.ok(bootstrap.includes("exec /usr/bin/setpriv"));
  assert.ok(!bootstrap.includes(" -c "));
  assert.equal(plan.fileMountsReadOnly.some((m) => m.source.includes("auth.json") || m.source.includes("gateway.token")), false);
  assert.equal(plan.fileMountsReadOnly.some((m) => m.source.endsWith("models.json")), false, "host model configuration is not mounted in gateway mode");
  assert.ok(plan.fileMountsReadOnly.some((m) => m.source.endsWith(".gateway-placeholder")));
  assert.match(GATEWAY_PLACEHOLDER, /^[^.]+\.[^.]+\.[^.]+$/);
});

test("gateway client environments contain only loopback routing and non-secret placeholders", () => {
  assert.deepEqual(claudeGatewayEnv("/isolated/.claude"), {
    PI_ORCHESTRATOR_WORKER: "1",
    CLAUDE_CODE_BUBBLEWRAP: "1",
    CLAUDE_CONFIG_DIR: "/isolated/.claude",
    ANTHROPIC_BASE_URL: SANDBOX_GATEWAY_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: GATEWAY_PLACEHOLDER,
    ANTHROPIC_API_KEY: GATEWAY_PLACEHOLDER,
  });
});

test("gateway Pi model override contains only a loopback provider and non-secret placeholder", () => {
  const root = mkdtempSync(join(tmpdir(), "pio-gw-models-"));
  try {
    const file = writeGatewayPiModels(root, "openai-codex");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(parsed, { providers: { "openai-codex": { baseUrl: SANDBOX_GATEWAY_BASE_URL, apiKey: GATEWAY_PLACEHOLDER } } });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "pi-agent")).mode & 0o777, 0o700);
    assert.throws(() => writeGatewayPiModels(root, "../escape"), /invalid/);
    assert.throws(() => writeGatewayPiModels(root, "openai-codex"), /EEXIST/, "an existing model override is never silently replaced");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("host relay streams bodies and responses, rewrites worker auth, sanitizes failures, and cleans up", async () => {
  const root = mkdtempSync(join(tmpdir(), "pio-gw-"));
  const tokenFile = join(root, "token"); writeFileSync(tokenFile, "real-test-token\n", { mode: 0o600 });
  let observed: http.IncomingHttpHeaders = {}; let observedBody = ""; let observedPath = ""; let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => { upstreamRequests++; observed = req.headers; observedPath = req.url ?? ""; req.on("data", (c) => observedBody += c); req.on("end", () => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: one\n\n"); setTimeout(() => res.end("data: two\n\n"), 10); }); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address === "object");
  const relay = startGatewayRelay("test", { upstreamUrl: `http://127.0.0.1:${address.port}`, tokenFile }, join(root, "r"));
  try {
    for (const [path, method] of [["/admin/keys", "POST"], ["/v1/users", "GET"], ["/v1/messages", "DELETE"], ["http://127.0.0.1/v1/messages", "POST"], ["/v1/messages%2fadmin", "POST"]]) {
      const denied = await requestUds(relay.socketPath, "denied", path!, method!); assert.equal(denied.status, 404);
    }
    assert.equal(upstreamRequests, 0, "denied requests never reach the credential-bearing upstream");
    const response = await requestUds(relay.socketPath, "streamed-body", "/codex/responses?stream=true");
    assert.equal(response.status, 200); assert.equal(response.body, "data: one\n\ndata: two\n\n"); assert.equal(observedBody, "streamed-body");
    assert.equal(observedPath, "/v1/responses?stream=true", "the Codex transport is normalized to the gateway Responses endpoint");
    assert.equal(upstreamRequests, 1); assert.equal(observed.authorization, "Bearer real-test-token"); assert.equal(observed["proxy-authorization"], undefined); assert.equal(observed["x-api-key"], undefined);
    upstream.close(); await new Promise((r) => setTimeout(r, 20));
    const failed = await requestUds(relay.socketPath, "x"); assert.equal(failed.status, 502); assert.equal(failed.body, "gateway unavailable\n");
  } finally { await relay.cleanup(); upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
  assert.throws(() => readFileSync(relay.socketPath), /ENOENT/);
});

test("relay spawn errors and readiness timeouts leave no orphan directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "pio-gw-fail-")); const tokenFile = join(root, "token"); writeFileSync(tokenFile, "fake\n", { mode: 0o600 }); const base = join(root, "relays"); mkdirSync(base);
  try {
    assert.throws(() => startGatewayRelay("broken", { upstreamUrl: "http://127.0.0.1:9", tokenFile }, base, "/definitely/missing-bwrap", 20), /readiness/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(readdirSync(base), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("relay teardown permits immediate same-key reuse without stale generation directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "pio-gw-life-")); const tokenFile = join(root, "token"); writeFileSync(tokenFile, "fake\n", { mode: 0o600 });
  const upstream = http.createServer((_req, res) => res.end("ok")); await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address === "object"); const config = { upstreamUrl: `http://127.0.0.1:${address.port}`, tokenFile };
  try {
    const first = startGatewayRelay("same", config, join(root, "relays")); await first.cleanup();
    const second = startGatewayRelay("same", config, join(root, "relays")); assert.notEqual(second.directory, first.directory); await second.cleanup();
    assert.deepEqual(readFileSync(join(root, "token"), "utf8"), "fake\n");
  } finally { upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
