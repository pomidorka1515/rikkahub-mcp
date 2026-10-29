import assert from "node:assert/strict";
import os from "node:os";
import { ShellManager, type ShellSnapshot } from "../persistent-shell.js";

const manager = new ShellManager(process.env.MCP_SHELL || "bash", 1024, 2);
try {
  const first = await manager.open(os.homedir(), { SHELL_TEST: "initial" });
  const shell = manager.get(first.shell_id);
  const second = await manager.open(os.homedir());
  await assert.rejects(manager.open(os.homedir()), /Limit/);
  await assert.rejects(manager.open("/nonexistent-mcp-directory"), /Limit/);
  const drain = async (initial: ShellSnapshot): Promise<string> => {
    let text = initial.output;
    while (initial.buffered_bytes) {
      initial = await shell.read(100, 0);
      text += initial.output;
    }
    return text;
  };
  let result = await shell.send("cd /; export SHELL_TEST='saved'; f() { printf 'function-ok\\n'; }", 1000);
  assert.equal(result.state, "idle");
  result = await shell.send("pwd; printf '%s\\n' \"$SHELL_TEST\"; f", 1000);
  assert.equal(await drain(result), "/\nsaved\nfunction-ok\n");
  result = await manager.get(second.shell_id).send("printf '%s' \"${SHELL_TEST-unset}\"", 1000);
  assert.equal(result.output, "unset");
  result = await shell.send("printf 'α\\n';\nprintf 'β\\n' >&2\n", 1000);
  assert.equal(await drain(result), "α\nβ\n");
  result = await shell.send("false", 1000);
  assert.equal(result.exit_code, 1);
  result = await shell.send("sleep 0.2; printf 'finished\\n'", 0);
  assert.equal(result.state, "running");
  await assert.rejects(shell.send("echo overlap", 0), /running/);
  result = await shell.read(10, 1000);
  let text = result.output;
  while (result.state === "running") {
    result = await shell.read(10, 1000);
    text += result.output;
  }
  assert.equal(text, "finished\n");
  result = await shell.send("sleep 30; echo should-not-run", 100);
  assert.equal(result.state, "running");
  result = await shell.interrupt(1000);
  assert.equal(result.state, "idle");
  assert.ok(!result.output.includes("should-not-run"));
  result = await shell.send("echo survived", 1000);
  assert.equal(result.output, "survived\n");
  await shell.send("printf 'one\\ntwo\\nthree'", 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await shell.read(1, 0)).output, "one\n");
  assert.equal((await shell.read(1, 0)).output, "two\n");
  assert.equal((await shell.read(1, 0)).output, "three");
  result = await shell.send("printf '%2000s' x", 1000);
  assert.ok(result.dropped_bytes > 0);
  assert.ok(Buffer.byteLength(result.output) <= 1024);
  result = await shell.send("exit 7", 1000);
  assert.equal(result.state, "exited");
  assert.equal(result.exit_code, 7);
  await assert.rejects(shell.send("echo no", 0), /exited/);
  assert.throws(() => manager.get("missing"), /Unknown/);
  await assert.rejects(manager.open("/nonexistent-mcp-directory"), /ENOENT/);
  await manager.open(os.homedir());
  console.log("persistent shell tests passed");
} finally {
  manager.shutdown();
}
