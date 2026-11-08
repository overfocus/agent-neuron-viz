// A minimal MCP client for `neuron-engine mcp`: newline-delimited JSON-RPC 2.0
// over the child's stdin/stdout, one request per line, one response per line.
// The engine logs to stderr only, so every stdout line is a protocol frame.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

export const PROTOCOL_VERSION = "2025-06-18";

export interface ToolResult<T = unknown> {
  body: T;
  isError: boolean;
}

export interface Notification {
  method: string;
  params?: Record<string, unknown>;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class McpError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

export class McpClient extends EventEmitter {
  private next = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  private constructor(private child: ChildProcessWithoutNullStreams) {
    super();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.frame(line));
    child.stderr.on("data", (d: Buffer) => this.emit("log", d.toString()));
    child.on("exit", (code, signal) => {
      this.closed = true;
      const why = new Error(`neuron-engine mcp exited (${signal ?? code})`);
      for (const p of this.pending.values()) p.reject(why);
      this.pending.clear();
      this.emit("exit", code, signal);
    });
  }

  /** Start the server and complete the handshake. */
  static async start(opts: { command: string; cwd: string }): Promise<McpClient> {
    const child = spawn(opts.command, ["mcp"], { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    const client = new McpClient(child);
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "agent-neuron-viz", version: "0.0.0" },
    });
    client.notify("notifications/initialized");
    return client;
  }

  get alive(): boolean {
    return !this.closed;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("the MCP server is not running"));
    const id = this.next++;
    const frame: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) frame.params = params;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child.stdin.write(JSON.stringify(frame) + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const frame: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) frame.params = params;
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  /** `tools/call`, answered with the tool's structured body and its error flag. */
  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<ToolResult<T>> {
    const result = await this.request<{ structuredContent?: T; content?: { text: string }[]; isError?: boolean }>(
      "tools/call",
      { name, arguments: args },
    );
    const body = result.structuredContent ?? (JSON.parse(result.content?.[0]?.text ?? "null") as T);
    return { body, isError: result.isError === true };
  }

  /** `resources/read` of a JSON resource, parsed. */
  async readJson<T = unknown>(uri: string): Promise<T> {
    const result = await this.request<{ contents: { text: string }[] }>("resources/read", { uri });
    return JSON.parse(result.contents[0].text) as T;
  }

  close(): void {
    if (this.closed) return;
    this.child.stdin.end();
  }

  private frame(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit("log", `non-JSON line on stdout: ${line}\n`);
      return;
    }
    if (msg.method !== undefined && msg.id === undefined) {
      this.emit("notification", { method: msg.method, params: msg.params } satisfies Notification);
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new McpError(msg.error.code, msg.error.message));
    else p.resolve(msg.result);
  }
}
