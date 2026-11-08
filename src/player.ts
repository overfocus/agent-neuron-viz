// The clock that turns a run's events into animation. Events fire in order
// once the playhead passes their `t`. Live, the playhead trails the wall clock
// by LIVE_LAG ms: the engine announces a running job's state at most once a
// second, so a batch lands before its events are due and plays at its real
// pace instead of in bursts. Seeking replays everything up to the new time
// instantly, so the counters are always those of the playhead.
import type { TraceEvent } from "./types.ts";

export const LIVE_LAG = 1500;

export interface PlayerHooks {
  /** An event reached the playhead. `instant` while seeking: update state, skip effects. */
  fire(ev: TraceEvent, instant: boolean): void;
  /** Back to t = 0 with nothing fired. */
  reset(): void;
}

export class Player {
  events: TraceEvent[] = [];
  time = 0;
  playing = false;
  speed = 1;
  live = false;
  private cursor = 0;
  private liveStart = 0;

  constructor(private hooks: PlayerHooks) {}

  get duration(): number {
    return this.events.length ? this.events[this.events.length - 1].t : 0;
  }

  get fired(): number {
    return this.cursor;
  }

  load(events: TraceEvent[]): void {
    this.events = sorted(events);
    this.live = false;
    this.seek(0);
  }

  /** Begin a live run whose t = 0 is about `startedAt` (performance.now() ms). */
  startLive(startedAt: number): void {
    this.events = [];
    this.cursor = 0;
    this.time = 0;
    this.live = true;
    this.playing = true;
    this.speed = 1;
    this.liveStart = startedAt;
    this.hooks.reset();
  }

  /**
   * The events seen so far. A live list only grows at the end, so the
   * cursor stays put and a late event still fires. `replace` swaps in a
   * different list (the trace's whole one at the end): what lies at or
   * before the playhead counts as fired already.
   */
  update(events: TraceEvent[], replace = false): void {
    this.events = sorted(events);
    if (replace) {
      let c = 0;
      while (c < this.events.length && this.events[c].t <= this.time) c++;
      this.cursor = c;
    } else {
      this.cursor = Math.min(this.cursor, this.events.length);
    }
  }

  /**
   * Joining a live run late: everything up to the live playhead fires at
   * once, as a seek does, instead of all its pulses in one frame.
   */
  catchUp(now: number): void {
    if (!this.live) return;
    this.time = Math.max(this.time, now - this.liveStart - LIVE_LAG);
    while (this.cursor < this.events.length && this.events[this.cursor].t <= this.time) {
      this.hooks.fire(this.events[this.cursor], true);
      this.cursor++;
    }
  }

  endLive(): void {
    this.live = false;
  }

  tick(now: number, dt: number): void {
    if (!this.playing) return;
    if (this.live) {
      this.time = Math.max(this.time, now - this.liveStart - LIVE_LAG);
    } else {
      this.time += dt * this.speed;
    }
    this.advance(false);
    if (!this.live && this.time >= this.duration && this.cursor >= this.events.length) {
      this.time = this.duration;
      this.playing = false;
    }
  }

  seek(t: number): void {
    this.cursor = 0;
    this.time = Math.max(0, t);
    this.hooks.reset();
    this.advance(true);
  }

  private advance(instant: boolean): void {
    while (this.cursor < this.events.length && this.events[this.cursor].t <= this.time) {
      this.hooks.fire(this.events[this.cursor], instant);
      this.cursor++;
    }
  }
}

function sorted(events: TraceEvent[]): TraceEvent[] {
  // Stable: events of one millisecond keep the engine's order.
  return events
    .filter((e) => typeof e.t === "number")
    .map((e, i) => [e, i] as const)
    .sort((a, b) => a[0].t - b[0].t || a[1] - b[1])
    .map(([e]) => e);
}
