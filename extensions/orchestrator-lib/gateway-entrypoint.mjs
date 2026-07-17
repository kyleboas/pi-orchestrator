import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const [socketPath, ...argv] = process.argv.slice(2);
if (!socketPath || argv.length === 0 || socketPath.length > 100) process.exit(125);
try {
  const masks = readFileSync("/proc/self/status", "utf8").match(/^Cap(?:Inh|Prm|Eff|Bnd|Amb):\s+([0-9a-f]+)$/gmi) ?? [];
  if (masks.length !== 5 || masks.some((line) => !/:\s+0+$/.test(line))) process.exit(125);
} catch { process.exit(125); }
let child;
let closing = false;
const sockets = new Set();
const server = net.createServer((tcp) => {
  sockets.add(tcp);
  const uds = net.createConnection({ path: socketPath });
  sockets.add(uds);
  tcp.on("error", () => uds.destroy());
  uds.on("error", () => tcp.destroy());
  tcp.on("close", () => { sockets.delete(tcp); uds.destroy(); });
  uds.on("close", () => { sockets.delete(uds); tcp.destroy(); });
  tcp.pipe(uds).pipe(tcp);
});
server.on("error", () => process.exit(125));
server.listen({ host: "127.0.0.1", port: 4000, exclusive: true }, () => {
  const readiness = net.createConnection({ path: socketPath });
  readiness.once("error", () => shutdown(125));
  readiness.once("connect", () => {
    readiness.destroy();
    child = spawn(argv[0], argv.slice(1), { stdio: "inherit", env: process.env });
    child.on("error", () => shutdown(125));
    child.on("exit", (code, signal) => shutdown(code ?? (signal ? 128 : 1)));
  });
});
function shutdown(code) {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(code));
  for (const socket of sockets) socket.destroy();
  setTimeout(() => process.exit(code), 500).unref();
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    if (child && !child.killed) child.kill(signal);
    else shutdown(128);
  });
}
