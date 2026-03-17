---
name: bitrouter
description: Manage BitRouter LLM proxy — check status, add/remove routes, generate scoped tokens, and control sub-agent delegation policies.
user-invocable: true
---

# BitRouter Management

All LLM calls flow through a local BitRouter proxy. This skill covers status checks, route management, key generation, and sub-agent delegation.

## Status & Diagnostics

```bash
openclaw bitrouter status          # overview: health, routes, wallet
curl http://127.0.0.1:8787/health  # daemon health check
curl http://127.0.0.1:8787/v1/routes   # active routing table
curl http://127.0.0.1:8787/v1/metrics  # request counts, latency, spend
```

## Route Management

Admin operations require a short-lived admin token:

```bash
# Mint a 5-minute admin token
ADMIN_TOKEN=$(bitrouter --home-dir ~/.openclaw/plugins/bitrouter keygen --scope admin --exp 5m 2>/dev/null)

# List all routes (config + dynamic)
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:8787/admin/routes | jq .

# Add a route
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8787/admin/routes \
  -d '{"model":"fast","endpoints":[{"provider":"openai","model_id":"gpt-4o-mini"}]}'

# Add a route with load balancing
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8787/admin/routes \
  -d '{"model":"balanced","strategy":"load_balance","endpoints":[{"provider":"openai","model_id":"gpt-4o"},{"provider":"anthropic","model_id":"claude-sonnet-4-20250514"}]}'

# Remove a route
curl -s -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8787/admin/routes/fast
```

## Key Generation & Accounts

```bash
# Generate a scoped API token (defaults: scope=api, exp=1h)
bitrouter --home-dir ~/.openclaw/plugins/bitrouter keygen

# Generate with constraints
bitrouter --home-dir ~/.openclaw/plugins/bitrouter keygen \
  --scope api --exp 30m --models "openai/*,anthropic/claude-3-haiku*" --budget 50000

# List saved tokens
bitrouter --home-dir ~/.openclaw/plugins/bitrouter keys --list

# Inspect a token's claims
bitrouter --home-dir ~/.openclaw/plugins/bitrouter keys --show <name>

# Remove a token
bitrouter --home-dir ~/.openclaw/plugins/bitrouter keys --rm <name>

# Switch active account
bitrouter --home-dir ~/.openclaw/plugins/bitrouter account --set <id>
```

## Wallet & Onboarding

```bash
openclaw bitrouter wallet   # show wallet address, Swig ID, agent wallets
openclaw bitrouter setup    # re-run onboarding wizard (interactive)
```

## Sub-Agent Delegation

When spawning sub-agents, mint scoped tokens to enforce cost and model constraints:

1. Decide: what model tier does this task need? How much can it spend?
2. Mint a constrained JWT with `bitrouter keygen`
3. Pass `BITROUTER_TOKEN=<jwt>` in the sub-agent's environment
4. BitRouter enforces limits server-side — the sub-agent cannot bypass them

### Token Design by Task

| Task | Models | Budget | Rounds |
|------|--------|--------|--------|
| Quick classification / yes-no | `anthropic/claude-3-haiku` | $0.005 (5000 µUSD) | `rounds:3` |
| Summarization / extraction | `anthropic/claude-3-haiku,openai/gpt-4o-mini` | $0.02 (20000 µUSD) | `rounds:5` |
| Research / drafting | `anthropic/claude-sonnet*,openai/gpt-4o` | $0.20 (200000 µUSD) | — |
| Complex reasoning / synthesis | `anthropic/claude-opus*,openai/o3*` | $1.00 (1000000 µUSD) | — |

### Example

```bash
# Mint a cheap token for a summarization sub-agent
TOKEN=$(bitrouter --home-dir ~/.openclaw/plugins/bitrouter keygen \
  --exp 10m \
  --models "anthropic/claude-3-haiku,openai/gpt-4o-mini" \
  --budget 20000 \
  --budget-scope session \
  --budget-range "rounds:5" 2>/dev/null)

# Pass it to the sub-agent via environment
BITROUTER_TOKEN=$TOKEN
```

## Notes

- Budget is enforced server-side; sub-agents cannot bypass it
- If a sub-agent hits its budget, BitRouter returns 402 on the next call
- You do not need to revoke tokens — expiry handles cleanup
- Tokens are scoped to the current BitRouter instance; they don't work elsewhere
- Admin tokens should be short-lived (5m) — mint fresh ones as needed
