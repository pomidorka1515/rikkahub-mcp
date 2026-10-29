import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isUtf8 } from "node:buffer";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ProjectContext, projectIdSchema } from "./projects.js";

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_PAGE_BYTES = 50 * 1024;
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/** identify media by signature before falling back to known binary extensions. */
function attachmentType(head: Buffer, file: string): string | undefined {
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (/^GIF8[79]a/.test(head.toString("ascii", 0, 6))) return "image/gif";
  if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (head.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  const types: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
    ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
    ".svg": "image/svg+xml", ".ico": "image/vnd.microsoft.icon",
    ".pdf": "application/pdf", ".zip": "application/zip", ".gz": "application/gzip",
    ".doc": "application/msword", ".xls": "application/vnd.ms-excel",
    ".ppt": "application/vnd.ms-powerpoint",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".flac": "audio/flac", ".mp4": "video/mp4", ".webm": "video/webm",
  };
  return types[path.extname(file).toLowerCase()] ??
    (head.includes(0) || !isUtf8(head) ? "application/octet-stream" : undefined);
}

/** never return a partial attachment or buffer an unbounded growing file. */
async function readAttachment(file: string, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    const data = chunk as Buffer;
    size += data.length;
    if (size > cap) throw new Error(`attachment exceeds ${cap} byte limit; attachments cannot be paginated`);
    chunks.push(data);
  }
  return Buffer.concat(chunks, size);
}

/** stream lines without retaining arbitrarily large individual lines. */
async function* textLines(file: string, size: number): AsyncGenerator<string> {
  if (!size) return;
  const stream = fs.createReadStream(file, { encoding: "utf8", end: size - 1 });
  const deadline = Date.now() + 30_000;
  let head = "";
  let length = 0;
  let last = "";
  const finish = (): string => {
    const size = length - (last === "\r" ? 1 : 0);
    const text = Array.from(head).slice(0, Math.min(size, MAX_LINE_CHARS)).join("");
    return size > MAX_LINE_CHARS ? `${text}…[line truncated]` : text;
  };
  try {
    for await (const chunk of stream) {
      if (Date.now() > deadline) throw new Error("text scan timed out after 30 seconds; narrow the read or search");
      for (const char of String(chunk)) {
        if (char === "\0") throw new Error("binary data detected beyond the file type probe; cannot read this file as text");
        if (char === "\n") {
          yield finish();
          head = "";
          length = 0;
          last = "";
        } else {
          if (length < MAX_LINE_CHARS) head += char;
          length++;
          last = char;
        }
      }
    }
    if (length) yield finish();
  } finally {
    stream.destroy();
  }
}

