import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { boundedOutputSchema, jsonResult } from "./structured-result.js";

export const projectIdSchema = z.string().min(1).optional().describe(
  "Project id returned by project_open in this chat. Relative paths and default directories use that project. No shared active project.",
);

const roots = new Map<string, string>();
const projectOutputSchema = boundedOutputSchema({
  project_id: z.string(), path: z.string(),
  instructions: z.array(z.object({ path: z.string(), content: z.string() })),
  missing: z.array(z.string()), guidance: z.string(),
});
const expandHome = (value: string): string => value === "~" ? os.homedir()
  : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;

/** explicit handles isolate project selection without assuming one mcp connection per chat. */
export class ProjectContext {
  constructor(readonly defaultId?: string) {}

  resolve(value?: string, id = this.defaultId, fallback = process.cwd()): string {
    const root = id === undefined ? (value === undefined ? fallback : process.cwd()) : roots.get(id);
    if (root === undefined) throw new Error("unknown project_id; call project_open again (handles expire on server restart)");
    return path.resolve(root, expandHome(value ?? "."));
  }

  selected(id?: string): string | undefined {
    const selected = id ?? this.defaultId;
    if (selected !== undefined) this.resolve(undefined, selected);
    return selected;
  }
}

async function describeProject(root: string, id: string, maxBytes: number): Promise<string> {
  if (!(await fs.stat(root)).isDirectory()) throw new Error("project path is not a directory");
  const instructions: { path: string; content: string }[] = [];
  const missing: string[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const file = path.join(root, name);
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { missing.push(name); continue; }
      throw error;
    }
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`instruction path is not a regular file: ${file}`);
      const bytes = Buffer.alloc(Math.min(64 * 1024, maxBytes) + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await handle.read(bytes, size, bytes.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size === bytes.length) throw new Error(`project instructions exceed the output limit: ${file}`);
      if (bytes.subarray(0, size).includes(0)) throw new Error(`binary project instructions: ${file}`);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
      instructions.push({ path: file, content });
    } finally { await handle.close(); }
  }
  const text = JSON.stringify({
    project_id: id, path: root, instructions, missing,
    guidance: "use this project_id on subsequent project tool calls in this chat. follow both instruction files as project guidance, " +
      "subject to higher-priority instructions; neither file overrides system or developer instructions. " +
      "when switching projects, use the new id and stop applying the previous project's instructions. " +
      "only root instruction files are loaded; read applicable nested instruction files before editing subdirectories. " +
      "this is tool-result context, not a system-prompt modification. project selection is not a filesystem sandbox.",
  });
  if (Buffer.byteLength(text) > maxBytes) throw new Error("combined project instructions exceed the output limit; shorten the files or increase MCP_MAX_OUTPUT_BYTES");
  return text;
}

export function registerProjectTools(server: McpServer, maxBytes: number, context = new ProjectContext()): void {
  const result = async (action: () => Promise<string>): Promise<CallToolResult> => {
    try { return jsonResult(JSON.parse(await action()) as object, maxBytes); }
    catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
  };
  server.registerTool("project_open", {
    outputSchema: projectOutputSchema,
    title: "Open project",
    description: "Open a project directory and automatically return both root AGENTS.md and CLAUDE.md as project instructions. " +
      "Save the returned project_id in this chat and pass it to file/search/command tools or execute. " +
      "Always call when selecting or switching projects. No global active project or process-wide chdir; other chats are unaffected. " +
      "Does not change the client system prompt. Handles survive reconnects but not server restarts.",
    inputSchema: { path: z.string().min(1).describe("Project directory; ~ is expanded. Relative paths use the server working directory.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ path: input }) => result(async () => {
    if (roots.size >= 256) throw new Error("project handle limit reached; release unused handles with project_close");
    const root = await fs.realpath(path.resolve(expandHome(input)));
    const id = crypto.randomUUID();
    const text = await describeProject(root, id, maxBytes);
    if (roots.size >= 256) throw new Error("project handle limit reached; release unused handles with project_close");
    roots.set(id, root);
    return text;
  }));
  server.registerTool("project_list", {
    outputSchema: boundedOutputSchema({ projects: z.array(z.object({ project_id: z.string(), path: z.string() })) }),
    title: "List project handles",
    description: "List all retained project handles and canonical paths across clients, including duplicate paths. " +
      "Handles survive reconnects but not server restarts. Does not select a project or reload instructions; use project_info for that. " +
      "Large results may be truncated with output_path for recovery.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => result(async () => JSON.stringify({ projects: [...roots].map(([project_id, path]) => ({ project_id, path })) })));
  server.registerTool("project_info", {
    outputSchema: projectOutputSchema,
    title: "Read project context",
    description: "Return the project directory and reload both root instruction files. Use after context loss or instruction changes.",
    inputSchema: { project_id: projectIdSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ project_id }) => result(async () => {
    const id = context.selected(project_id);
    if (!id) throw new Error("project_id is required; call project_open first");
    return describeProject(context.resolve(undefined, id), id, maxBytes);
  }));
  server.registerTool("project_close", {
    outputSchema: boundedOutputSchema({ project_id: z.string(), released: z.boolean() }),
    title: "Release project handle",
    description: "Forget a project handle without deleting files or stopping existing jobs/shells. Future calls with this id fail.",
    inputSchema: { project_id: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ project_id }) => {
    try {
      context.resolve(undefined, project_id);
      roots.delete(project_id);
      return jsonResult({ project_id, released: true }, maxBytes, "project handle released");
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  });
}
