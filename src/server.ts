
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ShellManager, type ShellSnapshot } from "./persistent-shell.js";
import { registerSearchTools } from "./search-tools.js";
import { registerWebTools } from "./web-tools.js";
import { registerReadTool } from "./read-tool.js";
import { registerEditTools } from "./edit-tools.js";
import { JobManager } from "./jobs.js";
import { registerExecuteTool } from "./execute-tool.js";
import { requireRootAccess } from "./root-access.js";
import { registerScreenshotTool } from "./screenshot-tool.js";
import { requireRegularCommand, requireRegularEnvironment } from "./command-policy.js";

type RootMode = false | "tsu" | "sudo";
type KillSignal = "SIGTERM" | "SIGKILL";

interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  asRoot?: RootMode;
}

interface SpawnFailure {
  ok: false;
  text: string;
}

interface CommandCompletion {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  text: string;
}

type CommandResult = SpawnFailure | CommandCompletion;

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : "error";
}

function rpcMethod(body: unknown): string | undefined {
  return isRecord(body) && typeof body.method === "string" ? body.method : undefined;
}

/** inspect untrusted JSON for logging only (the SDK validates the actual request) */
function rpcNote(body: unknown, includeClient = false): string {
  const method = rpcMethod(body);
  const params = isRecord(body) && isRecord(body.params) ? body.params : {};
  let note = method === "tools/call" ? `call ${params.name}` : method || "response";
  if (includeClient && method === "initialize") {
    const client = isRecord(params.clientInfo) ? params.clientInfo : {};
    note += ` client=${client.name}@${client.version} proto=${params.protocolVersion}`;
  }
  return note;
}

/* ------------------------------------------------------------------ config */

const HOST = process.env.MCP_HOST || "127.0.0.1";
const PORT = Number(process.env.MCP_PORT || 8765);
const SHELL = process.env.MCP_SHELL || "bash";
const DEFAULT_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS || 60_000);
const MAX_TIMEOUT_MS = Number(process.env.MCP_MAX_TIMEOUT_MS || 600_000);
const MAX_OUTPUT_BYTES = Number(process.env.MCP_MAX_OUTPUT_BYTES || 128 * 1024);
const NO_AUTH = process.env.MCP_NO_AUTH === "1";
const JSON_RESPONSES = process.env.MCP_JSON_RESPONSE !== "0";
const shells = new ShellManager(SHELL, MAX_OUTPUT_BYTES);
const jobs = new JobManager(SHELL, MAX_OUTPUT_BYTES);

const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "rikkahub-mcp",
);
const TOKEN_FILE = path.join(CONFIG_DIR, "token");

