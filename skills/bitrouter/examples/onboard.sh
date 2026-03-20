#!/usr/bin/env bash
# BitRouter -- Non-Interactive Local Proxy Onboarding
#
# Sets up bitrouter as a local LLM proxy. Detects available API keys,
# writes config, starts the daemon, and verifies it's working.
#
# Prerequisites:
#   - cargo (Rust toolchain)
#   - At least one provider API key in environment:
#     OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_API_KEY
#
# Usage:
#   chmod +x onboard.sh
#   ./onboard.sh

set -euo pipefail

BITROUTER_HOME="${BITROUTER_HOME:-$HOME/.bitrouter}"
CONFIG_FILE="$BITROUTER_HOME/bitrouter.yaml"
ENV_FILE="$BITROUTER_HOME/.env"

# ── Step 0: Pre-flight ────────────────────────────────────────────────────

# Check if already running
if command -v bitrouter &>/dev/null && bitrouter status &>/dev/null; then
    echo "==> BitRouter is already running"
    bitrouter status
    echo ""
    echo "Proxy available at http://127.0.0.1:8787"
    echo "Try: curl http://127.0.0.1:8787/health"
    exit 0
fi

# ── Step 1: Install ──────────────────────────────────────────────────────

if ! command -v bitrouter &>/dev/null; then
    echo "==> Installing bitrouter..."
    if ! command -v cargo &>/dev/null; then
        echo "Error: cargo not found. Install Rust from https://rustup.rs"
        exit 1
    fi
    cargo install bitrouter
fi

echo "==> bitrouter $(bitrouter --version 2>/dev/null || echo 'installed')"

# ── Step 2: Detect providers and write config ─────────────────────────────

mkdir -p "$BITROUTER_HOME"

PROVIDERS=""
if [ -n "${OPENAI_API_KEY:-}" ]; then
    PROVIDERS="${PROVIDERS}  openai:\n    api_key: \"\${OPENAI_API_KEY}\"\n"
    echo "    Detected: OpenAI"
fi
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    PROVIDERS="${PROVIDERS}  anthropic:\n    api_key: \"\${ANTHROPIC_API_KEY}\"\n"
    echo "    Detected: Anthropic"
fi
if [ -n "${GOOGLE_API_KEY:-}" ]; then
    PROVIDERS="${PROVIDERS}  google:\n    api_key: \"\${GOOGLE_API_KEY}\"\n"
    echo "    Detected: Google"
fi

if [ -z "$PROVIDERS" ]; then
    echo "Error: No provider API keys found in environment."
    echo "Set at least one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY"
    exit 1
fi

if [ -f "$CONFIG_FILE" ]; then
    echo "==> Config already exists at $CONFIG_FILE, keeping it"
else
    echo "==> Writing config to $CONFIG_FILE"
    printf "server:\n  listen: \"127.0.0.1:8787\"\n\nproviders:\n${PROVIDERS}" > "$CONFIG_FILE"
fi

# ── Step 3: Start ─────────────────────────────────────────────────────────

echo "==> Starting bitrouter daemon..."
bitrouter start

# Brief pause for startup
sleep 1

# ── Step 4: Verify ────────────────────────────────────────────────────────

echo "==> Verifying..."

HEALTH=$(curl -sf http://127.0.0.1:8787/health 2>/dev/null || echo "")
if [ -n "$HEALTH" ]; then
    echo "    Health: $HEALTH"
    echo ""
    echo "BitRouter is running at http://127.0.0.1:8787"
    echo ""
    echo "Example requests:"
    [ -n "${OPENAI_API_KEY:-}" ] && echo "  curl http://127.0.0.1:8787/v1/chat/completions -H 'Content-Type: application/json' -d '{\"model\":\"openai:gpt-4o\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}'"
    [ -n "${ANTHROPIC_API_KEY:-}" ] && echo "  curl http://127.0.0.1:8787/v1/messages -H 'Content-Type: application/json' -d '{\"model\":\"anthropic:claude-sonnet-4-20250514\",\"max_tokens\":256,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}'"
    echo ""
    echo "Manage:"
    echo "  bitrouter status     # check status"
    echo "  bitrouter stop       # shutdown"
    echo "  bitrouter restart    # re-read config and restart"
else
    echo "    Warning: health check failed. Check logs:"
    echo "    cat $BITROUTER_HOME/logs/*.log"
    exit 1
fi
