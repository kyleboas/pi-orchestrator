# Pi Orchestrator

Persistent implementation-worker orchestration for [Pi](https://github.com/badlogic/pi-mono). The coordinator investigates and plans with read-only tools, delegates implementation to persistent workers, accepts steering, and only gains direct implementation tools after an explicit user takeover request.

Features: Pi RPC and Claude Code stream-json workers; exact-once result delivery; reload-safe process-global worker runtime; stop and steer controls; compact readable (non-dim) worker footer rows; replaceable catalog and executable configuration.

## Install

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

## Outcome ledger

Every settled run updates `~/.config/pi-orchestrator/stats.json`: aggregate per-worker task count, failures, steers, duration, tokens, and reported cost, plus a bounded latest-200 `recentRuns` ledger with worker, backend/model, truncated task, timestamp, outcome, duration, tokens, and cost when the provider supplied one. A per-worker summary (including average reported cost when available) is injected into the coordinator's system prompt so routing can optimize reliability and dollars as well as tokens. Pi cost is provider-reported only. Claude Code's `total_cost_usd` is stored as an estimated/notional API-equivalent value, not actual Claude subscription billing. The ledger is advisory, backward-compatible with the earlier aggregate-only shape, and corrupt or missing files load as empty; IO errors never disturb orchestration. Delete the file to reset it.

For example: “ask Opus to implement the migration and run its tests.” While a worker is live: “steer Opus: also cover rollback behavior.”

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

Worker stderr is never retained or reported, because it can contain local tool/auth details. Configuration errors are intentionally generic and never print config or environment contents. This package stores no credentials, recipient IDs, or tokens; Pi and Claude Code use their own normal authentication.

## Development

```sh
npm install
npm test
npm run typecheck
npm run smoke
npm pack --dry-run
```
