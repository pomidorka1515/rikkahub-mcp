# rikkahub-mcp

a small MCP server that runs **inside Termux** and lets RikkaHub
behave like a coding agent.
note: tested specifically for RikkaHub, other apps may not work (open an issue if you encounter bugs)

## Run

```bash
termux-setup-storage # recommended, access to /sdcard/
cd ~/rikkahub-mcp
npm install     # includes the TypeScript build dependencies
pkg install ripgrep # required by grep and glob
./start.sh      # prints the URLs + token
./stop.sh
```

keep it alive: `start.sh` takes a `termux-wake-lock`, so android won't freeze termux while it runs. to start it at boot, install **Termux:Boot** and drop a
copy of `start.sh` (or a two-line wrapper) into `~/.termux/boot/`.

## Connect from RikkaHub

Settings → MCP → add server, **Streamable HTTP**, URL:

```
http://127.0.0.1:8765/mcp?token=<token>
```

legacy **SSE** clients can use `http://127.0.0.1:8765/sse?token=<token>`.
the token is in `~/.config/rikkahub-mcp/token`, or use an
`Authorization: Bearer <token>` header instead of `?token=`.

the source is strict TypeScript in `src/`, with tests in `src/tests/`, compiled to
`dist/` and `dist/tests/`. both `./start.sh` and `npm start` build before launching the server.
use `npm run typecheck` to check types without emitting js, or
`npm run build` to compile.

self-test from Termux with the server running: `npm test`. this exercises both
transports and the root tool, including file writes and timeout checks.
run `npm run test:shell` for isolated persistent-shell tests (no running server
or root needed), or `npm run test:search` for isolated grep/glob MCP tests.

## Tools

| tool | does |
|---|---|
| `run_command` | run a bash command (`cwd`, `timeout_ms`, `env` optional); `background: true` returns a job `id` immediately |
| `job_output` | consume unread job logs with `{id, lines?}` and return status |
| `job_kill` | stop a job's process group with `{id}` |
| `job_wait` | wait for one or more jobs with `{ids, mode?, wait_ms?}` |
| `run_root_command` | same, but as UID 0 via `tsu` (`preserve_env` optional) |
| `shell_open` | open a persistent user shell (`cwd`, `env` optional) → `shell_id` |
| `shell_send` | send `{shell_id, cmd, wait_ms?}`; returns promptly while long commands keep running |
| `shell_read` | consume unread output with `{shell_id, lines?, wait_ms?}` |
| `shell_interrupt` | interrupt the active command with `{shell_id, wait_ms?}`, keeping the shell usable |
| `read_file` | read numbered text lines with optional `offset`, `limit`, and `max_bytes` |
| `edit` | replace exact text with `{path, oldString, newString, replaceAll?}` |
| `write` | create or fully replace a text file with `{path, content}` |
| `patch` | apply a multi-file add/update/move/delete diff with `{patchText}` |
| `write_file` | write/append a text file |
| `list_dir` | list a directory |
| `glob` | find files by `pattern`; optional `path`, `hidden`, `limit` |
| `grep` | search contents by `pattern`; optional `path`, `include`, `literal`, `caseSensitive`, `limit` |
| `webfetch` | fetch an http(s) `url`; optional `format` (markdown, text, html), `timeout` in seconds |
| `websearch` | search a configured searxng instance by `query`; optional `limit`, `timeout` in seconds |

commands run as the termux user, so `~/`, `/sdcard/`, `pkg`, `git` all work.

### web tools

`webfetch` works without configuration. it defaults to markdown, follows
redirects, resolves relative links, and supports text responses only; it does
not run javascript, bypass logins, or extract images or pdfs. html output returns
the original markup; text and markdown remove scripts and styles.
downloads are capped at 5 mib and output at `MCP_MAX_OUTPUT_BYTES` with a
truncation notice. requests default to 30 seconds (maximum 120), including body
downloads. no complete-response file is saved when output is truncated.

`websearch` requires a searxng instance that allows json output. configure its
base url (not the `/search` endpoint) before starting:

