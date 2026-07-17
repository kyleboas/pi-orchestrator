import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GATEWAY_PLACEHOLDER, startGatewayRelay } from "../extensions/orchestrator-lib/orchestrator-gateway.ts";
import { buildBwrapArgs, DEFAULT_SANDBOX_CONFIG, parseSandboxConfig, piWorkerSandboxPlan } from "../extensions/orchestrator-lib/orchestrator-sandbox.ts";

function requestUds(socketPath: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: "/v1/messages", method: "POST", headers: { authorization: "worker-secret", "proxy-authorization": "bad", "x-api-key": "bad", connection: "close", "content-type": "text/plain" } }, (res) => {
      let text = ""; res.on("data", (chunk) => text += chunk); res.on("end", () => resolve({ status: res.statusCode!, body: text }));
    });
    req.on("error", reject); req.end(body);
  });
}

test("gateway config accepts only an HTTP loopback origin and safe absolute token path", () => {
  const good = parseSandboxConfig({ mode: "required", network: "gateway", gateway: { upstreamUrl: "http://127.0.0.1:4000", tokenFile: "/home/user/.config/agent/gateway.token" } });
  assert.equal(good?.gateway?.upstreamUrl, "http://127.0.0.1:4000");
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
  assert.ok(plan.fileMountsReadOnly.some((m) => m.source.endsWith("models.json")));
  assert.ok(plan.fileMountsReadOnly.some((m) => m.source.endsWith(".gateway-placeholder")));
  assert.equal(GATEWAY_PLACEHOLDER, "PI_ORCHESTRATOR_GATEWAY_PLACEHOLDER");
});

test("host relay streams bodies and responses, rewrites worker auth, sanitizes failures, and cleans up", async () => {
  const root = mkdtempSync(join(tmpdir(), "pio-gw-"));
  const tokenFile = join(root, "token"); writeFileSync(tokenFile, "real-test-token\n", { mode: 0o600 });
  let observed: http.IncomingHttpHeaders = {}; let observedBody = "";
  const upstream = http.createServer((req, res) => { observed = req.headers; req.on("data", (c) => observedBody += c); req.on("end", () => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: one\n\n"); setTimeout(() => res.end("data: two\n\n"), 10); }); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address === "object");
  const relay = startGatewayRelay("test", { upstreamUrl: `http://127.0.0.1:${address.port}`, tokenFile }, join(root, "r"));
  try {
    const response = await requestUds(relay.socketPath, "streamed-body");
    assert.equal(response.status, 200); assert.equal(response.body, "data: one\n\ndata: two\n\n"); assert.equal(observedBody, "streamed-body");
    assert.equal(observed.authorization, "Bearer real-test-token"); assert.equal(observed["proxy-authorization"], undefined); assert.equal(observed["x-api-key"], undefined);
    upstream.close(); await new Promise((r) => setTimeout(r, 20));
    const failed = await requestUds(relay.socketPath, "x"); assert.equal(failed.status, 502); assert.equal(failed.body, "gateway unavailable\n");
  } finally { relay.cleanup(); upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
