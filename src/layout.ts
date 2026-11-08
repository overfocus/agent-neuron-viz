// Where each neuron sits in 3D. The flow runs along x: a neuron's depth (its
// distance from the sources, or from the entry of a composed network) pulls it
// to x = depth * STEP, and a 3D force layout spreads each layer over y and z.
// A composed neuron is a shell with its inner network laid out the same way
// inside it. Pure and deterministic (seeded), so a network always draws alike.
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ, type SimNode } from "d3-force-3d";
import { isNetwork, type NetworkDesc, type NeuronDesc } from "./types.ts";

export type Vec3 = [number, number, number];

export interface PlacedNeuron {
  /** Unique across the tree: the id path, "diagnosis/topology" for an inner neuron. */
  key: string;
  id: string;
  neuron: NeuronDesc;
  pos: Vec3;
  /** The sphere's radius, or the shell's for a composed neuron. */
  radius: number;
  depth: number;
  /** The key of the composed neuron this one lives in. */
  parent?: string;
  /** How many composed neurons it is nested in. */
  level: number;
  /** A composed neuron whose file loops back: its inside is not drawn. */
  cycle?: boolean;
}

export interface PlacedLink {
  from: string;
  to: string;
  parent?: string;
}

export interface Layout {
  neurons: PlacedNeuron[];
  links: PlacedLink[];
  /** The radius of a sphere around the origin holding every neuron. */
  extent: number;
}

const STEP = 7;
const NEURON_RADIUS = 1.0;
const INNER_SCALE = 0.62;

interface Node extends SimNode {
  id: string;
  depth: number;
  radius: number;
}

/** How far the largest `at` coordinate of a network reaches from its origin, in scene units. */
const AT_REACH = STEP * 2.6;

/** Breadth-first distance from the starting neurons; unreachable ones take depth 0. */
export function depths(net: NetworkDesc): Map<string, number> {
  const starts = net.entry ? [net.entry] : net.neurons.filter((n) => n.kind === "source").map((n) => n.id);
  const out = new Map<string, number>();
  const queue = starts.length ? [...starts] : net.neurons.slice(0, 1).map((n) => n.id);
  for (const s of queue) out.set(s, 0);
  while (queue.length) {
    const id = queue.shift()!;
    const d = out.get(id)!;
    for (const l of net.links) {
      if (l.from === id && !out.has(l.to)) {
        out.set(l.to, d + 1);
        queue.push(l.to);
      }
    }
  }
  for (const n of net.neurons) if (!out.has(n.id)) out.set(n.id, 0);
  return out;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** Lay one network out around its own origin (recursing into composed neurons first). */
function place(net: NetworkDesc, prefix: string, level: number, parent?: string): Layout {
  const depth = depths(net);
  const inner = new Map<string, Layout>();
  for (const n of net.neurons) {
    if (isNetwork(n.network)) inner.set(n.id, place(n.network, `${prefix}${n.id}/`, level + 1, `${prefix}${n.id}`));
  }
  const maxDepth = Math.max(0, ...depth.values());
  // Neurons the file places (`at`, decision 0011) are pinned there, scaled so
  // the farthest sits AT_REACH from the origin; the forces place the rest.
  const placed = net.neurons.filter((n) => n.at);
  const reach = Math.max(1e-9, ...placed.flatMap((n) => n.at!.map(Math.abs)));
  const scale = AT_REACH / reach;
  const nodes: Node[] = net.neurons.map((n) => {
    const sub = inner.get(n.id);
    const radius = sub ? sub.extent * INNER_SCALE + 1.4 : n.kind === "composed" ? 1.6 : NEURON_RADIUS;
    const node: Node = { id: n.id, depth: depth.get(n.id)!, radius };
    if (n.at) {
      [node.fx, node.fy, node.fz] = n.at.map((v) => v * scale);
      [node.x, node.y, node.z] = [node.fx, node.fy, node.fz];
    }
    return node;
  });
  // d3 swaps each link's ids for the node objects before it asks the distance.
  type SimLink = { source: string | Node; target: string | Node };
  const links: SimLink[] = net.links.map((l) => ({ source: l.from, target: l.to }));
  const r = (end: string | Node) => (typeof end === "string" ? 0 : end.radius);
  const sim = forceSimulation<Node>(nodes, 3);
  sim.randomSource?.(lcg(net.neurons.length * 7919 + level));
  sim
    .force(
      "link",
      forceLink<Node, SimLink>(links)
        .id((n) => n.id)
        .distance((l) => STEP * 0.8 + r(l.source) + r(l.target))
        .strength(0.4),
    )
    .force("charge", forceManyBody<Node>().strength(-25))
    .force("collide", forceCollide<Node>((n) => n.radius + 1.2).strength(1))
    .force("x", forceX<Node>((n) => (n.depth - maxDepth / 2) * STEP).strength(placed.length ? 0.05 : 0.9))
    .force("y", forceY<Node>(0).strength(0.05))
    .force("z", forceZ<Node>(0).strength(0.05))
    .stop()
    .tick(300);

  const neurons: PlacedNeuron[] = [];
  const placedLinks: PlacedLink[] = net.links.map((l) => ({ from: prefix + l.from, to: prefix + l.to, parent }));
  // Centre the layer layout on the origin so a shell's inside sits inside it.
  // A file that places its neurons keeps its own origin.
  const cx = placed.length ? 0 : avg(nodes.map((n) => n.x ?? 0));
  const cy = placed.length ? 0 : avg(nodes.map((n) => n.y ?? 0));
  const cz = placed.length ? 0 : avg(nodes.map((n) => n.z ?? 0));
  let extent = 0;
  net.neurons.forEach((n, i) => {
    const s = nodes[i];
    const pos: Vec3 = [(s.x ?? 0) - cx, (s.y ?? 0) - cy, (s.z ?? 0) - cz];
    extent = Math.max(extent, Math.hypot(...pos) + s.radius);
    const key = prefix + n.id;
    neurons.push({
      key,
      id: n.id,
      neuron: n,
      pos,
      radius: s.radius,
      depth: s.depth,
      parent,
      level,
      cycle: n.network !== undefined && !isNetwork(n.network) ? true : undefined,
    });
    const sub = inner.get(n.id);
    if (sub) {
      for (const m of sub.neurons) {
        neurons.push({
          ...m,
          pos: [pos[0] + m.pos[0] * INNER_SCALE, pos[1] + m.pos[1] * INNER_SCALE, pos[2] + m.pos[2] * INNER_SCALE],
          radius: m.radius * INNER_SCALE,
        });
      }
      placedLinks.push(...sub.links);
    }
  });
  return { neurons, links: placedLinks, extent: Math.max(extent, NEURON_RADIUS) };
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function layout(net: NetworkDesc): Layout {
  return place(net, "", 0);
}
