import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const token = fs.readFileSync(path.join(os.homedir(), ".config/rikkahub-mcp/token"), "utf8").trim();
// no Authorization header at all — token only in the URL, like RikkaHub
const c = new Client({ name: "sse-url-token", version: "1" });
await c.connect(new SSEClientTransport(new URL(`http://127.0.0.1:8765/sse?token=${token}`)));
const { tools } = await c.listTools();
const r = CallToolResultSchema.parse(await c.callTool({ name: "run_command", arguments: { command: "echo sse-ok" } }));
const first = r.content[0];
const text = first?.type === "text" ? first.text : JSON.stringify(r);
console.log("tools:", tools.length, "| call:", text.split("\n")[0]);
await c.close();
