# Pi Orchestrator

Persistent implementation-worker orchestration for [Pi](https://github.com/badlogic/pi-mono). The coordinator investigates and plans with read-only tools, delegates implementation to persistent workers, accepts steering, and only gains direct implementation tools after an explicit user takeover request.

Features: Pi RPC and Claude Code stream-json workers; exact-once result delivery; reload-safe process-global worker runtime; stop and steer controls; compact readable (non-dim) worker footer rows; replaceable catalog and executable configuration.

## Install

> **Runtime trust warning:** Run this only in repositories you trust. Workers are ordinary host processes with implementation tools: repository content and delegated instructions can cause them to read or modify files, run commands, use credentials already on the host, and make network requests. This extension provides no containment. For untrusted code, run the whole coordinator inside a container, VM, or other isolated environment.

```sh
pi install git:github.com/kyleboas/pi-orchestrator
```

Restart Pi or run `/reload`. If you already use a vendored/local orchestrator extension, disable or remove it first: running two orchestrators creates conflicting tools and worker ownership.

Pi workers require `pi` on `PATH`. Claude workers are optional and require Claude Code (`claude`) on `PATH` and its normal authentication. Workers run in the coordinator's current directory with implementation tools.

## Default catalog

Every worker is an individual, explicit model profile. Pi workers **never inherit the coordinator model**: each Pi RPC launch always uses the `model` and `thinking` in that worker's profile. The default catalog is:

- Claude Code: `Opus 5 Medium`, `Opus 5 Low`, `Sonnet High/Medium/Low`, and `Haiku High/Medium/Low`
- Pi RPC: `GPT-5.6 Terra xHigh/High/Medium/Low`, `GPT-5.6 Luna xHigh/High/Medium/Low`, and `GPT-5.6 Sol Medium/Low`
- `GPT-5.6 Luna Low` is the cheap default for routine bounded work. Higher tiers are for harder work; `xHigh` is the maximum thinking level.

Each worker may carry a `description` (in config too) that tells the coordinator what the tier is for. For an unqualified new task, the coordinator starts with GPT-5.6 Luna Low unless its already-inspected scope needs a stronger tier; explicit user worker choices always win. It escalates only for known complexity or after a cheaper attempt cannot finish. Distinct tasks receive new delegates; steering is only continuation/correction of the same task.

## Outcome ledger and routing advice

Every attempt updates `~/.config/pi-orchestrator/stats.json` with a stable root-task ID and unique run ID. A completed result starts as `completed` (pending coordinator review); review resolves it to `accepted` or `rework`. Terminal execution states are recorded separately as `failed`, `unavailable` (spawn/account/stdin/provider availability), or `cancelled`. Status resolution updates the existing run exactly once, so lifetime aggregates do not double-count review transitions. The bounded latest-200 `recentRuns` ledger persists only IDs, worker/backend/model, timestamp, status, duration/tokens/cost, and broad task category/complexity — not task text.

The coordinator receives concise lifetime context plus matching seven-day category/complexity evidence when at least three samples exist: status/acceptance signals and p50/p95 duration, with Pi provider-reported cost and Claude API-equivalent estimated/notional cost always labeled separately. Sparse evidence is explicitly advisory, never hard routing; existing tier rules and explicit user worker choice still win.

`orchestrator_delegate` accepts optional `category` (`code`, `tests`, `documentation`, `operations`, `research`, or `integration`) and `complexity` (`low`, `medium`, or `high`). Omitted values use deterministic task-text classification. A separately delegated retry can pass `retryOf` with a prior root task ID returned in tool details; an unresolved ID safely creates a new root. `orchestrator_steer` accepts `kind: correction|continuation`: correction marks the preceding completed attempt `rework`; continuation accepts it before starting the next attempt on the same root. Omitted steer kinds conservatively mean correction. It also accepts `interrupt: true` for a working Pi RPC worker that is actively heading the wrong way: the in-flight run is aborted through the Pi RPC `abort` command before the instructions are delivered, and the aborted run's partial output is discarded rather than reported as a result. Claude workers cannot be aborted mid-turn; an interrupt steer to one degrades to the normal queued follow-up and says so in the tool result.

`orchestrator_stop` kills the worker's entire process tree. Every worker is spawned as its own process group so stop, failover, and coordinator-exit cleanup can signal grandchildren too — a stuck deploy or long-running command cannot survive as an orphan.

The ledger is advisory and backwards-compatible with aggregate-only v1/v2 data. On initialization, old malformed top-level aggregate keys are removed only after a timestamped sibling backup is made; reserved aggregate names can never become workers. If a still-loaded v2 extension has overwritten a v3 cleanup, the next startup narrowly detects a v2 live file plus a richer sibling backup, snapshots the v2 file, retains its current lifetime totals, and deterministically unions its newer attempts with the backup before writing v3. Corrupt or missing files load as empty, and ledger IO errors never disturb orchestration. Delete the file to reset it.

For example: “ask Opus to implement the migration and run its tests.” While a worker is live: “steer Opus with correction: also cover rollback behavior.”

These model names are product defaults and may not exist in another user's provider or Claude setup. Supply your own complete `workers` catalog when they are unavailable; a configured catalog replaces all built-in defaults and may use arbitrary valid display names, Pi `provider/model` IDs, and Pi thinking levels.

## Configuration

Configuration is read once when the extension initializes. It uses `PI_ORCHESTRATOR_CONFIG` when set; otherwise it reads `~/.config/pi-orchestrator/config.json` if present; otherwise defaults apply. `~` is expanded in the config-path environment variable. Invalid, empty, duplicate, or incomplete worker catalogs safely use the full explicit default catalog without exposing configuration contents.

`checkInMinutes` is an optional nonnegative finite number and defaults to `15`; set it to `0` to disable check-ins. The first passive assessment is after this base interval. Healthy/on-track workers then back off to 30 minutes (at most 2x the configured base); suspicious, stalled, or newly steered workers reset to the base interval. Assessments use only already-captured task, transcript, and lifecycle state and never send a message to, steer, or interrupt the worker. Each digest carries a pace line: elapsed run time plus the p50 and p95 durations of that worker's comparable recent runs and the projected time to whichever it has not yet passed. The reference class widens until it holds at least three runs — same category and complexity first, then the same complexity across categories, then the worker's whole seven-day history — and the line names whichever class it drew from. The estimate is drawn entirely from the outcome ledger; the worker is never asked how far along it is, since that would require the RPC round trip the passive check exists to avoid. A worker with fewer than three recent runs of any kind reports elapsed time and says so. Healthy checks are hidden custom next-turn context (`triggerTurn:false`), so they do not wake the coordinator or require an acknowledgement. Only concrete suspicious signals — inactivity, blocked/error/permission/conflict/rate-limit language, or obvious repeated activity — send a coordinator follow-up, and it should steer only for actual drift.

`rolloverContextPercent` is an optional finite percentage from `0` through `100`, defaulting to the conservative `38`. Set it to `0` to disable outcome-boundary rollover. After a worker result is delivered, if no worker is starting, working, or settling and context use is at least this threshold, the extension requests one Pi compaction at the next `agent_end` boundary. Its handoff preserves the user goal, decisions, authoritative paths, changed files, validation, commits/PRs, and blockers while dropping routine tool/status chatter. It never compacts active work or small contexts, does not repeat the same outcome, and safely retries after a failed compaction.

`maxConcurrentWorkers` is an optional nonnegative integer and defaults to `3`; set it to `0` to remove the cap. Delegation is rejected while that many workers already hold a live process, and the rejection names them so the coordinator can wait or stop one. Workers that have settled but are still listed do not count, since only a live process holds memory. Each worker is a full model runtime in the hundreds of megabytes, so on a small host the concurrent worker count, not the chosen model tier, is what exhausts memory and drives the box into swap. Raise it on a machine with the RAM to spare.

`workers` is a complete catalog, either an object keyed by display name or an array whose entries have `name`. Names must be unique (case-insensitive), start with a letter, and contain only letters, numbers, spaces, and hyphens. Every Pi RPC worker requires a nonempty `provider/model` `model` and a `thinking` level (`low`, `medium`, `high`, or `xhigh`). Every Claude worker requires a nonempty model alias or model string.

## Worker session view

Like Claude Code's subagent navigation: with the editor empty, press **down** to move focus into the worker rows in the footer, **up/down** to change the highlighted worker, and **enter** to open that worker's live session view — the task, assistant replies, and tool calls captured from its stream. **Up/down** scrolls a line at a time, the **mouse wheel** three lines, **page up/down** a screen, **home** jumps to the oldest captured output, and **end** returns to the bottom. The view turns on terminal mouse tracking while it is open and turns it off again on exit, so the wheel reaches the view rather than the terminal; native text selection is unavailable for as long as the view is open. A scrolled view holds its place: output arriving below it does not drag the viewport down, and it stops following live output until you press **end** or scroll back to the bottom. The hint line states which of the two it is doing. **Esc** (or `q`) returns to the row list; **esc** again, or moving up past the first row, returns focus to the editor. A live row's trailing status reads `23m ~20m`: elapsed time against the ledger p50 for that worker's reference class, so an overrun is visible without opening the session. A trailing asterisk (`~20m*`) marks a p50 drawn from a widened class. Both times count from the last instruction, the same anchor the ledger records durations from, and elapsed time is shown in whole minutes past the first one. The estimate is resolved once per run rather than per repaint. Rows carry no token total, because providers report usage only at the end of a turn: a single-turn run would show nothing for its whole duration and then a stale carried-over figure on the next run. Only live workers are listed; settled ones leave the rows immediately. A completed worker remains steerable through the coordinator's review turn, then its subprocess is stopped automatically at the safe settled boundary; retained metadata ages out after an hour. Any other key cancels selection and types into the editor as normal. Transcripts are kept in memory only, bounded to the last 400 entries per worker.

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

Worker stderr is never retained or reported, because it can contain local tool/auth details. Configuration errors are intentionally generic and never print config or environment contents. The orchestrator does not persist credentials, recipient IDs, or tokens. Pi and Claude Code use their own normal authentication.

Workers inherit the coordinator's environment minus every `GH_*`, `GITHUB_*`, `SSH_*`, and `GIT_*` variable, so ambient forge tokens are not handed to a delegated process. This is hygiene, not containment: a worker still runs as your user and can read `~/.config/gh`, `~/.ssh`, and every other credential file on the host. Treat a delegated worker as having exactly your own access.

Earlier versions shipped an optional bubblewrap worker sandbox, a credential-free pull-request broker, and a network gateway relay. They were removed in favor of a single-purpose orchestrator; the last commit containing them is tagged [`sandbox-final`](../../tree/sandbox-final).

## Development

```sh
npm install
npm test
npm run typecheck
npm run smoke
npm pack --dry-run
```
