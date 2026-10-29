import { spawn } from "node:child_process";
import path from "node:path";
import { stat } from "node:fs/promises";
import { z } from "zod";
import picomatch from "picomatch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ProjectContext, projectIdSchema } from "./projects.js";

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

export function registerSearchTools(server: McpServer, maxBytes: number, context = new ProjectContext()): void {
  const resultLimit = z.number().int().positive().optional();
  server.registerTool("glob", {
    title: "Glob",
    description: 'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.tsx"). Results are sorted lexicographically by path before applying limits.',
    inputSchema: {
      project_id: projectIdSchema,
      hidden: z.boolean().optional().describe("Include hidden files and directories (default: false)."),
      limit: resultLimit.describe("Maximum number of matching files to return (default: 100)"),
      path: z.string().optional().describe("Directory to search. Defaults to the current working directory."),
      pattern: z.string().describe("Glob pattern to match files against"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ hidden, limit, path: dir, pattern, project_id }) => {
    try {
      const root = context.resolve(dir, project_id);
      if (!(await stat(root)).isDirectory()) throw new Error(`Not a directory: ${root}`);
      const matches = picomatch(pattern, { dot: hidden ?? false, basename: !pattern.includes("/") });
      return await search(["--files", "--null", "--sort", "path", ...(hidden ? ["--hidden"] : []), "--", root],
        "\0", limit ?? 100, maxBytes, (file) => matches(path.relative(root, file)) ? file : undefined);
    } catch (error) {
      return { content: [{ type: "text", text: String(error) }], isError: true };
    }
  });
  server.registerTool("grep", {
    title: "Grep",
    description: "Search file contents using ripgrep's regular expression syntax or literal text matching. " +
      "Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. " +
      "Returns matching file paths, line numbers, and line previews. Optional before/after/context add surrounding lines (marked with - instead of :). Limits count all returned lines, including context.",
    inputSchema: {
      project_id: projectIdSchema,
      caseSensitive: z.boolean().optional().describe("Use case-sensitive matching (default: true)."),
      include: z.string().optional().describe('Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")'),
      limit: resultLimit.describe("Maximum number of result lines, including context (default: 100)"),
      before: z.number().int().min(0).max(2000).optional().describe("Lines before each match (-B); overrides context for this side."),
      after: z.number().int().min(0).max(2000).optional().describe("Lines after each match (-A); overrides context for this side."),
      context: z.number().int().min(0).max(2000).optional().describe("Lines before and after each match (-C; default 0)."),
      literal: z.boolean().optional().describe("Treat `pattern` as exact text instead of a regular expression (default: false)."),
      path: z.string().optional().describe("File or directory to search. Defaults to the current working directory."),
      pattern: z.string().min(1).describe("Regular expression or literal text to match in file contents."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ caseSensitive, include, limit, literal, path: dir, pattern, project_id, before, after, context: surrounding }) => {
    try {
      const root = context.resolve(dir, project_id);
      const info = await stat(root);
      if (!info.isFile() && !info.isDirectory()) throw new Error(`Not a file or directory: ${root}`);
      return await search(["--json", "--color", "never", caseSensitive === false ? "--ignore-case" : "--case-sensitive",
        "--before-context", String(before ?? surrounding ?? 0), "--after-context", String(after ?? surrounding ?? 0),
        ...(literal ? ["--fixed-strings"] : []), ...(include === undefined ? [] : ["--type-add", `mcpinclude:${include}`, "--type", "mcpinclude"]), "--", pattern, root],
      "\n", limit ?? 100, maxBytes, (record) => {
        const event = JSON.parse(record);
        if (event.type !== "match" && event.type !== "context") return undefined;
        const decode = (field: { text?: string; bytes?: string }): string =>
          field.text ?? Buffer.from(field.bytes ?? "", "base64").toString("utf8");
        const preview = decode(event.data.lines).replace(/\r?\n$/, "");
        const separator = event.type === "match" ? ":" : "-";
        return `${decode(event.data.path)}${separator}${event.data.line_number}${separator} ${preview.slice(0, 2000)}${preview.length > 2000 ? "…" : ""}`;
      });
    } catch (error) {
      return { content: [{ type: "text", text: String(error) }], isError: true };
    }
  });
}
