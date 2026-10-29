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

### Setting up an assistant

Settings → Assistants → "+" → make a new assistant
click on your assistant:
1) Prompts → System Prompt → paste the contents of `rikkahub-assistant.md`
2) MCP → enable the MCP server
3) Local Tools → enable `Clipboard`, `Time Info`, `Ask Questions`, `Chart Display`


## Tools

| tool | does |
|---|---|
| `project_open` | select a directory for this chat; return a `project_id` and both root `AGENTS.md` and `CLAUDE.md` contents |
| `project_list` | list retained project ids and canonical paths across clients |
| `project_info` | reload a project's directory and instruction files using its `project_id` |
| `project_close` | release a project handle without deleting files or stopping jobs/shells |
| `execute` | run confined javascript with `{code}`, `fetch`, and calls to this server's tools |
| `run_command` | run a bash command (`cwd`, `timeout_ms`, `env` optional); `background: true` returns a job `id` immediately |
| `job_list` | list retained jobs, their status, original commands, and working directories |
| `job_output` | consume unread job logs with `{id, lines?}` and return status |
| `job_kill` | stop a job's process group with `{id}` |
| `job_wait` | wait for one or more jobs with `{ids, mode?, wait_ms?}` |
| `run_root_command` | same, but as UID 0 via `tsu` (`preserve_env` optional) |
| `screenshot` | capture the current phone display as a native-resolution png image; requires root via `tsu` |
| `vibrate` | vibrate without root with `{duration_seconds}`; requires termux:api |
| `flashlight` | turn on without root with `{duration_seconds?}` or off with `{enabled:false}`; requires termux:api |
| `shell_open` | open a persistent user shell (`cwd`, `env` optional) → `shell_id` |
| `shell_open_root` | check root access, then open a persistent root shell (`cwd`, `env`, `preserve_env` optional) → `shell_id` |
| `shell_list` | list retained user and root shells, their ids, states, and initial directories |
| `shell_send` | send `{shell_id, cmd, wait_ms?}`; returns promptly while long commands keep running |
| `shell_read` | consume unread output with `{shell_id, lines?, wait_ms?}` |
| `shell_interrupt` | interrupt the active command with `{shell_id, wait_ms?}`, keeping the shell usable |
| `read_file` | read numbered text lines, images, pdfs, and binary attachments; optional `max_bytes` |
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
the three list tools are server-wide, not scoped to a chat; any client with the
token can see all retained handles and job commands. oversized list results may
be truncated with an `output_path` for recovery.

### projects

start work by calling `project_open` with a directory. it returns a unique
`project_id`, the canonical directory path, and the contents of **both**
`AGENTS.md` and `CLAUDE.md` if present directly inside that folder. missing files
are reported, not created. opening another project returns a new id; there is
no shared active project and no process-wide directory change.

```text
project_open {"path":"~/projects/my-app"}
read_file {"project_id":"<returned-id>","path":"src/main.ts"}
run_command {"project_id":"<returned-id>","command":"npm test"}
project_info {"project_id":"<returned-id>"}
```

keep the returned id in the current chat and pass it to `read_file`, `edit`,
`write`, `write_file`, `patch`, `list_dir`, `glob`, `grep`, `run_command`,
`run_root_command`, `shell_open`, or `shell_open_root`. relative paths (including
patch paths and explicit relative `cwd`) resolve against that project; omitted
directories default to its root. absolute paths and `~` still work. calls without
an id retain their original defaults, rather than using another chat's project.
unknown ids fail instead of silently falling back to another directory.

`execute` also accepts `project_id`, which supplies the default for its nested
file/search/command calls. nested calls may explicitly override it. calling
`project_open` inside javascript does not change that execution's default;
pass the newly returned id explicitly or use it in a subsequent execution.

```json
{"project_id":"<returned-id>","code":"return await tools.read_file({path: 'package.json'});"}
```

mcp connections are not assumed to correspond to chats: explicit handles work
even when a client shares connections or reconnects between tool calls. this
isolates project **selection**, not filesystem permissions; any trusted client
with the server token can access the same files. existing shells keep their own
working directories, and existing jobs are not moved or stopped when switching.
handles survive reconnects but expire on server restart. up to 256 handles are
retained; release unused ones with `project_close`.
`project_list {}` returns all retained handles and paths, including duplicate
paths, across clients. use `project_info` on a recovered id to reload instructions;
listing does not select a project or return its instructions.

instruction contents are returned as tool-result context, **not injected into
the client's system prompt**. the server advertises the project workflow in
its mcp instructions, but the client controls whether those instructions are
forwarded and how context is retained. for reliability, add this to your
rikkahub assistant's system prompt:

