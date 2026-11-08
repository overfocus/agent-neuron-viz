# agent-neuron-viz

A local 3D viewer for agent-neuron networks (TypeScript, Vite, three.js). It
talks to the Rust engine only through MCP (`neuron-engine mcp`), through the
bridge in `bridge/`. See README.md for the architecture.

- Run `npm run check` before you finish. The bridge test needs
  `../agent-neuron/rust-engine/target/debug/neuron-engine`, built from a branch
  that has `describe_network`.
- Everything about a network comes from the engine. Don't parse network files
  in the bridge or the page; if the page needs something MCP doesn't give, add
  it to the engine's MCP surface in agent-neuron (with its tests and README M3
  entry) rather than working around it here.
- Event and network shapes follow agent-neuron's docs/TRACE.md and the
  rust-engine README's M3 section; `src/types.ts` mirrors them.
- Relative imports carry their extension (`.ts`).
- Use made-up data in tests: no real names, emails or paths.
- This is a local tool: not deployed, no push to `main` without Kevin's
  go-ahead.
