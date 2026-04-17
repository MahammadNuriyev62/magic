import { spawn, ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * One ssh session = one long-lived interactive bash on the remote.
 *
 * Design notes:
 * - ssh is started with -tt so the remote gets a pty. We need the pty for
 *   Ctrl-C forwarding; otherwise interrupting a long-running command would
 *   tear the session down.
 * - The initial ssh command sets PS1/PS2 to empty strings (exported so the
 *   interactive bash we exec into inherits them) and disables terminal
 *   echo/line-editing, then execs `bash --noprofile --norc` as an interactive
 *   shell that reads commands from our stdin.
 * - After the shell comes up we inject a helper function `__magic_run` via
 *   stdin. Every subsequent user command is dispatched through it:
 *     __magic_run <uuid> <base64-of-cmd>
 *   The helper base64-decodes the command, evals it in the current shell
 *   (so cd/env/shell-funcs persist), and prints a completion sentinel
 *   (\x01MAGIC-END:<uuid>:<exitcode>\x01). Because the helper installs a
 *   trap on INT, interrupting the foreground command still flows past the
 *   eval and still prints the sentinel, so the session never gets "stuck".
 */

const SHELL_SETUP = [
  "stty -echo -icanon -icrnl 2>/dev/null",
  "export PS1=''",
  "export PS2=''",
  "export PS3=''",
  "export PS4=''",
  "export TERM=dumb",
  "export HISTFILE=/dev/null",
].join("; ");

// Sentinel markers use only printable ASCII so interactive bash's readline
// never interprets them as control bytes (e.g. \x01 == ^A = move-to-start-of-
// line, which was silently mangling inputs). Readable too, which is helpful
// when debugging.
const READY_PREFIX = "__MAGIC_READY__";
const END_PREFIX = "__MAGIC_END__";

// Function definition sent over stdin once the remote bash is up.
// Written as a single line so interactive bash never prints PS2.
const MAGIC_RUN_FN =
  "__magic_run(){ local u=\"$1\"; local c; c=$(printf %s \"$2\" | base64 -d 2>/dev/null || printf %s \"$2\" | base64 -D); local __intr=0; trap '__intr=1' INT; eval \"$c\"; local __rc=$?; trap - INT; if [ \"$__intr\" = 1 ]; then __rc=130; fi; printf '\\n__MAGIC_END__%s:%d\\n' \"$u\" \"$__rc\"; }";

const DEFAULT_MAX_RETURN_BYTES = 256 * 1024;

export type SessionStatus =
  | { kind: "idle" }
  | { kind: "running"; commandId: string; startedAt: number; sentinel: string }
  | { kind: "closed"; reason: string; code: number | null };

export interface RunResult {
  status: "complete" | "running" | "closed";
  output: string;
  exitCode?: number;
  truncated: boolean;
  reason?: string;
}

export interface SessionInfo {
  name: string;
  host: string;
  sshArgs: string[];
  state: "idle" | "running" | "closed";
  lastActivityAgoMs: number;
  pendingCommandMs?: number;
  reason?: string;
}

export class Session {
  readonly name: string;
  readonly host: string;
  readonly sshArgs: string[];
  readonly createdAt: number;

  private child: ChildProcess;
  private buffer = "";
  private cursor = 0;
  private status: SessionStatus = { kind: "idle" };
  private lastActivity: number;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private readyPromise: Promise<void>;
  private readonly readyMarker: string;
  private currentDispatchLine: string | null = null;

  constructor(opts: { name: string; host: string; sshArgs?: string[] }) {
    this.name = opts.name;
    this.host = opts.host;
    this.sshArgs = opts.sshArgs ?? [];
    this.createdAt = Date.now();
    this.lastActivity = this.createdAt;
    this.readyMarker = `${READY_PREFIX}${randomUUID()}`;

    const args = [
      "-tt",
      "-o", "LogLevel=ERROR",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      ...this.sshArgs,
      this.host,
      `${SHELL_SETUP}; exec bash --noprofile --norc --noediting`,
    ];

    this.child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.child.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.on("exit", (code, signal) => {
      const reason = signal ? `signal:${signal}` : `exit:${code}`;
      if (this.status.kind !== "closed") {
        this.status = { kind: "closed", reason, code: code ?? null };
      }
      if (this.readyReject) {
        this.readyReject(new Error(`ssh exited before ready (${reason})`));
        this.readyReject = null;
        this.readyResolve = null;
      }
    });
    this.child.on("error", (err) => {
      this.status = { kind: "closed", reason: `spawn-error:${err.message}`, code: null };
      if (this.readyReject) {
        this.readyReject(err);
        this.readyReject = null;
        this.readyResolve = null;
      }
    });

    // Interactive bash re-enables terminal echo/icanon when readline initializes,
    // so the pre-exec `stty -echo` doesn't survive `exec bash`. Re-disable from
    // inside bash before anything else — otherwise every command we send is
    // echoed back and pollutes output.
    this.child.stdin!.write(`stty -echo -icanon 2>/dev/null\n`);
    this.child.stdin!.write(`${MAGIC_RUN_FN}\n`);
    this.child.stdin!.write(`printf '%s\\n' ${shellQuote(this.readyMarker)}\n`);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    this.lastActivity = Date.now();
    if (this.readyResolve) {
      // The pty emits `\r\n`. Match either variant of marker+newline so we
      // pick printf's output rather than the echoed command line (which ends
      // the marker with a quote instead of a newline).
      const re = new RegExp(this.readyMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\r?\\n");
      const m = re.exec(this.buffer);
      if (m) {
        this.cursor = m.index + m[0].length;
        this.readyResolve();
        this.readyResolve = null;
        this.readyReject = null;
      }
    }
  }

  ready(timeoutMs = 15000): Promise<void> {
    return withTimeout(this.readyPromise, timeoutMs, `ssh session "${this.name}" did not become ready (buffer so far: ${JSON.stringify(this.buffer.slice(-400))})`);
  }

  isClosed(): boolean {
    return this.status.kind === "closed";
  }

  info(): SessionInfo {
    const base: SessionInfo = {
      name: this.name,
      host: this.host,
      sshArgs: this.sshArgs,
      state: this.status.kind === "closed" ? "closed" : this.status.kind,
      lastActivityAgoMs: Date.now() - this.lastActivity,
    };
    if (this.status.kind === "running") {
      base.pendingCommandMs = Date.now() - this.status.startedAt;
    }
    if (this.status.kind === "closed") {
      base.reason = this.status.reason;
    }
    return base;
  }

  async run(cmd: string, timeoutMs = 30000, maxBytes = DEFAULT_MAX_RETURN_BYTES): Promise<RunResult> {
    if (this.status.kind === "closed") return closedResult(this.status.reason);
    if (this.status.kind === "running") {
      throw new Error(
        `session "${this.name}" is busy running a previous command; call ssh_read or ssh_signal first`,
      );
    }

    const id = randomUUID();
    const sentinel = `${END_PREFIX}${id}:`;
    const b64 = Buffer.from(cmd, "utf8").toString("base64");
    const dispatch = `__magic_run ${id} ${b64}\n`;

    this.status = { kind: "running", commandId: id, startedAt: Date.now(), sentinel };
    this.currentDispatchLine = dispatch.replace(/\n$/, "");
    this.child.stdin!.write(dispatch);
    this.lastActivity = Date.now();

    return this.waitForCompletion(timeoutMs, maxBytes);
  }

  async read(waitMs = 0, maxBytes = DEFAULT_MAX_RETURN_BYTES): Promise<RunResult> {
    if (this.status.kind === "closed") return closedResult(this.status.reason);
    if (waitMs > 0 && this.status.kind === "running") {
      return this.waitForCompletion(waitMs, maxBytes);
    }
    return this.drainOnce(maxBytes);
  }

  signal(which: "INT" | "QUIT" | "EOF"): void {
    if (this.status.kind === "closed") return;
    const byte = which === "INT" ? "\x03" : which === "QUIT" ? "\x1c" : "\x04";
    this.child.stdin!.write(byte);
  }

  close(): void {
    if (this.status.kind !== "closed") {
      this.status = { kind: "closed", reason: "closed-by-user", code: null };
    }
    try { this.child.stdin?.end(); } catch { /* ignore */ }
    try { this.child.kill("SIGTERM"); } catch { /* ignore */ }
  }

  private waitForCompletion(timeoutMs: number, maxBytes: number): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      const start = Date.now();
      const check = () => {
        if (this.status.kind === "closed") {
          resolve(closedResult(this.status.reason));
          return;
        }
        if (this.status.kind === "idle") {
          resolve(this.drainOnce(maxBytes));
          return;
        }
        const done = this.tryExtractCompletion(maxBytes);
        if (done) { resolve(done); return; }
        if (Date.now() - start >= timeoutMs) {
          resolve(this.drainOnce(maxBytes, /* running */ true));
          return;
        }
        setTimeout(check, 25);
      };
      check();
    });
  }

  private tryExtractCompletion(maxBytes: number): RunResult | null {
    if (this.status.kind !== "running") return null;
    const { sentinel } = this.status;
    const sentinelIdx = this.buffer.indexOf(sentinel, this.cursor);
    if (sentinelIdx === -1) return null;

    const eol = this.buffer.indexOf("\n", sentinelIdx + sentinel.length);
    if (eol === -1) return null;

    const exitStr = this.buffer.slice(sentinelIdx + sentinel.length, eol).trim();
    const exitCode = parseInt(exitStr, 10);

    let outEnd = sentinelIdx;
    if (this.buffer[outEnd - 1] === "\n") outEnd -= 1;
    let rawOut = this.buffer.slice(this.cursor, outEnd);
    if (rawOut.startsWith("\n")) rawOut = rawOut.slice(1);
    // Interactive bash may echo our dispatch line back at us before running it
    // (terminal echo can be re-enabled by bash's interactive-mode setup).
    // Strip it if present so callers see only the command's actual output.
    if (this.currentDispatchLine) {
      const echoed = this.currentDispatchLine;
      if (rawOut.startsWith(echoed + "\n")) rawOut = rawOut.slice(echoed.length + 1);
      else if (rawOut.startsWith(echoed + "\r\n")) rawOut = rawOut.slice(echoed.length + 2);
    }
    this.currentDispatchLine = null;

    this.cursor = eol + 1;
    this.status = { kind: "idle" };

    const { text, truncated } = truncate(normalizeLineEndings(rawOut), maxBytes);
    return { status: "complete", output: text, exitCode, truncated };
  }

  private drainOnce(maxBytes: number, forceRunning = false): RunResult {
    if (!forceRunning) {
      const done = this.tryExtractCompletion(maxBytes);
      if (done) return done;
    }
    const slice = this.buffer.slice(this.cursor);
    const consumed = Math.min(slice.length, findByteBoundaryByUtf8(slice, maxBytes));
    const rawConsumed = slice.slice(0, consumed);
    this.cursor += consumed;
    const text = normalizeLineEndings(rawConsumed);
    const truncated = consumed < slice.length;
    const status: "running" | "complete" =
      this.status.kind === "running" || forceRunning ? "running" : "complete";
    const out: RunResult = { status, output: truncated ? text + "\n…[truncated]" : text, truncated };
    if (status === "complete") out.exitCode = 0;
    return out;
  }
}

