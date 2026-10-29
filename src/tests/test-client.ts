import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

interface CommandArguments {
  command: string;
  cwd?: string;
  timeout_ms?: number;
  env?: Record<string, string>;
}

interface RootCommandArguments extends CommandArguments {
  preserve_env?: boolean;
}

type ToolCase =
  | [name: "run_command", args: CommandArguments]
  | [name: "write_file", args: { path: string; content: string; append?: boolean }]
  | [name: "read_file", args: { path: string; max_bytes?: number }]
  | [name: "list_dir", args: { path?: string }];

const token = fs.readFileSync(path.join(os.homedir(), ".config/rikkahub-mcp/token"), "utf8").trim();
const headers = { Authorization: `Bearer ${token}` };

async function exercise(label: string, transport: Transport): Promise<void> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  console.log(`\n=== ${label} ===`);
  console.log("server:", JSON.stringify(client.getServerVersion()));
  const { tools } = await client.listTools();
  console.log("tools:", tools.map((t) => t.name).join(", "));

  const cases: ToolCase[] = [
    ["run_command", { command: "echo hello from $(whoami) on $(uname -m); pwd" }],
    ["run_command", { command: "ls /nope-does-not-exist", }],
    ["run_command", { command: "sleep 5; echo late", timeout_ms: 1000 }],
    ["write_file", { path: "~/rikkahub-mcp/tmp_test.txt", content: "line1\n" }],
    ["run_command", { command: "cat ~/rikkahub-mcp/tmp_test.txt; printf 'x%.0s' $(seq 1 10)" }],
    ["list_dir", { path: "~/rikkahub-mcp" }],
    ["read_file", { path: "~/rikkahub-mcp/tmp_test.txt" }],
  ];
  for (const [name, args] of cases) {
    const r = CallToolResultSchema.parse(await client.callTool({ name, arguments: { ...args } }));
    const first = r.content[0];
    const text = first?.type === "text" ? first.text : JSON.stringify(r);
    console.log(`\n[${name}] isError=${!!r.isError}\n${text.slice(0, 400)}`);
  }
  await client.close();
}

const base = "http://127.0.0.1:8765";
await exercise(
  "streamable http",
  new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }),
);
await exercise("legacy sse", new SSEClientTransport(new URL(`${base}/sse`), { requestInit: { headers } }));

/* --- root tool --- */
async function rootTests(): Promise<void> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8765/mcp"), { requestInit: { headers } }));
  const cases: RootCommandArguments[] = [
    { command: "id; echo HOME=$HOME; echo PREFIX=$PREFIX" },
    { command: "id; echo HOME=$HOME; which node" , preserve_env: true },
    { command: "id; pwd", cwd: "/data/adb" },
    { command: "sleep 30; echo never", timeout_ms: 1500 },
    { command: "touch /data/local/tmp/from-mcp && ls -l /data/local/tmp/from-mcp" },
  ];
  for (const args of cases) {
    const r = CallToolResultSchema.parse(await client.callTool({ name: "run_root_command", arguments: { ...args } }));
    const first = r.content[0];
    const text = first?.type === "text" ? first.text : JSON.stringify(r);
    console.log(`\n[root ${args.preserve_env ? "preserve" : "tsu"}] isError=${!!r.isError}\n${text.slice(0, 350)}`);
  }
  await client.close();
}
await rootTests();