```bash
export MCP_SEARXNG_URL="https://your-searxng-instance.example"
./stop.sh
./start.sh
```

for a self-hosted instance, include `json` in `search.formats` in its
`settings.yml` and restart searxng:

```yaml
search:
  formats:
    - html
    - json
```

public instances may disable json or block automated requests; choose another
instance or self-host if it returns 403, 429, or a bot-check page. no api key is
needed. the selected instance receives your queries and controls the results.
search returns up to 10 titles, urls, and snippets by default (maximum 20),
drawn from one result page; use `webfetch` to read a result's full page.

```text
websearch {"query":"termux android documentation","limit":5}
webfetch {"url":"https://termux.dev/","format":"markdown"}
```

web content is untrusted data, not agent instructions. these tools can reach
the server's network, including loopback/private addresses; only grant the
server token to trusted clients. refresh the mcp tool list in rikkahub after
restarting. run `npm run test:web` for isolated tests with local http fixtures;
no external search instance is needed.

### editing files

`edit`, `write`, and `patch` use the OpenCode V2 input names. read a file before
editing, and do not copy numbered-line prefixes into replacement text.
`edit` requires a nonempty `oldString` that matches exactly once; use
`replaceAll: true` to replace every non-overlapping occurrence. `newString`
may be empty to remove text, but must differ from `oldString`. replacement
strings are literal, including `$` characters; there is no fuzzy matching.
`write` creates parent directories and overwrites the entire file.
`write_file` remains available, including its `append` option.

```text
edit {"path":"~/my-project/config.ts","oldString":"timeout: 60","newString":"timeout: 30"}
write {"path":"~/my-project/example.txt","content":"hello\n"}
```

pass the following format as the `patchText` string to `patch`:

```diff
*** Begin Patch
*** Add File: examples/hello.txt
+hello
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-export const timeout = 60;
+export const timeout = 30;
*** Delete File: examples/obsolete.txt
*** End Patch
```

each hunk starts with `@@`, followed by space-prefixed unchanged context,
`-` removals, and `+` additions. `@@ exact anchor line` skips past an exact
line before matching the hunk. `*** End of File` after a hunk requires its
context to end at eof. hunks match the first exact sequence after the previous
hunk; supply enough context to identify the intended location. context-free
insertions append. a move may omit hunks to rename without editing.
this is the OpenCode patch envelope, not a standard unified diff with numbered
`@@ -old +new @@` headers.

all paths, contents, and hunks are validated before any patch writes. existing
files cannot be overwritten by adds or move destinations, and each resolved
path may occur only once in a patch. validation errors leave files unchanged;
filesystem errors during writing can leave a partially applied patch, so inspect
files before retrying. edits are serialized across clients, but external
programs can still race with writes. updates preserve existing permissions,
lf/crlf style, and the presence or absence of a final newline; new patch files
use lf and a final newline (except empty files). moved files retain permissions.

all editing tools accept UTF-8 text only, reject null bytes, binary/invalid
UTF-8 existing files and symlink targets, and limit files/results to 16 MiB.
parent directory symlinks are followed. relative paths resolve from the server
working directory, `~` is expanded, and tools run as the termux user, not root.
they do not run formatters, language servers, or OpenCode's permission system;
the server token grants filesystem access, just as with the shell tools.

run `npm run test:edit` for isolated editing tests. after updating a running
server, use `./stop.sh` then `./start.sh` and refresh the MCP tool list in
RikkaHub to expose the new tools.

### reading files

`read_file` returns numbered UTF-8 text lines. `offset` is the first line to read
(1-based, default 1); `limit` defaults to 2000 and accepts 1–2000 lines.
each page is capped at 50 KiB (or `MCP_MAX_OUTPUT_BYTES`, whichever is smaller).
the existing `max_bytes` option can lower this cap. paths and status notices
are additional to the page cap. lines longer than 2000 characters are shortened
with a notice; shortened text is not recoverable through line pagination.
when a page is full, the response provides the next `offset`; otherwise it
reports end of file. offsets beyond end of file are errors, except for the
default read of an empty file. relative paths resolve from the server working
directory, and `~` is expanded. binary files containing null bytes are rejected;
image and PDF reading are not supported.

