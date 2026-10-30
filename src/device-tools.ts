import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const setupHint = "install termux-api with pkg install termux-api and the compatible Termux:API android app; grant its requested permissions";

export async function runDeviceCommand(command: string, args: string[]): Promise<void> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 10_000, maxBuffer: 64 * 1024 });
    // termux-api can return an error object with a successful exit status.
    if (stdout.trim()) {
      let response: unknown;
      try { response = JSON.parse(stdout); } catch { throw new Error(stdout.trim()); }
      if (typeof response === "object" && response !== null && "error" in response) {
        throw new Error(String(response.error));
      }
    }
  } catch (error) {
    throw new Error(`${command} failed: ${error instanceof Error ? error.message : String(error)}; ${setupHint}`);
  }
}

type DeviceRunner = (command: string, args: string[]) => Promise<void>;

export class DeviceController {
  private timer: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly run: DeviceRunner = runDeviceCommand) {}

  async notification(title: string, body: string): Promise<void> {
    await this.run("termux-notification", ["--title", title, "--content", body]);
  }

  async vibrate(seconds: number): Promise<void> {
    await this.run("termux-vibrate", ["-d", String(Math.round(seconds * 1000))]);
  }

  flashlight(enabled: boolean, seconds?: number): Promise<void> {
    // serialize device-wide changes across sessions and execute tool instances.
    const action = this.queue.then(async () => {
      await this.run("termux-torch", [enabled ? "on" : "off"]);
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      if (enabled && seconds !== undefined) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.flashlight(false).catch((error: unknown) => console.error("flashlight auto-off failed:", error));
        }, Math.round(seconds * 1000));
        this.timer.unref();
      }
    });
    this.queue = action.catch(() => {});
    return action;
  }
}

const devices = new DeviceController();
const duration = z.number().finite().min(0.001).max(3600)
  .describe("Duration in seconds (0.001–3600); fractional seconds supported.");

export function registerDeviceTools(server: McpServer, controller = devices): void {
  const result = async (action: () => Promise<void>, text: string): Promise<CallToolResult> => {
    try {
      await action();
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  };

  server.registerTool("notification", {
    title: "Show notification",
    description: "Post an Android notification without root using Termux:API. Requires the termux-api package and compatible Termux:API android app with notification permission. " +
      "Both title (header) and body text are required and must be nonblank. Use for requested alerts, completion of long-running work, or important blockers needing attention, not routine progress. " +
      "Text may be visible on the lock screen; omit secrets and sensitive details. Returns after the API request succeeds, not proof the user saw it; Android settings may suppress display or sound.",
    inputSchema: {
      title: z.string().trim().min(1).describe("Required nonblank notification header text."),
      body: z.string().trim().min(1).describe("Required nonblank notification body text."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, ({ title, body }) => result(() => controller.notification(title, body), "notification requested"));

  server.registerTool("vibrate", {
    title: "Vibrate device",
    description: "Vibrate the phone without root using Termux:API. Requires the termux-api package and compatible Termux:API android app. " +
      "Power/strength control is not supported by this API. Silent mode may suppress vibration. Returns after the request, not after the vibration ends.",
    inputSchema: { duration_seconds: duration },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, ({ duration_seconds }) => result(() => controller.vibrate(duration_seconds), `vibration requested for ${duration_seconds} seconds`));

  server.registerTool("flashlight", {
    title: "Control flashlight",
    description: "Turn the flashlight on or off without root using Termux:API. Requires the termux-api package and compatible Termux:API android app. " +
      "Defaults to on. Optional duration_seconds schedules auto-off and returns immediately; omit it to stay on. " +
      "Use enabled=false to turn off (omit duration). A successful call replaces any previous auto-off timer, across all clients. " +
      "Auto-off requires this server to keep running; after a restart or crash, turn off manually if needed.",
    inputSchema: {
      enabled: z.boolean().optional().describe("Whether to enable the flashlight (default true)."),
      duration_seconds: duration.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, ({ enabled = true, duration_seconds }) => {
    if (!enabled && duration_seconds !== undefined) {
      return { isError: true, content: [{ type: "text", text: "duration_seconds is only valid when enabled=true" }] };
    }
    return result(() => controller.flashlight(enabled, duration_seconds), enabled
      ? duration_seconds === undefined ? "flashlight on until explicitly turned off" : `flashlight on; auto-off in ${duration_seconds} seconds`
      : "flashlight off");
  });
}
