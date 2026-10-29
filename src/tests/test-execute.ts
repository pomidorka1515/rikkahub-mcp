import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerExecuteTool } from "../execute-tool.js";

const buildTools = async () => {
  const server = new McpServer({ name: "execute-test", version: "1" });
  server.registerTool("echo", { inputSchema: { value: z.string() } }, async ({ value }) => ({
    content: [{ type: "text" as const, text: value }],
  }));
  server.registerTool("fail", { inputSchema: {} }, async () => ({
    content: [{ type: "text" as const, text: "expected failure" }], isError: true,
  }));
  return server;
};
const server = await buildTools();
await registerExecuteTool(server, buildTools, 1024);
const client = new Client({ name: "execute-test", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
const fixture = http.createServer((req, res) => {
  if (req.url === "/large") { res.end("x".repeat(5 * 1024 * 1024 + 1)); return; }
  res.writeHead(201, { "content-type": "application/json", "x-test": "yes" });
  res.end(JSON.stringify({ method: req.method }));
});
await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address();
assert.ok(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}`;
try {
  await server.connect(a);
  await client.connect(b);
  const call = async (code: string, error = false): Promise<string> => {
    const result = CallToolResultSchema.parse(await client.callTool({ name: "execute", arguments: { code } }));
    const text = result.content.map(item => item.type === "text" ? item.text : "").join("\n");
    assert.equal(Boolean(result.isError), error, text);
    return text;
  };
  assert.equal(await call("1 + 2"), "3");
  assert.equal(await call("const x = 3; x * 2; // trailing comment"), "6");
  assert.equal(await call("return { ok: true };"), '{"ok":true}');
  assert.equal(await call("const x = 3;"), "null");
  assert.equal(await call("[typeof process, typeof require, typeof setTimeout, typeof console]"), '["undefined","undefined","undefined","undefined"]');
  assert.equal(await call("typeof tools.execute"), '"undefined"');
  assert.equal(await call('(await tools.echo({value:"hello"})).content[0].text'), '"hello"');
  assert.equal(await call('(await tools.fail({})).isError'), "true");
  assert.equal(await call('(await tools.echo({value:3})).isError'), "true");
  assert.equal(await call('const r = await Promise.allSettled([tools.echo({value:"a"}), Promise.resolve().then(() => tools.missing({}))]); r.map(x => x.status)'), '["fulfilled","rejected"]');
  assert.equal(await call('globalThis.saved = 1; return saved'), "1");
  assert.equal(await call("typeof saved"), '"undefined"');
  assert.match(await call('throw new Error("expected")', true), /expected/);
  assert.match(await call("return (", true), /Unexpected token/);
  assert.match(await call('await import("node:fs")', true), /module|load/i);
  assert.equal(await call(`const r = await fetch(${JSON.stringify(url)}, {method:"POST",body:"hi"});
    return {ok:r.ok,status:r.status,header:r.headers.get("X-Test"),data:await r.json()}`),
  '{"ok":true,"status":201,"header":"yes","data":{"method":"POST"}}');
  assert.match(await call('await fetch("file:///etc/passwd")', true), /http/);
  assert.match(await call(`await fetch(${JSON.stringify(url + "/large")})`, true), /5 MiB/);
  const large = await call('"x".repeat(2000)');
  assert.match(large, /output truncated/);
  const saved = /\noutput_path: (.+)\n/.exec(large)?.[1];
  assert.ok(saved);
  assert.equal(JSON.parse(await readFile(saved, "utf8")), "x".repeat(2000));
  // an unending promise must not hold the server indefinitely, including cpu loops.
  const stuck = call("while (true) {}", true);
  assert.equal(await call("42"), "42");
  assert.match(await stuck, /deadline|interrupt/i);
  assert.equal(await call("42"), "42");
  console.log("execute MCP tests passed (isolation, tools, schemas, promises, fetch, limits, deadline)");
} finally {
  await client.close();
  await server.close();
  await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
}
