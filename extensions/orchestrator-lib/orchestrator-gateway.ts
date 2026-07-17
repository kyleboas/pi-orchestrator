import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayConfig } from "./orchestrator-sandbox.ts";

// Deliberately not a credential: the host relay strips it and injects the
// host-owned gateway credential only after route validation.
export const GATEWAY_PLACEHOLDER = "PI_ORCHESTRATOR_GATEWAY_PLACEHOLDER";
export const SANDBOX_GATEWAY_BASE_URL = "http://127.0.0.1:4000";
export const GATEWAY_PI_PROVIDER = "pi-orchestrator-gateway";
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
  cleanup(): Promise<void>;
};

export function gatewayRuntimeBase(): string { return join(homedir(), ".cache", "pi-orchestrator", "gateway-relays"); }

export function claudeGatewayEnv(configDir: string): Record<string, string> {
  return {
    PI_ORCHESTRATOR_WORKER: "1",
    CLAUDE_CODE_BUBBLEWRAP: "1",
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: SANDBOX_GATEWAY_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: GATEWAY_PLACEHOLDER,
    ANTHROPIC_API_KEY: GATEWAY_PLACEHOLDER,
  };
}

/** The gateway model is intentionally shared by every worker tier. */
export function gatewayPiModel(model: string): string {
  return `${GATEWAY_PI_PROVIDER}/${model}`;
}

/** Write the only Pi provider/model definition visible in gateway mode. */
export function writeGatewayPiModels(homeDir: string, model: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) throw new Error("Gateway model is invalid.");
  const agentDir = join(homeDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  chmodSync(agentDir, 0o700);
  const modelsFile = join(agentDir, "models.json");
  const provider = {
    baseUrl: `${SANDBOX_GATEWAY_BASE_URL}/v1`,
    apiKey: GATEWAY_PLACEHOLDER,
    api: "openai-completions",
    models: [{ id: model, name: `Gateway ${model}`, reasoning: true, input: ["text", "image"], contextWindow: 128_000, maxTokens: 32_768 }],
  };
  const contents = `${JSON.stringify({ providers: { [GATEWAY_PI_PROVIDER]: provider } }, null, 2)}\n`;
  writeFileSync(modelsFile, contents, { mode: 0o600, flag: "wx" });
  chmodSync(modelsFile, 0o600);
  return modelsFile;
}

export function validateGatewayTokenFile(path: string, uid = process.getuid?.()): string {
  if (uid === undefined) throw new Error("Gateway token ownership cannot be verified.");
  let before;
  try { before = lstatSync(path); } catch { throw new Error("Gateway token file is unavailable."); }
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || (before.mode & 0o077) !== 0) throw new Error("Gateway token file is unsafe.");
  let canonical: string;
  try { canonical = realpathSync(path); } catch { throw new Error("Gateway token file is unavailable."); }
  const after = lstatSync(canonical);
  if (!after.isFile() || after.isSymbolicLink() || after.uid !== uid || (after.mode & 0o077) !== 0 || after.dev !== before.dev || after.ino !== before.ino) throw new Error("Gateway token file changed during validation.");
  return canonical;
}

function nodeRuntimeRoot(nodePath: string): string {
  const real = realpathSync(nodePath);
  return basename(dirname(real)) === "bin" ? dirname(dirname(real)) : dirname(real);
}

export function buildHostRelayBwrapArgs(runtimeRoot: string, relayScript: string, tokenFile: string, directory: string): string[] {
  return [
    "--die-with-parent", "--new-session", "--unshare-user", "--uid", "0", "--gid", "0", "--cap-drop", "ALL",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind-try", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64", "--ro-bind-try", "/usr/lib", "/usr/lib",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl", "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
    "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf", "--ro-bind-try", "/etc/hosts", "/etc/hosts",
    "--ro-bind-try", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
    "--dir", "/runtime", "--ro-bind", runtimeRoot, "/runtime",
    "--dir", "/orchestrator", "--ro-bind", relayScript, "/orchestrator/relay.mjs",
    "--ro-bind", tokenFile, "/gateway.token", "--dir", "/relay", "--bind", directory, "/relay",
    "/runtime/bin/node", "/orchestrator/relay.mjs",
  ];
}

