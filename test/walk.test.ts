import { describe, expect, it } from "vitest";
import { stride, trips } from "../src/walk.ts";
import type { TraceEvent } from "../src/types.ts";

// An ant's trip as the trace has it: the clock's signal reaches it at 100,
// it answers at 500 and its forward goes to the food.
const events: TraceEvent[] = [
  { t: 100, type: "signal", id: "#1", from: "clock", to: ["ant", "other"] },
  { t: 500, type: "answer", id: "#2", from: "ant", to: ["clock"], replyTo: "#1" },
  { t: 500, type: "signal", id: "#3", from: "ant", to: ["food"], cause: "#2" },
  { t: 540, type: "answer", id: "#4", from: "food", to: ["ant"], replyTo: "#3" },
  { t: 540, type: "signal", id: "#5", from: "food", to: ["nest"], cause: "#4" },
];

describe("walkers", () => {
  it("reads a trip from the trace: leaves at the signal, arrives at the answer, home after as long again", () => {
    const t = trips(events, new Set(["ant"]));
    expect(t.get("ant")).toEqual([{ target: "food", leave: 100, arrive: 500, home: 900 }]);
    // Only walkers walk: the food's forward to the nest is not a trip.
    expect(trips(events, new Set(["ant"])).has("food")).toBe(false);
    expect(trips(events, new Set()).size).toBe(0);
  });

  it("places a walker along its trip at any moment, so a scrubbed timeline agrees", () => {
    const list = trips(events, new Set(["ant"])).get("ant");
    expect(stride(list, 50)).toBeNull();
    expect(stride(list, 300)?.k).toBeCloseTo(0.5);
    expect(stride(list, 500)?.k).toBeCloseTo(1);
    expect(stride(list, 700)?.k).toBeCloseTo(0.5);
    expect(stride(list, 900)).toBeNull();
  });
});
