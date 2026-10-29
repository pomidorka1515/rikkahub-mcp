import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { ShellManager, type ShellSnapshot } from "../persistent-shell.js";
import { requireRegularCommand } from "../command-policy.js";

for (const command of ["sudo id", "su -c id", "tsu", "/system/bin/su", "true && tsu", "$(sudo id)", "s'u'do id", "t\\su", "bash -c 'su -c id'", "s\\\nu id"]) {
  assert.throws(() => requireRegularCommand(command), /blocked/);
}
for (const command of ["true", "echo usual", "ls /some/superuser", "printf '%s' sushi"]) requireRegularCommand(command);

const manager = new ShellManager(process.env.MCP_SHELL || "bash", 1024, 2);
try {
  const first = await manager.open(os.homedir(), { SHELL_TEST: "initial" });
  const shell = manager.get(first.shell_id);
  await assert.rejects(shell.send("tsu", 0), /blocked/);
  assert.equal((await shell.send("echo still-idle", 1000)).output, "still-idle\n");
  await assert.rejects(manager.open(os.homedir(), { BASH_ENV: "/tmp/sudo" }), /blocked/);
  const forbidden = new ShellManager("/system/bin/su", 1024);
  await assert.rejects(forbidden.open(os.homedir()), /blocked/);
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
  assert.ok(result.output_path);
  assert.ok((await readFile(result.output_path, "utf8")).endsWith("x"));
  assert.equal(result.output_capture_error, undefined);
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

// fake elevation programs exercise root lifecycle without requesting device root.
const temporary = await mkdtemp(path.join(os.tmpdir(), "mcp-root-shell-"));
const originalPath = process.env.PATH;
const rootManager = new ShellManager("bash", 4096, 2);
try {
  const bash = process.env.PREFIX ? path.join(process.env.PREFIX, "bin/bash") : "/bin/bash";
  const grant = path.join(temporary, "grant");
  const calls = path.join(temporary, "calls");
  const fake = `#!${bash}\necho call >> '${calls}'\n[ -f '${grant}' ] || exit 1\nif [ "$1" = -E ]; then shift; exec "$@"; fi\nexec '${bash}'\n`;
  await writeFile(path.join(temporary, "tsu"), fake, { mode: 0o700 });
  await writeFile(path.join(temporary, "sudo"), fake, { mode: 0o700 });
  await writeFile(path.join(temporary, "id"), `#!${bash}\nprintf '0\\n'\n`, { mode: 0o700 });
  process.env.PATH = `${temporary}:${originalPath}`;
  await assert.rejects(rootManager.openRoot(), /termux does not have root access/);
  await writeFile(grant, "yes");
  const opened = await rootManager.openRoot(temporary, { ROOT_SHELL_TEST: "saved" });
  const root = rootManager.get(opened.shell_id);
  let result = await root.send("pwd; echo $ROOT_SHELL_TEST; printf partial", 1000);
  assert.equal(result.output, `${temporary}\nsaved\npartial`);
  assert.equal(result.state, "idle");
  assert.equal((await root.send("false", 1000)).exit_code, 1);
  // root shells do not apply the regular-shell command-name policy.
  assert.equal((await root.send("echo tsu", 1000)).output, "tsu\n");
  result = await root.send("sleep 30", 20);
  assert.equal(result.state, "running");
  assert.equal((await root.interrupt(1000)).state, "idle");
  const preserved = await rootManager.openRoot(temporary, {}, "sudo");
  assert.equal(preserved.state, "idle");
  await rm(grant);
  await assert.rejects(rootManager.openRoot(), /termux does not have root access/);
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 6);
  console.log("root shell policy and lifecycle tests passed (simulated root)");
} finally {
  rootManager.shutdown();
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  await rm(temporary, { recursive: true, force: true });
}
