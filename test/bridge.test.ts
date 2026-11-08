// The bridge against the real engine: `neuron-engine mcp` from the sibling
// agent-neuron checkout (build it with `cargo build` in rust-engine first).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { createBridge } from "../bridge/api.ts";

const root = path.resolve(process.env.AGENT_NEURON_ROOT ?? path.join(import.meta.dirname, "../../agent-neuron"));
const engine = process.env.NEURON_ENGINE ?? path.join(root, "rust-engine/target/debug/neuron-engine");
const ready = existsSync(engine);

let server: Server;
let base = "";
let bridge: ReturnType<typeof createBridge>;

beforeAll(async () => {
  if (!ready) return;
  bridge = createBridge({ root, engine });
  server = createServer((req, res) => bridge.middleware(req, res, () => res.writeHead(404).end()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  if (!ready) return;
  await bridge.close();
  await new Promise((r) => server.close(r));
});

/** Read an SSE stream to its end, as {event, data} records. */
async function sse(url: string): Promise<{ event: string; data: any }[]> {
  const res = await fetch(url);
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) => {
      const event = /^event: (.*)$/m.exec(b)?.[1] ?? "message";
      const data = JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? "null");
      return { event, data };
    });
}

describe.skipIf(!ready)("the MCP bridge", () => {
  it("lists the spec's example networks and inputs", async () => {
    const r = await (await fetch(`${base}/api/networks`)).json();
    expect(r.networks).toContain("spec/examples/alerts.network.json");
    expect(r.inputs).toContain("spec/examples/alerts.inputs.jsonl");
  });

  it("describes a network with its composed neuron inside", async () => {
    const r = await (await fetch(`${base}/api/describe?file=spec/examples/alerts.network.json`)).json();
    expect(r.isError).toBe(false);
    const net = r.body.network;
    expect(net.name).toBe("alerts");
    const diagnosis = net.neurons.find((n: { id: string }) => n.id === "diagnosis");
    expect(diagnosis.kind).toBe("composed");
    expect(diagnosis.network.entry).toBe("topology");
  });

  it("refuses a file outside the checkout", async () => {
    const r = await fetch(`${base}/api/describe?file=../../etc/hosts`);
    expect(r.status).toBe(400);
  });

  it("runs a network and streams it to the end, with the trace's events", async () => {
    const start = await (
      await fetch(`${base}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "spec/examples/alerts.network.json", inputs: "spec/examples/alerts.inputs.jsonl" }),
      })
    ).json();
    expect(start.isError).toBe(false);
    const job = start.body.job_id as string;
    expect(job).toBeTruthy();
    const records = await sse(`${base}/api/jobs/${job}/stream`);
    const done = records.at(-1)!;
    expect(done.event).toBe("done");
    expect(done.data.status).toBe("done");
    const events = done.data.trace_events as { type: string; t: number }[];
    expect(events.length).toBeGreaterThan(50);
    expect(events.some((e) => e.type === "signal")).toBe(true);
    expect(events.at(-1)!.type).toBe("finished");
    // Live states, if any arrived, only ever grow.
    const sizes = records.filter((r) => r.event === "state").map((r) => r.data.events_so_far.length);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
  }, 30000);
});