/** Start a minimal-mount, zero-cap host-side relay and fail before worker spawn unless ready. */
export function startGatewayRelay(workerKey: string, config: Pick<GatewayConfig, "upstreamUrl" | "tokenFile">, base = gatewayRuntimeBase(), bwrapCommand = "bwrap", readinessMs = 4_000): GatewayRelay {
  const tokenFile = validateGatewayTokenFile(config.tokenFile);
  mkdirSync(base, { recursive: true, mode: 0o700 }); chmodSync(base, 0o700);
  const safe = workerKey.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 48) || "worker";
  // A generation suffix permits failover/immediate same-key reuse without ever
  // deleting or reusing a directory still mounted by the prior process.
  const directory = join(base, `${safe}-${randomUUID().slice(0, 8)}`);
  mkdirSync(directory, { mode: 0o700 }); chmodSync(directory, 0o700);
  const socketPath = join(directory, "r");
  if (Buffer.byteLength(socketPath) > 100) { rmSync(directory, { recursive: true, force: true }); throw new Error("Gateway relay socket path is too long."); }
  const relayScript = fileURLToPath(new URL("./gateway-relay-process.mjs", import.meta.url));
  const bootstrapPath = fileURLToPath(new URL("./gateway-bootstrap.sh", import.meta.url));
  const entrypointPath = fileURLToPath(new URL("./gateway-entrypoint.mjs", import.meta.url));
  const runtimeRoot = nodeRuntimeRoot(process.execPath);
  const args = buildHostRelayBwrapArgs(runtimeRoot, relayScript, tokenFile, directory);
  const child = spawn(bwrapCommand, args, {
    env: { PI_ORCHESTRATOR_RELAY_SOCKET: "/relay/r", PI_ORCHESTRATOR_GATEWAY_UPSTREAM: config.upstreamUrl, PI_ORCHESTRATOR_GATEWAY_TOKEN_FILE: "/gateway.token" },
    stdio: "ignore",
  });
  let cleaning: Promise<void> | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const spawnedPid = child.pid;
  const safeSpawnedChild = Number.isFinite(spawnedPid) && Number.isInteger(spawnedPid) && spawnedPid! > 1 && spawnedPid !== process.pid;
  const removeAfterExit = () => { if (killTimer) clearTimeout(killTimer); try { rmSync(directory, { recursive: true, force: true }); } catch {} };
  child.once("exit", removeAfterExit);
  // A spawn error may not have an exit event. It is safe to remove because no
  // child mount namespace was created.
  child.once("error", () => { if (child.pid === undefined) removeAfterExit(); });
  const signalChild = (signal: NodeJS.Signals): boolean => {
    // Never pass a negative/group PID, an unspawned PID, or our own PID to a
    // signaling API. Recheck the immutable spawn PID before every signal.
    if (!safeSpawnedChild || child.pid !== spawnedPid || child.exitCode !== null || child.signalCode !== null) return false;
    return child.kill(signal);
  };
  const cleanup = (): Promise<void> => {
    if (cleaning) return cleaning;
    cleaning = new Promise<void>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) { removeAfterExit(); resolve(); return; }
      // An invalid PID must never be signaled. Its eventual exit/error handler
      // owns removal so a possibly live mount generation is not deleted early.
      if (!safeSpawnedChild) { resolve(); return; }
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
      try {
        if (!signalChild("SIGTERM")) { resolve(); return; }
      } catch (error) { reject(error); return; }
      killTimer = setTimeout(() => {
        try { signalChild("SIGKILL"); } catch (error) { reject(error); }
      }, 750);
      killTimer.unref();
    });
    return cleaning;
  };
  const deadline = Date.now() + Math.max(1, Math.min(readinessMs, 30_000));
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      if (lstatSync(socketPath).isSocket() && (lstatSync(socketPath).mode & 0o777) === 0o600 && readdirSync(directory).length === 1) {
        return { child, directory, socketPath, nodePath: process.execPath, bootstrapPath, entrypointPath, cleanup };
      }
    } catch {}
    Atomics.wait(waitBuffer, 0, 0, 10);
  }
  void cleanup().catch(() => {});
  throw new Error("Gateway relay failed its readiness check.");
}