function loadOrCreateToken(): string {
  if (process.env.MCP_TOKEN) return process.env.MCP_TOKEN.trim();
  try {
    const existing = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString("base64url");
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  return token;
}

const TOKEN = NO_AUTH ? null : loadOrCreateToken();
const TOKEN_BUF = TOKEN ? Buffer.from(TOKEN) : null;

function authorized(req: IncomingMessage, url: URL): boolean {
  if (NO_AUTH) return true;
  if (!TOKEN_BUF) return false;
  const header = req.headers["authorization"];
  let presented = "";
  if (header && /^Bearer\s+/i.test(header)) presented = header.replace(/^Bearer\s+/i, "").trim();
  else if (req.headers["x-mcp-token"]) presented = String(req.headers["x-mcp-token"]).trim();
  else presented = url.searchParams.get("token") || "";
  if (!presented) return false;
  const a = Buffer.from(presented);
  return a.length === TOKEN_BUF.length && crypto.timingSafeEqual(a, TOKEN_BUF);
}

/* --------------------------------------------------------------- utilities */

const TRUNC = "\n…[output truncated]";

function utf8Truncate(buf: Buffer): string {
  // cut on a byte boundary without splitting a multi-byte character.
  let s = buf.toString("utf8");
  if (buf.length >= MAX_OUTPUT_BYTES && s.length) {
    s = Buffer.from(buf).subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
    // drop a possible partial trailing character
    s = s.replace(/\uFFFD$/, "");
    s += TRUNC;
  }
  return s;
}

function collect(stream: Readable): () => string {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  stream.on("data", (c: Buffer) => {
    if (truncated) return;
    const room = MAX_OUTPUT_BYTES + 1 - size;
    if (c.length > room) {
      chunks.push(c.subarray(0, room));
      size += room;
      truncated = true;
      return;
    }
    chunks.push(c);
    size += c.length;
  });
  return () => utf8Truncate(Buffer.concat(chunks));
}

/** single-quote a string for safe embedding in a shell script */
function shq(s: string): string {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function rootScript(command: string, { cwd, env }: Pick<CommandOptions, "cwd" | "env">): string {
  const lines: string[] = [];
  if (cwd) {
    const dir = path.resolve(expandHome(cwd));
    lines.push(`cd ${shq(dir)} || { echo "cd failed: ${dir}" >&2; exit 1; }`);
  }
  for (const [k, v] of Object.entries(env || {})) lines.push(`export ${k}=${shq(v)}`);
  lines.push(command);
  return lines.join("\n");
}

/**
 * run a shell command, kill the whole process group on timeout.
 *
 * asRoot:
 *  - false (default): bash as the termux user.
 *  - "tsu": pipe the script into `tsu`, which keeps PREFIX/PATH/TERM but uses
 *    the root home (~/.suroot).
 *  - "sudo": `sudo -E bash -c ...` - tsu's sudo, preserving the full termux
 *    environment (HOME included).
 */
function runCommand(command: string, { cwd, timeoutMs, env, asRoot = false }: CommandOptions = {}): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const started = Date.now();
    const useCwd = cwd ? path.resolve(expandHome(cwd)) : os.homedir();
    let child: ChildProcessByStdio<Writable | null, Readable, Readable>;
    try {
      if (!asRoot) {
        requireRegularCommand(command);
        requireRegularCommand(SHELL);
        requireRegularEnvironment({ ...process.env, ...env });
      }
      if (!asRoot && !fs.existsSync(useCwd)) throw new Error(`cwd does not exist: ${useCwd}`);
      if (asRoot) {
        const script = rootScript(command, { cwd, env });
        const rootChild =
          asRoot === "sudo"
            ? spawn("sudo", ["-E", SHELL, "-c", script], { detached: true, stdio: ["pipe", "pipe", "pipe"] })
            : spawn("tsu", [], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
        rootChild.stdin.on("error", () => {}); // tsu may exit before we finish writing
        rootChild.stdin.end(script + "\n");
        child = rootChild;
      } else {
        child = spawn(command, {
          shell: SHELL,
          cwd: useCwd,
          detached: true, // own process group -> we can kill children too
          env: { ...process.env, ...(env || {}) },
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
    } catch (e) {
      resolve({ ok: false, text: `spawn failed: ${errorMessage(e)}` });
      return;
    }
    const stdoutBuf = collect(child.stdout);
    const stderrBuf = collect(child.stderr);

    let timedOut = false;
    let done = false;
    let killTimer: NodeJS.Timeout | undefined;
    let failSafe: NodeJS.Timeout | undefined;
    let spawned = false;
    child.on("spawn", () => {
      spawned = true;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killGroup(child, "SIGKILL");
        // if even that does not reap it (e.g. a root-owned process we cannot
        // signal), stop waiting and report what we have.
        failSafe = setTimeout(() => finish(null, "SIGKILL", null), 5000);
      }, 3000);
    }, timeoutMs);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, err?: Error | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (failSafe) clearTimeout(failSafe);
      const out = stdoutBuf();
      const errOut = stderrBuf();
      const mode = asRoot ? `root via ${asRoot === "sudo" ? "sudo -E" : "tsu"}` : `user ${os.userInfo().username}`;
      const parts = [];
      parts.push(`$ ${command}`);
      parts.push(`# ${mode}  cwd: ${useCwd}  exit: ${exitCode ?? "null"}${signal ? `  signal: ${signal}` : ""}  (${Date.now() - started}ms)`);
      if (out) parts.push(`--- stdout ---\n${out}`);
      if (errOut) parts.push(`--- stderr ---\n${errOut}`);
      if (timedOut) parts.push(`--- timed out after ${timeoutMs}ms, process group killed ---`);
      if (err) parts.push(`--- error: ${err.message} ---`);
      if (!out && !errOut && !timedOut && !err) parts.push("(no output)");
      resolve({
        ok: !err && !timedOut && exitCode === 0,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        stdout: out,
        stderr: errOut,
        text: parts.join("\n"),
      });
    };

    child.on("error", (e) => {
      if (spawned) return;
      finish(null, null, e);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

const SIGNUM: Record<KillSignal, number> = { SIGTERM: 15, SIGKILL: 9 };

function killGroup(child: ChildProcess, sig: KillSignal): void {
  if (!child.pid) return;
  const attempt = (pid: number): string | null => {
    try {
      process.kill(pid, sig);
      return null;
    } catch (e) {
      return errorCode(e);
    }
  };
  const err = attempt(-child.pid) || attempt(child.pid);
  if (!err || err === "ESRCH") return;
  if (err === "EPERM" || err === "EACCES") {
    const n = SIGNUM[sig] ?? 15;
    try {
      spawn("su", ["-c", `kill -${n} -${child.pid} 2>/dev/null; kill -${n} ${child.pid} 2>/dev/null; true`], {
        stdio: "ignore",
        detached: true,
      }).unref();
    } catch {}
  }
}

function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/* ------------------------------------------------------------------- tools */

async function buildServer(includeExecute = true): Promise<McpServer> {
  const server = new McpServer(
    { name: "termux-shell", version: "1.0.0" },
    {
      instructions:
        "Shell access to this Android device's Termux environment (user " +
        `${os.userInfo().username}, home ${os.homedir()}). ` +
        "Shared storage is at ~/storage/shared or /sdcard. Commands run in bash, " +
        "non-interactively. Use run_command with background=true for app servers and background tasks; " +
        "save the job id, inspect job_output, wait for completion with job_wait, and stop with job_kill. " +
        "Use shell_open/send/read/interrupt (shell_open_root for checked root access) " +
         "for persistent shells and long builds. Save shell_id; check state and exit_code before assuming success. " +
         "Read files before editing. Prefer edit for exact replacements, patch for multi-file diffs (add/update/move/delete), " +
         "and write for new files or full replacements; do not use shell commands to edit files when these tools suffice.",
    },
  );

  server.registerTool(
    "run_command",
    {
      title: "Run shell command",
      description:
        "Execute a bash command in Termux and return stdout, stderr and the exit code. " +
        "Runs non-interactively with a timeout (default " +
        `${DEFAULT_TIMEOUT_MS / 1000}s, max ${MAX_TIMEOUT_MS / 1000}s). ` +
        "Pipes, redirects, &&, globs all work. Output is capped at " +
        `${Math.round(MAX_OUTPUT_BYTES / 1024)} KiB per stream. ` +
        "With background=true returns a job id immediately instead; no timeout unless timeout_ms is set. " +
        "Use job_output, job_wait and job_kill to manage it. Background stdout/stderr share a rolling buffer. " +
        "sudo, su and tsu are blocked; use run_root_command or shell_open_root for root access.",
      inputSchema: {
        command: z.string().min(1).describe("The command line to run, e.g. `ls -la ~/projects`"),
        cwd: z.string().optional().describe("Working directory (default: home). ~ is expanded."),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})`),
        env: z.record(z.string(), z.string()).optional().describe("Extra environment variables"),
        background: z.boolean().optional().describe("Return a job id immediately; default false. No default timeout for background jobs."),
      },
      annotations: { openWorldHint: true, readOnlyHint: false },
    },
    async ({ command, cwd, timeout_ms, env, background }): Promise<CallToolResult> => {
      if (background) {
        try {
          const job = await jobs.start(command, path.resolve(expandHome(cwd || "~")), env,
            timeout_ms === undefined ? undefined : Math.min(timeout_ms, MAX_TIMEOUT_MS));
          return { content: [{ type: "text", text: JSON.stringify(job) }] };
        } catch (error) {
          return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
        }
      }
      const t = Math.min(timeout_ms || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const r = await runCommand(command, { cwd, timeoutMs: t, env });
      return { content: [{ type: "text", text: r.text }], isError: !r.ok };
    },
  );

  const jobResult = async (action: () => unknown | Promise<unknown>): Promise<CallToolResult> => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await action()) }] };
    } catch (error) {
      return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
    }
  };
  const jobId = z.string().min(1).describe("id returned by run_command with background=true");
  server.registerTool("job_output", {
    title: "Read background job output",
    description: "Consume unread merged stdout/stderr, including partial lines, and return job status. " +
      "Defaults to 100 lines, maximum 10000. The rolling buffer retains MCP_MAX_OUTPUT_BYTES; " +
      "dropped_bytes reports overflow since the last read. Jobs survive reconnects, not server restarts. " +
      "At most 32 jobs are retained; the oldest completed job is evicted when space is needed.",
    inputSchema: { id: jobId, lines: z.number().int().min(1).max(10_000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, ({ id, lines }) => jobResult(() => jobs.get(id).read(lines ?? 100)));

  server.registerTool("job_kill", {
    title: "Stop background job",
    description: "Send SIGTERM to the job's entire process group, escalating to SIGKILL after 3 seconds. " +
      "Returns current status immediately; use job_wait to confirm termination. Output remains readable. " +
      "Does nothing if already exited.",
    inputSchema: { id: jobId },
    annotations: { openWorldHint: true, readOnlyHint: false, destructiveHint: true },
  }, ({ id }) => jobResult(() => { const job = jobs.get(id); job.kill(); return job.status(); }));

  server.registerTool("job_wait", {
    title: "Wait for background jobs",
    description: "Wait for one or more jobs to exit. mode=all (default) waits for all; any waits for at least one, " +
      "including already completed jobs. Returns ready and a status for every requested id. " +
      "wait_ms defaults to 30000 (0–30000); ready=false means the wait expired, not that jobs were killed. " +
      "Does not consume output; use job_output to inspect logs and check exit_code for success.",
    inputSchema: {
      ids: z.array(jobId).min(1).max(32),
      mode: z.enum(["all", "any"]).optional(),
      wait_ms: z.number().int().min(0).max(30_000).optional(),
    },
    annotations: { readOnlyHint: true },
  }, ({ ids, mode, wait_ms }) => jobResult(() => jobs.wait(ids, mode ?? "all", wait_ms ?? 30_000)));

  const shellResult = async (action: () => Promise<ShellSnapshot>): Promise<CallToolResult> => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await action()) }] };
    } catch (error) {
      return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
    }
  };
  const shellId = z.string().min(1).describe("shell_id returned by shell_open or shell_open_root");
  const waitMs = z.number().int().min(0).max(30_000).optional()
    .describe("Wait up to this many milliseconds, at most 30000. Does not kill the command.");

  server.registerTool("shell_open", {
    title: "Open persistent shell",
    description: "Open a pipe-based user shell, preserving cwd, variables and functions across sends. " +
      "Returns shell_id. Survives client reconnects, not server restarts. No PTY or interactive stdin. " +
      "At most 16 shells; send 'exit' when finished. sudo, su and tsu are blocked; use shell_open_root for root.",
    inputSchema: {
      cwd: z.string().optional().describe("Working directory (default home); ~ is expanded"),
      env: z.record(z.string(), z.string()).optional().describe("Extra environment variables"),
    },
    annotations: { openWorldHint: true, readOnlyHint: false },
  }, ({ cwd, env }) => shellResult(() => shells.open(path.resolve(expandHome(cwd || "~")), env)));

  server.registerTool("shell_open_root", {
    title: "Open persistent root shell",
    description: "Check root access on every invocation, then open a pipe-based UID 0 shell via tsu. " +
      "Returns shell_id for shell_send/read/interrupt. No PTY or interactive stdin. " +
      "Shares the 16-shell limit with user shells. Send 'exit' when finished. " +
      "preserve_env=true uses sudo -E, matching run_root_command.",
    inputSchema: {
      cwd: z.string().optional().describe("Working directory (default: root shell's home); ~ is expanded"),
      env: z.record(z.string(), z.string()).optional().describe("Extra environment variables"),
      preserve_env: z.boolean().optional().describe("Keep the full Termux environment; default false"),
    },
    annotations: { openWorldHint: true, readOnlyHint: false, destructiveHint: true },
  }, ({ cwd, env, preserve_env }) => shellResult(() => shells.openRoot(
    cwd === undefined ? undefined : path.resolve(expandHome(cwd)), env, preserve_env ? "sudo" : "tsu")));

  server.registerTool("shell_send", {
    title: "Send shell command",
    description: "Run cmd in an idle persistent shell. Returns after completion or wait_ms (default 1000), " +
      "leaving long commands running with no timeout. Rejects sends while busy. Returns state, exit_code " +
      "and consumes up to 100 lines of merged stdout/stderr; read remaining output with shell_read. " +
      "Commands must be non-interactive. Do not change traps, stdin, control descriptor 3 or __mcp_ variables/functions.",
    inputSchema: { shell_id: shellId, cmd: z.string().min(1), wait_ms: waitMs },
    annotations: { openWorldHint: true, readOnlyHint: false },
  }, ({ shell_id, cmd, wait_ms }) => shellResult(() => shells.get(shell_id).send(cmd, wait_ms ?? 1000)));

  server.registerTool("shell_read", {
    title: "Read shell output",
    description: "Consume up to lines (default 100) of unread merged stdout/stderr, including partial lines. " +
      "wait_ms defaults to 0; when empty, optionally wait for output or command completion. " +
      "state=idle means the last command finished; exit_code is its status. " +
      "The buffer keeps the most recent output up to MCP_MAX_OUTPUT_BYTES; dropped_bytes reports overflow.",
    inputSchema: {
      shell_id: shellId, lines: z.number().int().min(1).max(10_000).optional(), wait_ms: waitMs,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, ({ shell_id, lines, wait_ms }) => shellResult(() => shells.get(shell_id).read(lines ?? 100, wait_ms ?? 0)));

  server.registerTool("shell_interrupt", {
    title: "Interrupt shell command",
    description: "Send SIGINT to the shell process group (like Ctrl-C), keeping the shell usable. " +
      "Wait up to wait_ms (default 1000) and consume up to 100 output lines. " +
      "Commands that ignore SIGINT may remain running. Does nothing to an idle/exited shell.",
    inputSchema: { shell_id: shellId, wait_ms: waitMs },
    annotations: { openWorldHint: true, readOnlyHint: false },
  }, ({ shell_id, wait_ms }) => shellResult(() => shells.get(shell_id).interrupt(wait_ms ?? 1000)));

  server.registerTool(
    "run_root_command",
    {
      title: "Run shell command as root",
      description:
        "Execute a bash command as UID 0 via `tsu` (Termux su). " +
        "By default (preserve_env=false) it behaves like plain `tsu`: PREFIX, PATH and TERM are kept, " +
        "but HOME is /data/data/com.termux/files/home/.suroot. " +
        "With preserve_env=true it runs `sudo -E` instead, keeping your full Termux environment " +
        "(HOME=/data/data/com.termux/files/home, all exported vars). " +
        "Same timeout and output limits as run_command. Use only when root is genuinely required " +
        "(/data/adb, /system, iptables, pm, settings, dumpsys, mounting).",
      inputSchema: {
        command: z.string().min(1).describe("The command to run as root, e.g. `id` or `ls /data/adb`"),
        cwd: z.string().optional().describe("Working directory (default: root shell's home)"),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})`),
        preserve_env: z
          .boolean()
          .optional()
          .describe("Keep the full Termux environment (uses tsu's `sudo -E`); default false = plain tsu"),
        env: z.record(z.string(), z.string()).optional().describe("Extra environment variables"),
      },
      annotations: { openWorldHint: true, readOnlyHint: false, destructiveHint: true },
    },
    async ({ command, cwd, timeout_ms, preserve_env, env }): Promise<CallToolResult> => {
      try {
        await requireRootAccess(preserve_env ? "sudo" : "tsu");
      } catch (error) {
        return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
      }
      const t = Math.min(timeout_ms || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const r = await runCommand(command, {
        cwd,
        timeoutMs: t,
        env,
        asRoot: preserve_env ? "sudo" : "tsu",
      });
      return { content: [{ type: "text", text: r.text }], isError: !r.ok };
    },
  );

  registerReadTool(server, MAX_OUTPUT_BYTES);
  registerScreenshotTool(server);

  registerEditTools(server);

  server.registerTool(
    "list_dir",
    {
      title: "List directory",
      description: "List a directory (name, type, size). Hidden files are included.",
      inputSchema: {
        path: z.string().optional().describe("Directory path (default: home)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: p }): Promise<CallToolResult> => {
      const dir = path.resolve(expandHome(p || "~"));
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        const rows: string[] = [];
        for (const e of entries.slice(0, 500)) {
          let size = "";
          if (e.isFile()) {
            try {
              size = String((await fsp.stat(path.join(dir, e.name))).size);
            } catch {}
          }
          rows.push(`${e.isDirectory() ? "d" : e.isSymbolicLink() ? "l" : "-"} ${size.padStart(10)}  ${e.name}`);
        }
        if (!rows.length) rows.push("(empty)");
        if (entries.length > 500) rows.push(`…[${entries.length - 500} more entries]`);
        return { content: [{ type: "text", text: `${dir}\n${rows.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `${errorCode(e)}: ${errorMessage(e)}` }], isError: true };
      }
    },
  );

  registerSearchTools(server, MAX_OUTPUT_BYTES);
  registerWebTools(server, MAX_OUTPUT_BYTES);
  if (includeExecute) await registerExecuteTool(server, () => buildServer(false), MAX_OUTPUT_BYTES);
  return server;
}

/* -------------------------------------------------------------- transport */

const sessions = new Map<string, Session>();
const sseTransports = new Map<string, SSEServerTransport>();

function logLine(msg: string): void {
  console.log(`${new Date().toISOString().replace("T", " ").slice(0, 19)}  ${msg}`);
}

function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const route = url.pathname.replace(/\/+$/, "") || "/";
  let note = "";
  res.on("finish", () => {
    const ua = String(req.headers["user-agent"] || "-").slice(0, 32);
    logLine(
      `${req.method} ${url.pathname} -> ${res.statusCode}${note ? ` [${note}]` : ""} ` +
        `(${Date.now() - t0}ms) ua=${ua} accept=${req.headers["accept"] || "-"}`,
    );
  });

  if (route === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    return;
  }

  if (!authorized(req, url)) {
    note = "unauthorized";
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }));
    return;
  }

  try {
    if (route === "/mcp") {
      let parsedBody: unknown;
      if (req.method === "POST") {
        // The MCP spec demands this Accept; some clients only send JSON.
        const accept = String(req.headers["accept"] || "");
        if (!accept.includes("text/event-stream") || !accept.includes("application/json")) {
          req.headers["accept"] = "application/json, text/event-stream";
        }
        const raw = await readBody(req);
        try {
          parsedBody = JSON.parse(raw);
        } catch {
          note = "bad json";
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null }));
          return;
        }
        note = rpcNote(parsedBody, true);
      } else if (req.method === "GET") {
        note = "server->client stream";
      }
      await handleStreamable(req, res, parsedBody);
      return;
    }
    if (route === "/sse" && req.method === "GET") {
      note = "sse stream open";
      await handleLegacySse(req, res);
      return;
    }
    if (route.startsWith("/messages") && req.method === "POST") {
      const sid = url.searchParams.get("sessionId") || "";
      const transport = sseTransports.get(sid);
      if (!transport) {
        note = `unknown session ${sid.slice(0, 8)}`;
        res.writeHead(404, { "content-type": "text/plain" }).end("unknown session\n");
        return;
      }
      const raw = await readBody(req);
      try {
        const msg: unknown = JSON.parse(raw);
        note = rpcNote(msg);
      } catch {}
      await transport.handlePostMessage(req, res, raw);
      return;
    }
    note = "no route";
    res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
  } catch (err) {
    console.error("[error]", err);
    note = `error ${errorMessage(err)}`;
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: errorMessage(err) }, id: null }));
    } else {
      res.end();
    }
  }
});

async function handleStreamable(req: IncomingMessage, res: ServerResponse, parsedBody: unknown): Promise<void> {
  const sid = req.headers["mcp-session-id"];
  const existing = sid ? sessions.get(String(sid)) : undefined;
  if (existing) {
    await existing.transport.handleRequest(req, res, parsedBody);
    return;
  }
  const method = rpcMethod(parsedBody);
  if (method && method !== "initialize") {
    const server = await buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: JSON_RESPONSES,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } finally {
      server.close().catch(() => {});
    }
    return;
  }
  const server = await buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: JSON_RESPONSES,
    onsessioninitialized: (newId) => {
      sessions.set(newId, { server, transport });
    },
  });
  let closing = false;
  transport.onclose = () => {
    if (closing) return; // server.close() re-enters transport.close()
    closing = true;
    const id = transport.sessionId;
    if (id) sessions.delete(id);
    server.close().catch(() => {});
  };
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

async function handleLegacySse(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const endpoint = "/messages" + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "");
  const transport = new SSEServerTransport(endpoint, res);
  sseTransports.set(transport.sessionId, transport);
  const server = await buildServer();
  let closing = false;
  transport.onclose = () => {
    if (closing) return;
    closing = true;
    sseTransports.delete(transport.sessionId);
    server.close().catch(() => {});
  };
  // Server.connect() calls transport.start() itself
  await server.connect(transport);
}

/* -------------------------------------------------------------------- boot */

httpServer.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`;
  const q = TOKEN ? `?token=${TOKEN}` : "";
  console.log(`rikkahub-mcp listening on ${base}`);
  console.log(`  streamable http : ${base}/mcp${q}`);
  console.log(`  legacy sse      : ${base}/sse${q}`);
  if (NO_AUTH) console.log("  WARNING: auth disabled (MCP_NO_AUTH=1)");
  else console.log(`  token file      : ${TOKEN_FILE}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n${sig} — shutting down`);
    shells.shutdown();
    jobs.shutdown();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