export function registerReadTool(server: McpServer, maxOutputBytes: number, context = new ProjectContext()): void {
  server.registerTool("read_file", {
    title: "Read file",
    description: "Read text, images, PDFs and other files. Text uses 1-based line numbers; use offset and limit to page through text. " +
      "tail returns the last N text lines; count_only returns only the total line count. Both scan the file (30 second limit), not follow it. " +
      "Defaults to at most 2000 lines and 50 KiB per page; lines longer than 2000 characters are shortened. " +
      "Images return MCP image blocks; PDFs and other binary files return embedded resource blobs (client support required). " +
      "Call directly, not through execute, to receive attachments. Attachments are limited to 32 MiB and cannot be paginated. " +
      "max_bytes can lower the text page or attachment byte cap.",
    inputSchema: {
      project_id: projectIdSchema,
      path: z.string().describe("File path, absolute or relative to the selected project (otherwise server working directory); ~ is expanded"),
      offset: z.number().int().min(1).optional().describe("First line to read, 1-based (default 1)"),
      limit: z.number().int().min(1).max(MAX_LINES).optional().describe("Maximum lines to return (default 2000)"),
      tail: z.number().int().min(1).max(MAX_LINES).optional().describe("Return the last N text lines with original line numbers; cannot combine with offset or limit."),
      count_only: z.boolean().optional().describe("Return only the text line count; cannot combine with offset, limit or tail."),
      max_bytes: z.number().int().positive().optional().describe("Optional lower text page or attachment byte cap (raw bytes, before base64)"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ path: input, offset, limit, max_bytes, project_id, tail, count_only }): Promise<CallToolResult> => {
    try {
      if (tail !== undefined && (offset !== undefined || limit !== undefined)) throw new Error("tail cannot be combined with offset or limit");
      if (count_only && (offset !== undefined || limit !== undefined || tail !== undefined)) throw new Error("count_only cannot be combined with offset, limit or tail");
      const file = context.resolve(input, project_id);
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw new Error("path is not a regular file");
      const handle = await fsp.open(file, "r");
      let head: Buffer;
      try {
        const probe = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
        // exclude a potentially incomplete utf-8 character at the probe boundary.
        head = probe.subarray(0, bytesRead);
        if (stat.size > bytesRead) {
          for (let trim = 0; trim <= 3; trim++) {
            const prefix = head.subarray(0, head.length - trim);
            if (isUtf8(prefix)) { head = prefix; break; }
          }
        }
      } finally {
        await handle.close();
      }
      const mimeType = attachmentType(head, file);
      if (mimeType) {
        if (offset !== undefined || limit !== undefined || tail !== undefined || count_only) throw new Error("offset, limit, tail and count_only are only supported for text files; omit them to read an attachment");
        const cap = Math.min(max_bytes ?? MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES);
        if (stat.size > cap) throw new Error(`attachment exceeds ${cap} byte limit; attachments cannot be paginated`);
        const data = (await readAttachment(file, cap)).toString("base64");
        return { content: [mimeType.startsWith("image/")
          ? { type: "image", data, mimeType }
          : { type: "resource", resource: { uri: pathToFileURL(file).href, mimeType, blob: data } }] };
      }
      offset ??= 1;
      limit ??= MAX_LINES;
      const cap = Math.min(max_bytes ?? MAX_PAGE_BYTES, MAX_PAGE_BYTES, maxOutputBytes);
      const rows: string[] = [];
      let bytes = 0;
      let line = 0;
      let next: number | undefined;
      let source: AsyncIterable<string> = textLines(file, stat.size);
      let total: number | undefined;
      if (tail !== undefined || count_only) {
        const retained: string[] = [];
        total = 0;
        for await (const text of source) {
          if (tail !== undefined) retained[total % tail] = text;
          total++;
        }
        if (count_only) return { content: [{ type: "text", text: `${file}\n[total_lines=${total}]` }] };
        const length = Math.min(total, tail!);
        line = total - length;
        source = (async function* () {
          for (let i = 0; i < length; i++) yield retained[(total! - length + i) % tail!]!;
        })();
      }
      for await (const text of source) {
        line++;
        if (line < offset) continue;
        const row = `${line}: ${text}`;
        const size = Buffer.byteLength(row) + (rows.length ? 1 : 0);
        if (rows.length >= limit || bytes + size > cap) {
          if (!rows.length) {
            // preserve progress even with a byte cap smaller than one line.
            const partial = Buffer.from(row).subarray(0, cap).toString("utf8").replace(/\uFFFD$/, "");
            rows.push(partial + "…[line truncated by byte cap]");
            next = line + 1;
          } else next = line;
          break;
        }
        rows.push(row);
        bytes += size;
      }
      if (!rows.length && offset > line && !(line === 0 && offset === 1)) {
        throw new Error(`offset ${offset} is beyond end of file (${line} lines)`);
      }
      const footer = next === undefined ? "[end of file]" : `[page truncated; continue with offset=${next}]`;
      return { content: [{ type: "text", text: `${file}\n${rows.join("\n")}\n${footer}${total === undefined ? "" : `\n[total_lines=${total}]`}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
}
