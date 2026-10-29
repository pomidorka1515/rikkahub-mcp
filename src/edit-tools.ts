import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const resolvePath = (value: string): string => path.resolve(
  value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value,
);

// serialize edits across clients, including legacy writes, to avoid lost updates.
let pending: Promise<unknown> = Promise.resolve();
function locked(action: () => Promise<string>): Promise<CallToolResult> {
  const result = pending.then(action).then(
    (text): CallToolResult => ({ content: [{ type: "text", text }] }),
    (error: unknown): CallToolResult => ({
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true,
    }),
  );
  pending = result;
  return result;
}

async function readText(file: string): Promise<string | undefined> {
  let info;
  try { info = await fs.lstat(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile()) throw new Error(`not a regular file (symlinks are not edited): ${file}`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`file exceeds 16 MiB: ${file}`);
  const bytes = await fs.readFile(file);
  if (bytes.includes(0)) throw new Error(`binary file cannot be edited: ${file}`);
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`file is not valid UTF-8: ${file}`); }
}

function checkContent(content: string): void {
  if (content.includes("\0")) throw new Error("text must not contain null bytes");
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("result exceeds 16 MiB");
}

interface Hunk { anchor?: string; old: string[]; next: string[]; eof: boolean }
type Operation = { kind: "add"; file: string; content: string }
  | { kind: "delete"; file: string }
  | { kind: "update"; file: string; move?: string; hunks: Hunk[] };

function parsePatch(text: string): Operation[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") {
    throw new Error("patch must start with *** Begin Patch and end with *** End Patch");
  }
  const operations: Operation[] = [];
  let i = 0;
  const target = (name: string): string => {
    if (!name.trim()) throw new Error("patch path must not be empty");
    return resolvePath(name);
  };
  while (i < lines.length) {
    const header = lines[i++]!;
    if (header.startsWith("*** Add File: ")) {
      const file = target(header.slice(14));
      const added: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith("*** ")) {
        const line = lines[i++]!;
        if (!line.startsWith("+")) throw new Error("every added file line must start with +");
        added.push(line.slice(1));
      }
      operations.push({ kind: "add", file, content: added.length ? added.join("\n") + "\n" : "" });
    } else if (header.startsWith("*** Delete File: ")) {
      operations.push({ kind: "delete", file: target(header.slice(17)) });
    } else if (header.startsWith("*** Update File: ")) {
      const file = target(header.slice(17));
      let move: string | undefined;
      if (lines[i]?.startsWith("*** Move to: ")) move = target(lines[i++]!.slice(13));
      const hunks: Hunk[] = [];
      while (i < lines.length && !lines[i]!.startsWith("*** ")) {
        const marker = lines[i++]!;
        if (marker !== "@@" && !marker.startsWith("@@ ")) throw new Error(`expected @@ hunk marker, got: ${marker}`);
        const hunk: Hunk = { anchor: marker === "@@" ? undefined : marker.slice(3), old: [], next: [], eof: false };
        let changed = false;
        while (i < lines.length && !lines[i]!.startsWith("@@") && !lines[i]!.startsWith("*** ")) {
          const line = lines[i++]!;
          const prefix = line[0];
          if (prefix !== " " && prefix !== "+" && prefix !== "-") throw new Error("hunk lines must start with a space, + or -");
          if (prefix !== "+") hunk.old.push(line.slice(1));
          if (prefix !== "-") hunk.next.push(line.slice(1));
          if (prefix !== " ") changed = true;
        }
        if (lines[i] === "*** End of File") { hunk.eof = true; i++; }
        if (!changed) throw new Error("hunk must contain an addition or removal");
        hunks.push(hunk);
      }
      if (!hunks.length && !move) throw new Error(`update has no hunks: ${file}`);
      operations.push({ kind: "update", file, move, hunks });
    } else throw new Error(`invalid patch header: ${header}`);
  }
  if (!operations.length) throw new Error("patch contains no file operations");
  return operations;
}

function updateText(content: string, hunks: Hunk[], file: string): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const trailing = content.endsWith("\n");
  const lines = content === "" ? [] : content.replace(/\r\n/g, "\n").split("\n");
  if (trailing) lines.pop();
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.anchor !== undefined) {
      const anchor = lines.indexOf(hunk.anchor, cursor);
      if (anchor < 0) throw new Error(`hunk anchor not found in ${file}: ${hunk.anchor}`);
      cursor = anchor + 1;
    }
    let start = -1;
    if (!hunk.old.length) {
      // a context-free insertion appends; contextual insertions use context lines.
      start = lines.length;
    } else {
      for (let j = cursor; j + hunk.old.length <= lines.length; j++) {
        if (hunk.eof && j + hunk.old.length !== lines.length) continue;
        if (hunk.old.every((line, k) => lines[j + k] === line)) { start = j; break; }
      }
    }
    if (start < 0) throw new Error(`exact hunk context not found in ${file}: ${hunk.old.slice(0, 3).join("\n")}`);
    lines.splice(start, hunk.old.length, ...hunk.next);
    cursor = start + hunk.next.length;
  }
  return lines.join(eol) + (lines.length && (trailing || content === "") ? eol : "");
}

