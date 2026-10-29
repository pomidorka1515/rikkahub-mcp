import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ShellSnapshot } from "../persistent-shell.js";

// Isolated server: does not restart the user's server or require root.
const probe = net.createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const address = probe.address() as net.AddressInfo;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const token = randomUUID();
const base = `http://127.0.0.1:${address.port}`;
const child = spawn(process.execPath, [new URL("../server.js", import.meta.url).pathname], {
  env: { ...process.env, MCP_HOST: "127.0.0.1", MCP_PORT: String(address.port), MCP_TOKEN: token, MCP_NO_AUTH: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
child.stderr.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
const clients: Client[] = [];
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${logs}`)), 5000);
    child.stdout.on("data", () => {
      if (logs.includes("listening on")) { clearTimeout(timer); resolve(); }
    });
    child.once("error", reject);
    child.once("exit", () => { clearTimeout(timer); reject(new Error(logs)); });
  });
  const headers = { Authorization: `Bearer ${token}` };
  const client = new Client({ name: "shell-test", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ["grep", "glob", "shell_open", "shell_send", "shell_read", "shell_interrupt"]) assert.ok(names.includes(name));
  const opened = CallToolResultSchema.parse(await client.callTool({ name: "shell_open", arguments: {} }));
  const first = opened.content[0];
  assert.equal(first?.type, "text");
  const shell = JSON.parse(first!.type === "text" ? first!.text : "") as ShellSnapshot;
  await client.close();

  let id = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { result: unknown };
    return CallToolResultSchema.parse(body.result);
  };
  const snapshot = (result: ReturnType<typeof CallToolResultSchema.parse>): ShellSnapshot => {
    assert.ok(!result.isError, JSON.stringify(result));
    const text = result.content[0];
    assert.equal(text?.type, "text");
    return JSON.parse(text!.type === "text" ? text!.text : "") as ShellSnapshot;
  };
  // No Mcp-Session-Id: each request builds a separate MCP server instance.
  const sent = snapshot(await call("shell_send", { shell_id: shell.shell_id, cmd: "export RECONNECT_TEST=yes; sleep 30", wait_ms: 50 }));
  assert.equal(sent.state, "running");
  assert.ok((await call("shell_send", { shell_id: shell.shell_id, cmd: "echo busy" })).isError);
  assert.equal(snapshot(await call("shell_interrupt", { shell_id: shell.shell_id })).state, "idle");
  assert.ok((await call("shell_read", { shell_id: "missing" })).isError);

  const sse = new Client({ name: "shell-sse-test", version: "1" });
  clients.push(sse);
  await sse.connect(new SSEClientTransport(new URL(`${base}/sse?token=${token}`)));
  const continued = snapshot(CallToolResultSchema.parse(await sse.callTool({
    name: "shell_send", arguments: { shell_id: shell.shell_id, cmd: "echo $RECONNECT_TEST" },
  })));
  assert.equal(continued.output, "yes\n");
  snapshot(await call("shell_send", { shell_id: shell.shell_id, cmd: "sleep 30", wait_ms: 50 }));
  // Graceful server shutdown must also terminate its persistent process groups.
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  console.log("persistent shell MCP tests passed (HTTP, stateless, SSE, reconnect, shutdown)");
} finally {
  for (const client of clients) await client.close().catch(() => {});
  child.kill("SIGTERM");
}
