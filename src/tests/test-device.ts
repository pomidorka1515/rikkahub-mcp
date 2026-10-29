import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { DeviceController, registerDeviceTools, runDeviceCommand } from "../device-tools.js";

const calls: { command: string; args: string[] }[] = [];
let fail = false;
const controller = new DeviceController(async (command, args) => {
  calls.push({ command, args });
  if (fail) throw new Error("permission denied");
});
const server = new McpServer({ name: "device-test", version: "1" });
registerDeviceTools(server, controller);
const client = new Client({ name: "device-test", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(a);
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}, error = false) => {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    assert.equal(Boolean(result.isError), error, JSON.stringify(result));
    return JSON.stringify(result);
  };
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["flashlight", "vibrate"]);
  await call("vibrate", { duration_seconds: 0.125 });
  assert.deepEqual(calls.pop(), { command: "termux-vibrate", args: ["-d", "125"] });
  for (const args of [{}, { duration_seconds: 0 }, { duration_seconds: -1 }, { duration_seconds: 3601 }, { duration_seconds: "1" }]) {
    await call("vibrate", args, true);
  }
  assert.equal(calls.length, 0);
  await call("flashlight");
  assert.deepEqual(calls.pop(), { command: "termux-torch", args: ["on"] });
  await call("flashlight", { duration_seconds: 0.02 });
  await delay(80);
  assert.deepEqual(calls.splice(0), [
    { command: "termux-torch", args: ["on"] },
    { command: "termux-torch", args: ["off"] },
  ]);
  for (const replacement of [{}, { enabled: false }]) {
    await call("flashlight", { duration_seconds: 0.2 });
    await call("flashlight", replacement);
    calls.length = 0;
    await delay(250);
    assert.equal(calls.length, 0, "a successful replacement must cancel the old timer");
  }
  await call("flashlight", { enabled: false, duration_seconds: 1 }, true);
  await call("flashlight", { duration_seconds: 0 }, true);
  assert.equal(calls.length, 0);
  fail = true;
  assert.match(await call("vibrate", { duration_seconds: 1 }, true), /permission denied/);
  assert.match(await call("flashlight", {}, true), /permission denied/);
  fail = false;
  await call("flashlight", { enabled: false });

  // exercise process failures and api error objects without touching device hardware.
  await runDeviceCommand(process.execPath, ["-e", ""]);
  await assert.rejects(runDeviceCommand(process.execPath, ["-e", "console.log(JSON.stringify({error:'camera denied'}))"]), /camera denied.*pkg install termux-api/s);
  await assert.rejects(runDeviceCommand(process.execPath, ["-e", "process.stderr.write('failed'); process.exit(1)"]), /failed/);
  await assert.rejects(runDeviceCommand("/nonexistent/mcp-device-command", []), /pkg install termux-api/);
  console.log("device tests passed (rootless commands, schemas, timers, replacement, errors)");
} finally {
  fail = false;
  await controller.flashlight(false);
  await client.close();
  await server.close();
}
