// Attach: the bridge follows a demo harness's runs/current.json. A real run
// of the engine's command line (a small invented network, with --stream and
// --trace) stands in for a demo; the manifest names its files.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBridge } from "../bridge/api.ts";

const root = path.resolve(process.env.AGENT_NEURON_ROOT ?? path.join(import.meta.dirname, "../../agent-neuron"));
const engine = process.env.NEURON_ENGINE ?? path.join(root, "rust-engine/target/debug/neuron-engine");
const ready = existsSync(engine);

let demos = "";
let server: Server;
let base = "";
let bridge: ReturnType<typeof createBridge>;

beforeAll(async () => {
  if (!ready) return;
  demos = mkdtempSync(path.join(tmpdir(), "viz-attach-"));
  const run = path.join(demos, "runs", "tiny");
  mkdirSync(run, { recursive: true });
  const network = path.join(run, "tiny.network.json");
  writeFileSync(
    network,
    JSON.stringify({
      version: 0,
      name: "tiny",
      description: "a source, an echo and a quiet one",
      neurons: [
        { id: "in", description: "in", source: true },
        { id: "echo", description: "echo", run: ["cat"], effect: true },
        { id: "end", description: "end", run: ["true"] },
      ],
      links: [
        { from: "in", to: "echo" },
        { from: "echo", to: "end" },
      ],
    }),
  );
  const inputs = path.join(run, "tiny.inputs.jsonl");
  writeFileSync(inputs, '{"at": 0, "source": "in", "payload": "one"}\n{"at": 50, "source": "in", "payload": "two"}\n');
  const stream = path.join(run, "stream.jsonl");
  const trace = path.join(run, "trace.json");
  const r = spawnSync(engine, ["run", network, "--inputs", inputs, "--stream", stream, "--trace", trace], { cwd: run });
  expect(r.status).toBe(0);
  writeFileSync(
    path.join(demos, "runs", "current.json"),
    JSON.stringify({ demo: "tiny", title: "Tiny", network, stream, trace, started: Date.now() - 1000, ended: true, code: 0, people: [] }),
  );
  bridge = createBridge({ root, engine, demos });
  server = createServer((req, res) => bridge.middleware(req, res, () => res.writeHead(404).end()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  if (!ready) return;
  await bridge.close();
  await new Promise((r) => server.close(r));
  rmSync(demos, { recursive: true, force: true });
});

/** SSE records until `until` arrives (the attach stream never ends by itself). */
async function sseUntil(url: string, until: string): Promise<{ event: string; data: any }[]> {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal });
  const reader = res.body!.getReader();
  const out: { event: string; data: any }[] = [];
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    const blocks = text.split("\n\n");
    text = blocks.pop() ?? "";
    for (const b of blocks) {
      const event = /^event: (.*)$/m.exec(b)?.[1] ?? "message";
      out.push({ event, data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? "null") });
      if (event === until) {
        ac.abort();
        return out;
      }
    }
  }
  return out;
}

describe.skipIf(!ready)("attach", () => {
  it("follows the announced run: its shape, its stream, then the trace", async () => {
    const records = await sseUntil(`${base}/api/attach`, "done");
    const kinds = records.map((r) => r.event);
    expect(kinds[0]).toBe("waiting");
    const run = records.find((r) => r.event === "run")!;
    expect(run.data.manifest.demo).toBe("tiny");
    const net = run.data.describe.body.network;
    expect(net.neurons.find((n: { id: string }) => n.id === "echo").effect).toBe(true);
    const streamed = records.filter((r) => r.event === "events").flatMap((r) => r.data.events);
    const done = records.at(-1)!;
    expect(done.event).toBe("done");
    // The stream is the trace, event for event (SPEC 9.1).
    expect(streamed.length).toBe(done.data.trace_events.length);
    expect(streamed.some((e: { type: string }) => e.type === "answer")).toBe(true);
  }, 20000);

  it("refuses a manifest that names a file outside the demos checkout", async () => {
    const manifest = path.join(demos, "runs", "current.json");
    writeFileSync(manifest, JSON.stringify({ demo: "x", network: "/etc/hosts", stream: "/etc/hosts", trace: "/etc/hosts", started: 1, ended: true }));
    const records = await sseUntil(`${base}/api/attach`, "problem");
    expect(records.at(-1)!.data.message).toMatch(/outside the demos checkout/);
  }, 20000);
});
