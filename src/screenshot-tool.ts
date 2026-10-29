import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { requireRootAccess, rootOutput } from "./root-access.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function registerScreenshotTool(server: McpServer): void {
  server.registerTool("screenshot", {
    title: "Screenshot",
    description: "Capture the current phone display as a native-resolution PNG image. Requires Termux root access via tsu. " +
      "Use directly (not inside execute) to receive the image. May include sensitive on-screen information; protected content may appear blank.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (): Promise<CallToolResult> => {
    try {
      await requireRootAccess();
      const png = await rootOutput("/system/bin/screencap -p");
      if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString("ascii", 12, 16) !== "IHDR") {
        throw new Error("screenshot capture did not return a valid PNG image");
      }
      return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
}
