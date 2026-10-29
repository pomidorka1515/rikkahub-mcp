import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { requireRootAccess, rootOutput, ROOT_ACCESS_ERROR } from "../root-access.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-screenshot-"));
const originalPath = process.env.PATH;
const state = path.join(dir, "state");
const calls = path.join(dir, "calls");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
const fixture = `#!${process.execPath}
const fs = require('node:fs');
let script = '';
process.stdin.on('data', chunk => script += chunk);
process.stdin.on('end', () => {
  const mode = fs.readFileSync(${JSON.stringify(state)}, 'utf8');
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({script, args: process.argv.slice(2)}) + '\\n');
  if (mode === 'denied') { process.stderr.write('permission denied'); process.exitCode = 1; }
  else if (mode === 'hang') setTimeout(() => {}, 30000);
  else if (mode === 'overflow') process.stdout.write(Buffer.alloc(8192));
  else if (script.trim() === 'id -u') console.log(mode === 'nonroot' ? '2000' : '0');
  else if (script.includes('/system/bin/screencap -p')) {
    if (mode === 'bad') process.stdout.write('not an image');
    else if (mode === 'capture-failure') { process.stderr.write('capture failed'); process.exitCode = 1; }
    else process.stdout.write(Buffer.from(${JSON.stringify(png)}, 'base64'));
  } else console.log('root command executed');
});
`;
await fs.writeFile(path.join(dir, "tsu"), fixture, { mode: 0o700 });
await fs.writeFile(path.join(dir, "sudo"), fixture, { mode: 0o700 });
process.env.PATH = `${dir}:${originalPath}`;
const probe = net.createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = (probe.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const child = spawn(process.execPath, [new URL("../server.js", import.meta.url).pathname], {
  env: { ...process.env, MCP_HOST: "127.0.0.1", MCP_PORT: String(port), MCP_TOKEN: "screenshot-test", MCP_NO_AUTH: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
child.stderr.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(logs || "server startup timed out")), 10_000);
    child.stdout.on("data", () => {
      if (logs.includes("listening on")) { clearTimeout(timer); resolve(); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(logs)); });
  });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer screenshot-test", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200);
    return CallToolResultSchema.parse((await response.json() as { result: unknown }).result);
  };
  for (const mode of ["denied", "nonroot"]) {
    await fs.writeFile(state, mode);
    await fs.writeFile(calls, "");
    for (const [name, args] of [
      ["screenshot", {}],
      ["run_root_command", { command: "must not execute" }],
      ["run_root_command", { command: "must not execute", preserve_env: true }],
    ] as const) {
      const result = await call(name, args);
      assert.equal(result.isError, true);
      assert.deepEqual(result.content, [{ type: "text", text: ROOT_ACCESS_ERROR }]);
    }
    const recorded = await fs.readFile(calls, "utf8");
    assert.ok(!recorded.includes("must not execute"));
    assert.ok(!recorded.includes("screencap"));
  }
  await fs.writeFile(state, "ok");
  const result = await call("screenshot");
  assert.ok(!result.isError);
  assert.deepEqual(result.content, [{ type: "image", data: png, mimeType: "image/png" }]);
  for (const preserve_env of [false, true]) {
    const root = await call("run_root_command", { command: "echo success", preserve_env });
    assert.ok(!root.isError, JSON.stringify(root));
  }
  for (const mode of ["bad", "capture-failure"]) {
    await fs.writeFile(state, mode);
    const error = await call("screenshot");
    assert.equal(error.isError, true);
    assert.match(JSON.stringify(error), mode === "bad" ? /valid PNG/ : /capture failed/);
  }
  await fs.writeFile(state, "overflow");
  await assert.rejects(rootOutput("anything", "tsu", 1000, 32), /byte limit/);
  await fs.writeFile(state, "hang");
  await assert.rejects(rootOutput("anything", "tsu", 100), /timed out/);
  process.env.PATH = dir + "/missing";
  await assert.rejects(requireRootAccess(), new RegExp(ROOT_ACCESS_ERROR));
  console.log("screenshot and root tests passed (image bytes, denied/missing root, both root modes, errors, limits, timeout)");
} finally {
  process.env.PATH = originalPath;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  await fs.rm(dir, { recursive: true, force: true });
}