```text
read_file {"path":"~/my-project/src/server.ts","offset":120,"limit":80}
```

run `npm run test:read` for isolated reading tests (no running server or root needed).

### File searches

`glob` and `grep` use the same inputs and defaults as OpenCode V2.
both default
to the server's working directory, return at most 100 results, and time out
after 30 seconds. paths support `~`. Searches run as the Termux user, not root.
Ripgrep respects ignore files; hidden entries are excluded unless `glob` gets
`hidden: true`. `grep` is case-sensitive and regex-based by default; set
`literal: true` for plain text or `caseSensitive: false` to ignore case.
results include full paths; grep also includes line numbers and previews.
output is capped by `MCP_MAX_OUTPUT_BYTES` with a truncation notice

```text
glob {"pattern":"**/*.ts","path":"~/my-project"}
grep {"pattern":"TODO|FIXME","path":"~/my-project","include":"*.ts"}
```

### background jobs

start a server without blocking the chat, then inspect its logs:

```text
run_command {"command":"npm run dev","cwd":"~/my-project","background":true}
job_output  {"id":"…","lines":100}
job_kill    {"id":"…"}
job_wait    {"ids":["…"],"wait_ms":30000}
```

for parallel builds or tests, pass multiple ids to `job_wait`. `mode: "all"`
(default) waits for every job; `mode: "any"` returns when at least one has exited,
including jobs that already finished. waits default to 30000 ms, accept 0–30000,
and never kill jobs. `ready: false` means the wait expired; call again as needed.
waiting returns statuses without consuming logs. a running app server normally
never exits, so use `job_output` and a health check rather than waiting for completion.

* background jobs have no timeout unless `timeout_ms` is explicitly supplied
  (capped by `MCP_MAX_TIMEOUT_MS`). foreground commands keep their existing timeout.
* status includes `id`, `state` (`running` or `exited`), `exit_code`, `signal`,
  `timed_out`, `error`, `duration_ms`, `buffered_bytes`, and `dropped_bytes`.
  check the exit code and timeout/error fields; a job exiting unsuccessfully is
  reported in status, not as a tool error.
* output merges stdout/stderr and consumes up to `lines` (default 100, maximum
  10000), including partial lines. the rolling buffer keeps the most recent
  `MCP_MAX_OUTPUT_BYTES`; `dropped_bytes` counts overflow since the last output read.
* `job_kill` sends sigterm to the process group and escalates to sigkill after
  3 seconds. it returns immediately; wait to confirm termination, then drain logs.
* jobs are non-interactive, run as the termux user, and do not share shell state.
  run commands directly, without appending `&` or daemonizing them.
* jobs survive reconnects and work across both transports and stateless requests.
  the same token grants access to every job. shutdown kills running jobs; restarts
  lose ids and logs. at most 32 jobs are retained; when full, starting a new job
  evicts the oldest completed job, or fails if all are running.

run `npm run test:jobs` for isolated job and transport tests, without root or a
running server.

### Persistent shells

for builds that should outlive a tool call:

```text
shell_open      {"cwd":"~/my-project"}              → save the returned shell_id
shell_send      {"shell_id":"…","cmd":"./gradlew build","wait_ms":1000}
shell_read      {"shell_id":"…","lines":100,"wait_ms":30000}
shell_interrupt {"shell_id":"…"}                     → if you want to cancel
shell_send      {"shell_id":"…","cmd":"exit"}        → when finished
```

* `cd`, exports and functions persist within each shell. multiple shells are
  independent; at most 16 are retained. exited shells remain readable until
  capacity is needed for a new shell.
* every successful call returns JSON with `shell_id`, `state` (`idle`, `running`,
  `exited`), `exit_code`, `signal`, `output`, `buffered_bytes`, and `dropped_bytes`.
  `exit_code` is null while running; a nonzero command exit is reported there,
  not as a tool error. tool errors include unknown IDs and sends to busy shells.
