#!/usr/bin/env bash
# BitRouter -- Using Services as a Client
#
# Examples of consuming chat, MCP, and A2A services through the BitRouter router.
#
# Prerequisites:
#   - bitrouter CLI binary on PATH
#   - A keypair at ~/.config/bitrouter/keypair.json (run: bitrouter keygen)
#   - Sufficient session balance or X402 payment capability
#
# Usage:
#   chmod +x use_services.sh
#   ./use_services.sh

set -euo pipefail

KEYPAIR="${BITROUTER_KEYPAIR:-$HOME/.config/bitrouter/keypair.json}"
ROUTER_URL="${BITROUTER_URL:-https://beta.bitrouter.ai}"

# ── Service Discovery ────────────────────────────────────────────────────────

echo "==> Listing available models:"
bitrouter router list-models --json --router-url "$ROUTER_URL" | jq '.[].id'

echo ""
echo "==> Listing available tools:"
bitrouter router list-tools --json --router-url "$ROUTER_URL" | jq '.[].name'

echo ""
echo "==> Listing registered agents:"
bitrouter router list-agents --json --router-url "$ROUTER_URL" | jq '.[].agent_id'

# ── Chat Completions ─────────────────────────────────────────────────────────

echo ""
echo "==> Sending a chat completion:"
bitrouter chat \
    --model gpt-4 \
    --message "Explain quicksort in one paragraph" \
    --keypair "$KEYPAIR" \
    --router-url "$ROUTER_URL"

# ── MCP ──────────────────────────────────────────────────────────────────────

# Replace <agent_id> with an actual agent ID from list-agents above.
AGENT_ID="${1:-<agent_id>}"

if [ "$AGENT_ID" != "<agent_id>" ]; then
    echo ""
    echo "==> Initializing MCP session with agent $AGENT_ID:"
    bitrouter mcp initialize "$AGENT_ID" --keypair "$KEYPAIR" --router-url "$ROUTER_URL"

    echo ""
    echo "==> Listing MCP tools for agent $AGENT_ID:"
    bitrouter mcp list-tools "$AGENT_ID" --keypair "$KEYPAIR" --router-url "$ROUTER_URL"
else
    echo ""
    echo "==> Skipping MCP/A2A examples (pass an agent_id as first argument)"
    echo "    Usage: ./use_services.sh <agent_id>"
fi

# ── A2A ──────────────────────────────────────────────────────────────────────

if [ "$AGENT_ID" != "<agent_id>" ]; then
    echo ""
    echo "==> Getting A2A agent card for $AGENT_ID:"
    bitrouter a2a get-card "$AGENT_ID" --json --router-url "$ROUTER_URL"

    echo ""
    echo "==> Sending A2A message to $AGENT_ID:"
    bitrouter a2a send "$AGENT_ID" "Hello from the BitRouter CLI" \
        --keypair "$KEYPAIR" \
        --router-url "$ROUTER_URL"
fi

echo ""
echo "Done."
