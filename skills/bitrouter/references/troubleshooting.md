# Troubleshooting

## Port Already in Use

If `bitrouter start` or `bitrouter serve` fails because port 8787 is taken:

```bash
# Find what's using the port
lsof -i :8787

# If it's a stale bitrouter process, stop it
bitrouter stop

# Or kill it manually
kill <PID>

# Alternative: use a different port in bitrouter.yaml
# server:
#   listen: "127.0.0.1:9090"
```

## Stale PID File

If `bitrouter status` shows a PID but the process isn't actually running,
bitrouter auto-cleans the stale PID file. Run `bitrouter status` again and
it should show "not running." Then `bitrouter start` as normal.

If the PID file persists:

```bash
rm ~/.bitrouter/run/bitrouter.pid
bitrouter start
```

## API Key Not Working

Verify the key works by calling the provider directly:

```bash
# OpenAI
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY" | head -c 200

# Anthropic
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3.5-haiku-20241022","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'
```

If the direct call works but bitrouter fails, check:
- The env var is exported (not just set): `export OPENAI_API_KEY=sk-...`
- The `.env` file uses the right format: `KEY=value` (no `export`, no spaces around `=`)
- The `${VAR}` in YAML matches the actual env var name

## Config Parse Errors

Common YAML mistakes:

```yaml
# Wrong -- missing quotes around value with special characters
server:
  listen: 127.0.0.1:8787

# Right
server:
  listen: "127.0.0.1:8787"
```

Validate your config by running `bitrouter status` -- it loads and parses the
config file and shows the resolved providers and models.

## Provider Not Available

If `bitrouter status` shows a provider missing:

1. Check the env var is set: `echo $OPENAI_API_KEY`
2. Check the env var is non-empty (empty string = not detected)
3. If using `.env`, ensure the file is at `~/.bitrouter/.env` (or wherever
   `--env-file` points)
4. If using `${VAR}` in YAML, unresolved variables become empty strings
   silently -- double-check spelling

## Health Check Fails

```bash
curl -s http://127.0.0.1:8787/health
# No response → server isn't running
# Connection refused → wrong port or server crashed
```

Check if the process is alive:

```bash
bitrouter status
# or
ps aux | grep bitrouter
```

Check logs:

```bash
cat ~/.bitrouter/logs/*.log
```

## Daemon Won't Stop

If `bitrouter stop` hangs or fails:

```bash
# Find the process
ps aux | grep bitrouter

# Force kill
kill -9 <PID>

# Clean up PID file
rm ~/.bitrouter/run/bitrouter.pid
```
