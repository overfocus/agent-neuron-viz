import { describe, expect, it } from "vitest";
import { depths, layout } from "../src/layout.ts";
import { Player } from "../src/player.ts";
import type { NetworkDesc, TraceEvent } from "../src/types.ts";

const net: NetworkDesc = {
  file: "t.network.json",
  name: "t",
  description: "a made-up network",
  neurons: [
    { id: "in", kind: "source", description: "in" },
    { id: "a", kind: "run", description: "a" },
    { id: "b", kind: "run", description: "b" },
    {
      id: "c",
      kind: "composed",
      description: "c",
      network: {
        file: "inner.json",
        name: "inner",
        description: "inner",
        entry: "x",
        exit: "y",
        neurons: [
          { id: "x", kind: "run", description: "x" },
          { id: "y", kind: "run", description: "y" },
        ],
        links: [{ from: "x", to: "y" }],
      },
    },
  ],
  links: [
    { from: "in", to: "a" },
    { from: "in", to: "b" },
    { from: "a", to: "c" },
    { from: "b", to: "c" },
  ],
};

describe("layout", () => {
  it("measures depth from the sources", () => {
    expect(Object.fromEntries(depths(net))).toEqual({ in: 0, a: 1, b: 1, c: 2 });
  });

  it("flows along x, puts inner neurons inside their shell, and is deterministic", () => {
    const one = layout(net);
    const two = layout(net);
    expect(one.neurons.map((n) => n.pos)).toEqual(two.neurons.map((n) => n.pos));
    const at = (k: string) => one.neurons.find((n) => n.key === k)!;
    expect(at("in").pos[0]).toBeLessThan(at("a").pos[0]);
    expect(at("a").pos[0]).toBeLessThan(at("c").pos[0]);
    const c = at("c");
    for (const k of ["c/x", "c/y"]) {
      const n = at(k);
      expect(n.parent).toBe("c");
      expect(n.level).toBe(1);
      const d = Math.hypot(n.pos[0] - c.pos[0], n.pos[1] - c.pos[1], n.pos[2] - c.pos[2]);
      expect(d + n.radius).toBeLessThan(c.radius);
    }
    expect(one.links).toContainEqual({ from: "c/x", to: "c/y", parent: "c" });
    for (const n of one.neurons) expect(n.pos.every(Number.isFinite)).toBe(true);
  });

  it("marks a composed file that loops back", () => {
    const looped: NetworkDesc = {
      ...net,
      neurons: [net.neurons[0], { id: "c", kind: "composed", description: "c", network: { file: "c.json", cycle: true } }],
      links: [{ from: "in", to: "c" }],
    };
    const c = layout(looped).neurons.find((n) => n.key === "c")!;
    expect(c.cycle).toBe(true);
  });
});

describe("player", () => {
  const ev = (t: number, id: string): TraceEvent => ({ t, type: "signal", id, from: "in", to: ["a"] });

  function make() {
    const fired: string[] = [];
    let resets = 0;
    const p = new Player({ fire: (e) => fired.push(e.id!), reset: () => resets++ });
    return { p, fired, resets: () => resets };
  }

  it("fires events in time order as the playhead passes them", () => {
    const { p, fired } = make();
    p.load([ev(20, "b"), ev(10, "a"), ev(20, "c")]);
    p.playing = true;
    p.tick(0, 15);
    expect(fired).toEqual(["a"]);
    p.tick(0, 10);
    expect(fired).toEqual(["a", "b", "c"]);
    expect(p.playing).toBe(false);
  });

  it("seeks by replaying from the start", () => {
    const { p, fired, resets } = make();
    p.load([ev(10, "a"), ev(20, "b"), ev(30, "c")]);
    const before = resets();
    p.seek(25);
    expect(resets()).toBe(before + 1);
    expect(fired).toEqual(["a", "b"]);
  });

  it("live: trails the wall clock, keeps late events, and swaps in the trace without refiring", () => {
    const { p, fired } = make();
    p.startLive(0);
    p.update([ev(100, "a")]);
    p.tick(1000, 16); // 1000 - 1500 lag: nothing due yet
    expect(fired).toEqual([]);
    p.tick(1700, 16);
    expect(fired).toEqual(["a"]);
    p.update([ev(100, "a"), ev(150, "late")]); // arrived after its time: still fires
    p.tick(1716, 16);
    expect(fired).toEqual(["a", "late"]);
    p.update([ev(100, "a"), ev(150, "late"), ev(900, "z")], true);
    p.endLive();
    expect(fired).toEqual(["a", "late"]);
    p.tick(0, 800);
    expect(fired).toEqual(["a", "late", "z"]);
  });
});
