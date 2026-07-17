import http from "node:http";
import { readFileSync, chmodSync, lstatSync, unlinkSync } from "node:fs";

const socketPath = process.env.PI_ORCHESTRATOR_RELAY_SOCKET;
const upstreamText = process.env.PI_ORCHESTRATOR_GATEWAY_UPSTREAM;
const tokenFile = process.env.PI_ORCHESTRATOR_GATEWAY_TOKEN_FILE;
const fail = () => process.exit(125);
try {
  const masks = readFileSync("/proc/self/status", "utf8").match(/^Cap(?:Inh|Prm|Eff|Bnd|Amb):\s+([0-9a-f]+)$/gmi) ?? [];
  if (masks.length !== 5 || masks.some((line) => !/:\s+0+$/.test(line))) fail();
} catch { fail(); }
if (!socketPath || !upstreamText || !tokenFile || socketPath.length > 100 || /[\r\n\0]/.test(socketPath + tokenFile)) fail();
let upstream;
try { upstream = new URL(upstreamText); } catch { fail(); }
if (upstream.protocol !== "http:" || upstream.username || upstream.password || !["127.0.0.1", "[::1]"].includes(upstream.hostname) || (upstream.pathname !== "/" && upstream.pathname !== "") || upstream.search || upstream.hash) fail();
let token;
try {
  const tokenStat = lstatSync(tokenFile);
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || tokenStat.uid !== process.getuid() || (tokenStat.mode & 0o077) !== 0) fail();
  token = readFileSync(tokenFile, "utf8").trim();
} catch { fail(); }
if (!token || token.length > 8192 || /[\r\n\0]/.test(token)) fail();
try { const s = lstatSync(socketPath); if (s.isSocket()) unlinkSync(socketPath); else fail(); } catch (error) { if (error?.code !== "ENOENT") fail(); }
const hop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const credentials = new Set(["authorization", "proxy-authorization", "x-api-key"]);
const inferenceRoutes = new Set(["/codex/responses", "/v1/responses", "/v1/chat/completions", "/v1/messages", "/v1/messages/count_tokens"]);
function filtered(headers, response = false) {
  const blocked = new Set(hop);
  for (const item of String(headers.connection ?? "").split(",")) if (item.trim()) blocked.add(item.trim().toLowerCase());
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (blocked.has(lower) || (!response && credentials.has(lower))) continue;
    if (value !== undefined) out[lower] = value;
  }
  return out;
}
const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 120_000, headersTimeout: 10_000 }, (req, res) => {
  let target;
  try { target = req.url?.startsWith("/") && !req.url.startsWith("//") ? new URL(req.url, "http://worker") : undefined; } catch {}
  const allowed = req.method === "POST" && target && !target.hash && inferenceRoutes.has(target.pathname);
  if (!allowed || req.method === "CONNECT" || req.headers.upgrade) { req.resume(); res.writeHead(404, { connection: "close" }); res.end("not found\n"); return; }
  const headers = filtered(req.headers);
  headers.host = upstream.host;
  headers.authorization = `Bearer ${token}`;
  // Pi's openai-codex API uses ChatGPT's /codex/responses path. The local
  // gateway exposes the equivalent OpenAI-compatible /v1/responses endpoint.
  const upstreamPath = target.pathname === "/codex/responses" ? `/v1/responses${target.search}` : req.url;
  const proxy = http.request({ protocol: "http:", hostname: upstream.hostname.replace(/^\[|\]$/g, ""), port: upstream.port || 80, method: req.method, path: upstreamPath, headers, timeout: 115_000 }, (reply) => {
    res.writeHead(reply.statusCode ?? 502, filtered(reply.headers, true));
    reply.pipe(res);
  });
  proxy.on("timeout", () => proxy.destroy());
  proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("gateway unavailable\n"); });
  req.on("aborted", () => proxy.destroy());
  req.pipe(proxy);
});
server.on("clientError", (_error, socket) => socket.destroy());
server.on("connect", (_req, socket) => socket.destroy());
server.on("upgrade", (_req, socket) => socket.destroy());
server.on("error", fail);
server.listen(socketPath, () => { try { chmodSync(socketPath, 0o600); process.stdout.write("ready\n"); } catch { fail(); } });
function stop() {
  server.close(() => { try { unlinkSync(socketPath); } catch {} process.exit(0); });
  setTimeout(() => process.exit(1), 1000).unref();
}
process.on("SIGTERM", stop); process.on("SIGINT", stop);
