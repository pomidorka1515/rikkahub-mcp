import { Worker } from "node:worker_threads";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { projectIdSchema } from "./projects.js";
import { recoverableText } from "./output-store.js";

const TIMEOUT_MS = 30_000;
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
let active = 0;

async function fetchText(url: string, init: unknown, signal: AbortSignal): Promise<unknown> {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("use an http or https URL without embedded credentials");
  }
  const options = z.object({
    method: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    redirect: z.enum(["follow", "error", "manual"]).optional(),
  }).strict().parse(init);
  const response = await fetch(parsed, { ...options, signal });
  const chunks: Buffer[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_FETCH_BYTES) {
          await reader.cancel();
          throw new Error("response exceeds the 5 MiB download limit");
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
  }
  return {
    ok: response.ok, status: response.status, statusText: response.statusText,
    url: response.url, redirected: response.redirected,
    headers: Object.fromEntries(response.headers), body: Buffer.concat(chunks).toString("utf8"),
  };
}

export async function registerExecuteTool(
  server: McpServer, buildTools: (projectId?: string) => Promise<McpServer>, maxBytes: number,
): Promise<void> {
  // use the sdk transport for normal schema validation and tool error semantics.
  const catalogServer = await buildTools();
  const catalogClient = new Client({ name: "execute-catalog", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  let catalog;
  try {
    await catalogServer.connect(a);
    await catalogClient.connect(b);
    catalog = (await catalogClient.listTools()).tools;
  } finally {
    await catalogClient.close();
    await catalogServer.close();
  }
  const names = catalog.map(tool => tool.name).filter(name => name !== "execute");
  server.registerTool("execute", {
    title: "Execute JavaScript",
    description: "Run JavaScript in a confined QuickJS runtime. Use explicit return or the final top-level expression. " +
      "Await tool calls; use Promise.allSettled for independent calls. tools.<name>(input) returns the raw MCP result " +
      "(content, structuredContent when provided, isError). Tool and schema errors are results; transport errors reject. " +
      "fetch(url, {method?, headers?, body?, redirect?}) supports HTTP(S), returning ok/status/statusText/url/redirected/headers.get/text()/json(). " +
      "No imports, filesystem, process, shell or timers except through tools. Fresh runtime per call; 30s deadline, 32 MiB JS memory. " +
      "Pending work is abandoned on completion; tool side effects are not rolled back. No recursive execute. " +
      "Truncated final output provides output_path to the full serialized result; nested tools may provide their own output paths. " +
      "Set project_id to default nested file/search/command calls to that project; individual nested calls may override it. " +
      "project_open returns a handle but does not change the context of this execution; use its id explicitly or in a later execute call. " +
      "Available tools (exact names and JSON input schemas):\n" +
      catalog.filter(tool => tool.name !== "execute").map(tool => JSON.stringify({
        name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
      })).join("\n"),
    inputSchema: { project_id: projectIdSchema, code: z.string().min(1).max(256 * 1024).describe("JavaScript source; top-level await and return are supported.") },
    annotations: { openWorldHint: true, readOnlyHint: false, destructiveHint: true },
  }, async ({ code, project_id }, extra): Promise<CallToolResult> => {
    if (active >= 4) return { isError: true, content: [{ type: "text", text: "at most 4 execute calls may run concurrently" }] };
    active++;
    const controller = new AbortController();
    const client = new Client({ name: "execute", version: "1" });
    let inner: McpServer | undefined;
    let worker: Worker | undefined;
    let timer: NodeJS.Timeout | undefined;
    const cancel = () => controller.abort();
    extra.signal.addEventListener("abort", cancel, { once: true });
    if (extra.signal.aborted) cancel();
    try {
      inner = await buildTools(project_id);
      const [left, right] = InMemoryTransport.createLinkedPair();
      await inner.connect(left);
      await client.connect(right);
      const value = await new Promise<unknown>((resolve, reject) => {
        const abort = () => reject(new Error("execute cancelled or exceeded the 30s deadline"));
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) { abort(); return; }
        timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        worker = new Worker(new URL("./execute-worker.js", import.meta.url), { workerData: { code, names, timeoutMs: TIMEOUT_MS } });
        worker.on("error", reject);
        worker.on("exit", () => reject(new Error("execute worker exited before returning a result")));
        let calls = 0;
        worker.on("message", async (message) => {
          if (message.done) {
            if (message.error) reject(new Error(message.error));
            else resolve(message.value);
            return;
          }
          if (controller.signal.aborted) return;
          try {
            if (++calls > 256) throw new Error("execute exceeds the 256 host-call limit");
            const args: unknown = JSON.parse(message.args);
            let result: unknown;
            if (message.kind === "fetch") result = await fetchText(message.name, args, controller.signal);
            else {
              if (!names.includes(message.name)) throw new Error("unknown or unavailable tool");
              if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("tool input must be an object");
              result = await client.callTool({ name: message.name, arguments: args as Record<string, unknown> }, undefined, { signal: controller.signal });
            }
            if (!controller.signal.aborted) worker?.postMessage({ id: message.id, value: result });
          } catch (error) {
            if (!controller.signal.aborted) worker?.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
          }
        });
      });
      const text = JSON.stringify(value) ?? "null";
      return { content: [{ type: "text", text: recoverableText(text, maxBytes) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    } finally {
      clearTimeout(timer);
      extra.signal.removeEventListener("abort", cancel);
      controller.abort();
      await worker?.terminate();
      await client.close();
      await inner?.close();
      active--;
    }
  });
}
