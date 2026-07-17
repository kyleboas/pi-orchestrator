import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type SandboxMode = "off" | "preferred" | "required";
export type SandboxNetwork = "host" | "none";
export type SandboxEnvPolicy = "inherit" | "allowlist";

export type SandboxConfig = {
	mode: SandboxMode;
	/** "host" shares host networking (required for a 127.0.0.1 gateway); "none" must actually unshare the network namespace. */
	network: SandboxNetwork;
	env: SandboxEnvPolicy;
	/** Additional environment variable NAMES (never values) passed through under the allowlist policy. */
	envAllow: string[];
	/** Extra host paths mounted read-only inside the sandbox; missing paths fail the launch rather than being skipped. */
	readOnlyPaths: string[];
	/**
	 * Directories whose contents may be selected as worker workspaces when the
	 * sandbox is enabled. Only the selected per-task cwd is ever mounted
	 * read-write, never a whole root. Empty means no workspace is permitted:
	 * sandboxed delegation fails closed until roots are configured.
	 */
	workspaceRoots: string[];
	/** bwrap executable name or path; never a shell snippet. */
	command: string;
	/** Present when a sandbox block was supplied but malformed: delegation must fail closed, never fall back to off. */
	invalid?: true;
};

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
	mode: "off",
	network: "host",
	env: "inherit",
	envAllow: [],
	readOnlyPaths: [],
	workspaceRoots: [],
	command: "bwrap",
};

/** A malformed sandbox block disables delegation; it must never silently become "off". */
export const INVALID_SANDBOX_CONFIG: SandboxConfig = {
	...DEFAULT_SANDBOX_CONFIG,
	mode: "required",
	invalid: true,
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODES = new Set<SandboxMode>(["off", "preferred", "required"]);
const NETWORKS = new Set<SandboxNetwork>(["host", "none"]);
const ENV_POLICIES = new Set<SandboxEnvPolicy>(["inherit", "allowlist"]);

/**
 * Conservative environment names that carry no credentials by convention.
 * HOME is included for unsandboxed allowlist launches; sandboxed launches
 * override it with the isolated home directory.
 */
export const SAFE_ENV_NAMES: readonly string[] = [
	"PATH",
	"HOME",
	"TERM",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR",
	"TZ",
	"USER",
	"LOGNAME",
	"SHELL",
];

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}
function safePath(value: unknown): string | undefined {
	if (!nonempty(value) || /[\r\n\0]/.test(value)) return undefined;
	const expanded = expandHome(value.trim());
	return isAbsolute(expanded) ? expanded : undefined;
}

/**
 * Parse a config `sandbox` block. Returns undefined for any malformed field:
 * the caller must map that to INVALID_SANDBOX_CONFIG (fail closed), never to
 * the "off" default. Values are never echoed in errors or warnings.
 */
export function parseSandboxConfig(value: unknown): SandboxConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const mode = raw.mode === undefined ? "off" : raw.mode;
	if (!MODES.has(mode as SandboxMode)) return undefined;
	const network = raw.network === undefined ? "host" : raw.network;
	if (!NETWORKS.has(network as SandboxNetwork)) return undefined;
	// An explicitly enabled sandbox defaults to the credential-safe allowlist;
	// only mode "off" (legacy direct spawn) defaults to full inheritance.
	const env = raw.env === undefined ? (mode === "off" ? "inherit" : "allowlist") : raw.env;
	if (!ENV_POLICIES.has(env as SandboxEnvPolicy)) return undefined;
	const envAllow: string[] = [];
	if (raw.envAllow !== undefined) {
		if (!Array.isArray(raw.envAllow) || raw.envAllow.length > 64) return undefined;
		for (const name of raw.envAllow) {
			if (typeof name !== "string" || name.length > 64 || !ENV_NAME.test(name)) return undefined;
			envAllow.push(name);
		}
	}
	const readOnlyPaths: string[] = [];
	if (raw.readOnlyPaths !== undefined) {
		if (!Array.isArray(raw.readOnlyPaths) || raw.readOnlyPaths.length > 32) return undefined;
		for (const path of raw.readOnlyPaths) {
			const expanded = safePath(path);
			if (!expanded) return undefined;
			readOnlyPaths.push(expanded);
		}
	}
	const workspaceRoots: string[] = [];
	if (raw.workspaceRoots !== undefined) {
		if (!Array.isArray(raw.workspaceRoots) || raw.workspaceRoots.length > 32) return undefined;
		for (const path of raw.workspaceRoots) {
			const expanded = safePath(path);
			if (!expanded) return undefined;
			workspaceRoots.push(expanded);
		}
	}
	const command = raw.command === undefined ? "bwrap" : raw.command;
	if (!nonempty(command) || /[\r\n\0]/.test(command as string)) return undefined;
	return {
		mode: mode as SandboxMode,
		network: network as SandboxNetwork,
		env: env as SandboxEnvPolicy,
		envAllow,
		readOnlyPaths,
		workspaceRoots,
		command: (command as string).trim(),
	};
}

