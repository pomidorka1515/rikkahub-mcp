import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

export interface JobStatus {
  id: string;
  state: "running" | "exited";
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  error: string | null;
  duration_ms: number;
  buffered_bytes: number;
  dropped_bytes: number;
}

class Job {
  readonly id = randomUUID();
  readonly child: ChildProcess;
  private started = Date.now();
  private ended: number | undefined;
  private output = "";
  private dropped = 0;
  private exitCode: number | null = null;
  private signal: NodeJS.Signals | null = null;
  private error: string | null = null;
  private timedOut = false;
  private timeout: NodeJS.Timeout | undefined;
  private escalation: NodeJS.Timeout | undefined;

  constructor(shell: string, command: string, cwd: string, env: Record<string, string>,
    private maxBytes: number, private changed: () => void, timeoutMs?: number) {
    this.child = spawn(shell, ["-c", command], {
      cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [this.child.stdout!, this.child.stderr!]) {
      const decoder = new StringDecoder("utf8");
      stream.on("data", (chunk: Buffer) => this.append(decoder.write(chunk)));
      stream.on("end", () => this.append(decoder.end()));
    }
    this.child.on("error", (error) => { this.error = error.message; });
    // close, unlike exit, means the output pipes have also been drained.
    this.child.on("close", (code, signal) => {
      this.exitCode = code;
      this.signal = signal;
      this.ended = Date.now();
      clearTimeout(this.timeout);
      clearTimeout(this.escalation);
      this.changed();
    });
    if (timeoutMs !== undefined) {
      this.timeout = setTimeout(() => {
        this.timedOut = true;
        try { this.kill(); }
        catch (error) { this.error = String(error); this.changed(); }
      }, timeoutMs);
    }
  }

  private append(text: string): void {
    if (!text) return;
    const bytes = Buffer.from(this.output + text);
    let start = Math.max(0, bytes.length - this.maxBytes);
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    this.dropped += start;
    this.output = bytes.subarray(start).toString("utf8");
  }

  status(): JobStatus {
    return { id: this.id, state: this.ended === undefined ? "running" : "exited",
      exit_code: this.exitCode, signal: this.signal, timed_out: this.timedOut, error: this.error,
      duration_ms: (this.ended ?? Date.now()) - this.started,
      buffered_bytes: Buffer.byteLength(this.output), dropped_bytes: this.dropped };
  }

  read(lines: number): JobStatus & { output: string } {
    let end = 0;
    for (let count = 0; count < lines && end < this.output.length; count++) {
      const newline = this.output.indexOf("\n", end);
      end = newline === -1 ? this.output.length : newline + 1;
    }
    const output = this.output.slice(0, end);
    this.output = this.output.slice(end);
    const status = this.status();
    this.dropped = 0;
    return { ...status, output };
  }

  kill(force = false): void {
    if (this.ended !== undefined || !this.child.pid) return;
    const signal = (sig: NodeJS.Signals): void => {
      try { process.kill(-this.child.pid!, sig); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    signal(force ? "SIGKILL" : "SIGTERM");
    if (!force && !this.escalation) {
      this.escalation = setTimeout(() => {
        try { signal("SIGKILL"); }
        catch (error) { this.error = String(error); this.changed(); }
      }, 3000);
    }
  }
}

export class JobManager {
  private jobs = new Map<string, Job>();
  private events = new EventEmitter();

  constructor(private shell: string, private maxBytes: number, private maxJobs = 32) {}

  async start(command: string, cwd: string, env: Record<string, string> = {}, timeoutMs?: number): Promise<JobStatus> {
    if (this.jobs.size >= this.maxJobs) {
      for (const [id, job] of this.jobs) {
        if (job.status().state === "exited") { this.jobs.delete(id); break; }
      }
    }
    if (this.jobs.size >= this.maxJobs) throw new Error(`limit of ${this.maxJobs} jobs reached; kill a running job first`);
    const job = new Job(this.shell, command, cwd, env, this.maxBytes, () => this.events.emit("change"), timeoutMs);
    this.jobs.set(job.id, job);
    try {
      await new Promise<void>((resolve, reject) => {
        const spawned = (): void => { job.child.off("error", failed); resolve(); };
        const failed = (error: Error): void => { job.child.off("spawn", spawned); reject(error); };
        job.child.once("spawn", spawned);
        job.child.once("error", failed);
      });
    } catch (error) {
      this.jobs.delete(job.id);
      throw error;
    }
    return job.status();
  }

  get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job id: ${id}`);
    return job;
  }

  async wait(ids: string[], mode: "all" | "any", waitMs: number): Promise<{ ready: boolean; jobs: JobStatus[] }> {
    const jobs = [...new Set(ids)].map((id) => this.get(id));
    const ready = (): boolean => mode === "all"
      ? jobs.every((job) => job.status().state === "exited")
      : jobs.some((job) => job.status().state === "exited");
    if (!ready() && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(timer);
          this.events.off("change", changed);
          resolve();
        };
        const changed = (): void => { if (ready()) finish(); };
        const timer = setTimeout(finish, waitMs);
        this.events.on("change", changed);
      });
    }
    return { ready: ready(), jobs: jobs.map((job) => job.status()) };
  }

  shutdown(): void {
    for (const job of this.jobs.values()) {
      try { job.kill(true); } catch {}
    }
  }
}
