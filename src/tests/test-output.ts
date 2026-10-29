import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OutputCapture, OutputStore } from "../output-store.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-output-"));
try {
  const store = new OutputStore(path.join(temporary, "normal"));
  const small = new OutputCapture(4, store);
  small.append("test");
  small.finish();
  assert.equal(small.text(), "test");
  assert.deepEqual(small.metadata(), {});
  assert.equal(fs.existsSync(store.directory), false);

  const capture = new OutputCapture(4, store);
  capture.append("first");
  capture.append("\nlast\n");
  const file = capture.metadata().output_path!;
  assert.equal(fs.readFileSync(file, "utf8"), "first\nlast\n");
  assert.match(capture.text(), /firs\n\[output truncated\]/);
  assert.ok(capture.text().includes(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
  capture.finish();

  // crossing the threshold in later chunks must retain the entire earlier prefix.
  const incremental = new OutputCapture(4, store);
  incremental.append("ab");
  incremental.append("cd");
  assert.deepEqual(incremental.metadata(), {});
  incremental.append("ef");
  assert.equal(fs.readFileSync(incremental.metadata().output_path!, "utf8"), "abcdef");
  incremental.append("gh");
  incremental.finish();
  assert.equal(fs.readFileSync(incremental.metadata().output_path!, "utf8"), "abcdefgh");

  // split multibyte characters across stream chunks and preview boundaries.
  const unicode = "a🙂雪é�z";
  const bytes = Buffer.from(unicode);
  for (let limit = 1; limit < bytes.length; limit++) {
    const streamed = new OutputCapture(limit, store);
    for (const byte of bytes) streamed.append(Buffer.from([byte]));
    streamed.finish();
    assert.equal(fs.readFileSync(streamed.metadata().output_path!, "utf8"), unicode);
    const prefix = streamed.text().split("\n")[0]!;
    assert.ok(unicode.startsWith(prefix), `invalid utf-8 preview at ${limit}: ${prefix}`);
    assert.ok(Buffer.byteLength(prefix) <= limit);
  }

  const bounded = new OutputCapture(3, new OutputStore(path.join(temporary, "bounded"), 8));
  bounded.append("0123456789");
  bounded.append("ignored");
  bounded.finish();
  assert.equal(fs.readFileSync(bounded.metadata().output_path!, "utf8"), "01234567");
  assert.match(bounded.metadata().output_capture_error!, /file limit/);
  assert.match(bounded.text(), /incomplete/);

  // active files cannot be evicted; a failed capture must not crash its producer.
  const quota = new OutputStore(path.join(temporary, "quota"), 20, 12);
  const active = new OutputCapture(2, quota);
  active.append("12345678");
  const blocked = new OutputCapture(2, quota);
  blocked.append("abcdef");
  assert.match(blocked.metadata().output_capture_error!, /storage is full/);
  blocked.finish();
  assert.equal(fs.readFileSync(active.metadata().output_path!, "utf8"), "12345678");
  active.finish();
  const replacement = new OutputCapture(2, quota);
  replacement.append("replacement");
  replacement.finish();
  assert.equal(fs.existsSync(active.metadata().output_path!), false);
  assert.equal(fs.readFileSync(replacement.metadata().output_path!, "utf8"), "replacement");

  // reload existing files after restart, then expire only managed inactive files.
  const oldFile = replacement.metadata().output_path!;
  fs.utimesSync(oldFile, new Date(0), new Date(0));
  fs.writeFileSync(path.join(quota.directory, "unrelated.txt"), "keep");
  const restarted = new OutputCapture(2, new OutputStore(quota.directory, 20, 12, 1000));
  restarted.append("new");
  restarted.finish();
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.readFileSync(path.join(quota.directory, "unrelated.txt"), "utf8"), "keep");

  const countLimited = new OutputStore(path.join(temporary, "count"), 20, 100, 1000, 1);
  const only = new OutputCapture(1, countLimited);
  only.append("first");
  const noRoom = new OutputCapture(1, countLimited);
  noRoom.append("second");
  assert.equal(noRoom.metadata().output_path, undefined);
  assert.match(noRoom.metadata().output_capture_error!, /storage is full/);
  only.finish();
  const next = new OutputCapture(1, countLimited);
  next.append("third");
  next.finish();
  assert.equal(fs.existsSync(only.metadata().output_path!), false);
  assert.equal(fs.readdirSync(countLimited.directory).length, 1);

  const unavailable = path.join(temporary, "not-a-directory");
  fs.writeFileSync(unavailable, "file");
  const failed = new OutputCapture(2, new OutputStore(unavailable));
  failed.append("preserve the preview");
  failed.finish();
  assert.match(failed.text(), /^pr\n\[output truncated\]/);
  assert.match(failed.metadata().output_capture_error!, /could not retain/);
  console.log("recoverable output storage tests passed");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
