export const ROOT_COMMAND_ERROR = "sudo, su and tsu are blocked in regular command tools; use run_root_command or shell_open_root";

/** reject explicit elevation names, including paths and shell quoting, before execution. */
export function requireRegularCommand(command: string): void {
  const normalized = command.replace(/\\\r?\n/g, "").replace(/[\\'"]/g, "");
  if (/(^|[^a-zA-Z0-9_])(sudo|su|tsu)(?=$|[^a-zA-Z0-9_])/.test(normalized)) {
    throw new Error(ROOT_COMMAND_ERROR);
  }
}

/** startup hooks are executable commands too. */
export function requireRegularEnvironment(env: Record<string, string | undefined> = {}): void {
  for (const value of Object.values(env)) {
    if (value !== undefined) requireRegularCommand(value);
  }
}
