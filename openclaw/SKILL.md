# BitRouter Agent Tools

The BitRouter plugin provides 4 tools that map directly to BitRouter CLI
commands. Use them to observe and authenticate with the local LLM proxy
during your session.

## Tools

| Tool | CLI equivalent | When to use |
|------|---------------|-------------|
| `bitrouter_status` | `bitrouter status` | Check if BitRouter is running, see providers and listen address |
| `bitrouter_keygen` | `bitrouter keygen` | Create a scoped JWT for API access |
| `bitrouter_account` | `bitrouter account` | Manage Ed25519 keypairs (list, generate, set active) |
| `bitrouter_keys` | `bitrouter keys` | List, inspect, or remove saved JWTs |

## Quick patterns

**Check what's available:**
Call `bitrouter_status` — it prints providers, listen address, and daemon PID.

**Generate a scoped token:**
```
bitrouter_keygen(scope: "api", exp: "1h", models: "openai:gpt-4o,anthropic:*")
```

**Create a new account keypair:**
```
bitrouter_account(action: "generate")
```

**Inspect a saved token's claims:**
```
bitrouter_keys(action: "show", name: "my-token")
```

## How routing works

BitRouter listens at `http://127.0.0.1:8787` and exposes:
- `POST /v1/chat/completions` (OpenAI-compatible)
- `POST /v1/messages` (Anthropic-compatible)
- `POST /v1/responses` (OpenAI Responses API)

Use `provider:model_id` format for direct routing (e.g. `openai:gpt-4o`),
or named models from the config for failover/load-balancing.

## Daemon lifecycle

The plugin manages BitRouter's daemon automatically — it starts on
activation and stops on deactivation. You do not need to start, stop,
or restart the daemon. If you need to check whether it's running, use
`bitrouter_status`.

## When NOT to use these tools

- For making LLM requests, just use the normal model APIs pointed at
  `http://127.0.0.1:8787`. You don't need a tool for that.
- For config changes, edit `~/.bitrouter/bitrouter.yaml` directly —
  the plugin will pick up changes on next restart.
