---
name: bitrouter
description: >
  Set up and run BitRouter as a local LLM proxy that routes requests to
  OpenAI, Anthropic, Google, and custom providers through a single endpoint.
  Use this skill when you need to install bitrouter, configure LLM providers,
  start the proxy server, or route model requests through localhost:8787.
  Triggers on: bitrouter setup, LLM proxy, model routing, multi-provider
  gateway, local AI proxy, configuring bitrouter.yaml.
license: MIT
compatibility: Requires internet access and cargo (Rust toolchain).
metadata:
  author: BitRouterAI
  version: "0.2.0"
---

# BitRouter -- Local LLM Proxy Onboarding

BitRouter is a local LLM proxy that gives you a single endpoint
(`http://127.0.0.1:8787`) routing to OpenAI, Anthropic, Google, or any
OpenAI-compatible provider. No auth needed locally by default.

---

## Step 0: Assess Current State

Before doing anything, figure out where things stand. Run these checks and
skip ahead to the matching section:

```bash
# 1. Is bitrouter installed?
command -v bitrouter

# 2. Is it already running?
bitrouter status

# 3. Does a config exist?
ls ~/.bitrouter/bitrouter.yaml 2>/dev/null

# 4. Which provider API keys are available?
[ -n "${OPENAI_API_KEY:-}" ]    && echo "openai: available"
[ -n "${ANTHROPIC_API_KEY:-}" ] && echo "anthropic: available"
[ -n "${GOOGLE_API_KEY:-}" ]    && echo "google: available"
```

| State | Go to |
|-------|-------|
| Running + healthy (`bitrouter status` shows PID) | Step 4: Verify & Use |
| Installed + config exists but not running | Step 3: Start |
| Installed but no config | Step 2: Configure |
| Not installed | Step 1: Install |

---

## Step 1: Install

```bash
cargo install bitrouter
```

This compiles from source and takes a few minutes on first install. Requires
the Rust toolchain -- if `cargo` is not found, install it from
https://rustup.rs first.

---

## Step 2: Configure

### Path A: Zero-Config (Recommended)

If provider API keys are already in your environment (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`), bitrouter auto-detects them. No
config file needed -- skip to Step 3.

BitRouter ships with built-in definitions for OpenAI, Anthropic, and Google.
When it sees `PROVIDER_API_KEY` in the environment, those providers become
available automatically.

### Path B: Write Config

When you need explicit control -- custom providers, named models, failover,
or load balancing -- write a config file.

BitRouter looks for config in this order:
1. `--config-file <path>` flag
2. `./bitrouter.yaml` in the current directory
3. `$BITROUTER_HOME/bitrouter.yaml`
4. `~/.bitrouter/bitrouter.yaml` (created if missing)

**Minimal config** -- detect which API keys exist and generate only what's
needed:

```yaml
server:
  listen: "127.0.0.1:8787"

providers:
  openai:
    api_key: "${OPENAI_API_KEY}"
  anthropic:
    api_key: "${ANTHROPIC_API_KEY}"
  google:
    api_key: "${GOOGLE_API_KEY}"
```

The `${VAR}` syntax pulls from environment variables or a `.env` file at
`~/.bitrouter/.env`. Only include providers whose keys you have.

**With named models and failover:**

```yaml
server:
  listen: "127.0.0.1:8787"

providers:
  openai:
    api_key: "${OPENAI_API_KEY}"
  anthropic:
    api_key: "${ANTHROPIC_API_KEY}"

models:
  default:
    strategy: priority
    endpoints:
      - provider: anthropic
        model_id: claude-sonnet-4-20250514
      - provider: openai
        model_id: gpt-4o
```

With `strategy: priority`, requests to model `"default"` go to the first
endpoint; if it fails, bitrouter tries the next. Use `strategy: load_balance`
for round-robin distribution.

For custom providers (OpenRouter, Ollama, etc.), see
`references/providers.md`.

**Secrets via .env file** -- keep API keys out of YAML:

```bash
# ~/.bitrouter/.env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Step 3: Start

```bash
# Background daemon (recommended for agents)
bitrouter start

# Check it started
bitrouter status
```

Or run in foreground without the TUI:

```bash
bitrouter serve --headless
```

If the port is already in use or startup fails, see
`references/troubleshooting.md`.

### Lifecycle Commands

```bash
bitrouter status    # Show PID, providers, models, listen address
bitrouter stop      # Graceful shutdown
bitrouter restart   # Stop + start, re-reads config
```

---

## Step 4: Verify & Use

```bash
# Health check
curl -s http://127.0.0.1:8787/health
# → {"status":"ok"}
```

### Model Naming

**Direct routing** -- `provider:model_id` format, works with any provider
that has an API key configured:

```
openai:gpt-4o
openai:gpt-4o-mini
openai:o3-mini
anthropic:claude-sonnet-4-20250514
anthropic:claude-3.5-haiku-20241022
google:gemini-2.5-flash
google:gemini-1.5-pro
```

**Named models** -- aliases defined in the `models:` section of your config
(e.g. `"default"`). These support failover and load balancing.

### Making Requests

Bitrouter exposes protocol-compatible endpoints. No auth headers needed when
`master_key` is not set (the default).

**OpenAI-compatible** (`/v1/chat/completions`):

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai:gpt-4o",
    "messages": [{"role": "user", "content": "ping"}]
  }'
```

**Anthropic-compatible** (`/v1/messages`):

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic:claude-sonnet-4-20250514",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "ping"}]
  }'
```

Any SDK that accepts a custom base URL works -- just point it at
`http://127.0.0.1:8787` and use the model names above.

### SDK Integration Examples

**Python (OpenAI SDK):**
```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="unused")
response = client.chat.completions.create(
    model="openai:gpt-4o",
    messages=[{"role": "user", "content": "Hello"}],
)
```

**Python (Anthropic SDK):**
```python
from anthropic import Anthropic
client = Anthropic(base_url="http://127.0.0.1:8787", api_key="unused")
message = client.messages.create(
    model="anthropic:claude-sonnet-4-20250514",
    max_tokens=256,
    messages=[{"role": "user", "content": "Hello"}],
)
```

---

## Available Endpoints

| Endpoint | Protocol |
|----------|----------|
| `GET /health` | Health check |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses` | OpenAI Responses API |
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1beta/models/generateContent` | Google Generative AI |

---

## Reference Documentation

- `references/providers.md` -- Custom providers, derived configs, auth options, all built-in models
- `references/troubleshooting.md` -- Port conflicts, stale daemons, API key issues, config errors
