import fs from "node:fs";
import fsp from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ProjectContext, projectIdSchema } from "./projects.js";

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_PAGE_BYTES = 50 * 1024;

/** stream lines without retaining arbitrarily large individual lines. */
async function* textLines(file: string): AsyncGenerator<string> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
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
      for (const char of String(chunk)) {
        if (char === "\0") throw new Error("binary files are not supported by read_file");
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
    description: "Read a UTF-8 text file with 1-based line numbers. Use offset and limit to page through files. " +
      "Defaults to at most 2000 lines and 50 KiB per page; lines longer than 2000 characters are shortened. " +
      "Images, PDFs and other binary files are not supported. max_bytes can lower the page byte cap.",
    inputSchema: {
      project_id: projectIdSchema,
      path: z.string().describe("File path, absolute or relative to the selected project (otherwise server working directory); ~ is expanded"),
      offset: z.number().int().min(1).optional().describe("First line to read, 1-based (default 1)"),
      limit: z.number().int().min(1).max(MAX_LINES).optional().describe("Maximum lines to return (default 2000)"),
      max_bytes: z.number().int().positive().optional().describe("Optional lower page byte cap"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ path: input, offset = 1, limit = MAX_LINES, max_bytes, project_id }): Promise<CallToolResult> => {
    try {
      const file = context.resolve(input, project_id);
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw new Error("path is not a regular file");
      const cap = Math.min(max_bytes ?? MAX_PAGE_BYTES, MAX_PAGE_BYTES, maxOutputBytes);
      const rows: string[] = [];
      let bytes = 0;
      let line = 0;
      let next: number | undefined;
      for await (const text of textLines(file)) {
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
      return { content: [{ type: "text", text: `${file}\n${rows.join("\n")}\n${footer}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
}
