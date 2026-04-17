---
description: Open a persistent SSH session exposed as tools (ssh_open, ssh_run, ssh_read, ssh_signal, ssh_close, ssh_list). Stays alive across turns until closed.
argument-hint: "[ssh args, e.g. studio  or  -p 2222 user@host]"
---

Open a persistent SSH session using the `magic-ssh` MCP tools and keep it around for the rest of the conversation.

Task:

1. Parse the arguments the user passed to this command: `$ARGUMENTS`. Treat them exactly the way a user would pass them to the real `ssh` binary — the final positional argument is the destination (`[user@]host`), anything before it is extra ssh options (e.g. `-p 2222`, `-J jump`, `-i ~/.ssh/key`). If there are no arguments, ask the user which host to connect to and stop.
2. Pick a short session name:
   - If the destination looks like `user@host`, use the `host` part.
   - Otherwise use the destination token as-is.
   - If a session with that name already exists (check `ssh_list`), append `-2`, `-3`, … until unique.
3. Call the `ssh_open` tool with `{ name, host, sshArgs }` where `host` is the destination and `sshArgs` is everything before it. Report the resulting session info briefly (name + host).
4. From here on, whenever the user wants something done **on that remote machine**, use `ssh_run` / `ssh_read` / `ssh_signal` against that session name. Use your normal local Bash tool for everything local (editing files, searching the web, running code locally, etc.). Do not tear the session down between commands — reuse it.
5. When the user says they're done with the remote, call `ssh_close` for that name.

Notes for the agent:
- `ssh_run` keeps shell state between calls: `cd`, exported variables, and background jobs all persist within the session.
- For long-running output, pass a short `timeoutMs` and then poll with `ssh_read`.
- To stop a stuck foreground command without killing the whole session, call `ssh_signal` with `"INT"` (Ctrl-C). The session stays usable afterwards.
- Remote file reads/writes go through `ssh_run` + `cat`/tee or via local `scp`/`rsync` in your Bash tool — there are no dedicated remote file tools.
