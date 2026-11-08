// Walkers: neurons a demo asks the viewer to draw as moving (the colony's
// ants). Where a walker is comes from the trace alone, so it is the same live
// and when the timeline is scrubbed: a walker's call starts when the signal it
// answers reached it (it leaves home), its answer forwarded to one neuron is
// the arrival there, and it walks home over as long as it took to get there.
import type { TraceEvent } from "./types.ts";

export interface Trip {
  /** The neuron walked to. */
  target: string;
  /** Leaves home, arrives, is home again: ms on the run's clock. */
  leave: number;
  arrive: number;
  home: number;
}

/** Every trip of every walker in `events`, by walker id, in time order. */
export function trips(events: TraceEvent[], walkers: ReadonlySet<string>): Map<string, Trip[]> {
  const out = new Map<string, Trip[]>();
  if (!walkers.size) return out;
  const byId = new Map<string, TraceEvent>();
  for (const e of events) if (e.id) byId.set(e.id, e);
  for (const e of events) {
    // The forward of a walker's answer, to exactly one neuron.
    if (e.type !== "signal" || !e.from || !walkers.has(e.from) || !e.cause || e.to?.length !== 1) continue;
    const answer = byId.get(e.cause);
    const started = answer?.replyTo ? byId.get(answer.replyTo) : undefined;
    if (!answer || !started) continue;
    const leave = started.t;
    const arrive = answer.t;
    if (arrive <= leave) continue;
    const list = out.get(e.from) ?? [];
    list.push({ target: e.to[0], leave, arrive, home: arrive + (arrive - leave) });
    out.set(e.from, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.leave - b.leave);
  return out;
}

/**
 * Where a walker is at `t`, as a fraction of the way from home to its
 * target: 0 at home, 1 at the target. The trip it is on, if any.
 */
export function stride(list: Trip[] | undefined, t: number): { trip: Trip; k: number } | null {
  if (!list) return null;
  for (const trip of list) {
    if (t < trip.leave) return null;
    if (t < trip.arrive) return { trip, k: (t - trip.leave) / (trip.arrive - trip.leave) };
    if (t < trip.home) return { trip, k: 1 - (t - trip.arrive) / (trip.home - trip.arrive) };
  }
  return null;
}
