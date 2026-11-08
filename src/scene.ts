// The 3D picture: one sphere per neuron (coloured by kind), a glass shell per
// composed neuron with its inner network inside, a line and arrowhead per
// link, and pulses that travel the links as the events play.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type { Layout, PlacedNeuron } from "./layout.ts";
import type { TraceEvent } from "./types.ts";
import { stride, type Trip } from "./walk.ts";

// Kind colours, the family's (rigswig's page uses the same hues): bright on black,
// and never the only cue — the legend names every colour, and this map is the one
// place they live. The family accent (green) is where signals enter; people are pink.
export const KIND_COLORS: Record<string, string> = {
  source: "#39ff00",
  run: "#ff9f43",
  serve: "#22d3ee",
  http: "#facc15",
  human: "#f472b6",
  composed: "#a78bfa",
};
const UNKNOWN_KIND = "#b4b4bc";
export const EVENT_COLORS: Record<string, string> = {
  signal: "#22d3ee",
  answer: "#39ff00",
  quiet: "#b4b4bc",
  drop: "#ffc14d",
  error: "#ff7a7a",
  unknown: "#ff7a7a",
  fail: "#ff7a7a",
};
const PULSE_MS = 520;
const FLASH_MS = 700;
const MAX_PULSES = 400;
/** A walker's drawn size against an ordinary neuron's: many small things moving. */
const WALKER_SIZE = 0.32;

export interface NeuronStats {
  sent: number;
  received: number;
  answers: number;
  quiet: number;
  drops: number;
  errors: number;
}

interface NodeView {
  placed: PlacedNeuron;
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  base: THREE.Color;
  flashColor: THREE.Color;
  flashAt: number;
  stats: NeuronStats;
  label: HTMLElement;
  /** Drawn size against the layout's radius: walkers are small. */
  size: number;
}

interface LinkView {
  line: THREE.Line;
  mat: THREE.LineBasicMaterial;
  cone: THREE.Mesh;
  count: number;
}

interface Pulse {
  mesh: THREE.Mesh;
  a: THREE.Vector3;
  b: THREE.Vector3;
  lift: THREE.Vector3;
  start: number;
}

const emptyStats = (): NeuronStats => ({ sent: 0, received: 0, answers: 0, quiet: 0, drops: 0, errors: 0 });

export class NetworkScene {
  readonly renderer: THREE.WebGLRenderer;
  private labels = new CSS2DRenderer();
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  private controls: OrbitControls;
  private graph = new THREE.Group();
  private pulses: Pulse[] = [];
  private pulseGeo = new THREE.SphereGeometry(0.3, 12, 8);
  private nodes = new Map<string, NodeView>();
  private links = new Map<string, LinkView>();
  private selection: THREE.Mesh;
  private selected: string | null = null;
  private failAt = -Infinity;
  private raycaster = new THREE.Raycaster();
  private reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  private walkers = new Set<string>();
  private tripsByWalker = new Map<string, Trip[]>();
  speed = 1;

