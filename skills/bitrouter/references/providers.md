# Provider Configuration Reference

## Built-In Providers

These are compiled into bitrouter and auto-detected when their API key
environment variable is set.

### OpenAI

- Env prefix: `OPENAI`
- Auto-detected from: `OPENAI_API_KEY`
- Base URL override: `OPENAI_BASE_URL`
- Protocol: `openai`
- Models: `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-3.5-turbo`, `o1`, `o1-mini`, `o3-mini`

### Anthropic

- Env prefix: `ANTHROPIC`
- Auto-detected from: `ANTHROPIC_API_KEY`
- Base URL override: `ANTHROPIC_BASE_URL`
- Protocol: `anthropic`
- Models: `claude-sonnet-4-20250514`, `claude-3.5-haiku-20241022`, `claude-3-opus-20240229`

### Google

- Env prefix: `GOOGLE`
- Auto-detected from: `GOOGLE_API_KEY`
- Base URL override: `GOOGLE_BASE_URL`
- Protocol: `google`
- Models: `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-1.5-pro`, `gemini-1.5-flash`

---

## Custom Providers

Any OpenAI-compatible or Anthropic-compatible API can be added using the
`derives` field, which inherits all settings from an existing provider and
lets you override specific fields.

### OpenRouter

```yaml
providers:
  openrouter:
    derives: openai
    api_base: "https://openrouter.ai/api/v1"
    api_key: "${OPENROUTER_API_KEY}"
```

Usage: `openrouter:anthropic/claude-sonnet-4` (model IDs can contain slashes).

### Together AI

```yaml
providers:
  together:
    derives: openai
    api_base: "https://api.together.xyz/v1"
    api_key: "${TOGETHER_API_KEY}"
```

### Local Ollama

```yaml
providers:
  ollama:
    derives: openai
    api_base: "http://localhost:11434/v1"
    api_key: "ollama"
```

Usage: `ollama:llama3.1`, `ollama:codellama`.

### Moonshot (Anthropic-compatible)

```yaml
providers:
  moonshot:
    derives: anthropic
    api_base: "https://api.moonshot.ai/anthropic"
    api_key: "${MOONSHOT_API_KEY}"
```

---

## Auth Configuration

By default, providers use bearer token auth (`Authorization: Bearer <key>`).
You can customize this per provider.

### Custom Header

```yaml
providers:
  custom-api:
    api_protocol: openai
    api_base: "https://api.example.com/v1"
    auth:
      type: header
      header_name: "X-Api-Key"
      api_key: "${CUSTOM_API_KEY}"
```

### Extra Headers

```yaml
providers:
  openrouter:
    derives: openai
    api_base: "https://openrouter.ai/api/v1"
    api_key: "${OPENROUTER_API_KEY}"
    default_headers:
      HTTP-Referer: "https://myapp.com"
      X-Title: "My App"
```

---

## Named Models

Named models define routing strategies across providers.

### Priority (Failover)

Try endpoints in order. If the first fails, try the next:

```yaml
models:
  fast:
    strategy: priority
    endpoints:
      - provider: anthropic
        model_id: claude-3.5-haiku-20241022
      - provider: openai
        model_id: gpt-4o-mini
```

### Load Balance (Round-Robin)

Distribute requests evenly across endpoints:

```yaml
models:
  balanced:
    strategy: load_balance
    endpoints:
      - provider: openai
        model_id: gpt-4o
        api_key: "${OPENAI_KEY_A}"
      - provider: openai
        model_id: gpt-4o
        api_key: "${OPENAI_KEY_B}"
```

### Per-Endpoint Overrides

Each endpoint can override the provider's `api_key` and `api_base`:

```yaml
models:
  premium:
    strategy: priority
    endpoints:
      - provider: openai
        model_id: gpt-4o
        api_key: "${PREMIUM_OPENAI_KEY}"
        api_base: "https://premium-proxy.example.com/v1"
      - provider: openai
        model_id: gpt-4o
```

---

## Full Provider Config Schema

```yaml
providers:
  <name>:
    derives: <parent-provider>        # Inherit fields from another provider
    api_protocol: openai|anthropic|google
    api_base: "https://..."           # Base URL for API calls
    api_key: "..."                    # API key (supports ${VAR} substitution)
    env_prefix: "PREFIX"              # Auto-load PREFIX_API_KEY and PREFIX_BASE_URL
    auth:                             # Custom auth (optional)
      type: bearer|header|custom
      api_key: "..."
      header_name: "..."             # For type: header
      method: "..."                  # For type: custom
      params: {}                     # For type: custom
    default_headers:                  # Extra HTTP headers (optional)
      X-Custom: "value"
```
