# Pi Orchestrator

Persistent implementation-worker orchestration for [Pi](https://github.com/badlogic/pi-mono). The coordinator investigates and plans with read-only tools, delegates implementation to persistent workers, accepts steering, and only gains direct implementation tools after an explicit user takeover request.

Features: Pi RPC and Claude Code stream-json workers; exact-once result delivery; reload-safe process-global worker runtime; stop and steer controls; compact readable (non-dim) worker footer rows; replaceable catalog and executable configuration.

## Install

> **Runtime trust warning:** Run this only in repositories you trust. Repository content and delegated instructions can cause workers to read or modify files, run commands, access inherited credentials, and make network requests. The optional bubblewrap worker sandbox below limits filesystem and process access for worker processes, but it is not a complete security boundary: see its explicit non-guarantees. For untrusted code, still prefer a container, VM, or other isolated environment.

```sh
pi install git:github.com/kyleboas/pi-orchestrator
```

Restart Pi or run `/reload`. If you already use a vendored/local orchestrator extension, disable or remove it first: running two orchestrators creates conflicting tools and worker ownership.

Pi workers require `pi` on `PATH`. Claude workers are optional and require Claude Code (`claude`) on `PATH` and its normal authentication. Workers run in the coordinator's current directory with implementation tools.

## Default catalog

Every worker is an individual, explicit model profile. Pi workers **never inherit the coordinator model**: each Pi RPC launch always uses the `model` and `thinking` in that worker's profile. The default catalog is:

- `Luna`: Pi RPC, `openai-codex/gpt-5.6-luna`, low thinking — the cheap default for routine bounded work
- `Sol-Low`: Pi RPC, `openai-codex/gpt-5.6-sol`, low thinking
- `Sol-Medium`: Pi RPC, `openai-codex/gpt-5.6-sol`, medium thinking
- `Terra`: Pi RPC, `openai-codex/gpt-5.6-terra`, high thinking — reserved for genuinely hard work
- `Opus`: Claude Code, `opus`
- `Sonnet`: Claude Code, `sonnet`
- `Haiku`: Claude Code, `haiku`
- `Fable`: Claude Code, `fable`

Each worker may carry a `description` (in config too) that tells the coordinator what the tier is for. For an unqualified new task, the coordinator starts with Luna unless its already-inspected scope demonstrably requires Sol or Terra; explicit user worker choices always win. It escalates only for known complexity or after a cheaper attempt cannot finish. Distinct tasks receive new delegates; steering is only continuation/correction of the same task.

## Outcome ledger and routing advice

Every attempt updates `~/.config/pi-orchestrator/stats.json` with a stable root-task ID and unique run ID. A completed result starts as `completed` (pending coordinator review); review resolves it to `accepted` or `rework`. Terminal execution states are recorded separately as `failed`, `unavailable` (spawn/account/stdin/provider availability), or `cancelled`. Status resolution updates the existing run exactly once, so lifetime aggregates do not double-count review transitions. The bounded latest-200 `recentRuns` ledger persists only IDs, worker/backend/model, timestamp, status, duration/tokens/cost, and broad task category/complexity — not task text.

The coordinator receives concise lifetime context plus matching seven-day category/complexity evidence when at least three samples exist: status/acceptance signals and p50/p95 duration, with Pi provider-reported cost and Claude API-equivalent estimated/notional cost always labeled separately. Sparse evidence is explicitly advisory, never hard routing; existing tier rules and explicit user worker choice still win.

`orchestrator_delegate` accepts optional `category` (`code`, `tests`, `documentation`, `operations`, `research`, or `integration`) and `complexity` (`low`, `medium`, or `high`). Omitted values use deterministic task-text classification. A separately delegated retry can pass `retryOf` with a prior root task ID returned in tool details; an unresolved ID safely creates a new root. `orchestrator_steer` accepts `kind: correction|continuation`: correction marks the preceding completed attempt `rework`; continuation accepts it before starting the next attempt on the same root. Omitted steer kinds conservatively mean correction. It also accepts `interrupt: true` for a working Pi RPC worker that is actively heading the wrong way: the in-flight run is aborted through the Pi RPC `abort` command before the instructions are delivered, and the aborted run's partial output is discarded rather than reported as a result. Claude workers cannot be aborted mid-turn; an interrupt steer to one degrades to the normal queued follow-up and says so in the tool result.

`orchestrator_stop` kills the worker's entire process tree. A sandboxed worker's tree dies with bwrap's PID namespace; an unsandboxed worker (the per-worker `"sandbox": "off"` opt-out) is spawned as its own process group so stop, failover, and coordinator-exit cleanup can signal grandchildren too — a stuck deploy or long-running command cannot survive as an orphan.

The ledger is advisory and backwards-compatible with aggregate-only v1/v2 data. On initialization, old malformed top-level aggregate keys are removed only after a timestamped sibling backup is made; reserved aggregate names can never become workers. If a still-loaded v2 extension has overwritten a v3 cleanup, the next startup narrowly detects a v2 live file plus a richer sibling backup, snapshots the v2 file, retains its current lifetime totals, and deterministically unions its newer attempts with the backup before writing v3. Corrupt or missing files load as empty, and ledger IO errors never disturb orchestration. Delete the file to reset it.

For example: “ask Opus to implement the migration and run its tests.” While a worker is live: “steer Opus with correction: also cover rollback behavior.”

The Terra, Sol, and Fable aliases are opinionated defaults from this package's author and may not exist in another user's provider or Claude setup. Supply your own complete `workers` catalog when they are unavailable; a configured catalog replaces all seven defaults and may use arbitrary valid display names, Pi `provider/model` IDs, and Pi thinking levels.

## Configuration

Configuration is read once when the extension initializes. It uses `PI_ORCHESTRATOR_CONFIG` when set; otherwise it reads `~/.config/pi-orchestrator/config.json` if present; otherwise defaults apply. `~` is expanded in the config-path environment variable. Invalid, empty, duplicate, or incomplete worker catalogs safely use the full explicit default catalog without exposing configuration contents.

`checkInMinutes` is an optional nonnegative finite number and defaults to `15`; set it to `0` to disable check-ins. The first passive assessment is after this base interval. Healthy/on-track workers then back off to 30 minutes (at most 2x the configured base); suspicious, stalled, or newly steered workers reset to the base interval. Assessments use only already-captured task, transcript, and lifecycle state and never send a message to, steer, or interrupt the worker. Healthy checks are hidden custom next-turn context (`triggerTurn:false`), so they do not wake the coordinator or require an acknowledgement. Only concrete suspicious signals — inactivity, blocked/error/permission/conflict/rate-limit language, or obvious repeated activity — send a coordinator follow-up, and it should steer only for actual drift.

`rolloverContextPercent` is an optional finite percentage from `0` through `100`, defaulting to the conservative `38`. Set it to `0` to disable outcome-boundary rollover. After a worker result is delivered, if no worker is starting, working, or settling and context use is at least this threshold, the extension requests one Pi compaction at the next `agent_end` boundary. Its handoff preserves the user goal, decisions, authoritative paths, changed files, validation, commits/PRs, and blockers while dropping routine tool/status chatter. It never compacts active work or small contexts, does not repeat the same outcome, and safely retries after a failed compaction.

`workers` is a complete catalog, either an object keyed by display name or an array whose entries have `name`. Names must be unique (case-insensitive), start with a letter, and contain only letters, numbers, spaces, and hyphens. Every Pi RPC worker requires a nonempty `provider/model` `model` and a `thinking` level (`low`, `medium`, or `high`). Every Claude worker requires a nonempty model alias or model string.

A worker profile may additionally declare `"sandbox": "off"`, the explicit per-worker opt-out described under [Worker sandbox](#worker-sandbox-linux-bubblewrap). Only the exact literal `"off"` is accepted; any other present value rejects the catalog (the config falls back to defaults with a warning) rather than loading with a different containment meaning.

### Restricted pull-request broker

`pullRequests` is absent by default: no worker receives PR publishing authority. When explicitly configured, it is an exact, case-normalized GitHub allowlist and branch policy:

```json
{
  "pullRequests": {
    "repositories": ["owner/repository", "owner/*"],
    "branchPrefixes": ["feat/", "fix/"]
  }
}
```

A repository entry is either an exact `owner/repository` or the explicit owner-wide `owner/*`, which allows every repository under that owner. Only those two full forms parse; any partial pattern (`*`, `*/name`, `owner/pre*`) rejects the whole block — authority is never broadened by a typo. The wildcard affects eligibility only: the pinned target is always the exact repository parsed from the workspace's canonical origin, and every subsequent check runs against that pin.

Each branch policy entry is either a slash-terminated prefix such as `feat/` or the exact wildcard `*`. Use `"branchPrefixes": ["*"]` to authorize any syntactically valid branch in an allowlisted repository; the repository's default branch remains forbidden. Both arrays are bounded, duplicate-free, and strictly validated, and wildcard-like values such as `feat/*` are invalid; malformed broker configuration disables the broker with a generic warning. For an eligible **sandboxed** worker, the host pins the canonical repository `origin` and its default branch before worker code starts (using the local origin HEAD when available, otherwise trusted `gh repo view`). Linked Git worktrees are not eligible because their `.git` file points outside the mounted workspace; the broker fails closed rather than claiming sandbox support for them. It mounts only a per-worker `/pr` directory containing `/pr/pio-pr` and a mode-0600 Unix socket. Existing narrow model-provider authentication/config mounts remain available so the worker can reach its model, but the broker feature exposes no host HOME, GitHub `gh` configuration, SSH files/agent socket, `GH_TOKEN`/`GITHUB_TOKEN`, or GitHub credentials.

Workers may run `/pr/pio-pr status`; it reports whether a branch is pinned and whether the current branch is eligible. Only when the task explicitly requests a PR create/update, after committing everything and obtaining a clean worktree (including no untracked files), they may run `/pr/pio-pr publish "title" "body"`. The first successful publish pins the then-current allowed non-default branch for that broker generation; later branch changes are rejected. Publish can only fast-forward that pinned origin branch and create or update that branch's one open PR, always against the pinned default branch. It cannot select a remote, repository, base, or head, force-push, run git/gh/API commands, or merge, close, delete, review, label, or otherwise administer a PR. Broker publication requires only that the host has already completed `gh auth login`; host SSH is neither required nor exposed. The trusted host broker uses that host-only GitHub authentication without returning or logging credentials, and workers still receive no GitHub credentials. A coordinator never delegates merge; it may merge only after an explicit user request, normally through takeover.

```json
{
  "coordinator": {
    "provider": "example-provider",
    "id": "coordinator-model-placeholder",
    "thinking": "high"
  },
  "commands": { "pi": "pi", "claude": "claude-auto" },
  "checkInMinutes": 15,
  "rolloverContextPercent": 38,
  "pullRequests": {
    "repositories": ["example-owner/example-repository"],
    "branchPrefixes": ["feat/", "fix/"]
  },
  "workers": {
    "Builder": {
      "backend": "pi-rpc",
      "model": "example-provider/implementation-model-placeholder",
      "thinking": "high"
    },
    "Reviewer": {
      "backend": "pi-rpc",
      "model": "another-provider/review-model-placeholder",
      "thinking": "low"
    },
    "Fable": { "backend": "claude-code", "model": "fable-custom-alias-placeholder" }
  }
}
```

A config without a `workers` key keeps its `coordinator`/`commands` and uses the default catalog. `coordinator` is optional. It defaults to high thinking and changes the coordinator model only when **both** `provider` and `id` are supplied. Coordinator `{provider, id, thinking}` settings affect only the coordinator; they never select or alter a worker model. See [`examples/config.json`](examples/config.json) for the same portable shape and placeholder IDs.

Executable overrides are command names or executable paths, never shell snippets. Config `commands.pi` and `commands.claude` set them; environment variables take precedence:

```sh
PI_ORCHESTRATOR_PI_BIN=pi PI_ORCHESTRATOR_CLAUDE_BIN=claude-auto pi
```

## Worker sandbox (Linux, bubblewrap)

An optional `sandbox` config block runs every delegated worker process (Pi RPC, Claude Code, and Claude account-failover respawns) inside [bubblewrap](https://github.com/containers/bubblewrap). It defaults to `off` for backward compatibility; after validating it on your host, public/VPS users should explicitly set `"mode": "required"`.

```json
{
  "sandbox": {
    "mode": "required",
    "network": "gateway",
    "gateway": {
      "upstreamUrl": "http://127.0.0.1:4000",
      "tokenFile": "~/.config/agent/gateway.token",
      "model": "coding-main"
    },
    "env": "allowlist",
    "envAllow": [],
    "readOnlyPaths": [],
    "workspaceRoots": ["~/code"]
  }
}
```

Ubuntu install and verification:

```sh
sudo apt install bubblewrap
npm run smoke:bwrap   # in a checkout: opt-in real-bwrap smoke test
```

Modes:

- `off` (default): legacy direct spawn.
- `preferred`: sandbox when a cached functional probe passes; otherwise the worker launches unsandboxed with a prominent warning in the delegate result and worker transcript.
- `required`: fail closed. A missing binary, failed namespace probe, unresolvable worker executable, or unenforceable isolated network rejects the delegation; nothing ever silently falls back. A malformed `sandbox` block also disables delegation rather than quietly becoming `off`. `network: "gateway"` always fails closed, including with `mode: "preferred"`; it can never fall back to a credential-bearing host launch.

### Per-worker opt-out: designated host workers

A sandboxed catalog cannot touch the host: workers cannot see host PIDs, the user systemd bus, journals, or paths outside their workspace mount, so operational tasks (reaping stale processes, restarting services, deploying into `~/.config`) dead-end with "a host-capable session is required". Rather than turning the sandbox off globally, designate an explicit ops worker with `"sandbox": "off"` in its profile:

```json
"workers": {
  "Ops": { "backend": "pi-rpc", "model": "provider/model", "thinking": "medium", "sandbox": "off",
           "description": "Host operations: processes, services, deploys, anything outside the workspace roots." }
}
```

Such a worker launches directly on the host with the same semantics as global `mode: "off"`: no bwrap, no workspace-root restriction (its `cwd` may be any accessible directory, including the coordinator's session cwd), and no PR broker (env stripping is skipped too — a host worker can read every credential file anyway, so stripping would only break its Git/SSH tooling without containing anything). The configured `env` policy still applies unchanged; add names like `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS` to `envAllow` if the ops worker must reach the user systemd bus under `env: "allowlist"`. The opt-out is loud, never silent: the worker's catalog description is prefixed with `UNSANDBOXED HOST WORKER`, and every delegate result notes the host launch.

Two boundaries are never weakened by the override. An invalid `sandbox` block still disables delegation for every worker, opted out or not. And under `network: "gateway"` the opt-out is rejected at spawn with a clear error — a gateway configuration never permits a credential-bearing host launch, per-worker or otherwise.

Sandboxed workers additionally require a **workspace policy**. `workspaceRoots` lists the directories whose contents may be selected as per-task workspaces; `orchestrator_delegate` accepts an optional `cwd` naming the exact repository directory, which is canonicalized (symlinks cannot escape) and must be equal to or inside a configured root — only that selected directory is mounted read-write, never a whole root. When `cwd` is omitted, the coordinator's session cwd is used only if it passes the same checks; otherwise the delegation is rejected with instructions to pass a repo cwd. The host home directory (or any ancestor of it, or anything overlapping the worker's isolated home) is always refused as a workspace, in every sandbox mode, because binding it would expose the entire home read-write and shadow the isolated HOME/token mounts. With no `workspaceRoots` configured, sandboxed delegation fails closed. Never list your home directory itself as a workspace root.

What a sandboxed worker gets: the selected workspace directory read-write; a private per-worker HOME (removed on exit) and tmpfs `/tmp`; system runtimes, certificates, and the resolved worker executable's runtime root (nvm-style Node trees and standalone Claude installs are handled) read-only; minimal `/proc` and `/dev`; new PID/IPC/UTS namespaces with parent-death teardown, so killing the worker reliably kills its whole process tree. The rest of the home directory, `/root`, `/var`, and unrelated `/etc` are not mounted. `readOnlyPaths` adds strict read-only mounts (a missing path fails the launch loudly).

`env: "allowlist"` is the default whenever the sandbox is enabled (`preferred` or `required`): it passes only conservative non-credential names (PATH, HOME, TERM, locale, and similar) plus explicit `envAllow` additions — provider/gateway variables must be named explicitly. `env: "inherit"` keeps the full environment and must be opted into; `mode: "off"` keeps legacy full inheritance. Environment values are passed via the process environment, never in bwrap argv, so they cannot leak into process listings.

Pi workers do not see the host `~/.pi` directory. In legacy `host`/`none` sandbox modes, each Pi worker receives only the individual `auth.json`, `models.json`, and gateway-token mounts described by the previous release; this preserves compatibility. In `gateway` mode the host model configuration is not mounted: the worker gets a generated mode-0600 provider-only `models.json` using the standard OpenAI Chat Completions API at `http://127.0.0.1:4000/v1`. `gateway.model` is the immutable upstream alias used by every sandboxed Pi and Claude worker, regardless of the worker profile's host-side provider or Claude alias; it defaults to `coding-main` for backward-compatible parsing, though explicitly pinning it is recommended. Real Pi auth, host model configuration, the real gateway token, broad Pi state, Claude config/account directories, inherited reusable credentials, and account rotation are not mounted or used. Both clients receive only the local base URL and a constant non-secret placeholder through their isolated configuration. If either client cannot operate that way, launch fails rather than weakening the policy.

`network: "host"` (default) preserves shared host networking. `network: "none"` is literal no-network. `network: "gateway"` also uses `--unshare-net`, but a trusted zero-capability Node entrypoint exposes only `127.0.0.1:4000` and byte-proxies it to a single Unix socket mounted at `/g/r`; other loopback ports and all external destinations remain unreachable. The socket is the sole entry in its mode-0700 host relay directory, is mode 0600, and that directory is mounted read-only. Node 24 and each worker executable are explicitly resolved and mounted.

The gateway trust boundary is deliberate. Bubblewrap first creates a root-mapped user/network namespace with exactly bootstrap-only `CAP_NET_ADMIN` and `CAP_SETPCAP`. A fixed argv-invoked script raises loopback, then **execs** `/usr/bin/setpriv` with empty bounding, inheritable, and ambient sets plus `no_new_privs`; normal executable rules leave effective/permitted empty too. Thus all five capability masks are zero before the trusted Node entrypoint or worker runs, with no capability-bearing parent and no `sh -c` or interpolated command. The entrypoint listens, verifies readiness, then launches the exact Pi/Claude argv while preserving stdio, signals, status, and teardown.

The coordinator-owned HTTP reverse relay reads `gateway.tokenFile` at runtime and never logs it. Before spawn the token path is canonicalized and must be a regular, non-symlink, owner-only file owned by the coordinator uid. The zero-cap host relay gets only exact runtime/system mounts, that token file, and its dedicated relay directory — never `/`, broad `/home`, or broad configuration state. It accepts origin-form `POST` requests only for `/v1/responses`, `/v1/chat/completions`, `/v1/messages`, and `/v1/messages/count_tokens` (queries are preserved), strips worker authorization, proxy authorization, API-key, connection-nominated, and hop-by-hop headers, injects gateway bearer authentication, and streams request bodies and SSE responses to the strictly configured loopback HTTP origin. Administration/key/team/user/config/spend paths and every other method/path are denied before authentication or forwarding. Header sizes and timeouts are bounded; upstream errors are sanitized. Absolute-form forward proxying, CONNECT, WebSocket upgrades, non-HTTP/non-loopback origins, URL credentials/paths, unsafe token paths, socket conflicts/length violations, and readiness failures are rejected before worker spawn. Relay processes are boundedly terminated, and sockets/generation directories and isolated homes are removed only after process exit.

Exact non-guarantees — this is containment, not a full security boundary:

- **Network egress is not restricted** under `network: "host"`: a worker can reach the host loopback and the internet, and prompts inherently send mounted repository content to the model provider.
- **Active provider credentials remain visible in legacy `host`/`none` sandbox modes.** Claude account and narrow Pi credential mounts are retained there for exact compatibility. Use `network: "gateway"` to isolate them.
- **The coordinator itself is not sandboxed.** It runs host-side with its normal tools; whole-session containment needs a future external launcher, not this extension.
- **A worker with `"sandbox": "off"` is deliberately uncontained.** It runs with your full user authority on the host. Only configure one on a machine where you would run its tasks yourself, and keep its catalog description honest about that scope.
- No resource limits (CPU/memory) are imposed yet, and macOS/Podman backends are not implemented.

## Worker session view

Like Claude Code's subagent navigation: with the editor empty, press **down** to move focus into the worker rows in the footer, **up/down** to change the highlighted worker, and **enter** to open that worker's live session pane — the task, assistant replies, and tool calls captured from its stream, rendered as a bounded widget **above pi's own editor** rather than a full-terminal takeover. The chat and input stay fully native while the pane is open: type and submit normally and the message goes to the coordinator, automatically prefixed with the viewed worker's id, name, and state, so "stop this, it's on the wrong file" arrives with its context attached. With an empty editor, **up/down** scrolls the pane line by line — touch terminals such as Termius on iOS deliver swipes as arrow keys, so swiping scrolls too — and **page up/down** scrolls by ten from any editor state (scrolled panes stop following live output until scrolled back to the bottom); **esc** with an empty editor closes it. Only live workers are listed; settled ones leave the rows immediately (they remain steerable in memory for an hour after their result is delivered; the viewed worker is retained while its pane is open). Any other key cancels selection and types into the editor as normal. Transcripts are kept in memory only, bounded to the last 400 entries per worker.

## Claude account failover

With a `claudeAccounts` config section, the orchestrator rotates Claude workers across accounts (claude-select/claude-auto-compatible state file) and handles usage limits automatically: the limited account is put in cooldown (reset time parsed from the limit message when present, 90 minutes otherwise), the worker restarts on the next available account resuming the same Claude session, and the interrupted instruction is resent. When every account is cooling down, the delegation fails with the earliest reset time so the coordinator can route to a Pi worker instead.

```json
{
  "claudeAccounts": {
    "state": "~/.claude-account-state.json",
    "accounts": { "claude1": "~/.claude-account1", "claude2": "~/.claude-account2" }
  }
}
```

The orchestrator picks the account itself (setting `CLAUDE_CONFIG_DIR`), so pair it with a launcher that respects a preset `CLAUDE_CONFIG_DIR`. An inherited `CLAUDE_CONFIG_DIR` from the surrounding shell is always stripped from worker environments so it cannot pin every worker to one account.

A takeover interrupted with esc no longer sticks: the next user prompt while the agent is idle restores orchestration, and `/orchestrator` force-exits it.

## Maintenance

```sh
pi update @kyleboas/pi-orchestrator
pi remove @kyleboas/pi-orchestrator
```

## Privacy and security

Worker stderr is never retained or reported, because it can contain local tool/auth details. Configuration errors are intentionally generic and never print config or environment contents. The orchestrator does not persist credentials, recipient IDs, or tokens; however, workers can access inherited environment variables and authentication context during execution. Pi and Claude Code use their own normal authentication.

## Development

```sh
npm install
npm test
npm run typecheck
npm run smoke
npm pack --dry-run
```
