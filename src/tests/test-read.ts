import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerReadTool } from "../read-tool.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-read-"));
const server = new McpServer({ name: "read-test", version: "1" });
registerReadTool(server, 128 * 1024);
const client = new Client({ name: "read-test", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(a);
  await client.connect(b);
  const file = path.join(root, "sample.txt");
  const read = async (args: Record<string, unknown> = {}, error = false) => {
    const result = CallToolResultSchema.parse(await client.callTool({ name: "read_file", arguments: { path: file, ...args } }));
    assert.equal(Boolean(result.isError), error, JSON.stringify(result));
    return result;
  };
  const call = async (args: Record<string, unknown> = {}, error = false): Promise<string> => {
    const result = await read(args, error);
    return result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
  };
  assert.equal((await client.listTools()).tools[0]?.annotations?.readOnlyHint, true);
  await fs.writeFile(file, "first\r\n\r\n雪😀\nlast");
  assert.equal(await call(), `${file}\n1: first\n2: \n3: 雪😀\n4: last\n[end of file]`);
  assert.equal(await call({ offset: 2, limit: 2 }), `${file}\n2: \n3: 雪😀\n[page truncated; continue with offset=4]`);
  assert.equal(await call({ offset: 4 }), `${file}\n4: last\n[end of file]`);
  assert.match(await call({ offset: 5 }, true), /beyond end/);
  for (const args of [{ offset: 0 }, { offset: 1.5 }, { limit: 0 }, { limit: 2001 }, { max_bytes: 0 }]) await call(args, true);
  await call({ path: root }, true);
  await call({ path: path.join(root, "absent") }, true);
  await fs.writeFile(file, "");
  assert.equal(await call(), `${file}\n\n[end of file]`);
  await call({ offset: 2 }, true);
  await fs.writeFile(file, "a\n");
  assert.equal(await call(), `${file}\n1: a\n[end of file]`);
  await fs.writeFile(file, "\n\n");
  assert.equal(await call(), `${file}\n1: \n2: \n[end of file]`);
  await fs.writeFile(file, Buffer.from("hello\0world"));
  assert.deepEqual((await read()).content, [{
    type: "resource", resource: {
      uri: pathToFileURL(file).href, mimeType: "application/octet-stream",
      blob: Buffer.from("hello\0world").toString("base64"),
    },
  }]);
  await fs.writeFile(file, "😀".repeat(2001) + "\r\nnext");
  const long = await call();
  assert.ok(long.includes("😀".repeat(2000) + "…[line truncated]\n2: next"));
  assert.ok(!long.includes("�"));
  await fs.writeFile(file, "x".repeat(2000) + "\r\n");
  assert.ok(!(await call()).includes("line truncated"));
  await fs.writeFile(file, Array.from({ length: 2001 }, (_, i) => `line ${i + 1}`).join("\n"));
  assert.match(await call(), /continue with offset=2001/);
  assert.match(await call({ offset: 2001 }), /2001: line 2001\n\[end of file\]/);
  await fs.writeFile(file, ("雪".repeat(1000) + "\n").repeat(30));
  const page = await call();
  const body = page.split("\n").slice(1, -1).join("\n");
  assert.ok(Buffer.byteLength(body) <= 50 * 1024);
  assert.match(page, /continue with offset=18/);
  assert.match(await call({ max_bytes: 10 }), /line truncated by byte cap/);
  assert.ok(!(await call({ max_bytes: 10 })).includes("�"));
  await fs.writeFile(file, "a\nb\nc");
  assert.match(await call({ max_bytes: 9 }), /1: a\n2: b\n\[page truncated; continue with offset=3\]/);
  await fs.writeFile(file, "x".repeat(200_000) + "\nnext");
  assert.match(await call({ offset: 2 }), /2: next\n\[end of file\]/);
  assert.match(await call({ path: path.relative(process.cwd(), file) }), /1: x/);
  // a multibyte character crossing the probe boundary must remain text.
  await fs.writeFile(file, "x".repeat(4095) + "雪\nnext");
  assert.match(await call({ offset: 2 }), /2: next/);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  await fs.writeFile(file, png);
  assert.deepEqual((await read()).content, [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
  for (const args of [{ offset: 1 }, { limit: 1 }]) assert.match(await call(args, true), /only supported for text/);
  assert.match(await call({ max_bytes: png.length - 1 }, true), /exceeds/);
  await read({ max_bytes: png.length });
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
  await fs.writeFile(file, pdf);
  assert.deepEqual((await read()).content, [{
    type: "resource", resource: { uri: pathToFileURL(file).href, mimeType: "application/pdf", blob: pdf.toString("base64") },
  }]);
  for (const [name, data, mimeType] of [
    ["photo.JPG", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    ["animation", Buffer.from("GIF89a"), "image/gif"],
    ["picture", Buffer.from("RIFF\0\0\0\0WEBP"), "image/webp"],
    ["icon.SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml"],
    ["archive.zip", Buffer.from("PK\0\0"), "application/zip"],
  ] as const) {
    const media = path.join(root, name);
    await fs.writeFile(media, data);
    const result = await read({ path: media });
    const item = result.content[0];
    if (mimeType.startsWith("image/")) {
      assert.deepEqual(item, { type: "image", data: data.toString("base64"), mimeType });
    } else {
      assert.deepEqual(item, { type: "resource", resource: { uri: pathToFileURL(media).href, mimeType, blob: data.toString("base64") } });
    }
  }
  const large = path.join(root, "large.pdf");
  await fs.writeFile(large, pdf);
  await fs.truncate(large, 32 * 1024 * 1024 + 1);
  assert.match(await call({ path: large }, true), /exceeds 33554432 byte limit/);
  // attachment limits are independent of the text output cap.
  await fs.truncate(large, 256 * 1024);
  const attachment = (await read({ path: large })).content[0];
  assert.ok(attachment?.type === "resource" && "blob" in attachment.resource);
  assert.equal(Buffer.from(attachment.resource.blob, "base64").length, 256 * 1024);
  console.log("read MCP tests passed (text pagination, unicode, images, attachments, byte limits, errors)");
} finally {
  await client.close();
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
}
