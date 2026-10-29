import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OutputCapture } from "./output-store.js";

export const outputMetadataSchema = {
  output_path: z.string().optional(),
  output_capture_error: z.string().optional(),
};

/** oversized objects are replaced by recovery metadata, never an unbounded second copy. */
export function boundedOutputSchema<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).partial().extend({
    truncated: z.literal(true).optional().describe("when true, payload fields are omitted; recover the serialized object from output_path"),
    ...outputMetadataSchema,
  }).describe("successful results contain the payload fields; oversized results contain only truncated=true and available recovery metadata");
}

/** retain the legacy text representation alongside machine-readable fields. */
export function jsonResult(value: object, maxBytes: number, text = JSON.stringify(value)): CallToolResult {
  const capture = new OutputCapture(maxBytes);
  capture.append(text);
  capture.finish();
  return {
    content: [{ type: "text", text: capture.text() }],
    structuredContent: Buffer.byteLength(text) > maxBytes
      ? { truncated: true, ...capture.metadata() }
      : JSON.parse(JSON.stringify(value)) as Record<string, unknown>,
  };
}

export const jobStatusSchema = z.object({
  id: z.string(), state: z.enum(["running", "exited"]), exit_code: z.number().nullable(),
  signal: z.string().nullable(), timed_out: z.boolean(), error: z.string().nullable(),
  duration_ms: z.number(), buffered_bytes: z.number(), dropped_bytes: z.number(),
  ...outputMetadataSchema,
});

export const shellSnapshotSchema = z.object({
  shell_id: z.string(), state: z.enum(["idle", "running", "exited"]),
  exit_code: z.number().nullable(), signal: z.string().nullable(), output: z.string(),
  buffered_bytes: z.number(), dropped_bytes: z.number(), ...outputMetadataSchema,
});