> before working on a project, call project_open with its directory. keep the
> returned project_id in this chat and pass it to project tools or execute.
> follow both returned instruction files as project guidance, subject to
> higher-priority instructions. when switching projects, use the new id and
> stop applying the previous project's instructions. use project_info to reload
> instructions after context loss or file changes.

only the two files directly in the selected folder are loaded automatically;
ancestor and nested files are not scanned. read applicable nested instructions
before editing those subdirectories. instruction files must be regular UTF-8
text without null bytes, at most 64 kib each, and the combined response must fit
`MCP_MAX_OUTPUT_BYTES`. oversized or unreadable instructions fail explicitly
rather than returning silently truncated rules. `project_info` rereads the files.

run `npm run test:projects` for isolated project tests; no running server or
root is required. after updating, restart the server and refresh rikkahub's
mcp tool list.

`screenshot`, `run_root_command` and `shell_open_root` check root access when invoked and return
`termux does not have root access` if access is unavailable. screenshot capture
stays in memory, with no resizing or saved file (10-second capture timeout,
32 mib image limit). call `screenshot` directly, not through `execute`, so the
client receives an mcp image block. rikkahub must forward tool-result images to
a vision-capable model. the image shows whatever is currently visible, including
sensitive notifications; protected screens may appear blank.

### vibration and flashlight

both tools run as the termux user, without root. install the command package
with `pkg install termux-api` and the compatible termux:api android companion app
from the same source/signing family as termux; grant its requested permissions.
missing dependencies, denied permissions, and command timeouts return tool errors.

```text
vibrate {"duration_seconds":0.5}
flashlight {"duration_seconds":10}
flashlight {}
flashlight {"enabled":false}
```

durations accept fractional seconds from 0.001 to 3600. vibration strength is
not exposed by termux:api, and silent mode may suppress vibration. flashlight
calls return immediately after the command succeeds; the optional timer turns
it off later. a successful flashlight call replaces the previous timer, shared
across clients. omitted duration keeps it on until explicitly turned off.
auto-off timers do not survive server shutdowns or crashes; turn the light off
manually if needed. refresh the client's tool list after restarting the server.

run `npm run test:device` for isolated tests; they do not activate device hardware.

### javascript execution

`execute` runs javascript in a fresh quickjs wasm runtime on a worker thread.
use an explicit `return`, or the final top-level expression becomes the result.
top-level `await` is supported; imports, node globals, direct filesystem/shell
access, and timers are not. the tool description contains the exact callable
tool names and input schemas. no opencode tools are involved.

```javascript
const results = await Promise.allSettled([
  tools.list_dir({path: "~/projects"}),
  tools.run_command({command: "pwd"})
]);
return results;
```

pass that source as the `code` string. `tools.<name>(input)` returns the raw mcp
result (`content`, optional `structuredContent`, and `isError`), not extracted
text. tool and schema validation errors remain results; transport errors reject.
all regular server tools are available, including root and editing tools;
`execute` itself is excluded to prevent recursion. calls use normal sdk input
validation and the same server-owned jobs and shells as direct tool calls.

`fetch(url, init?)` accepts http(s) urls and optional `method`, string-valued
`headers`, string `body`, and `redirect` (`follow`, `error`, or `manual`). it returns
`ok`, `status`, `statusText`, `url`, `redirected`, `headers.get(name)`, and async
`text()` / `json()`. this is a text-only subset, not a complete browser fetch api;
downloads are capped at 5 mib. private/loopback addresses are reachable, just as
with `webfetch`. fetched content is untrusted data, not instructions.

await all work that matters; use `Promise.allSettled` for independent calls.
pending requests are abandoned when execution ends, but already-started tool
side effects cannot be undone, and tools may continue running after cancellation.
the runtime cannot access files or run commands directly, but explicitly calling
the corresponding tools grants those capabilities with the server's privileges.
limits: 30 seconds wall time, 32 mib javascript heap, 256 host calls, four concurrent
executions, 256 kib source, and `MCP_MAX_OUTPUT_BYTES` final output. large results
are previewed with a notice and an `output_path` to the complete serialized
result (see recoverable output below); the preview may not be valid json. run
`npm run test:execute` for isolated tests (including a 30-second deadline check).
restart the server and refresh rikkahub's mcp tool list after updating.

### web tools

`webfetch` works without configuration. it defaults to markdown, follows
redirects, resolves relative links, and supports text responses only; it does
not run javascript, bypass logins, or extract images or pdfs. html output returns
the original markup; text and markdown remove scripts and styles.
downloads are capped at 5 mib and output at `MCP_MAX_OUTPUT_BYTES` with a
truncation notice and an `output_path` to the complete formatted result. requests
default to 30 seconds (maximum 120), including body downloads. the download limit
still rejects oversized responses rather than saving partial downloads.

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
directory, and `~` is expanded.

