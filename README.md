# agent-neuron-viz

Neuron Space: a 3D view of [agent-neuron](../agent-neuron) networks, driven
by the Rust engine over MCP. Pick a network file and it is drawn in 3D before
any traffic. Run it and the events play across the links as they happen, then
replay from the kept trace with a scrubber.

```
browser (three.js) ── HTTP + SSE ──▶ bridge (Vite middleware) ── stdio JSON-RPC ──▶ neuron-engine mcp
```

A browser cannot speak stdio, so the bridge in `bridge/` starts one
`neuron-engine mcp` child and turns it into a few endpoints. The bridge reads
only the inputs file from disk; everything about a network comes from the
engine:

| Page asks for | Bridge calls (MCP) |
|---|---|
| `GET /api/describe?file=` | `describe_network`: neurons, links, composed networks nested |
| `POST /api/run` | `start_run` with `keep_trace: true` |
| `GET /api/jobs/:id/stream` (SSE) | `resources/subscribe run://{id}`, then `resources/read` on each `notifications/resources/updated`; at the end `read_trace` on the kept trace |

`describe_network` is the sixth MCP tool, added to the Rust engine for this
project (agent-neuron branch `feat/describe-network`).

## Run it

```sh
# 1. Build the engine (agent-neuron checked out next to this repo, on a branch with describe_network)
(cd ../agent-neuron/rust-engine && cargo build)

# 2. Start the page
npm install
npm run dev            # http://localhost:5180
```

`AGENT_NEURON_ROOT` (default `../agent-neuron`) sets the checkout whose
`spec/examples` are listed and which is the engine's working directory;
`NEURON_ENGINE` overrides the binary. `PORT` sets the dev port.

## What you see

- **Neurons** are spheres coloured by kind (source, run, serve, http, human).
  Each network flows left to right by depth from its sources; a 3D force
  layout spreads each layer.
- **Composed neurons** are glass shells with their inner network inside. The
  inner neurons are dim because composition is sealed: a run's events never
  name them (TRACE.md). A composed file that composes itself is marked ↻
  instead of drawn forever.
- **Events**: a signal is a pulse along its link, an answer is a gold pulse
  arcing back to the sender, and drops, errors and `unknown`s flash at the
  neuron. A `fail` tints the scene. Links brighten as traffic accumulates.
  With reduced motion on, pulses become flashes.
- **Live, then replay**: while a run goes, the engine reports at most once a
  second, so playback trails the wall clock by 1.5 s and each batch plays at
  its real pace. At the end the kept trace replaces the live list (the run
  tool's own `events` stop at 300), and the timeline can be scrubbed.
- Click a neuron for its description, options and counts at the playhead.
  The log lists the same events as text.

Networks with `human` neurons are refused by the engine's run tools (the desk
is the person's surface, not an MCP surface). They can still be described and
drawn.

## Check

```sh
npm run check          # tsc, vitest (the bridge test runs the real engine), vite build
```

The bridge test is skipped when the engine binary is missing.
