import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const temporary = await mkdtemp(path.join(os.tmpdir(), "mcp-output-http-"));
const probe = net.createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = (probe.address() as net.AddressInfo).port;
await new Promise<void>(resolve => probe.close(() => resolve()));
const token = randomUUID();
const child = spawn(process.execPath, [new URL("../server.js", import.meta.url).pathname], {
  env: { ...process.env, XDG_CACHE_HOME: temporary, MCP_PORT: String(port), MCP_HOST: "127.0.0.1",
    MCP_TOKEN: token, MCP_NO_AUTH: "0", MCP_MAX_OUTPUT_BYTES: "1024" },
  stdio: ["ignore", "pipe", "pipe"],
});
const closed = once(child, "close");
let logs = "";
child.stdout.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
child.stderr.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
const client = new Client({ name: "output-test", version: "1" });
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server startup timed out: ${logs}`)), 5000);
    child.stdout.on("data", () => { if (logs.includes("listening on")) { clearTimeout(timer); resolve(); } });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(logs)); });
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const call = async (name: string, args: Record<string, unknown>, error = false): Promise<string> => {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    const text = result.content.map(item => item.type === "text" ? item.text : "").join("\n");
    assert.equal(Boolean(result.isError), error, text);
    return text;
  };
  const files = (text: string): string[] => [...text.matchAll(/\noutput_path: (.+)\n/g)].map(match => match[1]!);
  const small = await call("run_command", { command: "printf small" });
  assert.deepEqual(files(small), []);
  assert.ok(!small.includes("truncated"));

  const output = await call("run_command", {
    command: "printf 'line\\n%.0s' {1..1000}; printf 'last 雪\\n'; printf 'err\\n%.0s' {1..1000} >&2",
  });
  const paths = files(output);
  assert.equal(paths.length, 2);
  assert.equal(await readFile(paths[0]!, "utf8"), "line\n".repeat(1000) + "last 雪\n");
  assert.equal(await readFile(paths[1]!, "utf8"), "err\n".repeat(1000));
  assert.match(await call("read_file", { path: paths[0], offset: 1001, limit: 1 }), /last 雪/);
  assert.match(await call("grep", { path: paths[0], pattern: "last", literal: true }), /1001: last 雪/);
  assert.match(await call("run_command", { command: `tail -n 1 '${paths[0]}'` }), /last 雪/);

  const failed = await call("run_command", { command: "printf '%3000s' x; exit 7" }, true);
  assert.match(failed, /exit: 7/);
  assert.equal(await readFile(files(failed)[0]!, "utf8"), " ".repeat(2999) + "x");
  const timed = await call("run_command", { command: "printf '%3000s' x; sleep 30", timeout_ms: 100 }, true);
  assert.match(timed, /timed out/);
  assert.equal(await readFile(files(timed)[0]!, "utf8"), " ".repeat(2999) + "x");
  console.log("recoverable command output MCP tests passed");
} finally {
  await client.close();
  child.kill("SIGTERM");
  await closed;
  await rm(temporary, { recursive: true, force: true });
}
