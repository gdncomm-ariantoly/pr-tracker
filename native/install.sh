#!/bin/sh
# Installs PR Tracker's Claude Code helper for Chrome (macOS).
#
#   sh native/install.sh <extension-id> [--hook]   install (the id is shown in PR Tracker → Settings)
#   sh native/install.sh --uninstall               remove the helper and the hook
#
# What it writes:
#   native/host-run.sh                                  launcher with this machine's node path
#   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.gdncomm.pr_tracker.json
#   --hook: a PreToolUse hook in ~/.claude/settings.json (backed up first) that adds
#           <!-- claude-code-session: <id> --> to reviews/comments you post with Claude Code
#
# Overrides for testing: PR_TRACKER_HOSTS_DIR, CLAUDE_SETTINGS.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
name=com.gdncomm.pr_tracker
hosts_dir=${PR_TRACKER_HOSTS_DIR:-"$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"}
settings=${CLAUDE_SETTINGS:-"$HOME/.claude/settings.json"}
node_bin=$(command -v node || true)
claude_bin=$(command -v claude || true)
hook_cmd="\"$node_bin\" \"$here/claude-code-hook.mjs\""

# Add or remove our hook in Claude Code's settings.json, leaving everything else as is.
edit_hook() { # $1 = add | remove
  [ -n "$node_bin" ] || { echo "node not found on PATH" >&2; exit 1; }
  mkdir -p "$(dirname "$settings")"
  [ -f "$settings" ] && cp "$settings" "$settings.pr-tracker.bak"
  "$node_bin" - "$settings" "$1" "$hook_cmd" <<'JS'
const fs = require('node:fs')
const [file, mode, command] = process.argv.slice(2)
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8') || '{}') : {}
const ours = (h) => typeof h?.command === 'string' && h.command.includes('claude-code-hook.mjs')
settings.hooks ??= {}
const groups = (settings.hooks.PreToolUse ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length)
if (mode === 'add') groups.push({ matcher: 'Bash|mcp__.*github.*', hooks: [{ type: 'command', command }] })
if (groups.length) settings.hooks.PreToolUse = groups
else delete settings.hooks.PreToolUse
if (!Object.keys(settings.hooks).length) delete settings.hooks
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
JS
}

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$hosts_dir/$name.json" "$here/host-run.sh"
  [ -f "$settings" ] && edit_hook remove
  echo "Removed the helper and the Claude Code hook."
  exit 0
fi

id=${1:-}
case "$id" in
  [a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p]) ;;
  *) echo "usage: sh native/install.sh <extension-id> [--hook]   (32 letters a-p; see PR Tracker → Settings)" >&2; exit 2 ;;
esac
[ -n "$node_bin" ] || { echo "node not found on PATH; install Node.js first" >&2; exit 1; }

# Chrome starts the helper with a bare environment, so pin node's (and claude's) absolute path.
cat > "$here/host-run.sh" <<SH
#!/bin/sh
export PR_TRACKER_CLAUDE="$claude_bin"
exec "$node_bin" "$here/host.mjs" "\$@"
SH
chmod +x "$here/host-run.sh"

mkdir -p "$hosts_dir"
cat > "$hosts_dir/$name.json" <<JSON
{
  "name": "$name",
  "description": "PR Tracker: finds local Claude Code sessions for a PR and runs Claude Code headless to summarize one",
  "path": "$here/host-run.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$id/"]
}
JSON
echo "Helper installed for extension $id."
[ -n "$claude_bin" ] && echo "Summaries will use Claude Code at $claude_bin." || echo "claude not found on PATH: Summarize via Claude Code will not work until you re-run this where claude works."

if [ "${2:-}" = "--hook" ]; then
  edit_hook add
  echo "Claude Code hook added to $settings (backup: $settings.pr-tracker.bak). New sessions pick it up."
fi
echo "In PR Tracker: Settings → Claude Code helper → Connect, then Refresh."
