#!/usr/bin/env bash
# magic: run a coding agent locally, but against a remote machine over SSH.
#
# Usage:
#     magic.sh ssh="ssh user@host" agent="claude ..."
#     magic.sh ssh="ssh -p 2222 -i key.pem user@host" agent="codex ..."
#
# The agent runs on the local box. Its shell is redirected to a remote bash over
# SSH, so every command it runs executes on the remote. Native file tools are
# disabled for Claude so that reads/writes also flow through the remote shell.

set -eu

SYSTEM_PROMPT='You are running locally but your Bash tool executes on a REMOTE machine over SSH. The native Read, Write, Edit, Glob, and Grep tools are disabled here because the filesystem you care about is on the remote host — use shell commands instead: cat/head/tail to read, tee/printf/sed to write, rg or grep to search, find for globbing. All paths refer to the remote filesystem. Each Bash call may run in a fresh shell, so put multi-step sequences into a single command with && rather than relying on cd or env vars persisting across calls.'

ssh_spec=""
agent_spec=""
for arg in "$@"; do
  case "$arg" in
    ssh=*)   ssh_spec=${arg#ssh=} ;;
    agent=*) agent_spec=${arg#agent=} ;;
    *)       echo "magic: expected key=value, got '$arg'" >&2; exit 1 ;;
  esac
done

if [ -z "$ssh_spec" ] || [ -z "$agent_spec" ]; then
  echo 'usage: magic ssh="ssh user@host" agent="claude ..."' >&2
  exit 1
fi