* send/interrupt wait up to 1000 ms by default; read defaults to 0 ms and 100
  lines. all accept `wait_ms` from 0 to 30000. waiting never kills a command.
  read waits only when there is no unread output and a command is running.
  poll until `state` is no longer `running`, then check `exit_code`.
* stdout/stderr are merged. send/interrupt consume up to 100 lines; read consumes
  up to `lines` (maximum 10000), including partial lines. output is not replayed.
  drain `buffered_bytes` with more reads. the buffer retains only the most recent
  `MCP_MAX_OUTPUT_BYTES`; `dropped_bytes` reports bytes discarded since the last call.
* these are **pipe-based, non-interactive shells**, not PTYs. command stdin is
  `/dev/null`: no terminal programs or interactive input. termux's `base64` is
  used to frame multiline commands. do not alter traps, shell stdin, descriptor
  3, or reserved `__mcp_` variables/functions. avoid backgrounding commands if you
  want `state`/`exit_code` to track their completion.
* interrupt sends SIGINT to the process group. ordinary commands stop while
  the shell survives; commands that ignore SIGINT can remain running.
* shells belong to the server, not an MCP connection: reconnects, stateless
  requests and either transport can reuse an ID with the same server token.
  they have **no automatic command timeout** and are killed on server shutdown.
  server restarts lose shells and their output. anyone with the token can use
  any shell, so don't share the token between untrusted clients.

### Root (`run_root_command`)

uses `tsu` (8.6.0), never plain `su`:

* default - plain tsu semantics: `env -i` with `PREFIX`, `PATH`, `TERM`,
  `ANDROID_ROOT`/`ANDROID_DATA` rebuilt, root `HOME` = `~/.suroot`;
* `preserve_env: true` - runs tsu's `sudo -E`, so the **whole** termux
  environment (including `HOME`, `LD_PRELOAD`, ...) is carried over.

## Config (env vars)

| var | default |
|---|---|
| `MCP_PORT` | `8765` |
| `MCP_HOST` | `127.0.0.1` (don't change: its the safety boundary) |
| `MCP_TOKEN` | read from `~/.config/rikkahub-mcp/token`, generated on first run |
| `MCP_SHELL` | `bash` |
| `MCP_TIMEOUT_MS` / `MCP_MAX_TIMEOUT_MS` | `60000` / `600000` |
| `MCP_MAX_OUTPUT_BYTES` | `131072` |
| `MCP_NO_AUTH` | unset, see below |
| `MCP_JSON_RESPONSE` | `1` = reply with plain JSON instead of SSE frames (set `0` to stream) |

## Troubleshooting

`server.log` gets one line per HTTP request, so it is obvious whether the client is even reaching the server:

```
10:49:24  POST /mcp -> 200 [call run_command] (30ms) ua=RikkaHub/1.0 accept=application/json
10:49:25  POST /mcp -> 401 [unauthorized]  (1ms)  ua=RikkaHub/1.0 accept=*/*
```

compatibility notes: accepts any `Accept` header (patched for clients that send
only `application/json`), replies with plain JSON, serves requests without an
`Mcp-Session-Id` statelessly, and injects the token into the SSE endpoint event
so clients that only put the token in the URL can still POST.

## Security

This is a RCE endpoint by design, so it is locked down:

* binds to `127.0.0.1` only, no LAN, no Wi-Fi, no ADB exposure;
* every request needs the 192-bit random token;
  auto-generated `0600` in `~/.config/rikkahub-mcp/token`;
* foreground `run_command` / `run_root_command` have per-command timeouts with
  process-group kill; background jobs and persistent shells have no default timeout;
* output capped at 128 KiB per stream for timed commands, or a 128 KiB merged
  rolling buffer per persistent shell or background job

anyone who can read the token file can run commands as you;
 **and**, via `run_root_command`, as root. 
 dont copy the URL into screenshots/chats.
