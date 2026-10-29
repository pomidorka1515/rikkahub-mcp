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
import type { JobStatus } from "../jobs.js";

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
  for (const name of ["execute", "grep", "glob", "shell_open", "shell_open_root", "shell_list", "shell_send", "shell_read", "shell_interrupt", "job_list", "job_output", "job_wait", "job_kill", "project_list"]) assert.ok(names.includes(name));
  for (const [name, key] of [["job_list", "jobs"], ["shell_list", "shells"], ["project_list", "projects"]] as const) {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: {} }));
    const text = result.content[0];
    assert.equal(text?.type, "text");
    assert.deepEqual(JSON.parse(text!.type === "text" ? text!.text : "")[key], []);
  }
  const executed = CallToolResultSchema.parse(await client.callTool({
    name: "execute", arguments: { code: '(await tools.run_command({command:"echo execute-http"})).content[0].text' },
  }));
  assert.ok(!executed.isError, JSON.stringify(executed));
  assert.match(executed.content[0]!.type === "text" ? executed.content[0]!.text : "", /execute-http/);
  const opened = CallToolResultSchema.parse(await client.callTool({ name: "shell_open", arguments: {} }));
  const first = opened.content[0];
  assert.equal(first?.type, "text");
  const shell = JSON.parse(first!.type === "text" ? first!.text : "") as ShellSnapshot;
  const started = CallToolResultSchema.parse(await client.callTool({
    name: "run_command", arguments: { command: "echo ready; sleep 30", background: true },
  }));
  assert.ok(!started.isError);
  const jobText = started.content[0];
  const job = JSON.parse(jobText!.type === "text" ? jobText!.text : "") as JobStatus;
  assert.equal(job.state, "running");
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
  const json = (result: ReturnType<typeof CallToolResultSchema.parse>) => {
    assert.ok(!result.isError, JSON.stringify(result));
    const text = result.content[0];
    assert.equal(text?.type, "text");
    return JSON.parse(text!.type === "text" ? text!.text : "");
  };
  const listedJob = json(await call("job_list", {})).jobs.find((item: JobStatus) => item.id === job.id);
  assert.equal(listedJob.state, "running");
  assert.equal(listedJob.command, "echo ready; sleep 30");
  const listedShell = json(await call("shell_list", {})).shells.find((item: ShellSnapshot) => item.shell_id === shell.shell_id);
  assert.equal(listedShell.state, "idle");
  assert.equal(listedShell.root, false);
  assert.ok(listedShell.initial_cwd);
  assert.deepEqual(json(await call("execute", { code: "JSON.parse((await tools.shell_list({})).content[0].text).shells.map(s => s.shell_id)" })), [shell.shell_id]);
  for (const command of ["sudo id", "su -c id", "/system/bin/tsu", "true; s'u'do id"]) {
    for (const background of [false, true]) {
      const blocked = await call("run_command", { command, background });
      assert.ok(blocked.isError);
      assert.match(blocked.content[0]!.type === "text" ? blocked.content[0]!.text : "", /blocked/);
    }
    assert.ok((await call("shell_send", { shell_id: shell.shell_id, cmd: command })).isError);
  }
  assert.ok((await call("shell_open", { env: { BASH_ENV: "$(tsu)" } })).isError);
  const benign = "printf '%s' 'sudo su tsu'";
  for (const background of [false, true]) {
    const result = await call("run_command", { command: benign, background, env: { POLICY_DATA: "sudo su tsu" } });
    assert.ok(!result.isError, JSON.stringify(result));
    if (background) {
      const benignJob = json(result) as JobStatus;
      assert.equal(json(await call("job_wait", { ids: [benignJob.id], wait_ms: 5000 })).ready, true);
      assert.equal(json(await call("job_output", { id: benignJob.id })).output, "sudo su tsu");
    } else {
      assert.match(result.content[0]!.type === "text" ? result.content[0]!.text : "", /sudo su tsu/);
    }
  }
  assert.equal(snapshot(await call("shell_send", { shell_id: shell.shell_id, cmd: benign, wait_ms: 1000 })).output, "sudo su tsu");
  const dataShell = snapshot(await call("shell_open", { env: { POLICY_DATA: "sudo su tsu" } }));
  assert.equal(snapshot(await call("shell_send", { shell_id: dataShell.shell_id, cmd: 'printf "%s" "$POLICY_DATA"', wait_ms: 1000 })).output, "sudo su tsu");
  snapshot(await call("shell_send", { shell_id: dataShell.shell_id, cmd: "exit", wait_ms: 1000 }));
  assert.equal(json(await call("shell_list", {})).shells.find((item: ShellSnapshot) => item.shell_id === dataShell.shell_id).state, "exited");
  const blockedExecute = json(await call("execute", {
    code: '(await tools.run_command({command:"tsu"})).isError',
  }));
  assert.equal(blockedExecute, true);
  assert.equal(json(await call("job_wait", { ids: [job.id], wait_ms: 20 })).ready, false);
  const viaExecute = json(await call("execute", {
    code: `JSON.parse((await tools.job_wait({ids:[${JSON.stringify(job.id)}],wait_ms:0})).content[0].text).ready`,
  }));
  assert.equal(viaExecute, false);
  for (let i = 0; i < 2; i++) {
    assert.equal(json(await call("job_output", { id: job.id, lines: 1, peek: true })).output, "ready\n");
  }
  assert.equal(json(await call("job_output", { id: job.id, lines: 1 })).output, "ready\n");
  assert.equal(json(await call("job_output", { id: job.id, peek: true })).output, "");
  assert.ok((await call("job_output", { id: "missing" })).isError);
  assert.ok((await call("job_wait", { ids: [] })).isError);
  assert.ok((await call("job_wait", { ids: [job.id], wait_ms: 30001 })).isError);
  assert.ok((await call("run_command", { command: "true", background: true, cwd: "/nonexistent-job-cwd" })).isError);
  // No Mcp-Session-Id: each request builds a separate MCP server instance.
  const sent = snapshot(await call("shell_send", { shell_id: shell.shell_id, cmd: "export RECONNECT_TEST=yes; sleep 30", wait_ms: 50 }));
  assert.equal(sent.state, "running");
  assert.equal(json(await call("shell_list", {})).shells.find((item: ShellSnapshot) => item.shell_id === shell.shell_id).state, "running");
  assert.ok((await call("shell_send", { shell_id: shell.shell_id, cmd: "echo busy" })).isError);
  assert.equal(snapshot(await call("shell_interrupt", { shell_id: shell.shell_id })).state, "idle");
  assert.ok((await call("shell_read", { shell_id: "missing" })).isError);
  const manyLines = "printf 'line\\n%.0s' {1..103}";
  const preview = snapshot(await call("shell_send", { shell_id: shell.shell_id, cmd: manyLines, wait_ms: 1000 }));
  assert.equal(preview.output, "line\n".repeat(100));
  for (let i = 0; i < 2; i++) {
    const peek = snapshot(await call("shell_read", { shell_id: shell.shell_id, lines: 1, peek: true }));
    assert.equal(peek.output, "line\n");
    assert.equal(peek.buffered_bytes, 15);
  }
  assert.equal(snapshot(await call("shell_read", { shell_id: shell.shell_id })).output, "line\n".repeat(3));

  const sse = new Client({ name: "shell-sse-test", version: "1" });
  clients.push(sse);
  await sse.connect(new SSEClientTransport(new URL(`${base}/sse?token=${token}`)));
  assert.equal(json(CallToolResultSchema.parse(await sse.callTool({
    name: "execute", arguments: { code: "6 * 7" },
  }))), 42);
  json(CallToolResultSchema.parse(await sse.callTool({ name: "job_kill", arguments: { id: job.id } })));
  assert.equal(json(await call("job_wait", { ids: [job.id], mode: "all", wait_ms: 5000 })).ready, true);
  const complete = json(await call("run_command", { command: "exit 4", background: true }));
  const waited = json(await call("job_wait", { ids: [job.id, complete.id], wait_ms: 5000 }));
  assert.equal(waited.ready, true);
  assert.equal(waited.jobs[1].exit_code, 4);
  assert.equal(json(await call("job_list", {})).jobs.find((item: JobStatus) => item.id === complete.id).state, "exited");
  const foreground = await call("run_command", { command: "echo foreground" });
  assert.ok(!foreground.isError);
  assert.match(foreground.content[0]!.type === "text" ? foreground.content[0]!.text : "", /foreground/);
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
