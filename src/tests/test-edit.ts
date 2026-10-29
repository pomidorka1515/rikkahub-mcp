import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerEditTools } from "../edit-tools.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-edit-"));
const server = new McpServer({ name: "edit-test", version: "1" });
registerEditTools(server);
const client = new Client({ name: "edit-test", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(a);
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>, error = false): Promise<string> => {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    assert.equal(Boolean(result.isError), error, JSON.stringify(result));
    return result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
  };
  const patch = (body: string, error = false) => call("patch", { patchText: `*** Begin Patch\n${body}\n*** End Patch` }, error);
  const file = path.join(root, "nested", "sample.txt");
  const read = () => fs.readFile(file, "utf8");
  const edit = (args: Record<string, unknown>, error = false) => call("edit", { path: file, ...args }, error);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["edit", "patch", "write", "write_file"]);
  for (const tool of (await client.listTools()).tools) {
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(tool.annotations?.destructiveHint, true);
  }
  await call("write", { path: file, content: "a\na\n雪😀\n" });
  await edit({ oldString: "a", newString: "b" }, true);
  assert.equal(await read(), "a\na\n雪😀\n");
  await edit({ oldString: "absent", newString: "x" }, true);
  await edit({ oldString: "", newString: "x" }, true);
  await edit({ oldString: "a", newString: "a" }, true);
  await edit({ oldString: "a", newString: "$&$1", replaceAll: true });
  assert.equal(await read(), "$&$1\n$&$1\n雪😀\n");
  await edit({ oldString: "雪😀\n", newString: "" });
  assert.equal(await read(), "$&$1\n$&$1\n");
  await edit({ path: path.join(root, "absent"), oldString: "a", newString: "b" }, true);
  await call("write_file", { path: file, content: "end", append: true });
  assert.equal(await read(), "$&$1\n$&$1\nend");
  await call("write", { path: file, content: "first\r\n雪😀\r\nlast\r\n" });
  await fs.chmod(file, 0o640);
  const added = path.join(root, "new", "add.txt");
  const moved = path.join(root, "moved", "sample.txt");
  const removed = path.join(root, "remove.txt");
  await fs.writeFile(removed, "delete me");
  await patch(`*** Add File: ${added}\n+hello\n+world\n*** Update File: ${file}\n*** Move to: ${moved}\n@@\n first\n-雪😀\n+changed\n last\n*** Delete File: ${removed}`);
  assert.equal(await fs.readFile(added, "utf8"), "hello\nworld\n");
  assert.equal(await fs.readFile(moved, "utf8"), "first\r\nchanged\r\nlast\r\n");
  assert.equal((await fs.stat(moved)).mode & 0o777, 0o640);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  await assert.rejects(fs.stat(removed), { code: "ENOENT" });
  await patch(`*** Update File: ${moved}\n*** Move to: ${file}`);
  assert.equal(await read(), "first\r\nchanged\r\nlast\r\n");
  const rejected = path.join(root, "never-created");
  await patch(`*** Add File: ${rejected}\n+hello\n*** Update File: ${file}\n@@\n-wrong\n+oops`, true);
  await assert.rejects(fs.stat(rejected), { code: "ENOENT" });
  assert.equal(await read(), "first\r\nchanged\r\nlast\r\n");
  await patch(`*** Add File: ${file}\n+overwrite`, true);
  await patch(`*** Update File: ${file}\n*** Move to: ${added}`, true);
  await patch(`*** Delete File: ${file}\n*** Add File: ${file}\n+oops`, true);
  await patch(`*** Delete File: ${rejected}`, true);
  for (const text of ["", "--- a/x\n+++ b/x", "*** Begin Patch\n*** End Patch", `*** Begin Patch\n*** Update File: ${file}\nnot a hunk\n*** End Patch`]) {
    await call("patch", { patchText: text }, true);
  }
  await patch(`*** Add File: ${rejected}\nno prefix`, true);
  await patch(`*** Update File: ${file}\n@@\n first`, true);
  await patch(`*** Update File: ${file}\n@@\n-first\n+wrong\n*** End of File`, true);
  await patch(`*** Update File: ${file}\n@@\n-last\n+final\n*** End of File`);
  assert.equal(await read(), "first\r\nchanged\r\nfinal\r\n");
  await call("write", { path: file, content: "anchor\none\nanchor\none\nend" });
  await patch(`*** Update File: ${file}\n@@ anchor\n-one\n+two\n@@ anchor\n-one\n+three\n@@\n end\n+tail`);
  assert.equal(await read(), "anchor\ntwo\nanchor\nthree\nend\ntail");
  await patch(`*** Update File: ${file}\n@@ missing\n-three\n+bad`, true);
  await patch(`*** Update File: ${file}\n@@\n+appended`);
  assert.equal(await read(), "anchor\ntwo\nanchor\nthree\nend\ntail\nappended");
  await call("write", { path: file, content: "" });
  await patch(`*** Update File: ${file}\n@@\n+new`);
  assert.equal(await read(), "new\n");
  await patch(`*** Update File: ${file}\n@@\n-new`);
  assert.equal(await read(), "");
  await patch(`*** Add File: ${rejected}`);
  assert.equal(await fs.readFile(rejected, "utf8"), "");
  await call("write", { path: path.relative(process.cwd(), file), content: "relative" });
  assert.equal(await read(), "relative");
  await fs.writeFile(file, "\uFEFFbom\n");
  await edit({ oldString: "bom", newString: "kept" });
  assert.equal(await read(), "\uFEFFkept\n");
  for (const content of [Buffer.from("a\0b"), Buffer.from([0xff, 0xfe])]) {
    await fs.writeFile(file, content);
    await edit({ oldString: "a", newString: "b" }, true);
    await patch(`*** Delete File: ${file}`, true);
    assert.deepEqual(await fs.readFile(file), content);
  }
  const link = path.join(root, "link");
  await fs.symlink(file, link);
  await call("write", { path: link, content: "oops" }, true);
  await patch(`*** Add File: ${link}\n+oops`, true);
  await call("write", { path: root, content: "oops" }, true);
  await fs.writeFile(file, "start");
  await call("write", { path: file, content: "bad\0text" }, true);
  await fs.writeFile(file, "x".repeat(16 * 1024 * 1024 + 1));
  await edit({ oldString: "x", newString: "y" }, true);
  await fs.writeFile(file, "");
  await Promise.all(Array.from({ length: 10 }, (_, i) => call("write_file", { path: file, content: String(i), append: true })));
  assert.equal(await read(), "0123456789");
  console.log("editing MCP tests passed (exact replacements, writes, patches, moves, deletes, validation, newline preservation, concurrency)");
} finally {
  await client.close();
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
}
