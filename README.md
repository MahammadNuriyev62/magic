# magic-ssh

Persistent SSH sessions as tools for AI coding agents.

`magic-ssh` is a tiny MCP server that gives your agent six tools:

| Tool | What it does |
|------|--------------|
| `ssh_open` | Open a named SSH session. The session is one long-lived `bash` on the remote host. |
| `ssh_run`  | Run a command in a session. `cd`, env vars, and background jobs persist across calls. |
| `ssh_read` | Stream more output from a still-running command (or drain buffered output). |
| `ssh_signal` | Send `INT` / `QUIT` / `EOF` to the foreground command without tearing the session down. |
| `ssh_close` | Close a session. |
| `ssh_list` | List open sessions. |

## Why

If you're working with an agent (Claude Code, GitHub Copilot CLI, any MCP-capable client) and your remote box is where the actual work lives — a GPU box, a cluster login node, an air-gapped experiment host — you usually end up with one of two bad options:

- **Shim everything through SSH** (like [`magic.sh`](magic-sh/README.md) in this repo). Great for "make the agent's entire Bash live on the remote", bad when you also need local internet / web search / doc lookups in the same session.
- **Have the agent run `ssh host 'cmd'` itself** every turn. Loses working directory, loses env, loses backgrounded jobs, and pays the SSH handshake on every call.

`magic-ssh` splits the world cleanly: the agent's **local Bash** stays local (research, web, editing files, `scp`), and **each remote host is a separate persistent session** driven by explicit tools. Open as many as you want, in one conversation.

## Install

### Claude Code

This repo doubles as a Claude Code plugin.

```bash
# clone, build, and add as a local plugin
git clone https://github.com/MahammadNuriyev62/magic.git magic-ssh
cd magic-ssh
npm install
npm run build
claude plugin install .
```

Then in any Claude Code session:

```
/ssh studio
/ssh -p 2222 user@gpu-box
```

The slash command asks the agent to open a session via `ssh_open` and use `ssh_run` / `ssh_read` / `ssh_signal` / `ssh_close` for everything on that host.

Or, if you've published `magic-ssh` to npm, users can skip the clone step — the shipped [`plugin.json`](.claude-plugin/plugin.json) already declares an MCP server launched via `npx -y magic-ssh@latest`.

### GitHub Copilot CLI

Add the server to your `~/.copilot/mcp-config.json` (see [`copilot/mcp-config.json.example`](copilot/mcp-config.json.example)):

```json
{
  "mcpServers": {
    "magic-ssh": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "magic-ssh@latest"],
      "tools": ["*"]
    }
  }
}
```

Or point it at a local build while developing:

```bash
copilot mcp add magic-ssh -- node /absolute/path/to/magic-ssh/dist/server.js
```

For the best experience copy [`copilot/magic-ssh.agent.md`](copilot/magic-ssh.agent.md) into `~/.copilot/agents/` and start Copilot with `copilot --agent magic-ssh`. The agent keeps local Bash for local work and steers remote work through the `magic-ssh-ssh_*` tools.

## Tool reference

### `ssh_open({ name, host, sshArgs? })`

Open a session. `name` is how you'll address it later. `host` is a destination (`user@host`, a `Host` alias from `~/.ssh/config`, etc.). `sshArgs` are extra flags passed before the destination (`-p`, `-i`, `-J`, `-o …`). The server spawns `ssh -tt … host "exec bash --noprofile --norc --noediting"` and waits for the shell to be ready.

### `ssh_run({ name, cmd, timeoutMs?, maxBytes? })`

Write `cmd` to the session's bash. Returns either:

- `{ status: "complete", output, exitCode, truncated }` — the command finished within `timeoutMs` (default 30 s).
- `{ status: "running", output, truncated }` — the command is still going; output so far is in `output`. Poll with `ssh_read`.

`maxBytes` caps how many bytes come back per call (default 256 KB); older bytes are kept in the session buffer and can be drained with more `ssh_read` calls.

### `ssh_read({ name, waitMs?, maxBytes? })`

Drain any new output produced by the currently-running command (or the one that just finished). If `waitMs > 0` and a command is still running, block up to `waitMs` waiting for completion. Returns the same shape as `ssh_run`.

### `ssh_signal({ name, signal })`

`signal` is `"INT"`, `"QUIT"`, or `"EOF"`. Sends the corresponding control byte (`\x03`, `\x1c`, `\x04`) to the remote pty. The foreground command gets the signal; the bash session stays alive, so the agent can immediately run more commands.

### `ssh_close({ name })` / `ssh_list()`

Clean up. Sessions are in-memory only — if the MCP server process exits (e.g. Claude Code restarts), sessions are gone.

## How persistence works (and its limits)

Each session is one `bash --noprofile --norc --noediting` on the remote side, driven by one long-lived `ssh -tt`. A small helper function `__magic_run` is injected once at startup; every `ssh_run` call hands it the command, runs it inside `eval`, and prints a sentinel (`__MAGIC_END__<uuid>:<exit>`) so the server knows where one command's output ends. The helper installs an `INT` trap so even an interrupted command prints the sentinel, meaning `ssh_signal INT` cleanly returns the session to idle instead of leaving it stuck.

State that persists: `cd`, `export`, bash functions, shell options, background jobs. State that doesn't: the remote ssh process dies when the MCP server exits; there's no reconnect.

## Repository layout

```
.
├── src/                      magic-ssh MCP server (TypeScript)
│   ├── server.ts             stdio MCP transport + tool handlers
│   └── session.ts            Session / SessionManager
├── .claude-plugin/           Claude Code plugin (plugin.json + /ssh command)
├── copilot/                  Copilot CLI agent + mcp-config example
├── magic-sh/                 Legacy transparent-shim script (magic.sh)
└── README.md
```

If you were using the old `magic.sh` script, it's still here at [`magic-sh/`](magic-sh/README.md). The plugin supersedes it for most workflows, but the shim is handy when you want your agent's entire shell to transparently live on a remote box.

## Development

```bash
npm install
npm run build          # tsc -> dist/
node dist/smoke.js     # end-to-end test (requires ssh access to `studio`)
```

The smoke test opens a session to a host aliased `studio` in your ssh config and exercises `cd` persistence, env persistence, output tailing, SIGINT, and close. Change the host in `src/smoke.ts` if you don't have a `studio` alias.

## License

MIT.
