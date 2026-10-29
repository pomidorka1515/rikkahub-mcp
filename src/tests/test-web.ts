import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerWebTools } from "../web-tools.js";

const originalInstance = process.env.MCP_SEARXNG_URL;
const fixture = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://localhost");
  if (url.pathname === "/redirect") {
    res.writeHead(302, { location: "/page" }).end();
  } else if (url.pathname === "/page") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end('<h1>hello 雪</h1><p>first</p><p><a href="/next">next</a></p><script>secret script</script><style>secret style</style>');
  } else if (url.pathname === "/plain") {
    res.setHeader("content-type", "text/plain");
    res.end("plain <text> 雪");
  } else if (url.pathname === "/image") {
    res.setHeader("content-type", "image/png");
    res.end("not text");
  } else if (url.pathname === "/large") {
    res.end("x".repeat(5 * 1024 * 1024 + 1));
  } else if (url.pathname === "/recoverable") {
    res.setHeader("content-type", "text/plain");
    res.end("line\n".repeat(1000) + "last 雪\n");
  } else if (url.pathname === "/slow") {
    // leave the body open to verify that the timeout includes streaming.
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("waiting");
  } else if (url.pathname === "/base/search") {
    assert.equal(url.searchParams.get("format"), "json");
    res.setHeader("content-type", "application/json");
    const query = url.searchParams.get("q");
    if (query === "invalid") res.end("not JSON");
    else if (query === "malformed") res.end('{"results":42}');
    else res.end(JSON.stringify({
      results: query === "empty" ? [] : [
        { title: "unsafe", url: "javascript:alert(1)" },
        { title: query, url: "https://example.com/", content: "a snippet" },
        { title: "second", url: "https://example.org/" },
      ],
      unresponsive_engines: query === "partial" ? [["engine", "timeout"]] : [],
    }));
  } else res.writeHead(403).end("forbidden");
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
const address = fixture.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const server = new McpServer({ name: "web-test", version: "1" });
registerWebTools(server, 1024);
const client = new Client({ name: "web-test", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(a);
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>, error = false) => {
    const response = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    assert.equal(Boolean(response.isError), error, JSON.stringify(response));
    return response.content.map((item) => item.type === "text" ? item.text : "").join("\n");
  };
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["webfetch", "websearch"]);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.openWorldHint, true);
  }
  const page = await call("webfetch", { url: base + "/redirect" });
  assert.match(page, /# hello 雪/);
  assert.ok(page.includes(`[next](${base}/next)`));
  assert.ok(!page.includes("secret"));
  const text = await call("webfetch", { url: base + "/page", format: "text" });
  assert.match(text, /hello 雪\nfirst\nnext/);
  assert.ok(!text.includes("secret"));
  assert.match(await call("webfetch", { url: base + "/page", format: "html" }), /<script>secret script/);
  assert.match(await call("webfetch", { url: base + "/plain" }), /plain <text> 雪/);
  assert.match(await call("webfetch", { url: base + "/image" }, true), /unsupported content type/);
  assert.match(await call("webfetch", { url: base + "/large" }, true), /download limit/);
  const large = await call("webfetch", { url: base + "/recoverable" });
  assert.match(large, /output truncated/);
  const saved = /\noutput_path: (.+)\n/.exec(large)?.[1];
  assert.ok(saved);
  assert.ok((await readFile(saved, "utf8")).endsWith("line\n".repeat(1000) + "last 雪\n"));
  await call("webfetch", { url: base + "/slow", timeout: 0.05 }, true);
  assert.match(await call("webfetch", { url: base + "/forbidden" }, true), /HTTP 403/);
  await call("webfetch", { url: "file:///etc/passwd" }, true);
  await call("webfetch", { url: "http://user:secret@example.com" }, true);
  await call("webfetch", { url: base, timeout: 121 }, true);
  await call("webfetch", { url: base, format: "pdf" }, true);
  delete process.env.MCP_SEARXNG_URL;
  assert.match(await call("websearch", { query: "hello" }, true), /MCP_SEARXNG_URL/);
  process.env.MCP_SEARXNG_URL = base + "/base/";
  const search = await call("websearch", { query: "snow 雪 & sun", limit: 1 });
  assert.match(search, /snow 雪 & sun/);
  assert.match(search, /https:\/\/example.com\//);
  assert.match(search, /a snippet/);
  assert.ok(!search.includes("second") && !search.includes("unsafe"));
  assert.match(await call("websearch", { query: "empty" }), /no results/);
  assert.match(await call("websearch", { query: "partial" }), /incomplete/);
  assert.match(await call("websearch", { query: "invalid" }, true), /did not return JSON/);
  assert.match(await call("websearch", { query: "malformed" }, true), /invalid SearXNG/);
  assert.match(await call("websearch", { query: "x".repeat(3000) }), /output truncated/);
  await call("websearch", { query: " " }, true);
  await call("websearch", { query: "hello", limit: 21 }, true);
  console.log("web MCP tests passed (fetch formats, redirects, limits, timeouts, SearXNG, schemas, errors)");
} finally {
  if (originalInstance === undefined) delete process.env.MCP_SEARXNG_URL;
  else process.env.MCP_SEARXNG_URL = originalInstance;
  await client.close();
  await server.close();
  fixture.closeAllConnections();
  await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
}
