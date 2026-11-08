// The shapes the engine sends: `describe_network` (rust-engine README, M3)
// and v1 trace events (agent-neuron docs/TRACE.md).

export interface NeuronDesc {
  id: string;
  kind: "source" | "run" | "serve" | "http" | "human" | "composed" | string;
  description: string;
  options?: { threshold?: number; within?: number; maxHops?: number };
  cost?: Record<string, number>;
  /** Declared `effect` (SPEC 11): a started call is never cut, a crash is `unknown`. */
  effect?: boolean;
  /** A composed neuron's inner network, or a loop mark. */
  network?: NetworkDesc | { file: string; cycle: true };
}

export interface LinkDesc {
  from: string;
  to: string;
}

export interface NetworkDesc {
  file: string;
  name: string;
  description: string;
  entry?: string;
  exit?: string;
  budget?: Record<string, number>;
  neurons: NeuronDesc[];
  links: LinkDesc[];
}

export interface Diagnostic {
  file: string | null;
  line: number | null;
  col: number | null;
  message: string;
}

export type DescribeBody =
  | { ok: true; warnings: Diagnostic[]; network: NetworkDesc }
  | { ok: false; errors?: Diagnostic[]; warnings?: Diagnostic[]; error?: string };

export interface TraceEvent {
  t: number;
  type: "signal" | "answer" | "quiet" | "drop" | "error" | "unknown" | "fail" | "finished" | "note" | string;
  id?: string;
  from?: string;
  to?: string[];
  trace?: string;
  neuron?: string;
  reason?: string;
  message?: string;
  code?: string;
  what?: string;
  status?: string;
  hops?: number;
  payload?: { type: "json"; data?: unknown; preview?: string; truncated?: boolean } | { type: "text"; text: string; truncated?: boolean };
  truncated?: number;
}

export interface JobState {
  job_id: string;
  status: "running" | "done" | "refused" | "failed" | string;
  events_so_far?: TraceEvent[];
  events?: TraceEvent[];
  answers?: unknown[];
  summary?: Record<string, unknown>;
  reason?: string;
  error?: string;
  trace_path?: string;
  trace_events?: TraceEvent[];
}

export function isNetwork(n: NeuronDesc["network"]): n is NetworkDesc {
  return !!n && "neurons" in n;
}