// ------------------- helpers -------------------

function normalizeLineEndings(s: string): string {
  // ssh -tt gives us CRLF; agents want LF. Strip all \r.
  return s.replace(/\r/g, "");
}

function truncate(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return { text: s, truncated: false };
  const cut = findByteBoundaryByUtf8(s, maxBytes);
  return { text: s.slice(0, cut) + "\n…[truncated]", truncated: true };
}

function findByteBoundaryByUtf8(s: string, maxBytes: number): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!;
    const cpBytes = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + cpBytes > maxBytes) return i;
    bytes += cpBytes;
    if (cp >= 0x10000) i++;
  }
  return s.length;
}

function shellQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}

function closedResult(reason: string): RunResult {
  return { status: "closed", output: "", truncated: false, reason };
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

// ------------------- manager -------------------

export class SessionManager {
  private sessions = new Map<string, Session>();

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  has(name: string): boolean {
    return this.sessions.has(name);
  }

  get(name: string): Session {
    const s = this.sessions.get(name);
    if (!s) throw new Error(`no ssh session named "${name}" (use ssh_list to see open sessions)`);
    return s;
  }

  async open(opts: {
    name: string;
    host: string;
    sshArgs?: string[];
    readyTimeoutMs?: number;
  }): Promise<SessionInfo> {
    if (this.sessions.has(opts.name)) {
      throw new Error(`ssh session "${opts.name}" is already open`);
    }
    const s = new Session(opts);
    this.sessions.set(opts.name, s);
    try {
      await s.ready(opts.readyTimeoutMs ?? 15000);
    } catch (err) {
      s.close();
      this.sessions.delete(opts.name);
      throw err;
    }
    return s.info();
  }

  close(name: string): void {
    const s = this.sessions.get(name);
    if (!s) return;
    s.close();
    this.sessions.delete(name);
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
