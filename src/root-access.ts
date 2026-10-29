import { spawn } from "node:child_process";

export type RootMode = "tsu" | "sudo";
export const ROOT_ACCESS_ERROR = "termux does not have root access";

/** collect root command output as bytes without text conversion or truncation. */
export function rootOutput(script: string, mode: RootMode = "tsu", timeoutMs = 10_000, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(mode, mode === "sudo" ? ["-E", "bash"] : [], {
      detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let done = false;
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        try { process.kill(-child.pid!, "SIGKILL"); } catch {}
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        reject(error);
      } else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => finish(new Error("root operation timed out")), timeoutMs);
    child.on("error", (error) => finish(error));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) finish(new Error("root output exceeds byte limit"));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8").slice(0, 4096 - stderr.length);
    });
    child.on("close", (code) => finish(code === 0 ? undefined : new Error(stderr.trim() || `root operation failed (exit ${code})`)));
    child.stdin.end(script + "\n");
  });
}

/** verify privileges on each invocation; never cache grants or denials. */
export async function requireRootAccess(mode: RootMode = "tsu"): Promise<void> {
  try {
    const uid = await rootOutput("id -u", mode, 10_000, 4096);
    if (uid.toString("utf8").trim() !== "0") throw new Error(ROOT_ACCESS_ERROR);
  } catch {
    throw new Error(ROOT_ACCESS_ERROR);
  }
}
