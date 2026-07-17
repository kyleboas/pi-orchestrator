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

`orchestrator_delegate` accepts optional `category` (`code`, `tests`, `documentation`, `operations`, `research`, or `integration`) and `complexity` (`low`, `medium`, or `high`). Omitted values use deterministic task-text classification. A separately delegated retry can pass `retryOf` with a prior root task ID returned in tool details; an unresolved ID safely creates a new root. `orchestrator_steer` accepts `kind: correction|continuation`: correction marks the preceding completed attempt `rework`; continuation accepts it before starting the next attempt on the same root. Omitted steer kinds conservatively mean correction.

The ledger is advisory and backwards-compatible with aggregate-only v1/v2 data. On initialization, old malformed top-level aggregate keys are removed only after a timestamped sibling backup is made; reserved aggregate names can never become workers. If a still-loaded v2 extension has overwritten a v3 cleanup, the next startup narrowly detects a v2 live file plus a richer sibling backup, snapshots the v2 file, retains its current lifetime totals, and deterministically unions its newer attempts with the backup before writing v3. Corrupt or missing files load as empty, and ledger IO errors never disturb orchestration. Delete the file to reset it.

For example: “ask Opus to implement the migration and run its tests.” While a worker is live: “steer Opus with correction: also cover rollback behavior.”

The Terra, Sol, and Fable aliases are opinionated defaults from this package's author and may not exist in another user's provider or Claude setup. Supply your own complete `workers` catalog when they are unavailable; a configured catalog replaces all seven defaults and may use arbitrary valid display names, Pi `provider/model` IDs, and Pi thinking levels.

## Configuration

Configuration is read once when the extension initializes. It uses `PI_ORCHESTRATOR_CONFIG` when set; otherwise it reads `~/.config/pi-orchestrator/config.json` if present; otherwise defaults apply. `~` is expanded in the config-path environment variable. Invalid, empty, duplicate, or incomplete worker catalogs safely use the full explicit default catalog without exposing configuration contents.

`checkInMinutes` is an optional nonnegative finite number and defaults to `15`; set it to `0` to disable check-ins. The first passive assessment is after this base interval. Healthy/on-track workers then back off to 30 minutes (at most 2x the configured base); suspicious, stalled, or newly steered workers reset to the base interval. Assessments use only already-captured task, transcript, and lifecycle state and never send a message to, steer, or interrupt the worker. Healthy checks are hidden custom next-turn context (`triggerTurn:false`), so they do not wake the coordinator or require an acknowledgement. Only concrete suspicious signals — inactivity, blocked/error/permission/conflict/rate-limit language, or obvious repeated activity — send a coordinator follow-up, and it should steer only for actual drift.

`rolloverContextPercent` is an optional finite percentage from `0` through `100`, defaulting to the conservative `38`. Set it to `0` to disable outcome-boundary rollover. After a worker result is delivered, if no worker is starting, working, or settling and context use is at least this threshold, the extension requests one Pi compaction at the next `agent_end` boundary. Its handoff preserves the user goal, decisions, authoritative paths, changed files, validation, commits/PRs, and blockers while dropping routine tool/status chatter. It never compacts active work or small contexts, does not repeat the same outcome, and safely retries after a failed compaction.

`workers` is a complete catalog, either an object keyed by display name or an array whose entries have `name`. Names must be unique (case-insensitive), start with a letter, and contain only letters, numbers, spaces, and hyphens. Every Pi RPC worker requires a nonempty `provider/model` `model` and a `thinking` level (`low`, `medium`, or `high`). Every Claude worker requires a nonempty model alias or model string.

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
    "network": "host",
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
- `required`: fail closed. A missing binary, failed namespace probe, unresolvable worker executable, or unenforceable `network: "none"` rejects the delegation; nothing ever silently falls back. A malformed `sandbox` block also disables delegation rather than quietly becoming `off`.

