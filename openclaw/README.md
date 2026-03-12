# @bitrouter/openclaw-plugin

BitRouter integration for OpenClaw — route LLM requests through a local multi-provider proxy with failover, load balancing, and unified API access.

## What is BitRouter?

[BitRouter](https://github.com/bitrouter/bitrouter) is a Rust-based LLM routing proxy that connects to upstream providers (OpenAI, Anthropic, Google) and exposes their APIs through a single local endpoint. It supports config-driven routing strategies including priority failover and round-robin load balancing.

This plugin integrates BitRouter natively into [OpenClaw](https://github.com/openclaw/openclaw), replacing manual CLI/skill-based setups with transparent, always-on routing.

## Quick Start

### Install

```bash
openclaw plugins install @bitrouter/openclaw-plugin
```

### Zero-Config Setup

If you already have provider API keys in your environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`), BitRouter picks them up automatically. No additional configuration is needed — the plugin will:

1. Start a BitRouter daemon on `127.0.0.1:8787`
2. Auto-detect your provider credentials from environment variables
3. Register itself as a provider in OpenClaw
4. Begin routing model requests through BitRouter

### Auth Fallback

If no environment variables are found, run:

```bash
openclaw models auth login --provider bitrouter
```

This prompts for your API keys and writes them to a local `.env` file that BitRouter reads on startup.

## Configuration

Add plugin config in your OpenClaw settings:

```jsonc
{
  "plugins": {
    "entries": {
      "bitrouter": {
        "enabled": true,
        "config": {
          // Optional — all fields have sensible defaults.
          "port": 8787,
          "host": "127.0.0.1",

          // Define virtual models with routing strategies.
          "models": {
            "fast": {
              "strategy": "load_balance",
              "endpoints": [
                { "provider": "openai", "modelId": "gpt-4o-mini" },
                { "provider": "anthropic", "modelId": "claude-3.5-haiku" }
              ]
            },
            "smart": {
              "strategy": "priority",
              "endpoints": [
                { "provider": "anthropic", "modelId": "claude-sonnet-4-20250514" },
                { "provider": "openai", "modelId": "gpt-4o" }
              ]
            }
          }
        }
      }
    }
  }
}
```

### Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | `number` | `8787` | Port for BitRouter to listen on. |
| `host` | `string` | `"127.0.0.1"` | Host address for BitRouter to bind to. |
| `autoStart` | `boolean` | `true` | Auto-start BitRouter when OpenClaw starts. |
| `healthCheckIntervalMs` | `number` | `30000` | Interval between health check polls (ms). |
| `interceptAllModels` | `boolean` | `false` | When `true`, route ALL model requests through BitRouter. When `false`, only intercept models with configured routes. |
| `providers` | `object` | `{}` | Provider configurations (see below). |
| `models` | `object` | `{}` | Model routing definitions (see below). |

### Provider Configuration

Providers are usually auto-detected from environment variables. Explicit config is only needed for custom providers or overrides:

```jsonc
{
  "providers": {
    // Override the default OpenAI base URL.
    "openai": {
      "apiBase": "https://my-proxy.com/v1"
    },

    // Custom provider that inherits from OpenAI.
    "openrouter": {
      "derives": "openai",
      "apiBase": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}"
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `apiKey` | `string` | API key or env var reference (`"${OPENAI_API_KEY}"`). Literal keys are stored in `.env`. |
| `apiBase` | `string` | Custom API base URL. |
| `envPrefix` | `string` | Env var prefix for auto-loading (e.g. `"OPENAI"` → reads `OPENAI_API_KEY`). |
| `derives` | `string` | Inherit defaults from a built-in provider (`"openai"`, `"anthropic"`, `"google"`). |

### Model Routing

Define virtual model names with routing strategies:

```jsonc
{
  "models": {
    "my-model": {
      "strategy": "priority",      // or "load_balance"
      "endpoints": [
        { "provider": "anthropic", "modelId": "claude-sonnet-4-20250514" },
        { "provider": "openai", "modelId": "gpt-4o" }
      ]
    }
  }
}
```

**Strategies:**

- **`priority`** (default) — Try endpoints in order. If the first fails, fall over to the next.
- **`load_balance`** — Distribute requests evenly via round-robin.

**Per-endpoint overrides:** Each endpoint can optionally specify `apiKey` and `apiBase` to override the provider defaults.

## Agent Tools

The plugin registers 4 optional tools that agents can call at runtime. Each maps directly to a BitRouter CLI command — the agent can observe state and manage authentication, but cannot interfere with the daemon lifecycle (which the plugin manages automatically).

| Tool | CLI equivalent | Purpose |
|------|---------------|---------|
| `bitrouter_status` | `bitrouter status` | Check health, providers, listen address, daemon status |
| `bitrouter_keygen` | `bitrouter keygen` | Generate a scoped JWT for API access |
| `bitrouter_account` | `bitrouter account` | Manage Ed25519 keypairs (list, generate, set active) |
| `bitrouter_keys` | `bitrouter keys` | List, inspect, or remove saved JWTs |

See [SKILL.md](./SKILL.md) for agent-facing usage guidance.

## Architecture

### Request Flow

```
Agent requests model "fast"
    │
    ▼
┌─────────────────────────────────┐
│  before_model_resolve hook      │
│                                 │
│  1. Known static route?         │
│     YES → override provider to  │
│           "bitrouter"           │
│                                 │
│  2. interceptAllModels?         │
│     YES → override provider     │
│     NO  → fall through          │
└───────────────┬─────────────────┘
                │ (redirected)
                ▼
┌─────────────────────────────────┐
│  OpenClaw sends request to      │
│  "bitrouter" provider           │
│  (http://127.0.0.1:8787)       │
└───────────────┬─────────────────┘
                │
                ▼
┌─────────────────────────────────┐
│  BitRouter resolves route and   │
│  proxies to upstream provider   │
└───────────────┬─────────────────┘
                │
                ▼
┌─────────────────────────────────┐
│  Upstream provider (OpenAI /    │
│  Anthropic / Google)            │
└─────────────────────────────────┘
```

### Credential Flow

The plugin uses **env var passthrough** by default:

1. Most users already have `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc. set — OpenClaw itself uses these.
2. BitRouter auto-detects these via its `env_prefix` mechanism. Zero config needed.
3. If no env vars are found, the plugin offers an auth flow that prompts for keys and writes them to a `.env` file in BitRouter's data directory.

### Binary Distribution

The `@bitrouter/cli` npm package (published via [cargo-dist](https://opensource.axo.dev/cargo-dist/)) provides platform-specific BitRouter binaries. On install, npm resolves the correct binary for your OS/architecture (like esbuild's distribution model). Fallback: `bitrouter` on `$PATH` or `cargo install bitrouter`.

### Module Structure

```
src/
├── index.ts      Plugin entry — activate(), wires everything together
├── types.ts      Shared types, OpenClaw API stubs, config defaults
├── service.ts    Daemon lifecycle — spawn/stop bitrouter process
├── config.ts     Generate bitrouter.yaml from plugin config
├── provider.ts   Register "bitrouter" as an OpenClaw provider
├── routing.ts    before_model_resolve hook, route table caching
├── health.ts     Health check loop, startup readiness polling
├── tools.ts      Agent tools — thin CLI wrappers for status, auth, and key management
├── metrics.ts    Fetch/cache metrics from BitRouter
├── gateway.ts    Gateway RPC methods for external access
├── auth.ts       Ed25519 keypair generation and JWT minting
├── auto-detect.ts  Scan environment for provider API keys
└── binary.ts     Binary resolution and auto-download from GitHub releases
```

## Troubleshooting

### BitRouter won't start

- **Binary not found:** Run `npm ls @bitrouter/cli` to check if the binary package is installed. If not, try `openclaw plugins install @bitrouter/openclaw-plugin` again, or install manually with `cargo install bitrouter`.
- **Port in use:** Another process may be using port 8787. Change the port in config: `"port": 9000`.
- **Check logs:** Look at `<data-dir>/bitrouter/logs/` for BitRouter's stdout/stderr output.

### Models not routing through BitRouter

- **Health check failing:** The `before_model_resolve` hook is a no-op when BitRouter is unhealthy. Check if the daemon is running.
- **Model not in routing table:** In selective mode (default), only models with configured routes are intercepted. Add the model to your `models` config, or set `"interceptAllModels": true`.
- **Direct routing:** Even without named routes, you can use `"provider:model_id"` syntax (e.g. `"openai:gpt-4o"`) which BitRouter handles via direct routing.

### API key errors

- **Check env vars:** Run `echo $OPENAI_API_KEY` to verify your keys are set.
- **Re-run auth:** `openclaw models auth login --provider bitrouter` to re-enter keys.
- **Check .env:** Look at `<data-dir>/bitrouter/.env` for stored keys.

## Development

### Building from source

```bash
git clone https://github.com/bitrouter/bitrouter-plugins.git
cd bitrouter-plugins/openclaw
npm install
npm run build
```

### Running tests

```bash
npm test              # single run
npm run test:watch    # watch mode
```

### Dev install in OpenClaw

```bash
openclaw plugins install -l ./bitrouter-plugins/openclaw
```

This creates a symlink so changes are reflected immediately (after `npm run build`).

## License

MIT
