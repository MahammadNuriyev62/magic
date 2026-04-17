#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SessionManager, RunResult, SessionInfo } from "./session.js";

const manager = new SessionManager();

// ---------- tool schemas ----------

const OpenArgs = z.object({
  name: z.string().min(1).describe("short identifier for this session (e.g. 'gpu-box')"),
  host: z.string().min(1).describe("ssh destination (user@host, or a Host alias from ~/.ssh/config)"),
  sshArgs: z
    .array(z.string())
    .optional()
    .describe("extra args passed to ssh, e.g. ['-p', '2222', '-i', '~/.ssh/key']"),
});

const RunArgs = z.object({
  name: z.string().min(1),
  cmd: z.string().min(1).describe("shell command to execute in the session"),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(600_000)
    .optional()
    .describe("max ms to wait for completion before returning partial output (default 30000)"),
  maxBytes: z
    .number()
    .int()
    .min(1024)
    .max(4 * 1024 * 1024)
    .optional()
    .describe("max bytes of output to return in one call (default 262144)"),
});

const ReadArgs = z.object({
  name: z.string().min(1),
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(600_000)
    .optional()
    .describe("if a command is running, block up to this many ms waiting for completion"),
  maxBytes: z.number().int().min(1024).max(4 * 1024 * 1024).optional(),
});

const SignalArgs = z.object({
  name: z.string().min(1),
  signal: z
    .enum(["INT", "QUIT", "EOF"])
    .default("INT")
    .describe("INT=Ctrl-C (default), QUIT=Ctrl-\\, EOF=Ctrl-D"),
});

const CloseArgs = z.object({ name: z.string().min(1) });
const ListArgs = z.object({});

// ---------- helpers ----------

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function json(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

function formatRun(result: RunResult): string {
  const header: Record<string, unknown> = { status: result.status };
  if (result.exitCode !== undefined) header.exitCode = result.exitCode;
  if (result.truncated) header.truncated = true;
  if (result.reason) header.reason = result.reason;
  return JSON.stringify(header) + "\n---\n" + result.output;
}

function formatInfo(info: SessionInfo): string {
  return JSON.stringify(info, null, 2);
}

// ---------- server ----------

const server = new Server(
  { name: "magic-ssh", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const tools = [
  {
    name: "ssh_open",
    description:
      "Open a persistent ssh session to a remote host and give it a short name. The session runs a long-lived bash on the remote; subsequent ssh_run calls execute in that same shell so cd, env vars, and background jobs persist. Remember this name for later calls.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "short identifier for this session (e.g. 'gpu-box')" },
        host: {
          type: "string",
          description: "ssh destination (user@host, or a Host alias from ~/.ssh/config)",
        },
        sshArgs: {
          type: "array",
          items: { type: "string" },
          description: "extra args passed to ssh, e.g. ['-p', '2222', '-i', '~/.ssh/key']",
        },
      },
      required: ["name", "host"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_run",
    description:
      "Run a shell command in the named session's persistent bash. Returns when the command finishes or timeoutMs elapses (whichever first). On timeout the command keeps running; use ssh_read to poll for more output and the final exit code, or ssh_signal to interrupt it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        cmd: { type: "string", description: "shell command to execute in the session" },
        timeoutMs: {
          type: "integer",
          minimum: 100,
          maximum: 600000,
          description: "max ms to wait for completion (default 30000)",
        },
        maxBytes: {
          type: "integer",
          minimum: 1024,
          maximum: 4194304,
          description: "max bytes of output to return in one call (default 262144)",
        },
      },
      required: ["name", "cmd"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_read",
    description:
      "Read any output produced by the currently-running or last-finished command in the session. If a command is still running, pass waitMs to block until it completes or the wait elapses. Use this to tail long-running jobs (tail -f, train.py, etc).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        waitMs: {
          type: "integer",
          minimum: 0,
          maximum: 600000,
          description: "if a command is running, block up to this many ms waiting for completion (default 0)",
        },
        maxBytes: { type: "integer", minimum: 1024, maximum: 4194304 },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_signal",
    description:
      "Send a control signal to the session's foreground command (like pressing Ctrl-C/Ctrl-\\/Ctrl-D in a terminal). Interrupts without tearing down the session; the bash shell stays alive for further ssh_run calls.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        signal: {
          type: "string",
          enum: ["INT", "QUIT", "EOF"],
          description: "INT=Ctrl-C (default), QUIT=Ctrl-\\, EOF=Ctrl-D",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_close",
    description: "Terminate the named ssh session and free its resources.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "ssh_list",
    description:
      "List all open ssh sessions with their current state (idle/running/closed), host, and how long since last activity.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case "ssh_open": {
        const a = OpenArgs.parse(args ?? {});
        const info = await manager.open(a);
        return text(`session "${info.name}" opened to ${info.host}\n` + formatInfo(info));
      }
      case "ssh_run": {
        const a = RunArgs.parse(args ?? {});
        const res = await manager.get(a.name).run(a.cmd, a.timeoutMs ?? 30000, a.maxBytes);
        return text(formatRun(res));
      }
      case "ssh_read": {
        const a = ReadArgs.parse(args ?? {});
        const res = await manager.get(a.name).read(a.waitMs ?? 0, a.maxBytes);
        return text(formatRun(res));
      }
      case "ssh_signal": {
        const a = SignalArgs.parse(args ?? {});
        manager.get(a.name).signal(a.signal);
        return text(`sent ${a.signal} to "${a.name}"`);
      }
      case "ssh_close": {
        const a = CloseArgs.parse(args ?? {});
        manager.close(a.name);
        return text(`session "${a.name}" closed`);
      }
      case "ssh_list": {
        ListArgs.parse(args ?? {});
        return json(manager.list());
      }
      default:
        return { content: [{ type: "text" as const, text: `unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `error: ${msg}` }], isError: true };
  }
});

// ---------- lifecycle ----------

function shutdown() {
  manager.closeAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => manager.closeAll());

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("magic-ssh fatal:", err);
  process.exit(1);
});