  constructor(
    private container: HTMLElement,
    private onSelect: (key: string | null) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.append(this.renderer.domElement);
    this.labels.domElement.className = "labels";
    container.append(this.labels.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(10, 20, 14);
    this.scene.add(sun, this.graph);
    this.selection = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.35 }),
    );
    this.selection.visible = false;
    this.scene.add(this.selection);
    this.applyTheme();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.applyTheme());
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.pickOnClick();
    this.renderer.setAnimationLoop((now) => this.frame(now));
  }

  /** Draw a network, replacing whatever was shown. */
  show(layout: Layout): void {
    this.clear();
    for (const p of layout.neurons) this.addNeuron(p);
    for (const l of layout.links) this.addLink(l.from, l.to);
    const d = Math.max(12, layout.extent * 1.9);
    this.camera.position.set(0, d * 0.3, d);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  clear(): void {
    for (const obj of [...this.graph.children]) {
      this.graph.remove(obj);
      obj.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
        if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
    this.nodes.clear();
    this.links.clear();
    this.walkers.clear();
    this.tripsByWalker.clear();
    this.pulses = [];
    this.select(null);
  }

  /** Back to before any event: no counts, no pulses. */
  resetActivity(): void {
    for (const n of this.nodes.values()) {
      n.stats = emptyStats();
      n.flashAt = -Infinity;
    }
    for (const l of this.links.values()) l.count = 0;
    for (const p of this.pulses) this.graph.remove(p.mesh);
    this.pulses = [];
    this.failAt = -Infinity;
  }

  stats(key: string): NeuronStats | undefined {
    return this.nodes.get(key)?.stats;
  }

  neuron(key: string): PlacedNeuron | undefined {
    return this.nodes.get(key)?.placed;
  }

  select(key: string | null): void {
    this.selected = key && this.nodes.has(key) ? key : null;
    for (const [k, v] of this.nodes) v.label.classList.toggle("chosen", k === this.selected);
    const n = this.selected ? this.nodes.get(this.selected) : undefined;
    this.selection.visible = !!n;
    if (n) {
      this.selection.position.copy(n.mesh.position);
      this.selection.scale.setScalar(n.placed.radius * 1.35);
    }
  }

  /** One event at the playhead. `instant` while seeking: counts only. */
  event(ev: TraceEvent, instant: boolean): void {
    const now = performance.now();
    const color = EVENT_COLORS[ev.type];
    if (ev.type === "fail") {
      if (!instant) this.failAt = now;
      return;
    }
    const from = ev.from ? this.nodes.get(ev.from) : undefined;
    const at = ev.neuron ? this.nodes.get(ev.neuron) : undefined;
    switch (ev.type) {
      case "signal":
        if (from) from.stats.sent++;
        for (const to of ev.to ?? []) {
          const target = this.nodes.get(to);
          if (target) target.stats.received++;
          const link = this.links.get(`${ev.from}->${to}`);
          if (link) link.count++;
          // A walker's trip is its signal: no pulses to or from a neuron that walks.
          if (!instant && from && target && !this.walkers.has(ev.from!) && !this.walkers.has(to)) this.pulse(from, target, color, false);
        }
        if (!instant && from) this.flash(from, color, now);
        break;
      case "answer":
      case "quiet":
        if (from) from.stats[ev.type === "answer" ? "answers" : "quiet"]++;
        if (!instant && from) {
          this.flash(from, color, now);
          if (ev.type === "answer") {
            for (const to of ev.to ?? []) {
              const target = this.nodes.get(to);
              if (target && !this.walkers.has(to) && !this.walkers.has(ev.from!)) this.pulse(from, target, color, true);
            }
          }
        }
        break;
      case "drop":
        if (at) at.stats.drops++;
        if (!instant && at) this.flash(at, color, now);
        break;
      case "error":
      case "unknown":
        if (at) at.stats.errors++;
        if (!instant && at) this.flash(at, color, now);
        break;
    }
  }

  private addNeuron(p: PlacedNeuron): void {
    const kindColor = new THREE.Color(KIND_COLORS[p.neuron.kind] ?? UNKNOWN_KIND);
    const composed = p.neuron.kind === "composed";
    const inner = p.level > 0;
    const mat = new THREE.MeshStandardMaterial({
      color: kindColor,
      roughness: composed ? 0.15 : 0.45,
      metalness: 0.1,
      emissive: kindColor.clone(),
      emissiveIntensity: 0.08,
      transparent: composed || inner,
      opacity: composed ? 0.13 : inner ? 0.6 : 1,
      depthWrite: !composed,
      side: composed ? THREE.DoubleSide : THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(p.radius, composed ? 48 : 28, composed ? 32 : 18), mat);
    mesh.position.set(...p.pos);
    mesh.userData.key = p.key;
    if (composed) {
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(p.radius * 1.001, 1)),
        new THREE.LineBasicMaterial({ color: kindColor, transparent: true, opacity: 0.3 }),
      );
      mesh.add(edges);
    }
    const el = document.createElement("div");
    el.className = `label${inner ? " inner" : ""}${composed ? " composed" : ""}`;
    el.textContent = p.cycle ? `${p.id} ↻` : p.neuron.effect ? `${p.id} ⚑` : p.id;
    if (p.neuron.effect) el.title = "effect: never cut; a crash is unknown";
    const label = new CSS2DObject(el);
    label.position.set(0, p.radius + (composed ? 0.3 : 0.45), 0);
    mesh.add(label);
    this.graph.add(mesh);
    this.nodes.set(p.key, {
      placed: p,
      mesh,
      mat,
      base: kindColor,
      flashColor: new THREE.Color(),
      flashAt: -Infinity,
      stats: emptyStats(),
      label: el,
      size: 1,
    });
  }

  /**
   * The neurons a demo asks to see walking (the colony's ants): their labels
   * hide until selected, and walk() moves them along their trips.
   */
  setWalkers(ids: Iterable<string>): void {
    this.walkers = new Set([...ids].filter((id) => this.nodes.has(id)));
    for (const [key, n] of this.nodes) {
      n.label.classList.toggle("walker", this.walkers.has(key));
      n.size = this.walkers.has(key) ? WALKER_SIZE : 1;
    }
  }

  get walking(): ReadonlySet<string> {
    return this.walkers;
  }

  setTrips(trips: Map<string, Trip[]>): void {
    this.tripsByWalker = trips;
  }

  /** Put every walker where it is at `t` (ms on the run's clock). */
  walk(t: number): void {
    for (const id of this.walkers) {
      const n = this.nodes.get(id);
      if (!n) continue;
      const home = new THREE.Vector3(...n.placed.pos);
      const s = this.reducedMotion.matches ? null : stride(this.tripsByWalker.get(id), t);
      const target = s ? this.nodes.get(s.trip.target) : undefined;
      if (s && target) {
        // Stop at the target's surface, not inside it.
        const to = target.mesh.position.clone();
        to.addScaledVector(home.clone().sub(to).normalize(), target.placed.radius + n.placed.radius * n.size);
        n.mesh.position.lerpVectors(home, to, s.k);
      } else {
        n.mesh.position.copy(home);
      }
      if (this.selected === id) this.selection.position.copy(n.mesh.position);
    }
  }

  /**
   * Calls a human neuron has been given and not yet answered: what the
   * desk is waiting on a person for (inputs minus answers, quiets, drops
   * and errors at it).
   */
  waiting(key: string): number {
    const n = this.nodes.get(key);
    if (!n || n.placed.neuron.kind !== "human") return 0;
    const s = n.stats;
    return Math.max(0, s.received - s.answers - s.quiet - s.drops - s.errors);
  }

  private addLink(fromKey: string, toKey: string): void {
    const a = this.nodes.get(fromKey);
    const b = this.nodes.get(toKey);
    if (!a || !b) return;
    const [p, q] = this.ends(a, b);
    const mat = new THREE.LineBasicMaterial({ color: this.linkColor(), transparent: true, opacity: 0.35 });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, q]), mat);
    const dir = q.clone().sub(p).normalize();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.5, 12),
      new THREE.MeshBasicMaterial({ color: this.linkColor(), transparent: true, opacity: 0.6 }),
    );
    cone.position.copy(q).addScaledVector(dir, -0.25);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    this.graph.add(line, cone);
    this.links.set(`${fromKey}->${toKey}`, { line, mat, cone, count: 0 });
  }

  /** A link's two ends, on the spheres' surfaces rather than at their centres. */
  private ends(a: NodeView, b: NodeView): [THREE.Vector3, THREE.Vector3] {
    const p = a.mesh.position.clone();
    const q = b.mesh.position.clone();
    const dir = q.clone().sub(p).normalize();
    return [p.addScaledVector(dir, a.placed.radius), q.addScaledVector(dir, -b.placed.radius)];
  }

  private pulse(a: NodeView, b: NodeView, color: string, reply: boolean): void {
    if (this.reducedMotion.matches || this.pulses.length >= MAX_PULSES) return;
    const [p, q] = this.ends(a, b);
    const mesh = new THREE.Mesh(this.pulseGeo, new THREE.MeshBasicMaterial({ color }));
    mesh.position.copy(p);
    // Replies arc above the link so they read apart from the forward signals.
    const lift = reply ? new THREE.Vector3(0, Math.max(1, p.distanceTo(q) * 0.18), 0) : new THREE.Vector3();
    this.graph.add(mesh);
    this.pulses.push({ mesh, a: p, b: q, lift, start: performance.now() });
  }

  private flash(n: NodeView, color: string, now: number): void {
    n.flashColor.set(color);
    n.flashAt = now;
  }

  private frame(now: number): void {
    const pulseMs = PULSE_MS / Math.max(0.25, Math.min(this.speed, 4));
    this.pulses = this.pulses.filter((p) => {
      const k = (now - p.start) / pulseMs;
      if (k >= 1) {
        this.graph.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        return false;
      }
      p.mesh.position.lerpVectors(p.a, p.b, k).addScaledVector(p.lift, 4 * k * (1 - k));
      return true;
    });
    for (const n of this.nodes.values()) {
      const k = Math.max(0, 1 - (now - n.flashAt) / FLASH_MS);
      const activity = Math.min(0.35, Math.log2(1 + n.stats.received + n.stats.answers) * 0.04);
      n.mat.emissive.copy(n.base).lerp(n.flashColor, k);
      n.mat.emissiveIntensity = 0.08 + activity + k * 1.4;
      if (n.placed.neuron.kind !== "composed") n.mesh.scale.setScalar(n.size * (1 + k * 0.25));
      if (n.placed.neuron.kind === "human") {
        // A person owes an answer: the neuron breathes until it comes.
        const w = this.waiting(n.placed.key);
        const breathe = w && !this.reducedMotion.matches ? 0.5 + 0.5 * Math.sin(now / 260) : w ? 1 : 0;
        n.mat.emissiveIntensity += breathe * 0.9;
        if (w) n.mesh.scale.setScalar(1 + k * 0.25 + breathe * 0.12);
        const text = w ? `${n.placed.id} · waiting ${w}` : n.placed.id;
        if (n.label.textContent !== text) n.label.textContent = text;
        n.label.classList.toggle("waiting", !!w);
      }
    }
    for (const l of this.links.values()) {
      l.mat.opacity = 0.3 + Math.min(0.6, Math.log2(1 + l.count) * 0.12);
    }
    const fk = Math.max(0, 1 - (now - this.failAt) / 1200);
    this.renderer.setClearColor(this.background.clone().lerp(new THREE.Color("#5a1020"), fk * 0.6));
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  private background = new THREE.Color();

  private applyTheme(): void {
    const css = getComputedStyle(document.documentElement);
    this.background.set(css.getPropertyValue("--scene-bg").trim() || "#0d1117");
    for (const l of this.links.values()) {
      l.mat.color.set(this.linkColor());
      (l.cone.material as THREE.MeshBasicMaterial).color.set(this.linkColor());
    }
  }

  private linkColor(): string {
    return getComputedStyle(document.documentElement).getPropertyValue("--link").trim() || "#9aa7b8";
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
  }

  /** A click that is not a drag selects the neuron under the pointer (or clears). */
  private pickOnClick(): void {
    const el = this.renderer.domElement;
    let down: [number, number] | null = null;
    el.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
    el.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      const meshes = [...this.nodes.values()].map((n) => n.mesh);
      const hits = this.raycaster.intersectObjects(meshes, false);
      // Prefer a solid neuron over the glass shell it sits in.
      const hit = hits.find((h) => this.nodes.get(h.object.userData.key)?.placed.neuron.kind !== "composed") ?? hits[0];
      const key = (hit?.object.userData.key as string | undefined) ?? null;
      this.select(key);
      this.onSelect(key);
    });
  }
}
