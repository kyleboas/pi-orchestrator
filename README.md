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

Each worker may carry a `description` (in config too) that tells the coordinator what the tier is for. The coordinator is instructed to default to the cheapest plausible tier and escalate only when difficulty demands it.

## Outcome ledger

Every settled run appends to `~/.config/pi-orchestrator/stats.json`: per worker name, task count, failures, steers, total duration, and tokens. A per-worker summary (averages) is injected into the coordinator's system prompt each turn so tier choice is informed by the actual track record — failure-prone cheap tiers get escalated, reliable ones keep the work. The ledger is advisory: corrupt or missing files load as empty and IO errors never disturb orchestration. Delete the file to reset the record.

For example: “ask Opus to implement the migration and run its tests.” While a worker is live: “steer Opus: also cover rollback behavior.”

The Terra, Sol, and Fable aliases are opinionated defaults from this package's author and may not exist in another user's provider or Claude setup. Supply your own complete `workers` catalog when they are unavailable; a configured catalog replaces all seven defaults and may use arbitrary valid display names, Pi `provider/model` IDs, and Pi thinking levels.

## Configuration

Configuration is read once when the extension initializes. It uses `PI_ORCHESTRATOR_CONFIG` when set; otherwise it reads `~/.config/pi-orchestrator/config.json` if present; otherwise defaults apply. `~` is expanded in the config-path environment variable. Invalid, empty, duplicate, or incomplete worker catalogs safely use the full explicit default catalog without exposing configuration contents.

`workers` is a complete catalog, either an object keyed by display name or an array whose entries have `name`. Names must be unique (case-insensitive), start with a letter, and contain only letters, numbers, spaces, and hyphens. Every Pi RPC worker requires a nonempty `provider/model` `model` and a `thinking` level (`low`, `medium`, or `high`). Every Claude worker requires a nonempty model alias or model string.

```json
{
  "coordinator": {
    "provider": "example-provider",
    "id": "coordinator-model-placeholder",
    "thinking": "high"
  },
  "commands": { "pi": "pi", "claude": "claude-auto" },
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
