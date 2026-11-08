import { defineConfig, type Plugin } from "vite";
import path from "node:path";
import { createBridge } from "./bridge/api.ts";

// The agent-neuron checkout and its Rust engine: siblings by default, or set
// AGENT_NEURON_ROOT / NEURON_ENGINE.
const root = path.resolve(process.env.AGENT_NEURON_ROOT ?? "../agent-neuron");
const engine = process.env.NEURON_ENGINE ?? path.join(root, "rust-engine/target/debug/neuron-engine");
// The demos checkout whose runs/current.json `?attach` follows.
const demos = path.resolve(process.env.AGENT_NEURON_DEMOS ?? "../agent-neuron-demos");

function mcpBridge(): Plugin {
  const bridge = createBridge({ root, engine, demos });
  return {
    name: "agent-neuron-mcp-bridge",
    configureServer(server) {
      server.middlewares.use(bridge.middleware);
      server.httpServer?.on("close", () => void bridge.close());
    },
    configurePreviewServer(server) {
      server.middlewares.use(bridge.middleware);
    },
  };
}

export default defineConfig({
  plugins: [mcpBridge()],
  build: { chunkSizeWarningLimit: 900 },
  server: { port: Number(process.env.PORT ?? 5180), strictPort: false },
});
