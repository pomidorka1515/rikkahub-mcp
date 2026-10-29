import assert from "node:assert/strict";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { JobManager } from "../jobs.js";

const jobs = new JobManager(process.env.MCP_SHELL || "bash", 128);
const cwd = os.homedir();
try {
  const first = await jobs.start("printf '%s\\n' \"$JOB_TEST\"; printf 'error\\n' >&2; exit 7", cwd, { JOB_TEST: "hello" });
  const finished = await jobs.wait([first.id], "all", 5000);
  assert.equal(finished.ready, true);
  assert.equal(finished.jobs[0]!.exit_code, 7);
  assert.equal(jobs.get(first.id).read(1).output, "hello\n");
  assert.equal(jobs.get(first.id).read(1).output, "error\n");
  assert.equal(jobs.get(first.id).read(100).output, "");

  const slow = await jobs.start("sleep 30", cwd);
  const quick = await jobs.start("exit 0", cwd);
  assert.equal((await jobs.wait([slow.id, quick.id], "any", 5000)).ready, true);
  assert.equal((await jobs.wait([slow.id, quick.id], "all", 20)).ready, false);
  assert.equal(jobs.get(slow.id).status().state, "running");
  await assert.rejects(jobs.wait([slow.id, "missing"], "any", 0), /unknown job/);
  assert.throws(() => jobs.get("missing"), /unknown job/);
  jobs.get(slow.id).kill();
  assert.equal((await jobs.wait([slow.id], "all", 5000)).ready, true);
  jobs.get(slow.id).kill();

  const timeout = await jobs.start("sleep 30", cwd, {}, 30);
  const timed = (await jobs.wait([timeout.id], "all", 5000)).jobs[0]!;
  assert.equal(timed.state, "exited");
  assert.equal(timed.timed_out, true);

  const overflow = await jobs.start("printf '🙂%.0s' {1..100}", cwd);
  await jobs.wait([overflow.id], "all", 5000);
  const output = jobs.get(overflow.id).read(100);
  assert.equal(output.output, "🙂".repeat(32));
  assert.equal(output.dropped_bytes, 272);
  assert.ok(output.output_path);
  assert.equal(await readFile(output.output_path, "utf8"), "🙂".repeat(100));
  assert.equal(output.output_capture_error, undefined);
  assert.equal(jobs.get(overflow.id).read(100).dropped_bytes, 0);

  // consuming the rolling buffer must not consume the saved lifetime transcript.
  const streaming = await jobs.start("printf 'a%.0s' {1..80}; sleep 0.3; printf 'b%.0s' {1..80}", cwd);
  for (let i = 0; i < 100 && !jobs.get(streaming.id).status().buffered_bytes; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(jobs.get(streaming.id).read(100).output, "a".repeat(80));
  await jobs.wait([streaming.id], "all", 5000);
  const transcript = jobs.get(streaming.id).read(100);
  assert.equal(transcript.dropped_bytes, 0);
  assert.ok(transcript.output_path);
  assert.equal(await readFile(transcript.output_path, "utf8"), "a".repeat(80) + "b".repeat(80));

  const partial = await jobs.start("printf partial", cwd);
  await jobs.wait([partial.id], "all", 5000);
  assert.equal(jobs.get(partial.id).read(1).output, "partial");
  await assert.rejects(jobs.start("echo no", `${cwd}/missing-${Date.now()}`));

  const limited = new JobManager(process.env.MCP_SHELL || "bash", 128, 1);
  try {
    const running = await limited.start("sleep 30", cwd);
    await assert.rejects(limited.start("true", cwd), /limit/);
    limited.get(running.id).kill();
    await limited.wait([running.id], "all", 5000);
    const replacement = await limited.start("true", cwd);
    assert.throws(() => limited.get(running.id), /unknown job/);
    await limited.wait([replacement.id], "all", 5000);
  } finally { limited.shutdown(); }

  // termination escalates even when the shell ignores sigterm.
  const stubborn = await jobs.start("trap '' TERM; echo ready; while :; do sleep 1; done", cwd);
  for (let i = 0; i < 100 && !jobs.get(stubborn.id).status().buffered_bytes; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(jobs.get(stubborn.id).status().buffered_bytes);
  jobs.get(stubborn.id).kill();
  const killed = (await jobs.wait([stubborn.id], "all", 5000)).jobs[0]!;
  assert.equal(killed.signal, "SIGKILL");

  const shutdown = await jobs.start("sleep 30", cwd);
  jobs.shutdown();
  assert.equal((await jobs.wait([shutdown.id], "all", 5000)).ready, true);
  console.log("background job tests passed");
} finally { jobs.shutdown(); }
