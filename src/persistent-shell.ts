import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { requireRootAccess, ROOT_ACCESS_ERROR, type RootMode } from "./root-access.js";
import { requireRegularCommand, requireRegularEnvironment } from "./command-policy.js";

export interface ShellSnapshot {
  shell_id: string;
  state: "idle" | "running" | "exited";
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  buffered_bytes: number;
  dropped_bytes: number;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

class PersistentShell {
  readonly id = randomUUID();
  readonly events = new EventEmitter();
  readonly child: ChildProcess;
  readonly input: Writable;
  state: ShellSnapshot["state"] = "idle";
  exitCode: number | null = null;
  signal: NodeJS.Signals | null = null;
  private output = "";
  private dropped = 0;

  constructor(shell: string, cwd: string | undefined, env: Record<string, string>, private maxBytes: number,
    private rootMode?: RootMode) {
    // A trapped INT keeps the shell alive; external foreground commands reset
    // the trap and receive SIGINT along with the rest of this process group.
    const marker = `__mcp_status_${randomUUID()}__`;
    const script = "trap ':' INT; exec 2>&1\n" +
      "__mcp_run() { trap 'return 130' INT; eval \"$__mcp_line\" </dev/null; }\n" +
      `while IFS= read -r __mcp_line; do __mcp_run; __mcp_status=$?; trap ':' INT; printf '${rootMode ? marker : ""}%s\\n' "$__mcp_status" ${rootMode ? "" : ">&3"}; done\n`;
    this.child = spawn(rootMode ?? shell, rootMode ? (rootMode === "sudo" ? ["-E", "bash"] : []) : ["-c", script], {
      cwd: rootMode ? undefined : cwd, env: { ...process.env, ...env }, detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    this.input = this.child.stdin!;
    this.input.on("error", () => {});
    let status = "";
    const receiveStatus = (chunk: string): void => {
      status += chunk;
      let end: number;
      while ((end = status.indexOf("\n")) !== -1) {
        this.exitCode = Number(status.slice(0, end));
        status = status.slice(end + 1);
        if (this.state !== "exited") this.state = "idle";
        this.events.emit("change");
      }
    };
    // root daemons need not preserve descriptor 3; frame status on stdout instead.
    let pending = "";
    const receiveRootOutput = (text: string): void => {
      pending += text;
      while (pending) {
        const start = pending.indexOf(marker);
        if (start !== -1) {
          this.append(pending.slice(0, start));
          pending = pending.slice(start);
          const end = pending.indexOf("\n", marker.length);
          if (end === -1) return;
          receiveStatus(pending.slice(marker.length, end + 1));
          pending = pending.slice(end + 1);
        } else {
          let keep = Math.min(marker.length - 1, pending.length);
          while (keep && !marker.startsWith(pending.slice(-keep))) keep--;
          this.append(pending.slice(0, pending.length - keep));
          pending = pending.slice(pending.length - keep);
          return;
        }
      }
    };
    for (const stream of [this.child.stdout!, this.child.stderr!]) {
      const decoder = new StringDecoder("utf8");
      const receive = rootMode && stream === this.child.stdout ? receiveRootOutput : (text: string) => this.append(text);
      stream.on("data", (chunk: Buffer) => receive(decoder.write(chunk)));
      stream.on("end", () => {
        receive(decoder.end());
        if (rootMode && stream === this.child.stdout) { this.append(pending); pending = ""; }
      });
    }
    (this.child.stdio[3] as Readable).setEncoding("utf8").on("data", receiveStatus);
    this.child.on("error", (error) => {
      this.append(`shell error: ${error.message}\n`);
      this.state = "exited";
      this.events.emit("change");
    });
    this.child.on("exit", (code, signal) => {
      this.state = "exited";
      this.exitCode = code;
      this.signal = signal;
      this.events.emit("change");
    });
    if (rootMode) {
      const setup = ["[ \"$(id -u)\" = 0 ] || exit 1"];
      for (const [key, value] of Object.entries(env)) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) throw new Error(`invalid environment variable: ${key}`);
        setup.push(`export ${key}=${quote(value)}`);
      }
      setup.push(cwd === undefined ? 'cd -- "$HOME" || exit 1' : `cd -- ${quote(cwd)} || exit 1`);
      setup.push(`exec ${quote(shell)} -c ${quote(script)}`);
      this.input.write(setup.join("\n") + "\n");
    }
  }

  private append(text: string): void {
    if (!text) return;
    const bytes = Buffer.from(this.output + text);
    let start = Math.max(0, bytes.length - this.maxBytes);
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    this.dropped += start;
    this.output = bytes.subarray(start).toString("utf8");
    this.events.emit("change");
  }

