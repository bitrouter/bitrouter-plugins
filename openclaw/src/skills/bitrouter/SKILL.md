---
name: bitrouter
description: Control LLM routing strategy for sub-agents — mint scoped JWTs with model restrictions, budget caps, and expiry before delegating tasks.
user-invocable: false
---

# BitRouter Routing Skill

All your LLM calls flow through a local BitRouter proxy. This skill teaches you to **actively control routing** when delegating work to sub-agents by minting scoped tokens before spawning them.

## Why

Sub-agents inherit your model and provider by default. With BitRouter you can:

- **Restrict models** — a summarizer shouldn't use an expensive reasoning model
- **Cap spend** — give each sub-agent a hard budget it cannot exceed
- **Limit rounds** — cap the number of LLM calls a sub-agent can make
- **Set expiry** — token expires after the task window, no lingering access

## Tools

### `bitrouter_status`
Verify the daemon is running. Call this first if something seems wrong.

### `bitrouter_keygen`
Mint a scoped JWT for a sub-agent.

| Parameter | Type | Description |
|-----------|------|-------------|
| `scope` | string | `"api"` (default) or `"admin"` |
| `exp` | string | Expiry: `"5m"`, `"1h"`, `"30d"`, `"never"` |
| `models` | string | Comma-separated allowed model glob patterns |
| `budget` | number | Spend cap in micro-USD (1 USD = 1,000,000 µUSD) |
| `budget_scope` | string | `"session"` or `"account"` |
| `budget_range` | string | `"rounds:N"` or `"duration:Ns"` |

### `bitrouter_keys`
List or inspect saved tokens (auditing).

## Delegation Pattern

Before spawning a sub-agent:

1. Decide: what model tier does this task need? How much can it spend?
2. Call `bitrouter_keygen` to mint a constrained JWT
3. Include `BITROUTER_TOKEN=<jwt>` in the sub-agent's task prompt
4. The sub-agent authenticates to BitRouter with that token — server enforces limits

## Token Design by Task

| Task | Models | Budget | Rounds |
|------|--------|--------|--------|
| Quick classification / yes-no | `anthropic/claude-3-haiku` | $0.005 (5000 µUSD) | `rounds:3` |
| Summarization / extraction | `anthropic/claude-3-haiku,openai/gpt-4o-mini` | $0.02 (20000 µUSD) | `rounds:5` |
| Research / drafting | `anthropic/claude-3-5-sonnet*,openai/gpt-4o` | $0.20 (200000 µUSD) | — |
| Complex reasoning / synthesis | `anthropic/claude-opus*,openai/o3*` | $1.00 (1000000 µUSD) | — |

## Example

```
// Mint a cheap token for a summarization sub-agent
bitrouter_keygen({
  exp: "10m",
  models: "anthropic/claude-3-haiku,openai/gpt-4o-mini",
  budget: 20000,
  budget_scope: "session",
  budget_range: "rounds:5"
})
// → returns a JWT string

// Pass it to the sub-agent in the task prompt:
// "Summarize the following text. BITROUTER_TOKEN=<jwt>\n\n<text>"
```

## Notes

- Budget is enforced server-side; sub-agents cannot bypass it
- If a sub-agent hits its budget, BitRouter returns 402 on the next call
- You do not need to revoke tokens — expiry handles cleanup
- Tokens are scoped to the current BitRouter instance; they don't work elsewhere
