# Pi Orchestrator

Persistent implementation-worker orchestration for [Pi](https://github.com/badlogic/pi-mono). The coordinator investigates and plans with read-only tools, delegates implementation to persistent workers, accepts steering, and only gains direct implementation tools after an explicit user takeover request.

Features: Pi RPC and Claude Code stream-json workers; exact-once result delivery; reload-safe process-global worker runtime; stop and steer controls; compact readable (non-dim) worker footer rows; portable catalog and executable configuration.

## Install

```sh
pi install git:github.com/kyleboas/pi-orchestrator
```

Restart Pi or run `/reload`. If you already use a vendored/local orchestrator extension, disable or remove it first: running two orchestrators creates conflicting tools and worker ownership.

Pi workers require `pi` on `PATH` and an available coordinator model. Claude workers are optional and require Claude Code (`claude`) on `PATH` and its normal authentication. Workers run in the coordinator's current directory with implementation tools.

By default the catalog is:

- `Pi-High`, `Pi-Medium`, `Pi-Low`: Pi RPC workers with high, medium, and low thinking. They inherit the provider/model selected when the coordinator session activates.
- `Opus`, `Sonnet`, `Haiku`: persistent Claude Code workers using the standard aliases.

For example: “ask Opus to implement the migration and run its tests.” While a worker is live: “steer Opus: also cover rollback behavior.”

## Configuration

Configuration is read once when the extension initializes. It uses `PI_ORCHESTRATOR_CONFIG` when set; otherwise it reads `~/.config/pi-orchestrator/config.json` if present; otherwise defaults apply. `~` is expanded in the config-path environment variable. Invalid, empty, or duplicate worker catalogs safely use defaults without exposing configuration contents.

`workers` is a complete catalog, either an object keyed by display name or an array whose entries have `name`. Names must be unique (case-insensitive), start with a letter, and contain only letters, numbers, spaces, and hyphens. A Pi model is `provider/id`; a Claude model is any nonempty alias or model string.

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
    "Reviewer": { "backend": "pi-rpc", "thinking": "medium" },
    "Fable": { "backend": "claude-code", "model": "fable-custom-alias-placeholder" }
  }
}
```

`coordinator` is optional. It defaults to high thinking; it changes the coordinator model only when **both** `provider` and `id` are supplied. An unpinned Pi worker inherits the model captured at activation; if no model was captured, that delegation fails safely. See [`examples/config.json`](examples/config.json) for the same portable shape and placeholder IDs.

Executable overrides are command names or executable paths, never shell snippets. Config `commands.pi` and `commands.claude` set them; environment variables take precedence:

```sh
PI_ORCHESTRATOR_PI_BIN=pi PI_ORCHESTRATOR_CLAUDE_BIN=claude-auto pi
```

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
npm pack --dry-run
```
