#!/usr/bin/env bash
# BitRouter -- Agent Registration Workflow
#
# This script walks through the full lifecycle of registering an agent on
# BitRouter: keypair generation, agent registration, service configuration,
# and starting the proxy.
#
# Prerequisites:
#   - bitrouter CLI binary on PATH (cargo build --release --package bitrouter-cli)
#
# Usage:
#   chmod +x register_agent.sh
#   ./register_agent.sh

set -euo pipefail

ROUTER_URL="${BITROUTER_URL:-https://beta.bitrouter.ai}"
KEYPAIR="${BITROUTER_KEYPAIR:-$HOME/.config/bitrouter/keypair.json}"

# ── Step 1: Generate a keypair ───────────────────────────────────────────────

echo "==> Generating keypair at $KEYPAIR"
if [ -f "$KEYPAIR" ]; then
    echo "    Keypair already exists, skipping (use bitrouter keygen -f to overwrite)"
else
    bitrouter keygen -o "$KEYPAIR"
fi

echo "==> Your wallet address:"
bitrouter address

# ── Step 2: Register the agent ───────────────────────────────────────────────

AGENT_NAME="${1:-My Agent}"
AGENT_DESC="${2:-An AI agent registered on BitRouter}"

echo "==> Registering agent: $AGENT_NAME"
bitrouter router register-agent \
    --name "$AGENT_NAME" \
    --description "$AGENT_DESC" \
    --keypair "$KEYPAIR" \
    --router-url "$ROUTER_URL"

# ── Step 3: Verify registration ─────────────────────────────────────────────

echo "==> Listing agents to verify registration:"
bitrouter router list-agents --json --router-url "$ROUTER_URL" | jq '.[] | select(.name == "'"$AGENT_NAME"'")'

# ── Step 4: Write a service configuration ────────────────────────────────────

CONFIG_FILE="bitrouter-cli.toml"

echo "==> Writing service configuration to $CONFIG_FILE"
cat > "$CONFIG_FILE" <<TOML
[router]
url = "$ROUTER_URL"

[auth]
keypair_file = "$KEYPAIR"
chain_id = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"

[mcp]
enabled = true
endpoint = "http://localhost:3000/mcp"
routing_key = "my-mcp-service"
version = "2025-06-18"

[mcp.capabilities]
tools = true
resources = true
prompts = false
TOML

echo "==> Configuration written. Review it:"
cat "$CONFIG_FILE"

# ── Step 5: Start the proxy ─────────────────────────────────────────────────

echo ""
echo "==> To start serving, run:"
echo "    bitrouter serve --config $CONFIG_FILE"
echo ""
echo "==> To check your balance:"
echo "    bitrouter router get-balance --keypair $KEYPAIR"
echo ""
echo "Done."