Sandboxed workers additionally require a **workspace policy**. `workspaceRoots` lists the directories whose contents may be selected as per-task workspaces; `orchestrator_delegate` accepts an optional `cwd` naming the exact repository directory, which is canonicalized (symlinks cannot escape) and must be equal to or inside a configured root — only that selected directory is mounted read-write, never a whole root. When `cwd` is omitted, the coordinator's session cwd is used only if it passes the same checks; otherwise the delegation is rejected with instructions to pass a repo cwd. The host home directory (or any ancestor of it, or anything overlapping the worker's isolated home) is always refused as a workspace, in every sandbox mode, because binding it would expose the entire home read-write and shadow the isolated HOME/token mounts. With no `workspaceRoots` configured, sandboxed delegation fails closed. Never list your home directory itself as a workspace root.

What a sandboxed worker gets: the selected workspace directory read-write; a private per-worker HOME (removed on exit) and tmpfs `/tmp`; system runtimes, certificates, and the resolved worker executable's runtime root (nvm-style Node trees and standalone Claude installs are handled) read-only; minimal `/proc` and `/dev`; new PID/IPC/UTS namespaces with parent-death teardown, so killing the worker reliably kills its whole process tree. The rest of the home directory, `/root`, `/var`, and unrelated `/etc` are not mounted. `readOnlyPaths` adds strict read-only mounts (a missing path fails the launch loudly).

`env: "allowlist"` is the default whenever the sandbox is enabled (`preferred` or `required`): it passes only conservative non-credential names (PATH, HOME, TERM, locale, and similar) plus explicit `envAllow` additions — provider/gateway variables must be named explicitly. `env: "inherit"` keeps the full environment and must be opted into; `mode: "off"` keeps legacy full inheritance. Environment values are passed via the process environment, never in bwrap argv, so they cannot leak into process listings.

Pi workers do not see the host `~/.pi` directory. Each sandboxed Pi worker gets an isolated agent directory inside its private HOME (`PI_CODING_AGENT_DIR`), into which only `auth.json` and `models.json` are bound read-only as individual files; sessions, chat data, logs, secret stores, prompts, and other private state under `~/.pi` are never mounted. Similarly only the exact host `~/.config/agent/gateway.token` file is mounted (read-only) for gateway-routed provider configs, never the surrounding directory — and its destination is `.config/agent/gateway.token` inside the worker's isolated HOME, because consumers resolve that path against `$HOME`. A host-absolute destination would be invisible to them.

`network: "host"` (default) shares host networking because a host-local model gateway on `127.0.0.1` requires it. `network: "none"` unshares the network namespace entirely and is verified by the probe; workers that must reach any model API will not function under it today.

Exact non-guarantees — this is containment, not a full security boundary:

- **Network egress is not restricted** under `network: "host"`: a worker can reach the host loopback and the internet, and prompts inherently send mounted repository content to the model provider.
- **Active provider credentials remain visible to their worker.** A Claude worker mounts its selected account directory (or `~/.claude` when no accounts are configured) read-write, and a Pi worker can read the narrowly mounted `auth.json`, `models.json`, and `gateway.token` files. The mounts are minimal, but those live credentials are still readable by that worker until gateway-based auth isolation replaces them.
- **The coordinator itself is not sandboxed.** It runs host-side with its normal tools; whole-session containment needs a future external launcher, not this extension.
- No resource limits (CPU/memory) are imposed yet, and macOS/Podman backends are not implemented.

## Worker session view

Like Claude Code's subagent navigation: with the editor empty, press **down** to move focus into the worker rows in the footer, **up/down** to change the highlighted worker, and **enter** to open that worker's live session view — the task, assistant replies, and tool calls captured from its stream. **Up/down** scrolls the view (page up/down for pages; scrolled views stop following live output until scrolled back to the bottom), and **esc** (or `q`) returns to the row list; **esc** again, or moving up past the first row, returns focus to the editor. Only live workers are listed; settled ones leave the rows immediately (they remain steerable in memory for an hour after their result is delivered). Any other key cancels selection and types into the editor as normal. Transcripts are kept in memory only, bounded to the last 400 entries per worker.

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
