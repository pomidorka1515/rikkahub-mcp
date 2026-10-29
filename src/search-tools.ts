import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { z } from "zod";
import picomatch from "picomatch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const searchPath = (value = process.cwd()): string => path.resolve(
  value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value,
);

/** run rg directly, never through a shell. bound output even for huge searches */
function search(args: string[], separator: string, limit: number, maxBytes: number,
  format: (record: string) => string | undefined): Promise<CallToolResult> {
  return new Promise((resolve) => {
    const child = spawn("rg", ["--no-config", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const rows: string[] = [];
    let pending = Buffer.alloc(0);
    let bytes = 0;
    let stderr = "";
    let stopped = false;
    let failure: string | undefined;
    const stop = () => { stopped = true; child.kill("SIGKILL"); };
    const timer = setTimeout(() => { failure = "Search timed out after 30 seconds."; stop(); }, 30_000);
    const consume = (record: string) => {
      if (stopped || !record) return;
      try {
        const row = format(record);
        if (row === undefined) return;
        if (rows.length >= limit || bytes + Buffer.byteLength(row) > maxBytes) { stop(); return; }
        rows.push(row);
        bytes += Buffer.byteLength(row) + 1;
      } catch (error) {
        failure = `Could not parse ripgrep output: ${String(error)}`;
        stop();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      pending = Buffer.concat([pending, chunk]);
      let end: number;
      while (!stopped && (end = pending.indexOf(separator)) !== -1) {
        consume(pending.subarray(0, end).toString("utf8"));
        pending = pending.subarray(end + 1);
      }
      // a single pathological match must not exhaust server memory.
      if (pending.length > 2 * 1024 * 1024) stop();
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(0, 8192); });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ content: [{ type: "text", text: `Could not run ripgrep: ${error.message}. Install it with pkg install ripgrep.` }], isError: true });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (pending.length && !stopped) consume(pending.toString("utf8"));
      const error = failure || (!stopped && code !== 0 && code !== 1 ? stderr.trim() || `ripgrep exited with code ${code}` : undefined);
      const text = error || [
        rows.join("\n") || (stopped ? "" : "No matches found."),
        stopped ? "[Results truncated. Narrow the search path or pattern, or increase limit.]" : "",
        !stopped && stderr.trim() ? `[Search warning: ${stderr.trim()}]` : "",
      ].filter(Boolean).join("\n");
      resolve({ content: [{ type: "text", text }], ...(error ? { isError: true } : {}) });
    });
  });
}

export function registerSearchTools(server: McpServer, maxBytes: number): void {
  const resultLimit = z.number().int().positive().optional();
  server.registerTool("glob", {
    title: "Glob",
    description: 'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.tsx").',
    inputSchema: {
      hidden: z.boolean().optional().describe("Include hidden files and directories (default: false)."),
      limit: resultLimit.describe("Maximum number of matching files to return (default: 100)"),
      path: z.string().optional().describe("Directory to search. Defaults to the current working directory."),
      pattern: z.string().describe("Glob pattern to match files against"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ hidden, limit, path: dir, pattern }) => {
    const root = searchPath(dir);
    try {
      if (!(await stat(root)).isDirectory()) throw new Error(`Not a directory: ${root}`);
      const matches = picomatch(pattern, { dot: hidden ?? false, basename: !pattern.includes("/") });
      return await search(["--files", "--null", ...(hidden ? ["--hidden"] : []), "--", root],
        "\0", limit ?? 100, maxBytes, (file) => matches(path.relative(root, file)) ? file : undefined);
    } catch (error) {
      return { content: [{ type: "text", text: String(error) }], isError: true };
    }
  });
  server.registerTool("grep", {
    title: "Grep",
    description: "Search file contents using ripgrep's regular expression syntax or literal text matching. " +
      "Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. " +
      "Returns matching file paths, line numbers, and line previews.",
    inputSchema: {
      caseSensitive: z.boolean().optional().describe("Use case-sensitive matching (default: true)."),
      include: z.string().optional().describe('Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")'),
      limit: resultLimit.describe("Maximum number of matching lines to return (default: 100)"),
      literal: z.boolean().optional().describe("Treat `pattern` as exact text instead of a regular expression (default: false)."),
      path: z.string().optional().describe("File or directory to search. Defaults to the current working directory."),
      pattern: z.string().min(1).describe("Regular expression or literal text to match in file contents."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ caseSensitive, include, limit, literal, path: dir, pattern }) => {
    const root = searchPath(dir);
    try {
      const info = await stat(root);
      if (!info.isFile() && !info.isDirectory()) throw new Error(`Not a file or directory: ${root}`);
      return await search(["--json", "--color", "never", caseSensitive === false ? "--ignore-case" : "--case-sensitive",
        ...(literal ? ["--fixed-strings"] : []), ...(include === undefined ? [] : ["--type-add", `mcpinclude:${include}`, "--type", "mcpinclude"]), "--", pattern, root],
      "\n", limit ?? 100, maxBytes, (record) => {
        const event = JSON.parse(record);
        if (event.type !== "match") return undefined;
        const decode = (field: { text?: string; bytes?: string }): string =>
          field.text ?? Buffer.from(field.bytes ?? "", "base64").toString("utf8");
        const preview = decode(event.data.lines).replace(/\r?\n$/, "");
        return `${decode(event.data.path)}:${event.data.line_number}: ${preview.slice(0, 2000)}${preview.length > 2000 ? "…" : ""}`;
      });
    } catch (error) {
      return { content: [{ type: "text", text: String(error) }], isError: true };
    }
  });
}
