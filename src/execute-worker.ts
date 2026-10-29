import { parentPort, workerData } from "node:worker_threads";
import { getQuickJS, type QuickJSDeferredPromise } from "quickjs-emscripten";
import { parse } from "acorn";

const port = parentPort!;
const { code, names, timeoutMs } = workerData as { code: string; names: string[]; timeoutMs: number };
const engine = await getQuickJS();
const runtime = engine.newRuntime();
runtime.setMemoryLimit(32 * 1024 * 1024);
runtime.setMaxStackSize(512 * 1024);
const deadline = Date.now() + timeoutMs;
runtime.setInterruptHandler(() => Date.now() >= deadline);
const context = runtime.newContext();
const pending = new Map<number, QuickJSDeferredPromise>();
let nextId = 0;

function pump(): void {
  const result = runtime.executePendingJobs();
  if (result.error) {
    const error = context.dump(result.error);
    result.error.dispose();
    throw new Error(JSON.stringify(error));
  }
}

port.on("message", (message: { id: number; value?: unknown; error?: string }) => {
  const deferred = pending.get(message.id);
  if (!deferred) return;
  pending.delete(message.id);
  try {
    const value = context.newString(JSON.stringify(message.value ?? null));
    if (message.error) {
      const error = context.newError(message.error);
      deferred.reject(error);
      error.dispose();
    } else deferred.resolve(value);
    value.dispose();
    deferred.dispose();
    pump();
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : String(error), done: true });
  }
});

try {
  const bridge = context.newFunction("bridge", (kind, name, args) => {
    const id = ++nextId;
    const deferred = context.newPromise();
    pending.set(id, deferred);
    port.postMessage({ id, kind: context.getString(kind), name: context.getString(name), args: context.getString(args) });
    return deferred.handle;
  });
  context.setProp(context.global, "__bridge", bridge);
  bridge.dispose();
  const setup = context.evalCode(`
    const tools = Object.freeze(Object.fromEntries(${JSON.stringify(names)}.map(name =>
      [name, async (input = {}) => JSON.parse(await __bridge("tool", name, JSON.stringify(input)))])));
    const fetch = async (url, init = {}) => {
      const response = JSON.parse(await __bridge("fetch", String(url), JSON.stringify(init)));
      return Object.freeze({ ...response,
        text: async () => response.body,
        json: async () => JSON.parse(response.body),
        headers: Object.freeze({ get: name => response.headers[String(name).toLowerCase()] ?? null })
      });
    };
  `);
  context.unwrapResult(setup).dispose();
  // parse only to identify the final top-level expression; execution stays inside quickjs.
  const ast = parse(code, { ecmaVersion: "latest", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  const last = ast.body.at(-1);
  let source = code;
  if (last?.type === "ExpressionStatement") {
    source = code.slice(0, last.start) + "return (" + code.slice(last.expression.start, last.expression.end) + ");" + code.slice(last.end);
  }
  const handle = context.unwrapResult(context.evalCode(`(async () => {\n${source}\n})()`));
  const completion = context.resolvePromise(handle);
  pump();
  const result = await completion;
  const value = context.unwrapResult(result);
  port.postMessage({ done: true, value: context.dump(value) ?? null });
  value.dispose();
  handle.dispose();
} catch (error) {
  port.postMessage({ done: true, error: error instanceof Error ? error.message : String(error) });
} finally {
  for (const deferred of pending.values()) deferred.dispose();
  context.dispose();
  runtime.dispose();
  port.close();
}