async function applyPatch(text: string): Promise<string> {
  const operations = parsePatch(text);
  const before = new Map<string, string | undefined>();
  const after = new Map<string, string | undefined>();
  const claim = async (file: string): Promise<string | undefined> => {
    if (before.has(file)) throw new Error(`path occurs more than once in patch: ${file}`);
    const content = await readText(file);
    before.set(file, content);
    return content;
  };
  const summary: string[] = [];
  for (const op of operations) {
    const content = await claim(op.file);
    if (op.kind === "add") {
      if (content !== undefined) throw new Error(`add would overwrite an existing file: ${op.file}`);
      after.set(op.file, op.content);
      summary.push(`A ${op.file}`);
    } else {
      if (content === undefined) throw new Error(`file does not exist: ${op.file}`);
      if (op.kind === "delete") {
        after.set(op.file, undefined);
        summary.push(`D ${op.file}`);
      } else {
        const updated = updateText(content, op.hunks, op.file);
        if (op.move && op.move !== op.file) {
          if (await claim(op.move) !== undefined) throw new Error(`move destination already exists: ${op.move}`);
          after.set(op.file, undefined);
          after.set(op.move, updated);
          summary.push(`R ${op.file} -> ${op.move}`);
        } else {
          after.set(op.file, updated);
          summary.push(`M ${op.file}`);
        }
      }
    }
  }
  // validate every operation before changing any file; detect external modifications.
  for (const [file, content] of after) if (content !== undefined) checkContent(content);
  for (const [file, content] of before) {
    if (await readText(file) !== content) throw new Error(`file changed while preparing patch: ${file}`);
  }
  // write destinations before deleting sources, preserving permissions on moved files.
  for (const [file, content] of after) {
    if (content === undefined) continue;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const moved = operations.find((op) => op.kind === "update" && op.move === file && op.file !== file);
    const mode = moved ? (await fs.stat(moved.file)).mode : undefined;
    await fs.writeFile(file, content, { encoding: "utf8", flag: before.get(file) === undefined ? "wx" : "w", mode });
    if (mode !== undefined) await fs.chmod(file, mode & 0o7777);
  }
  for (const [file, content] of after) if (content === undefined) await fs.unlink(file);
  return `patch applied:\n${summary.join("\n")}`;
}

export function registerEditTools(server: McpServer): void {
  const filePath = z.string().min(1).describe("File path; relative paths use the server working directory. ~ is expanded.");
  const annotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
  server.registerTool("edit", {
    title: "Edit file",
    description: "Replace exact text in an existing UTF-8 file. oldString must be nonempty and match exactly once unless replaceAll=true. " +
      "No fuzzy or whitespace matching. Read the file first; omit read_file line-number prefixes from strings.",
    inputSchema: { path: filePath, oldString: z.string().min(1), newString: z.string(), replaceAll: z.boolean().optional() },
    annotations,
  }, ({ path: name, oldString, newString, replaceAll }) => locked(async () => {
    if (oldString === newString) throw new Error("oldString and newString must differ");
    const file = resolvePath(name);
    const content = await readText(file);
    if (content === undefined) throw new Error(`file does not exist: ${file}`);
    const parts = content.split(oldString);
    const count = parts.length - 1;
    if (!count) throw new Error("oldString not found; read the file and use exact text");
    if (count > 1 && !replaceAll) throw new Error(`oldString matches ${count} times; provide more context or set replaceAll=true`);
    const updated = parts.join(newString);
    checkContent(updated);
    await fs.writeFile(file, updated, "utf8");
    return `edited ${file} (${count} replacement${count === 1 ? "" : "s"})`;
  }));

  const write = (name: string, content: string, append = false) => locked(async () => {
    const file = resolvePath(name);
    const existing = await readText(file);
    checkContent(append ? (existing ?? "") + content : content);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { encoding: "utf8", flag: append ? "a" : "w" });
    return `wrote ${Buffer.byteLength(content)} bytes to ${file}`;
  });
  server.registerTool("write", {
    title: "Write file", description: "Create or completely replace a UTF-8 text file, creating parent directories. Prefer edit for focused changes.",
    inputSchema: { path: filePath, content: z.string() }, annotations,
  }, ({ path: name, content }) => write(name, content));
  server.registerTool("write_file", {
    title: "Write file", description: "Create or overwrite a UTF-8 text file (parent directories are created). Set append to add instead.",
    inputSchema: { path: filePath, content: z.string(), append: z.boolean().optional() }, annotations,
  }, ({ path: name, content, append }) => write(name, content, append));
  server.registerTool("patch", {
    title: "Apply patch",
    description: "Apply an OpenCode-style multi-file patch. patchText starts with *** Begin Patch and ends with *** End Patch. " +
      "Use *** Add File: path (all content lines prefixed +), *** Delete File: path, or *** Update File: path " +
      "with optional *** Move to: path, then @@ hunks containing space-prefixed context, - removals and + additions. " +
      "@@ exact anchor line skips to that line; *** End of File anchors a hunk at EOF. Context must match exactly " +
      "(LF/CRLF normalized); no fuzzy matching or unified-diff line-number headers. All paths and hunks are validated before writes. " +
      "Adds and moves never overwrite existing files. Each path may occur only once. Updates preserve newline style and final newline. " +
      "Filesystem failures can leave partial changes; inspect files before retrying. Text files only, maximum 16 MiB each; symlink targets rejected.",
    inputSchema: { patchText: z.string().min(1) }, annotations,
  }, ({ patchText }) => locked(() => applyPatch(patchText)));
}
