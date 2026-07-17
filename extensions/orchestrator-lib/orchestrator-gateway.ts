import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayConfig } from "./orchestrator-sandbox.ts";

export const GATEWAY_PLACEHOLDER = "PI_ORCHESTRATOR_GATEWAY_PLACEHOLDER";
export const SANDBOX_RELAY_DIR = "/g";
export const SANDBOX_RELAY_SOCKET = "/g/r";
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

export type GatewayRelay = {
  child: ChildProcess;
  directory: string;
  socketPath: string;
  nodePath: string;
  bootstrapPath: string;
  entrypointPath: string;
  cleanup(): void;
};

export function gatewayRuntimeBase(): string { return join(homedir(), ".cache", "pi-orchestrator", "gateway-relays"); }

/** Start the trusted host-side reverse relay and synchronously fail before bwrap spawn unless it is ready. */
export function startGatewayRelay(workerKey: string, config: GatewayConfig, base = gatewayRuntimeBase(), bwrapCommand = "bwrap"): GatewayRelay {
  mkdirSync(base, { recursive: true, mode: 0o700 }); chmodSync(base, 0o700);
  const safe = workerKey.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 64) || "worker";
  const directory = join(base, safe);
  // A pre-existing worker directory is a conflict, not something to delete:
  // fail closed so an attacker cannot redirect or replace the relay socket.
  mkdirSync(directory, { mode: 0o700 }); chmodSync(directory, 0o700);
  const socketPath = join(directory, "r");
  if (Buffer.byteLength(socketPath) > 100) { rmSync(directory, { recursive: true, force: true }); throw new Error("Gateway relay socket path is too long."); }
  const relayScript = fileURLToPath(new URL("./gateway-relay-process.mjs", import.meta.url));
  const bootstrapPath = fileURLToPath(new URL("./gateway-bootstrap.sh", import.meta.url));
  const entrypointPath = fileURLToPath(new URL("./gateway-entrypoint.mjs", import.meta.url));
  const child = spawn(bwrapCommand, [
    "--die-with-parent", "--new-session", "--unshare-user", "--uid", "0", "--gid", "0", "--cap-add", "CAP_SETPCAP",
    "--ro-bind", "/", "/", "--bind", directory, directory,
    "/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "--", process.execPath, relayScript,
  ], {
    env: { PATH: process.env.PATH, PI_ORCHESTRATOR_RELAY_SOCKET: socketPath, PI_ORCHESTRATOR_GATEWAY_UPSTREAM: config.upstreamUrl, PI_ORCHESTRATOR_GATEWAY_TOKEN_FILE: config.tokenFile },
    stdio: "ignore",
  });
  const cleanup = () => { try { if (!child.killed) child.kill("SIGTERM"); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} };
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      if (lstatSync(socketPath).isSocket() && (lstatSync(socketPath).mode & 0o777) === 0o600 && readdirSync(directory).length === 1) {
        return { child, directory, socketPath, nodePath: process.execPath, bootstrapPath, entrypointPath, cleanup };
      }
    } catch {}
    Atomics.wait(waitBuffer, 0, 0, 10);
  }
  cleanup();
  throw new Error("Gateway relay failed its readiness check.");
}