export type SandboxProbe = { ok: true; unshareNet: boolean } | { ok: false; reason: string };
export type ProbeRunner = (bin: string, args: string[]) => boolean;

/** Runs bwrap against the live kernel; a version check alone cannot prove namespaces work here. */
function defaultProbeRunner(bin: string, args: string[]): boolean {
	try {
		const result = spawnSync(bin, args, { stdio: "ignore", timeout: 10_000 });
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

const probeCache = new Map<string, SandboxProbe>();

export function resetSandboxProbeCacheForTesting(): void {
	probeCache.clear();
}

/**
 * Functional probe: actually create the namespaces this backend depends on.
 * The broad ro-bind here is probe-only scaffolding around `true`; real worker
 * launches use the explicit mount plan in buildBwrapArgs.
 */
export function probeBwrap(bin: string, runner: ProbeRunner = defaultProbeRunner): SandboxProbe {
	const cached = probeCache.get(bin);
	if (cached) return cached;
	const baseArgs = ["--die-with-parent", "--unshare-pid", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "true"];
	let probe: SandboxProbe;
	if (!runner(bin, baseArgs)) {
		probe = { ok: false, reason: "bubblewrap is missing or cannot create namespaces on this host" };
	} else {
		probe = { ok: true, unshareNet: runner(bin, ["--unshare-net", ...baseArgs]) };
	}
	probeCache.set(bin, probe);
	return probe;
}

export type ResolvedCommand = {
	/** Fully resolved real executable path; launched directly so no PATH lookup happens inside the sandbox. */
	execPath: string;
	/** Host directories that must be visible read-only for the runtime to function (e.g. an nvm node version root). */
	readOnlyRoots: string[];
	/** Directories prepended to PATH inside the sandbox (e.g. the bin dir holding `node` for script shebangs). */
	pathDirs: string[];
};

export type CommandFs = {
	existsSync: (path: string) => boolean;
	realpathSync: (path: string) => string;
};

/**
 * Resolve a configured worker command to its real path and the runtime roots
 * that must be mounted. A `bin` parent widens to its package root so sibling
 * resources (nvm's `lib/node_modules`, a standalone Claude version directory)
 * stay reachable without exposing the whole home directory.
 */
export function resolveWorkerCommand(
	command: string,
	env: NodeJS.ProcessEnv = process.env,
	fs: CommandFs = { existsSync, realpathSync },
): ResolvedCommand | undefined {
	let candidate: string | undefined;
	if (command.includes("/")) {
		const expanded = expandHome(command);
		if (isAbsolute(expanded) && fs.existsSync(expanded)) candidate = expanded;
	} else {
		for (const dir of (env.PATH ?? "").split(":")) {
			if (!dir) continue;
			const path = join(dir, command);
			if (fs.existsSync(path)) {
				candidate = path;
				break;
			}
		}
	}
	if (!candidate) return undefined;
	let execPath: string;
	try {
		execPath = fs.realpathSync(candidate);
	} catch {
		return undefined;
	}
	// An npm-installed CLI resolves into <prefix>/lib/node_modules/<pkg>/...;
	// the runtime root is the prefix (e.g. an nvm Node version dir), which
	// carries bin/node, the launcher symlink, and every package dependency.
	// Mounting only the package dist directory would strand the interpreter.
	const realDir = dirname(execPath);
	const marker = execPath.indexOf("/node_modules/");
	let root: string;
	if (marker > 0) {
		root = execPath.slice(0, marker);
		if (basename(root) === "lib") root = dirname(root);
	} else {
		root = basename(realDir) === "bin" ? dirname(realDir) : realDir;
	}
	const pathDirs = [...new Set([dirname(candidate), realDir])];
	return { execPath, readOnlyRoots: [root], pathDirs };
}

/**
 * Standard system roots mounted read-only with --ro-bind-try so one mount plan
 * works across merged-usr and split layouts. Deliberately NOT `--ro-bind / /`:
 * /home, /root, /var, /run and the rest of /etc stay invisible.
 */
const SYSTEM_RO_TRY: readonly string[] = [
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/etc/alternatives",
	"/etc/ssl",
	"/etc/ca-certificates",
	"/etc/resolv.conf",
	"/etc/hosts",
	"/etc/nsswitch.conf",
	"/etc/passwd",
	"/etc/group",
	"/etc/localtime",
];

export type SandboxFileMount = { source: string; dest: string };

export type WorkerLaunchRequest = {
	command: string;
	args: string[];
	cwd: string;
	/** Values the launch must set regardless of env policy (worker marker, a rotation-selected CLAUDE_CONFIG_DIR). */
	envOverrides: Record<string, string>;
	/** Values applied ONLY when the launch is actually sandboxed (paths that exist only inside the sandbox home). */
	sandboxEnvOverrides?: Record<string, string>;
	/** Host directory bound as the worker's isolated HOME when sandboxed. */
	homeDir: string;
	/** Host paths bound read-only if they exist; absence is tolerated. */
	readOnlyTryPaths?: string[];
	/** Individual files bound read-only if they exist (narrow credential/config allowlists, never whole directories). */
	fileMountsReadOnlyTry?: SandboxFileMount[];
	/** Host paths bound read-write (workspace extras such as a Claude account directory); must exist. */
	readWritePaths?: string[];
};

/** The only files a sandboxed Pi RPC worker may see from the host Pi agent directory. */
export const PI_WORKER_CONFIG_FILES: readonly string[] = ["auth.json", "models.json"];

/**
 * Isolation plan for a Pi RPC worker: an isolated agent dir inside the worker
 * home receives only the allowlisted auth/model files, and PI_CODING_AGENT_DIR
 * points at it, so host sessions, chat, logs, secret-store, prompts, and other
 * private state under ~/.pi are never mounted. The gateway token, when Pi's
 * provider config references it, is mounted as that single file at
 * ~/.config/agent/gateway.token RELATIVE TO THE SANDBOX HOME: consumers
 * resolve that path against $HOME, which is the isolated worker home inside
 * the sandbox, so a host-absolute destination would be invisible to them.
 * The surrounding host ~/.config/agent directory is never mounted.
 */
export function piWorkerSandboxPlan(homeDir: string, home: string = homedir()): {
	sandboxEnvOverrides: Record<string, string>;
	fileMountsReadOnlyTry: SandboxFileMount[];
} {
	const sourceDir = join(home, ".pi", "agent");
	const isolatedDir = join(homeDir, "pi-agent");
	return {
		sandboxEnvOverrides: { PI_CODING_AGENT_DIR: isolatedDir },
		fileMountsReadOnlyTry: [
			...PI_WORKER_CONFIG_FILES.map((name) => ({ source: join(sourceDir, name), dest: join(isolatedDir, name) })),
			{
				source: join(home, ".config", "agent", "gateway.token"),
				dest: join(homeDir, ".config", "agent", "gateway.token"),
			},
		],
	};
}

export type WorkspaceFs = {
	realpathSync: (path: string) => string;
	statSync: (path: string) => { isDirectory(): boolean };
};

export type WorkspaceResolution = { ok: true; cwd: string } | { ok: false; error: string };

/**
 * Select and validate the workspace cwd for one delegation. In mode "off"
 * legacy behavior is preserved (the session cwd, untouched, when no explicit
 * cwd is given). Under sandboxed modes the candidate is canonicalized
 * (realpath, so symlinks cannot escape), must be an existing directory, must
 * not be the host home or one of its ancestors, and must be equal to or
 * inside an explicitly configured workspaceRoots entry. Only the selected
 * cwd is ever mounted read-write — never a whole configured root.
 */
export function resolveWorkerWorkspace(
	config: SandboxConfig,
	requestedCwd: string | undefined,
	sessionCwd: string,
	fs: WorkspaceFs = { realpathSync, statSync },
	hostHome: string = homedir(),
): WorkspaceResolution {
	const requested = requestedCwd?.trim() ? expandHome(requestedCwd.trim()) : undefined;
	if (config.mode === "off" && requested === undefined) return { ok: true, cwd: sessionCwd };
	const candidate = requested ?? sessionCwd;
	if (!isAbsolute(candidate)) return { ok: false, error: "The workspace cwd must be an absolute directory path." };
	let canonical: string;
	try {
		canonical = fs.realpathSync(candidate);
		if (!fs.statSync(canonical).isDirectory()) return { ok: false, error: "The workspace cwd is not a directory." };
	} catch {
		return { ok: false, error: "The workspace cwd does not exist or is not accessible." };
	}
	if (config.mode === "off") return { ok: true, cwd: canonical };
	if (canonical === hostHome || isPathInside(canonical, hostHome)) {
		return { ok: false, error: "The workspace cwd would mount the host home directory; pass a repository cwd inside a configured sandbox.workspaceRoots entry." };
	}
	const roots: string[] = [];
	for (const root of config.workspaceRoots) {
		try {
			roots.push(fs.realpathSync(root));
		} catch {
			// A configured root that does not exist simply cannot match.
		}
	}
	if (!roots.length) {
		return { ok: false, error: "No sandbox.workspaceRoots are configured; add the repository root(s) to the sandbox config and pass a cwd inside one of them." };
	}
	if (!roots.some((root) => canonical === root || isPathInside(root, canonical))) {
		return { ok: false, error: "The workspace cwd is outside every configured sandbox.workspaceRoots entry; pass a repository cwd inside one of them." };
	}
	return { ok: true, cwd: canonical };
}

export type LaunchSpec = {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
};

export type WorkerLaunchResult =
	| { ok: true; spec: LaunchSpec; sandboxed: boolean; warning?: string }
	| { ok: false; error: string };

function buildEnv(
	config: SandboxConfig,
	hostEnv: NodeJS.ProcessEnv,
	overrides: Record<string, string>,
	pathDirs: string[],
): NodeJS.ProcessEnv {
	let env: NodeJS.ProcessEnv;
	if (config.env === "allowlist") {
		env = {};
		for (const name of [...SAFE_ENV_NAMES, ...config.envAllow]) {
			if (hostEnv[name] !== undefined) env[name] = hostEnv[name];
		}
	} else {
		env = { ...hostEnv };
	}
	Object.assign(env, overrides);
	if (pathDirs.length) {
		const current = env.PATH ?? "";
		const prepend = pathDirs.filter((dir) => !current.split(":").includes(dir));
		if (prepend.length) env.PATH = [...prepend, current].filter(Boolean).join(":");
	}
	return env;
}

/**
 * Deterministic bwrap argument plan. Environment values are passed via the
 * spawn env (inherited by bwrap), never as --setenv argv, so secrets can never
 * appear in host process listings.
 */
export function buildBwrapArgs(config: SandboxConfig, request: WorkerLaunchRequest, execPath: string, readOnlyRoots: string[]): string[] {
	const args: string[] = [
		"--die-with-parent",
		"--new-session",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--unshare-cgroup-try",
	];
	if (config.network === "none") args.push("--unshare-net");
	args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
	for (const path of SYSTEM_RO_TRY) args.push("--ro-bind-try", path, path);
	// Explicitly configured read-only paths are strict binds: a typo should
	// fail the launch loudly, not silently vanish from the sandbox.
	const strictRo = [...new Set([...readOnlyRoots, ...config.readOnlyPaths])];
	for (const path of strictRo) args.push("--ro-bind", path, path);
	for (const path of [...new Set(request.readOnlyTryPaths ?? [])]) args.push("--ro-bind-try", path, path);
	args.push("--bind", request.homeDir, request.homeDir);
	// File mounts land after the home bind: destinations inside the worker home
	// must overlay it, not be shadowed by it. Each destination parent is created
	// explicitly with --dir (inside the namespace only — the host filesystem is
	// never touched) instead of relying on undocumented bind parent creation.
	const fileMountParents = new Set<string>();
	for (const mount of request.fileMountsReadOnlyTry ?? []) {
		const parent = dirname(mount.dest);
		if (!fileMountParents.has(parent)) {
			fileMountParents.add(parent);
			args.push("--dir", parent);
		}
		args.push("--ro-bind-try", mount.source, mount.dest);
	}
	args.push("--bind", request.cwd, request.cwd);
	for (const path of [...new Set(request.readWritePaths ?? [])]) args.push("--bind", path, path);
	args.push("--chdir", request.cwd);
	args.push(execPath, ...request.args);
	return args;
}

/**
 * Resolve one worker launch under the configured sandbox policy.
 *
 * off: legacy direct spawn (env policy still applies).
 * preferred: sandbox when the probe passes; otherwise fall back to a direct
 *   spawn with an explicit warning the caller must surface.
 * required: any missing capability rejects the launch; never falls back.
 */
export function resolveWorkerLaunch(
	config: SandboxConfig,
	request: WorkerLaunchRequest,
	hostEnv: NodeJS.ProcessEnv = process.env,
	probe: (bin: string) => SandboxProbe = probeBwrap,
	commandFs?: CommandFs,
): WorkerLaunchResult {
	if (config.invalid) {
		return { ok: false, error: "Sandbox configuration is invalid; fix the sandbox block (delegation stays disabled rather than running unsandboxed)." };
	}
	const direct = (warning?: string): WorkerLaunchResult => ({
		ok: true,
		sandboxed: false,
		spec: { command: request.command, args: request.args, env: buildEnv(config, hostEnv, request.envOverrides, []) },
		...(warning ? { warning } : {}),
	});
	if (config.mode === "off") return direct();

	// Hard fail-closed overlap guard, even in preferred mode: a workspace bind
	// that equals or contains the host home or the worker home would shadow the
	// isolated HOME/token submounts (the cwd bind comes later in the plan) and
	// expose the entire host home read-write. Never spawn, never fall back.
	const hostHome = hostEnv.HOME ?? homedir();
	const overlaps = (a: string, b: string) => a === b || isPathInside(a, b) || isPathInside(b, a);
	if (overlaps(request.cwd, request.homeDir)) {
		return { ok: false, error: "The workspace cwd overlaps the isolated worker home; pass a repository cwd inside a configured sandbox.workspaceRoots entry." };
	}
	if (request.cwd === hostHome || isPathInside(request.cwd, hostHome)) {
		return { ok: false, error: "The workspace cwd would mount the host home directory read-write; pass a repository cwd inside a configured sandbox.workspaceRoots entry." };
	}

	const fail = (reason: string): WorkerLaunchResult =>
		config.mode === "required"
			? { ok: false, error: `Sandbox is required but unavailable: ${reason}.` }
			: direct(`Sandbox unavailable (${reason}); worker launched WITHOUT sandbox containment.`);

	const result = probe(config.command);
	if (!result.ok) return fail(result.reason);
	if (config.network === "none" && !result.unshareNet) return fail("network isolation (--unshare-net) failed the functional probe");
	const resolved = commandFs
		? resolveWorkerCommand(request.command, hostEnv, commandFs)
		: resolveWorkerCommand(request.command, hostEnv);
	if (!resolved) return fail("the worker executable could not be resolved to a real path");

	const env = buildEnv(config, hostEnv, { ...request.envOverrides, ...request.sandboxEnvOverrides, HOME: request.homeDir, TMPDIR: "/tmp" }, resolved.pathDirs);
	return {
		ok: true,
		sandboxed: true,
		spec: {
			command: config.command,
			args: buildBwrapArgs(config, request, resolved.execPath, resolved.readOnlyRoots),
			env,
		},
	};
}

/** Per-worker isolated HOME on the host; bound into the sandbox and removed on worker exit. */
export function workerHomeBaseDir(): string {
	return join(homedir(), ".cache", "pi-orchestrator", "worker-homes");
}

export function workerHomeDirPath(workerKey: string, baseDir: string = workerHomeBaseDir()): string {
	const safe = workerKey.replace(/[^A-Za-z0-9-]+/g, "-").slice(0, 64) || "worker";
	return join(baseDir, safe);
}

export function createWorkerHomeDir(dir: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// mkdir's mode only applies to newly created directories: repair permissions
	// on pre-existing worker homes and their state parent too.
	for (const path of [dir, dirname(dir)]) {
		try {
			chmodSync(path, 0o700);
		} catch {
			// Permission repair is best-effort; the mkdir above already succeeded.
		}
	}
	return dir;
}

/** Path-component containment; a bare prefix check would match sibling dirs like "pi-orchestrator-evil". */
function isPathInside(base: string, path: string): boolean {
	const rel = relative(base, path);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function cleanupWorkerHomeDir(dir: string): void {
	// Only remove directories this module (or the smoke test under tmpdir) created.
	const allowedBases = [join(homedir(), ".cache", "pi-orchestrator"), tmpdir()];
	if (!allowedBases.some((base) => isPathInside(base, dir))) return;
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// Best-effort: a busy mount or already-removed home must not break worker teardown.
	}
}
