// The bridge between the page and `neuron-engine mcp`: a browser cannot speak
// stdio, so this middleware owns one MCP session and turns it into a few
// HTTP endpoints plus a Server-Sent Events stream per run.
//
//   GET  /api/networks                 network and inputs files under the examples directory
//   GET  /api/describe?file=…          describe_network
//   POST /api/run {file, inputs}       start_run (keep_trace), answers {job_id}
//   GET  /api/jobs/:id/stream          SSE: `state` while it runs, then `done` with the trace's events
//
// Every file is named relative to the agent-neuron checkout (the server's
// working directory) and must stay inside it.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { McpClient, type Notification } from "./mcp-client.ts";

export interface BridgeOptions {
  /** The agent-neuron checkout: the MCP server's working directory. */
  root: string;
  /** The `neuron-engine` binary. */
  engine: string;
  /** Directories under root listed by /api/networks. */
  examples?: string[];
}

type Next = (err?: unknown) => void;

export function createBridge(opts: BridgeOptions) {
  const root = path.resolve(opts.root);
  const examples = opts.examples ?? ["spec/examples"];
  let client: Promise<McpClient> | undefined;

  function mcp(): Promise<McpClient> {
    if (!client) {
      client = McpClient.start({ command: opts.engine, cwd: root }).then((c) => {
        c.on("log", (l: string) => process.stderr.write(`[neuron-engine] ${l}`));
        c.on("exit", () => (client = undefined));
        return c;
      });
      client.catch(() => (client = undefined));
    }
    return client;
  }

  function inside(file: unknown): string {
    if (typeof file !== "string" || !file) throw new HttpError(400, "a file is needed");
    const abs = path.resolve(root, file);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(400, "the file must be inside the agent-neuron checkout");
    return path.relative(root, abs);
  }

  async function networks() {
    const out = { networks: [] as string[], inputs: [] as string[] };
    for (const dir of examples) {
      const names = await readdir(path.join(root, dir)).catch(() => [] as string[]);
      for (const n of names.sort()) {
        if (n.endsWith(".network.json")) out.networks.push(path.join(dir, n));
        else if (n.endsWith(".inputs.jsonl")) out.inputs.push(path.join(dir, n));
      }
    }
    return out;
  }

  async function describe(file: string) {
    const c = await mcp();
    return c.callTool("describe_network", { file: inside(file) });
  }

  async function run(body: { file?: unknown; inputs?: unknown; timeout_ms?: unknown }) {
    const file = inside(body.file);
    const inputsFile = inside(body.inputs);
    const text = await readFile(path.join(root, inputsFile), "utf8");
    const inputs = text
      .split("\n")
      .filter((l) => l.trim())
      .map((l, i) => {
        try {
          return JSON.parse(l);
        } catch {
          throw new HttpError(400, `${inputsFile}:${i + 1} is not JSON`);
        }
      });
    const timeout = typeof body.timeout_ms === "number" ? body.timeout_ms : 60000;
    const c = await mcp();
    return c.callTool("start_run", { file, inputs, keep_trace: true, timeout_ms: timeout });
  }

  async function stream(jobId: string, req: IncomingMessage, res: ServerResponse) {
    const c = await mcp();
    const uri = `run://${jobId}`;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let ended = false;
    let reading = false;
    let dirty = false;

    const finish = () => {
      if (ended) return;
      ended = true;
      c.off("notification", onNote);
      c.request("resources/unsubscribe", { uri }).catch(() => {});
      res.end();
    };

    const refresh = async (): Promise<void> => {
      if (ended) return;
      if (reading) {
        dirty = true;
        return;
      }
      reading = true;
      try {
        const state = await c.readJson<{ status: string; trace_path?: string; [k: string]: unknown }>(uri);
        if (state.status === "running") {
          send("state", state);
        } else {
          let traceEvents: unknown[] | undefined;
          if (state.trace_path) {
            const t = await c.callTool<{ events?: unknown[] }>("read_trace", { path: state.trace_path });
            if (!t.isError) traceEvents = t.body.events;
          }
          send("done", { ...state, trace_events: traceEvents });
          finish();
          return;
        }
      } catch (e) {
        send("error", { message: (e as Error).message });
        finish();
        return;
      } finally {
        reading = false;
      }
      if (dirty) {
        dirty = false;
        void refresh();
      }
    };

    const onNote = (n: Notification) => {
      if (n.method === "notifications/resources/updated" && n.params?.uri === uri) void refresh();
    };
    c.on("notification", onNote);
    req.on("close", finish);
    try {
      await c.request("resources/subscribe", { uri });
    } catch (e) {
      send("error", { message: (e as Error).message });
      finish();
      return;
    }
    await refresh();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;
    if (req.method === "GET" && url.pathname === "/api/networks") return json(res, 200, await networks()), true;
    if (req.method === "GET" && url.pathname === "/api/describe") {
      const r = await describe(url.searchParams.get("file") ?? "");
      return json(res, 200, r), true;
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      const r = await run(await readBody(req));
      return json(res, 200, r), true;
    }
    const m = url.pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)\/stream$/);
    if (req.method === "GET" && m) return await stream(m[1], req, res), true;
    return json(res, 404, { error: "no such endpoint" }), true;
  }

  return {
    /** Connect-style middleware, for Vite's dev and preview servers. */
    middleware(req: IncomingMessage, res: ServerResponse, next: Next) {
      handle(req, res)
        .then((done) => {
          if (!done) next();
        })
        .catch((e) => {
          if (res.headersSent) return res.end();
          json(res, e instanceof HttpError ? e.status : 500, { error: (e as Error).message });
        });
    },
    async close() {
      if (client) (await client.catch(() => undefined))?.close();
    },
  };
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "the body is not JSON");
  }
}
