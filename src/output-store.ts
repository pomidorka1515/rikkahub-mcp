import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

interface Entry { size: number; modified: number; active: boolean }

/** private, bounded disk storage; inactive captures are evicted oldest first. */
export class OutputStore {
  private entries = new Map<string, Entry>();
  private initialized = false;

  constructor(readonly directory = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "rikkahub-mcp", "output"),
    readonly maxFileBytes = 16 * 1024 * 1024, private maxTotalBytes = 128 * 1024 * 1024,
    private retentionMs = 24 * 60 * 60 * 1000, private maxFiles = 256) {}

  private initialize(): void {
    if (this.initialized) return;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.txt$/.test(name)) continue;
      const file = path.join(this.directory, name);
      const info = fs.lstatSync(file);
      if (info.isFile()) this.entries.set(file, { size: info.size, modified: info.mtimeMs, active: false });
    }
    this.initialized = true;
  }

  private reserve(bytes: number, newFile = 0): void {
    let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.size, 0);
    const oldest = [...this.entries].filter(([, entry]) => !entry.active).sort((a, b) => a[1].modified - b[1].modified);
    for (const [file, entry] of oldest) {
      if (total + bytes <= this.maxTotalBytes && this.entries.size + newFile <= this.maxFiles &&
        Date.now() - entry.modified < this.retentionMs) break;
      fs.rmSync(file, { force: true });
      total -= entry.size;
      this.entries.delete(file);
    }
    if (total + bytes > this.maxTotalBytes || this.entries.size + newFile > this.maxFiles) {
      throw new Error("output storage is full (active captures occupy the quota)");
    }
  }

  create(): string {
    this.initialize();
    this.reserve(0, 1);
    const file = path.join(this.directory, `${randomUUID()}.txt`);
    fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 });
    this.entries.set(file, { size: 0, modified: Date.now(), active: true });
    return file;
  }

  append(file: string, bytes: Buffer): void {
    this.reserve(bytes.length);
    fs.appendFileSync(file, bytes, { mode: 0o600 });
    const entry = this.entries.get(file)!;
    entry.size += bytes.length;
    entry.modified = Date.now();
  }

  finish(file: string): void {
    const entry = this.entries.get(file);
    if (entry) entry.active = false;
  }
}

const defaultStore = new OutputStore();

export interface OutputMetadata {
  output_path?: string;
  output_capture_error?: string;
}

/** keep a small preview in memory and spill the complete stream on overflow. */
export class OutputCapture {
  private preview = Buffer.alloc(0);
  private total = 0;
  private saved = 0;
  private file: string | undefined;
  private error: string | undefined;

  constructor(private maxBytes: number, private store = defaultStore) {}

  append(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.total += bytes.length;
    if (!this.error) {
      try {
        if (!this.file && this.total > this.maxBytes) {
          this.file = this.store.create();
          this.save(this.preview);
        }
        if (this.file && !this.error) this.save(bytes);
      } catch (error) {
        this.error = `could not retain complete output: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const room = this.maxBytes - this.preview.length;
    if (room > 0) this.preview = Buffer.concat([this.preview, bytes.subarray(0, room)]);
  }

  private save(bytes: Buffer): void {
    const remaining = this.store.maxFileBytes - this.saved;
    let end = Math.min(remaining, bytes.length);
    // avoid cutting a utf-8 character within this chunk at the disk limit.
    if (end < bytes.length) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end) this.store.append(this.file!, bytes.subarray(0, end));
    this.saved += end;
    if (end < bytes.length) this.error = `saved output is incomplete: capture reached the ${this.store.maxFileBytes}-byte file limit`;
  }

  metadata(): OutputMetadata {
    return { ...(this.file ? { output_path: this.file } : {}), ...(this.error ? { output_capture_error: this.error } : {}) };
  }

  finish(): void { if (this.file) this.store.finish(this.file); }

  text(): string {
    if (this.total <= this.maxBytes) return this.preview.toString("utf8");
    let end = this.preview.length;
    // a preview may end in the middle of a multibyte character.
    while (end > 0 && (this.preview[end - 1]! & 0xc0) === 0x80) end--;
    if (end > 0 && this.preview[end - 1]! >= 0xc0) {
      const lead = this.preview[end - 1]!;
      const width = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
      end = this.preview.length - (end - 1) < width ? end - 1 : this.preview.length;
    } else end = this.preview.length;
    return this.preview.subarray(0, end).toString("utf8") + "\n[output truncated]" +
      (this.file ? `\noutput_path: ${this.file}\nuse read_file with this absolute path to read more, or grep/run_command to inspect it.` : "") +
      (this.error ? `\n[${this.error}]` : "");
  }
}

export function recoverableText(text: string, maxBytes: number): string {
  const capture = new OutputCapture(maxBytes);
  capture.append(text);
  capture.finish();
  return capture.text();
}