ssh_parts=()
eval "ssh_parts=($ssh_spec)"
[ ${#ssh_parts[@]} -gt 0 ] || { echo "magic: ssh argument is empty" >&2; exit 1; }

agent_argv=()
eval "agent_argv=($agent_spec)"
[ ${#agent_argv[@]} -gt 0 ] || { echo "magic: agent argument is empty" >&2; exit 1; }

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/magic-XXXXXXXX")
bindir="$tmpdir/bin"
mkdir -p "$bindir"
control="$tmpdir/ctl"
logfile="$tmpdir/shim.log"

# Keepalive options keep idle ssh sessions warm between agent tool calls.
# Without them, a server with a short idle timeout (or a flaky network) can
# drop the connection while the agent is reasoning, leading to "Invalid
# shell ID" errors on the next read from a pty the agent thinks is alive.
ssh_keepalive=(-o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes)

# ControlPersist=yes: keep the master alive indefinitely for the duration of
# the magic.sh session, regardless of how long the agent sits idle between
# user turns. A short ControlPersist (e.g. 60s) was causing the master to
# die during a user pause; the next shim invocation would find a stale
# socket and the agent would report "Invalid shell ID" on the next command.
# We clean the master up explicitly on magic.sh exit via the trap below.
"${ssh_parts[0]}" -M -S "$control" -f -N -o ControlPersist=yes "${ssh_keepalive[@]}" "${ssh_parts[@]:1}"

# Tear down the control master (and tmpdir) when magic.sh exits so we don't
# leave orphaned ssh processes or sockets behind.
cleanup() {
  "${ssh_parts[0]}" -S "$control" -O exit "${ssh_parts[@]:1}" >/dev/null 2>&1 || true
  rm -rf "$tmpdir"
}
trap cleanup EXIT

# -T: don't allocate a remote pty. The agent's bash tool already runs this
# shim inside its own pty; stacking a second remote pty on top injects
# CR/LF translation and raw-mode toggles that confuse agents' output
# readers (Copilot in particular). Do NOT add -n — Copilot runs bash as a
# persistent session (`bash --norc --noprofile`) and pipes commands in via
# stdin; -n would pin ssh's stdin to /dev/null and kill that session
# before the first command arrives ("Failed to start bash process").
ssh_base=$(printf '%q ' "${ssh_parts[0]}" -S "$control" -T -o LogLevel=ERROR "${ssh_keepalive[@]}" "${ssh_parts[@]:1}")
logfile_q=$(printf '%q' "$logfile")

shim="$bindir/bash"
# Unquoted heredoc: $ssh_base/$logfile_q expand here, but every runtime var the
# shim will use ($@, $#, $PPID, $$, $PWD, $MAGIC_DEBUG, ${q[*]}, …) is escaped
# with \$ so it lands in the output literally.
cat > "$shim" <<SHIM
#!/bin/bash
# magic: forward this shell invocation to a remote bash over SSH.
# Shebang is /bin/bash (not /usr/bin/env bash) so that when Copilot's PATH
# lookup finds this shim, the interpreter resolution doesn't loop back to
# the shim via /usr/bin/env's own PATH lookup.
if [ -n "\$MAGIC_DEBUG" ]; then
  { echo "[\$(date +%T.%N)] pid=\$\$ ppid=\$PPID pwd=\$PWD argc=\$# args=\$(printf '%q ' "\$@")"; } >> $logfile_q 2>&1
fi
# Recursion guard: if this shim invokes ssh and the user's ssh config uses a
# ProxyCommand (e.g. \`aws ssm start-session ...\`), ssh will spawn that
# command via \`sh -c "..."\`. Since \$bindir is first on PATH and we also
# symlink sh -> this shim, the ProxyCommand would loop back into the shim
# and fork-bomb. On recursion we defer to the real /bin/bash or /bin/sh so
# the ProxyCommand runs normally and ssh can establish its connection.
if [ -n "\$MAGIC_SHIM_ACTIVE" ]; then
  case "\$(basename -- "\$0")" in
    sh) exec /bin/sh "\$@" ;;
    *)  exec /bin/bash "\$@" ;;
  esac
fi
export MAGIC_SHIM_ACTIVE=1
if [ \$# -eq 0 ]; then
  # No-args invocation is how unrelated subprocesses probe for a login shell.
  # Falling back to local /bin/bash is safe and avoids hanging on an
  # interactive remote prompt. The agent's real shell calls always arrive
  # with args (e.g. \`-c <cmd>\` or \`--norc --noprofile\`).
  exec /bin/bash
fi
q=()
for a in "\$@"; do q+=("\$(printf %q "\$a")"); done
exec $ssh_base "bash \${q[*]}"
SHIM
chmod +x "$shim"
ln -s "$shim" "$bindir/sh"

case "$(basename "${agent_argv[0]}")" in
  claude)
    # Claude Code only honors CLAUDE_CODE_SHELL if the path contains "bash" or
    # "zsh"; our shim is named "bash" so it passes. Disable the native file
    # tools so all I/O flows through the shell, and thus through the shim.
    agent_argv+=(--disallowedTools Read Write Edit Glob Grep --append-system-prompt "$SYSTEM_PROMPT")
    export CLAUDE_CODE_SHELL="$shim"
    ;;
  copilot)
    # Copilot spawns bash via node-pty and looks it up through PATH, so
    # prepending the shim dir is how we intercept the shell.
    #
    # File tools and env-context also need handling. Copilot's built-in file
    # tools vary by model (view/create/edit/grep/glob for Claude, view/
    # apply_patch/glob for gpt-5.x), so --excluded-tools can't cover them all
    # without "Unknown tool" warnings. Copilot also answers env questions
    # (OS, hostname, pwd) from process context instead of running a shell.
    #
    # Fix both with a custom agent: tools whitelist limits Copilot to the
    # shell family, and includeEnvironmentContext: false + prompt body force
    # it to verify env facts via bash. The agent lives at
    # ~/.copilot/agents/magic-remote.agent.md (or $COPILOT_HOME/agents/).
    copilot_home="${COPILOT_HOME:-$HOME/.copilot}"
    copilot_agents_dir="$copilot_home/agents"
    mkdir -p "$copilot_agents_dir"
    cat > "$copilot_agents_dir/magic-remote.agent.md" <<'AGENT'
---
name: magic-remote
displayName: Magic Remote
description: Agent whose shell runs on a remote machine over SSH.
tools:
  - bash
  - read_bash
  - write_bash
  - stop_bash
  - list_shells
  - web_search
  - web_fetch
promptParts:
  includeAISafety: true
  includeToolInstructions: true
  includeCustomAgentInstructions: true
  includeEnvironmentContext: false
---

Your Bash tool executes on a REMOTE machine over SSH. The local host where this process runs is NOT what the user cares about.

Rules:
- NEVER answer questions about the OS, hostname, filesystem, users, or environment from your own context. Always verify with a shell command first.
- All file paths refer to the remote filesystem. Use cat/head/tail/sed/find/grep via bash. No native file tools are available.
- Chain multi-step work with && in a single bash call since each call is a fresh shell.
AGENT
    agent_argv+=(--agent magic-remote)
    export PATH="$bindir:$PATH"
    # Copilot's default 20 KB threshold for "large" command output is too
    # tight: anything above it gets saved to a local temp file that the
    # model is told to read with the view tool, but view is not in our
    # whitelist, so the model can't read back the overflow and ends up
    # confused. Bumping to 256 KB keeps typical outputs inline.
    export COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES=262144
    ;;
esac

echo "magic: tmpdir=$tmpdir" >&2

# Change to /tmp before launching the agent so its UI (and any local-cwd
# introspection like workspace detection, git root, etc.) doesn't display
# the user's project dir. The agent's shell commands all route to the
# remote via the shim anyway, so the local cwd is cosmetic.
cd /tmp

exec "${agent_argv[@]}"