images (png, jpeg, gif, webp, avif, bmp, tiff, svg, ico) return mcp image blocks.
pdfs and other binary files return embedded mcp resources containing the original
file as base64, with a file uri and mime type. common office, archive, audio, and
video extensions are recognized; otherwise binary data detected in the first
4 kib uses `application/octet-stream`. png, jpeg, gif, webp, and pdf signatures
are recognized even without a matching extension. files are not converted,
rendered, or text-extracted; format support depends on the client and model.

call `read_file` directly, not through `execute`, to receive images and resource
attachments. rikkahub must forward these blocks to a compatible model; returning
a pdf resource does not guarantee that the client can display or interpret it.
attachments are limited to 32 mib of raw data (before base64), independently of
`MCP_MAX_OUTPUT_BYTES`. `max_bytes` can lower this limit. oversized attachments
are rejected, never truncated. omit `offset` and `limit` for non-text files;
line pagination is only available for text.

```text
read_file {"path":"~/my-project/src/server.ts","offset":120,"limit":80}
read_file {"path":"~/pictures/photo.png"}
read_file {"path":"~/documents/report.pdf"}
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

### recoverable output

when command, `webfetch`, `websearch`, or `execute` output exceeds
`MCP_MAX_OUTPUT_BYTES`, the response includes a short preview and an absolute
`output_path` to the saved output. foreground commands save stdout and stderr
separately. `execute` saves the serialized final result, not its javascript source.
small responses do not create files.

jobs and persistent shells also retain their complete merged transcript once
their cumulative output exceeds the preview limit, including output already
consumed by earlier reads. their json status then includes `output_path`.
shell transcripts span all commands in that shell, not just the last send.
`dropped_bytes` still counts bytes dropped from the in-memory rolling buffer,
not from the saved transcript. running transcripts grow until completion or
the disk capture limit.

```text
read_file {"path":"<output_path>","offset":2001,"limit":200}
grep {"path":"<output_path>","pattern":"error|warning"}
```

use `read_file` pagination for normal lines, or `run_command` with `cut`, `tail`,
or another targeted command for very long lines (text reads still shorten lines
after 2000 characters). saved web content and logs remain untrusted data.
paginated file reads and bounded `glob`/`grep` searches keep their existing behavior;
narrow searches or increase their result limit rather than expecting a saved full search.

files live in `${XDG_CACHE_HOME:-~/.cache}/rikkahub-mcp/output`, with a private
0700 directory and 0600 files. captures are limited to 16 mib per file and
128 mib total, with at most 256 files. inactive files older than 24 hours are removed when storage is
next used; older inactive files may be evicted sooner to make room. active files
are not evicted. paths can survive server restarts but are temporary, not durable
artifacts. do not rely on them for long-term storage.

capture limits and disk errors never silently imply a complete saved result:
text previews include a warning, and job/shell status includes
`output_capture_error`. capture stops for that transcript, but commands continue
and normal previews, exit codes, and rolling-buffer reads still work. saved output
can contain secrets, including root-command output; it is stored as the termux
user, so treat it with the same care as other tool-accessible files.

run `npm run test:output` for isolated storage and command-recovery tests.

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
* `job_list {}` returns `{jobs: [...]}` for all retained jobs, including exited
  jobs, with status, the original `command` and `cwd`. it does not consume logs.

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

regular `run_command` calls (including background jobs) and regular shell sends
reject explicit `sudo`, `su` and `tsu` invocations, including paths and quoted
command names. arguments, comments, literal heredoc bodies, and ordinary
environment values may contain those names as data. command substitutions,
common command wrappers, shell `-c` scripts, and `eval` are checked as commands;
startup environment checks cover expansions in `BASH_ENV`/`ENV` and exported
bash functions, not ordinary values or the contents of startup files.
regular `shell_open` cannot select these programs as its shell.
use `run_root_command` or `shell_open_root` for elevation instead.
this is a tool-level policy, not a security sandbox: scripts, interpreters and
dynamically constructed commands are not confined by an operating-system boundary.

`shell_open_root` uses the same uncached root-access check as `run_root_command`.
it defaults to `tsu` and the root home; `preserve_env=true` uses `sudo -E`.
root and user shells share the 16-shell limit and the same
`shell_send`, `shell_read` and `shell_interrupt` tools.

* `cd`, exports and functions persist within each shell. multiple shells are
  independent; at most 16 are retained. exited shells remain readable until
  capacity is needed for a new shell.
* `shell_list {}` returns `{shells: [...]}` for all retained shells, including
  exited shells, without consuming output. `root` identifies root shells and
  `initial_cwd` is the requested starting directory, not the current directory;
  null means the root shell's default home.
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