  async send(cmd: string, waitMs: number): Promise<ShellSnapshot> {
    if (!this.rootMode) requireRegularCommand(cmd);
    if (this.state !== "idle") throw new Error(`Shell is ${this.state}; read or interrupt it before sending another command.`);
    this.state = "running";
    this.exitCode = null;
    // Base64 avoids newline framing issues and preserves trailing newlines.
    // Strip the sentinel after decoding without changing the caller's variables.
    this.input.write(`__mcp_command=$(printf %s ${quote(Buffer.from(cmd).toString("base64"))} | base64 -d; printf _); eval "\${__mcp_command%_}"\n`);
    await this.wait(waitMs, false);
    return this.snapshot(100);
  }

  async read(lines: number, waitMs: number): Promise<ShellSnapshot> {
    await this.wait(waitMs, true);
    return this.snapshot(lines);
  }

  async interrupt(waitMs: number): Promise<ShellSnapshot> {
    if (this.state === "running") this.kill("SIGINT");
    await this.wait(waitMs, false);
    return this.snapshot(100);
  }

  kill(signal: NodeJS.Signals): void {
    if (!this.child.pid) return;
    try { process.kill(-this.child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }

  private wait(ms: number, forOutput: boolean): Promise<void> {
    if (!ms || this.state !== "running" || (forOutput && this.output)) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.events.off("change", changed);
        resolve();
      };
      const changed = (): void => {
        if (this.state !== "running" || (forOutput && this.output)) finish();
      };
      const timer = setTimeout(finish, ms);
      this.events.on("change", changed);
    });
  }

  private snapshot(lines: number): ShellSnapshot {
    let end = 0;
    for (let count = 0; count < lines && end < this.output.length; count++) {
      const newline = this.output.indexOf("\n", end);
      end = newline === -1 ? this.output.length : newline + 1;
    }
    const output = this.output.slice(0, end);
    this.output = this.output.slice(end);
    const dropped = this.dropped;
    this.dropped = 0;
    return { shell_id: this.id, state: this.state, exit_code: this.exitCode,
      signal: this.signal, output, buffered_bytes: Buffer.byteLength(this.output), dropped_bytes: dropped };
  }
}

export class ShellManager {
  private shells = new Map<string, PersistentShell>();
  constructor(private shell: string, private maxBytes: number, private maxShells = 16) {}

  async open(cwd: string, env: Record<string, string> = {}): Promise<ShellSnapshot> {
    requireRegularCommand(this.shell);
    requireRegularEnvironment({ ...process.env, ...env });
    return this.create(cwd, env);
  }

  async openRoot(cwd?: string, env: Record<string, string> = {}, mode: RootMode = "tsu"): Promise<ShellSnapshot> {
    await requireRootAccess(mode);
    for (const key of Object.keys(env)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) throw new Error(`invalid environment variable: ${key}`);
    }
    return this.create(cwd, env, mode);
  }

  private async create(cwd: string | undefined, env: Record<string, string>, mode?: RootMode): Promise<ShellSnapshot> {
    // Keep exited shells readable until room is needed for a new one.
    if (this.shells.size >= this.maxShells) {
      for (const [id, shell] of this.shells) {
        if (shell.state === "exited") {
          // A background descendant may still hold output pipes after exit.
          shell.kill("SIGKILL");
          this.shells.delete(id);
        }
      }
    }
    if (this.shells.size >= this.maxShells) throw new Error(`Limit of ${this.maxShells} shells reached; send 'exit' to an idle shell first.`);
    const shell = new PersistentShell(this.shell, cwd, env, this.maxBytes, mode);
    this.shells.set(shell.id, shell);
    await new Promise<void>((resolve, reject) => {
      shell.child.once("spawn", resolve);
      shell.child.once("error", reject);
    }).catch((error: unknown) => { this.shells.delete(shell.id); throw error; });
    if (mode) {
      const ready = await shell.send("true", 10_000);
      if (ready.state !== "idle" || ready.exit_code !== 0) {
        shell.kill("SIGKILL");
        this.shells.delete(shell.id);
        throw new Error(ROOT_ACCESS_ERROR);
      }
      return ready;
    }
    return shell.read(100, 0);
  }

  get(id: string): PersistentShell {
    const shell = this.shells.get(id);
    if (!shell) throw new Error(`Unknown shell_id: ${id}`);
    return shell;
  }

  shutdown(): void {
    for (const shell of this.shells.values()) {
      try { shell.kill("SIGKILL"); } catch {}
    }
  }
}
