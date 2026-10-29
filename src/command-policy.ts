export const ROOT_COMMAND_ERROR = "sudo, su and tsu are blocked in regular command tools; use run_root_command or shell_open_root";

type Token = { value: string; operator?: boolean; quoted?: boolean };

/** lexical guard for explicit invocations, not a shell sandbox or an expansion evaluator. */
export function requireRegularCommand(command: string, depth = 0): void {
  if (depth > 64) throw new Error("command policy nesting limit exceeded");
  let i = 0;
  const source = command.replace(/\\\r?\n/g, "");
  const heredocs: { delimiter: string; quoted: boolean; tabs: boolean }[] = [];
  let heredoc: boolean | undefined;

  const scan = (stop?: string): Token[] => {
    const tokens: Token[] = [];
    while (i < source.length) {
      const c = source[i]!;
      if (c === stop) { i++; break; }
      if (/[^\S\n]/.test(c)) { i++; continue; }
      if (c === "#") {
        while (i < source.length && source[i] !== "\n") i++;
        continue;
      }
      if (c === "\n") {
        i++;
        tokens.push({ value: ";", operator: true });
        for (const doc of heredocs.splice(0)) {
          const start = i;
          let end = i;
          while (i < source.length) {
            end = i;
            const newline = source.indexOf("\n", i);
            const lineEnd = newline < 0 ? source.length : newline;
            const line = source.slice(i, lineEnd);
            i = newline < 0 ? source.length : newline + 1;
            if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
            end = i;
          }
          if (!doc.quoted) checkExpansions(source.slice(start, end), depth);
        }
        continue;
      }
      if (/[;&|()<>]/.test(c)) {
        i++;
        let value = c;
        if (source[i] === c && /[;&|<>]/.test(c)) value += source[i++];
        if (value === "<<" && source[i] === "<") value += source[i++];
        if (value === "<<" && source[i] === "-") value += source[i++];
        if ((c === ">" || c === "<") && source[i] === "&") value += source[i++];
        tokens.push({ value, operator: true });
        if (value === "<<" || value === "<<-") heredoc = value === "<<-";
        continue;
      }
      let value = "";
      let quote = "";
      let quoted = false;
      while (i < source.length) {
        const ch = source[i]!;
        if (!quote && /[\s;&|()<>]/.test(ch)) break;
        if (ch === "\\" && quote !== "'") {
          const next = source[i + 1];
          if (!quote || (next !== undefined && /[$`"\\]/.test(next))) {
            quoted = true;
            value += next ?? "";
            i += next === undefined ? 1 : 2;
            continue;
          }
        }
        if ((ch === "'" || ch === '"') && (!quote || quote === ch)) {
          quote = quote ? "" : ch;
          quoted = true;
          i++;
          continue;
        }
        if (quote !== "'" && ch === "$" && source[i + 1] === "(") {
          i += 2;
          // arithmetic is data; its nested command substitutions are still executable.
          if (source[i] === "(") {
            i++;
            const start = i;
            let balance = 1;
            while (i < source.length && balance) {
              if (source[i] === "(") balance++;
              if (source[i] === ")") balance--;
              i++;
            }
            checkExpansions(source.slice(start, i - 1), depth);
            if (source[i] === ")") i++;
          } else {
            checkTokens(scan(")"), depth + 1);
          }
          value += "$(...)";
          continue;
        }
        if (quote !== "'" && ch === "`") {
          i++;
          let script = "";
          while (i < source.length && source[i] !== "`") {
            if (source[i] === "\\" && /[$`\\]/.test(source[i + 1] ?? "")) i++;
            script += source[i++];
          }
          if (source[i] === "`") i++;
          requireRegularCommand(script, depth + 1);
          value += "`...`";
          continue;
        }
        value += ch;
        i++;
      }
      tokens.push({ value, quoted });
      if (heredoc !== undefined) {
        heredocs.push({ delimiter: value, quoted, tabs: heredoc });
        heredoc = undefined;
      }
    }
    return tokens;
  };
  checkTokens(scan(), depth);
}

function checkTokens(tokens: Token[], depth: number): void {
  let words: Token[] = [];
  let redirect = false;
  let header = false;
  let conditional = false;
  let arithmetic = 0;
  const cases: ("header" | "pattern" | "body")[] = [];
  const flush = () => {
    checkInvocation(words.map((token) => token.value), depth);
    words = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (arithmetic) {
      if (token.operator && token.value === "(") arithmetic++;
      if (token.operator && token.value === ")") arithmetic--;
      continue;
    }
    if (conditional) {
      if (!token.quoted && token.value === "]]") conditional = false;
      continue;
    }
    if (!words.length && !token.quoted && token.value === "[[") { conditional = true; continue; }
    if (token.operator && token.value === "(" && tokens[i + 1]?.value === "(") {
      flush();
      arithmetic = 2;
      i++;
      continue;
    }
    const caseState = cases[cases.length - 1];
    if (!token.quoted && token.value === "esac" && caseState) {
      flush();
      cases.pop();
      continue;
    }
    if (caseState === "header") {
      if (!token.quoted && token.value === "in") cases[cases.length - 1] = "pattern";
      continue;
    }
    if (caseState === "pattern") {
      if (token.operator && token.value === ")") cases[cases.length - 1] = "body";
      continue;
    }
    if (caseState === "body" && token.operator && [";;", ";&"].includes(token.value)) {
      flush();
      cases[cases.length - 1] = "pattern";
      continue;
    }
    if (token.operator) {
      if (/^[<>]/.test(token.value)) {
        // an adjacent numeric descriptor is not a command name.
        if (words.length === 1 && /^\d+$/.test(words[0]!.value)) words = [];
        redirect = true;
      } else {
        flush();
        redirect = false;
        header = false;
      }
      continue;
    }
    if (redirect) { redirect = false; continue; }
    if (!words.length && /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(token.value)) continue;
    if (!words.length && !token.quoted) {
      if (token.value === "case") { cases.push("header"); continue; }
      if (["for", "select"].includes(token.value)) { header = true; continue; }
      if (["if", "then", "elif", "else", "while", "until", "do", "done", "fi", "esac", "!", "{", "}"].includes(token.value)) continue;
      // a function name is a declaration, not an invocation.
      if (tokens[i + 1]?.value === "(" && tokens[i + 2]?.value === ")") continue;
    }
    if (!header) words.push(token);
  }
  flush();
}

function checkInvocation(words: string[], depth: number): void {
  const name = words[0]?.split("/").pop();
  if (!name) return;
  if (["sudo", "su", "tsu"].includes(name)) throw new Error(ROOT_COMMAND_ERROR);
  if (["command", "builtin", "exec", "env", "nohup"].includes(name)) {
    let i = 1;
    // command -v/-V only describes names; env without a command only prints data.
    while (i < words.length) {
      const word = words[i]!;
      if (word === "--") { i++; break; }
      if (name === "command" && /^-[p]*[vV][pvV]*$/.test(word)) return;
      if (name === "env" && ["--help", "--version"].includes(word)) return;
      if (["-u", "--unset", "-C", "--chdir", "-a"].includes(word)) { i += 2; continue; }
      if (word.startsWith("-") || /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(word)) { i++; continue; }
      break;
    }
    checkInvocation(words.slice(i), depth);
  } else if (["bash", "sh", "dash", "zsh", "ksh"].includes(name)) {
    for (let i = 1; i < words.length; i++) {
      const option = words[i]!;
      if (option === "--" || !option.startsWith("-")) break;
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(option)) {
        if (words[i + 1] !== undefined) requireRegularCommand(words[i + 1]!, depth + 1);
        break;
      }
      if (["-O", "-o", "--rcfile", "--init-file"].includes(option)) i++;
    }
  } else if (name === "eval") {
    requireRegularCommand(words.slice(1).join(" "), depth + 1);
  }
}

/** only expansions in startup filenames execute; ordinary environment values are data. */
export function requireRegularEnvironment(env: Record<string, string | undefined> = {}): void {
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (name === "BASH_ENV" || name === "ENV") checkExpansions(value, 0);
    if (name.startsWith("BASH_FUNC_") && name.endsWith("%%")) requireRegularCommand(value, 0);
  }
}

function checkExpansions(value: string, depth: number): void {
  // startup filenames and unquoted heredocs expand like double-quoted data.
  requireRegularCommand(`: "${value.replace(/"/g, '\\"')}"`, depth + 1);
}
