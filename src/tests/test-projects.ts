import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { ProjectContext } from "../projects.js";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-projects-"));
const probe = net.createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = (probe.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const token = randomUUID();
const child = spawn(process.execPath, [new URL("../server.js", import.meta.url).pathname], {
  env: { ...process.env, MCP_HOST: "127.0.0.1", MCP_PORT: String(port), MCP_TOKEN: token, MCP_NO_AUTH: "0", MCP_MAX_OUTPUT_BYTES: "131072" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
child.stderr.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server startup timed out: ${logs}`)), 10000);
    child.stdout.on("data", () => {
      if (logs.includes("listening on")) { clearTimeout(timer); resolve(); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(logs)); });
  });
  let requestId = 0;
  // stateless calls deliberately use a fresh mcp server instance each time, as some clients do.
  const call = async (name: string, args: Record<string, unknown>, error = false): Promise<string> => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { result: unknown };
    const result = CallToolResultSchema.parse(body.result);
    assert.equal(Boolean(result.isError), error, JSON.stringify(result));
    return result.content.map(item => item.type === "text" ? item.text : "").join("\n");
  };
  const a = path.join(temp, "project a");
  const b = path.join(temp, "project b");
  await fs.mkdir(a);
  await fs.mkdir(b);
  await fs.mkdir(path.join(a, "nested"));
  await fs.writeFile(path.join(a, "AGENTS.md"), "project a agent rules 雪\n");
  await fs.writeFile(path.join(a, "CLAUDE.md"), "project a claude rules\n");
  await fs.writeFile(path.join(b, "AGENTS.md"), "project b rules\n");
  const openA = JSON.parse(await call("project_open", { path: a }));
  const openB = JSON.parse(await call("project_open", { path: b }));
  assert.equal(openA.path, await fs.realpath(a));
  assert.equal(openA.instructions.length, 2);
  assert.equal(openA.instructions[0].content, "project a agent rules 雪\n");
  assert.equal(openA.instructions[1].content, "project a claude rules\n");
  assert.deepEqual(openB.missing, ["CLAUDE.md"]);
  assert.notEqual(openA.project_id, openB.project_id);
  const aid = openA.project_id as string;
  const bid = openB.project_id as string;
  for (const [project_id, content] of [[aid, "alpha"], [bid, "beta"]]) {
    await call("write", { project_id, path: "same.txt", content });
  }
  assert.equal(await fs.readFile(path.join(a, "same.txt"), "utf8"), "alpha");
  assert.equal(await fs.readFile(path.join(b, "same.txt"), "utf8"), "beta");
  assert.match(await call("read_file", { project_id: aid, path: "same.txt" }), /1: alpha/);
  assert.match(await call("read_file", { project_id: bid, path: "same.txt" }), /1: beta/);
  await call("edit", { project_id: aid, path: "same.txt", oldString: "alpha", newString: "edited" });
  await call("write_file", { project_id: bid, path: "same.txt", content: " appended", append: true });
  await call("patch", { project_id: aid, patchText: "*** Begin Patch\n*** Add File: before.txt\n+new\n*** End Patch" });
  await call("patch", { project_id: aid, patchText: "*** Begin Patch\n*** Update File: before.txt\n*** Move to: after.txt\n*** End Patch" });
  assert.equal(await fs.readFile(path.join(a, "after.txt"), "utf8"), "new\n");
  await assert.rejects(fs.stat(path.join(b, "after.txt")), { code: "ENOENT" });
  assert.match(await call("list_dir", { project_id: aid }), /after.txt/);
  assert.match(await call("glob", { project_id: aid, pattern: "*.txt" }), /after.txt/);
  assert.match(await call("grep", { project_id: bid, pattern: "beta" }), /same.txt/);
  assert.match(await call("run_command", { project_id: aid, command: "pwd" }), new RegExp(a));
  assert.match(await call("run_command", { project_id: bid, command: "pwd" }), new RegExp(b));
  assert.match(await call("run_command", { project_id: aid, cwd: "nested", command: "pwd" }), /project a\/nested/);
  const job = JSON.parse(await call("run_command", { project_id: aid, command: "pwd", background: true }));
  await call("job_wait", { ids: [job.id] });
  assert.match(JSON.parse(await call("job_output", { id: job.id })).output, new RegExp(a));
  const shell = JSON.parse(await call("shell_open", { project_id: aid }));
  await call("project_open", { path: b });
  const sent = JSON.parse(await call("shell_send", { shell_id: shell.shell_id, cmd: "pwd" }));
  assert.match(sent.output, new RegExp(a));
  await call("shell_send", { shell_id: shell.shell_id, cmd: "exit" });
  const nested = JSON.parse(await call("execute", {
    project_id: aid,
    code: `return await Promise.all([tools.read_file({path:"same.txt"}), tools.read_file({project_id:${JSON.stringify(bid)},path:"same.txt"}), tools.run_command({command:"pwd"}), tools.project_info({})]);`,
  }));
  assert.match(nested[0].content[0].text, /edited/);
  assert.match(nested[1].content[0].text, /beta appended/);
  assert.match(nested[2].content[0].text, new RegExp(a));
  assert.equal(JSON.parse(nested[3].content[0].text).project_id, aid);
  await fs.writeFile(path.join(a, "CLAUDE.md"), "updated instructions");
  assert.equal(JSON.parse(await call("project_info", { project_id: aid })).instructions[1].content, "updated instructions");
  await call("project_info", {}, true);
  await call("project_open", { path: path.join(temp, "absent") }, true);
  await call("project_open", { path: path.join(a, "same.txt") }, true);
  for (const [name, args] of [
    ["read_file", { path: "same.txt" }], ["write", { path: "bad.txt", content: "bad" }],
    ["edit", { path: "same.txt", oldString: "edited", newString: "bad" }],
    ["patch", { patchText: "*** Begin Patch\n*** Add File: bad.txt\n+bad\n*** End Patch" }],
    ["list_dir", {}], ["glob", { pattern: "*" }], ["grep", { pattern: "*" }],
    ["run_command", { command: "pwd" }], ["shell_open", {}], ["shell_open_root", {}],
    ["run_root_command", { command: "pwd" }], ["execute", { code: "return 1" }],
  ] as const) {
    assert.match(await call(name, { ...args, project_id: "unknown" }, true), /unknown project_id/);
  }
  await fs.writeFile(path.join(b, "CLAUDE.md"), Buffer.from([0xff]));
  await call("project_info", { project_id: bid }, true);
  await fs.writeFile(path.join(b, "CLAUDE.md"), "x".repeat(64 * 1024 + 1));
  await call("project_open", { path: b }, true);
  await fs.unlink(path.join(b, "CLAUDE.md"));
  await call("project_close", { project_id: aid });
  await call("read_file", { project_id: aid, path: "same.txt" }, true);
  assert.match(await call("read_file", { project_id: bid, path: "same.txt" }), /beta appended/);
  const legacy = new ProjectContext();
  assert.equal(legacy.resolve("relative", undefined, os.homedir()), path.resolve("relative"));
  assert.equal(legacy.resolve(undefined, undefined, os.homedir()), os.homedir());
  assert.equal(legacy.resolve("~/file"), path.join(os.homedir(), "file"));
  console.log("project tests passed");
} finally {
  child.kill("SIGTERM");
  await once(child, "exit");
  await fs.rm(temp, { recursive: true, force: true });
}
