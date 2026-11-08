import "./style.css";
import { layout } from "./layout.ts";
import { Player } from "./player.ts";
import { EVENT_COLORS, KIND_COLORS, NetworkScene } from "./scene.ts";
import type { DescribeBody, Diagnostic, JobState, NetworkDesc, TraceEvent } from "./types.ts";
import { trips } from "./walk.ts";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const networkSel = $<HTMLSelectElement>("#network");
const inputsSel = $<HTMLSelectElement>("#inputs");
const runBtn = $<HTMLButtonElement>("#run");
const stateEl = $<HTMLSpanElement>("#state");
const about = $<HTMLElement>("#about");
const selectedEl = $<HTMLElement>("#selected");
const log = $<HTMLOListElement>("#log");
const count = $<HTMLSpanElement>("#count");
const playBtn = $<HTMLButtonElement>("#play");
const scrub = $<HTMLInputElement>("#scrub");
const clock = $<HTMLOutputElement>("#clock");
const speedSel = $<HTMLSelectElement>("#speed");

const LOG_MAX = 200;
let selected: string | null = null;
let stream: EventSource | null = null;

const scene = new NetworkScene($("#stage"), (key) => {
  selected = key;
  renderSelected();
});
const player = new Player({
  fire(ev, instant) {
    scene.event(ev, instant);
    if (!instant) logEvent(ev);
  },
  reset() {
    scene.resetActivity();
    log.replaceChildren();
  },
});

function status(text: string, error = false) {
  stateEl.textContent = text;
  stateEl.classList.toggle("error", error);
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `${r.status}`);
  return body as T;
}

// -- Networks -----------------------------------------------------------------

async function loadLists() {
  const { networks, inputs } = await api<{ networks: string[]; inputs: string[] }>("/api/networks");
  networkSel.replaceChildren(...networks.map((f) => new Option(short(f), f)));
  inputsSel.replaceChildren(new Option("(none)", ""), ...inputs.map((f) => new Option(short(f), f)));
  const params = new URLSearchParams(location.search);
  const want = params.get("network") ?? networks.find((n) => n.endsWith("/alerts.network.json")) ?? networks[0];
  if (want) networkSel.value = want;
  await describe();
}

function short(file: string) {
  return file.split("/").pop()!.replace(/\.(network\.json|inputs\.jsonl)$/, "");
}

/** The inputs file that goes with a network: same name, or its name before the first dash. */
function inputsFor(network: string): string {
  const base = short(network);
  const options = [...inputsSel.options].map((o) => o.value).filter(Boolean);
  return options.find((o) => short(o) === base) ?? options.find((o) => short(o) === base.split("-")[0]) ?? "";
}

let current: NetworkDesc | null = null;

async function describe() {
  stopStream();
  const file = networkSel.value;
  inputsSel.value = new URLSearchParams(location.search).get("inputs") ?? inputsFor(file);
  status(`Describing ${short(file)}…`);
  runBtn.disabled = true;
  try {
    const { body, isError } = await api<{ body: DescribeBody; isError: boolean }>(`/api/describe?file=${encodeURIComponent(file)}`);
    if (isError || !body.ok) {
      current = null;
      scene.clear();
      const b = body as Extract<DescribeBody, { ok: false }>;
      renderAbout(null, b.errors ?? [], b.warnings ?? [], b.error);
      status("The network does not check", true);
      return;
    }
    current = body.network;
    scene.show(layout(body.network));
    player.load([]);
    renderAbout(body.network, [], body.warnings);
    syncTimeline();
    runBtn.disabled = !inputsSel.value;
    status(inputsSel.value ? "Ready" : "Pick an inputs file to run");
  } catch (e) {
    status((e as Error).message, true);
  }
}

// -- Runs ---------------------------------------------------------------------

async function run(e: Event) {
  e.preventDefault();
  if (!current || !inputsSel.value) return;
  stopStream();
  runBtn.disabled = true;
  status("Starting…");
  try {
    const { body, isError } = await api<{ body: { job_id?: string; error?: string }; isError: boolean }>("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: networkSel.value, inputs: inputsSel.value }),
    });
    if (isError || !body.job_id) throw new Error(body.error ?? "the run did not start");
    player.startLive(performance.now());
    speedSel.value = "1";
    status(`Running ${body.job_id}…`);
    watch(body.job_id);
  } catch (err) {
    status((err as Error).message, true);
    runBtn.disabled = false;
  }
}

function watch(jobId: string) {
  stream = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/stream`);
  stream.addEventListener("state", (m) => {
    const s = JSON.parse((m as MessageEvent).data) as JobState;
    player.update(s.events_so_far ?? []);
    status(`Running: ${s.events_so_far?.length ?? 0} events`);
  });
  stream.addEventListener("done", (m) => {
    const s = JSON.parse((m as MessageEvent).data) as JobState;
    stopStream();
    const events = s.trace_events ?? s.events ?? [];
    player.update(events, true);
    player.endLive();
    player.playing = player.time < player.duration;
    runBtn.disabled = false;
    if (s.status === "done") status(`Done: ${events.length} events, ${s.answers?.length ?? 0} answers`);
    else status(`${s.status}: ${s.reason ?? s.error ?? ""}`, true);
  });
  stream.addEventListener("error", (m) => {
    const data = (m as MessageEvent).data;
    if (data) status(JSON.parse(data).message, true);
    else if (stream?.readyState === EventSource.CLOSED) status("Lost the engine's stream", true);
    stopStream();
    player.endLive();
    runBtn.disabled = false;
  });
}

function stopStream() {
  stream?.close();
  stream = null;
}

// -- Panels -------------------------------------------------------------------

function renderAbout(net: NetworkDesc | null, errors: Diagnostic[], warnings: Diagnostic[], error?: string) {
  const parts: (Node | string)[] = [];
  if (net) {
    const h = document.createElement("h2");
    h.textContent = net.name || short(net.file);
    const p = document.createElement("p");
    p.textContent = net.description;
    const meta = document.createElement("p");
    meta.className = "muted";
    const inner = net.neurons.filter((n) => n.kind === "composed").length;
    meta.textContent = `${net.neurons.length} neurons, ${net.links.length} links${inner ? `, ${inner} composed` : ""}`;
    parts.push(h, p, meta);
  }
  if (error || errors.length || warnings.length) {
    const ul = document.createElement("ul");
    ul.className = "diag";
    const item = (cls: string, d: Diagnostic | string) => {
      const li = document.createElement("li");
      li.className = cls;
      li.textContent = typeof d === "string" ? d : `${d.file ?? ""}${d.line ? `:${d.line}:${d.col}` : ""} ${d.message}`;
      ul.append(li);
    };
    if (error) item("error", error);
    errors.forEach((d) => item("error", d));
    warnings.forEach((d) => item("warn", d));
    parts.push(ul);
  }
  about.replaceChildren(...parts);
}

function renderSelected() {
  const p = selected ? scene.neuron(selected) : undefined;
  selectedEl.hidden = !p;
  if (!p) return;
  const st = scene.stats(p.key)!;
  const h = document.createElement("h2");
  const dot = document.createElement("span");
  dot.className = "kind";
  dot.style.background = KIND_COLORS[p.neuron.kind] ?? "#9aa3ad";
  h.append(dot, p.key);
  const desc = document.createElement("p");
  desc.textContent = p.neuron.description;
  const kind = document.createElement("p");
  kind.className = "muted";
  const opts = p.neuron.options ? Object.entries(p.neuron.options).map(([k, v]) => `${k} ${v}`).join(", ") : "";
  const waiting = scene.waiting(p.key);
  kind.textContent = [
    p.neuron.kind,
    opts,
    p.neuron.effect ? "effect: never cut, a crash is unknown" : "",
    waiting ? `waiting on a person (${waiting})` : "",
    p.cycle ? "its file loops back on itself" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const parts: Node[] = [h, desc, kind];
  if (p.level > 0) {
    const sealed = document.createElement("p");
    sealed.className = "muted";
    sealed.textContent = "Inside a composed neuron: sealed, so a run's events never name it.";
    parts.push(sealed);
  } else {
    const dl = document.createElement("dl");
    dl.className = "stats";
    for (const [k, v] of Object.entries(st)) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = String(v);
      dl.append(dt, dd);
    }
    parts.push(dl);
  }
  selectedEl.replaceChildren(...parts);
}

function describeEvent(ev: TraceEvent): string {
  const to = ev.to?.join(", ") ?? "";
  switch (ev.type) {
    case "signal":
      return `signal ${ev.from} → ${to}`;
    case "answer":
    case "quiet":
      return `${ev.type} ${ev.from} → ${to}`;
    case "drop":
      return `drop at ${ev.neuron} (${ev.reason})`;
    case "error":
    case "unknown":
      return `${ev.type} at ${ev.neuron}: ${ev.message ?? ev.code ?? ""}`;
    case "fail":
      return `run failed: ${ev.message}`;
    case "finished":
      return `finished ${ev.status}`;
    case "note":
      return `note ${ev.what}${ev.neuron ? ` at ${ev.neuron}` : ""}`;
    default:
      return ev.truncated ? `… ${ev.truncated} events in all` : ev.type;
  }
}

function logEvent(ev: TraceEvent) {
  // A quiet reply says nothing: it is counted on its neuron, not logged (a
  // colony's ticks would bury every other line).
  if (ev.type === "quiet") return;
  const li = document.createElement("li");
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = String(ev.t);
  li.append(t, describeEvent(ev));
  li.title = li.textContent ?? "";
  log.append(li);
  while (log.childElementCount > LOG_MAX) log.firstElementChild!.remove();
  log.scrollTop = log.scrollHeight;
}

function renderLegend() {
  const items: [string, string][] = [
    ...Object.entries(KIND_COLORS).map(([k, c]) => [k, c] as [string, string]),
    ...Object.entries(EVENT_COLORS)
      .filter(([, c], i, all) => all.slice(0, i).every(([, c2]) => c2 !== c))
      .map(([k, c]) => [k, c] as [string, string]),
  ];
  $("#legend").replaceChildren(
    ...items.map(([name, color]) => {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "kind";
      dot.style.background = color;
      li.append(dot, name);
      return li;
    }),
  );
}

// -- Timeline -----------------------------------------------------------------

function syncTimeline() {
  const has = player.events.length > 0;
  scrub.disabled = !has || player.live;
  playBtn.disabled = !has || player.live;
  scrub.max = String(player.duration);
  scrub.value = String(Math.round(Math.min(player.time, player.duration)));
  clock.value = `${Math.round(player.time)} ms`;
  playBtn.textContent = player.playing ? "❚❚" : "▶";
  playBtn.setAttribute("aria-label", player.playing ? "Pause" : "Play");
  count.textContent = has ? `${player.fired} / ${player.events.length}` : "";
}

playBtn.addEventListener("click", () => {
  if (player.playing) player.playing = false;
  else {
    if (player.time >= player.duration) player.seek(0);
    player.playing = true;
  }
});
scrub.addEventListener("input", () => {
  player.seek(Number(scrub.value));
  renderSelected();
});
speedSel.addEventListener("change", () => {
  player.speed = Number(speedSel.value);
  scene.speed = player.speed;
});
networkSel.addEventListener("change", () => {
  history.replaceState(null, "", `?network=${encodeURIComponent(networkSel.value)}`);
  void describe();
});
inputsSel.addEventListener("change", () => (runBtn.disabled = !current || !inputsSel.value));
$<HTMLFormElement>("#controls").addEventListener("submit", run);

let last = performance.now();
let panelAt = 0;
function loop(now: number) {
  player.tick(now, now - last);
  last = now;
  scene.aging(player.time);
  if (scene.walking.size) scene.walk(player.time);
  syncTimeline();
  if (selected && now - panelAt > 250) {
    renderSelected();
    panelAt = now;
  }
  requestAnimationFrame(loop);
}

// -- Attach: follow the runs a demo harness announces --------------------------

interface AttachedRun {
  manifest: {
    demo: string;
    title?: string;
    started: number;
    ended: boolean;
    people?: { id: string; name: string; roles: string[]; url: string }[];
    /** Neurons the demo asks to see walking between the places their file gives them (`at`). */
    walk?: string[];
    /** The network file's ground (SPEC 4.5), announced so the trail glow ages as the engine does. */
    ground?: { evaporate?: number };
  };
  describe: { body: DescribeBody; isError: boolean };
}

function attach() {
  document.body.classList.add("attached");
  for (const el of [networkSel, inputsSel, runBtn]) (el.closest("label") ?? el).setAttribute("hidden", "");
  status("Watching for a demo run (npm run demo <name> in agent-neuron-demos)…");
  let events: TraceEvent[] = [];
  let people: AttachedRun["manifest"]["people"] = [];
  const src = new EventSource("/api/attach");
  src.addEventListener("run", (m) => {
    const r = JSON.parse((m as MessageEvent).data) as AttachedRun;
    const body = r.describe.body;
    if (r.describe.isError || !body.ok) {
      const b = body as Extract<DescribeBody, { ok: false }>;
      current = null;
      scene.clear();
      renderAbout(null, b.errors ?? [], b.warnings ?? [], b.error);
      status(`${r.manifest.demo}: the network does not check`, true);
      return;
    }
    current = body.network;
    people = r.manifest.people ?? [];
    scene.setEvaporate(r.manifest.ground?.evaporate ?? 0);
    scene.show(layout(body.network));
    scene.setWalkers(r.manifest.walk ?? []);
    renderAbout(body.network, [], body.warnings);
    renderPeople(people);
    events = [];
    // The run's t = 0 on this page's clock, from the harness's wall clock.
    player.startLive(performance.now() - (Date.now() - r.manifest.started));
    speedSel.value = "1";
    status(`${r.manifest.title ?? r.manifest.demo}: running`);
  });
  src.addEventListener("events", (m) => {
    const { events: more } = JSON.parse((m as MessageEvent).data) as { events: TraceEvent[] };
    events = events.concat(more);
    if (scene.walking.size) scene.setTrips(trips(events, scene.walking));
    player.update(events);
    player.catchUp(performance.now());
    status(`${current?.name ?? "run"}: ${events.length} events${people?.length ? " · the desk is open" : ""}`);
  });
  src.addEventListener("done", (m) => {
    const d = JSON.parse((m as MessageEvent).data) as { code?: number; trace_events?: TraceEvent[] };
    const all = d.trace_events ?? events;
    if (scene.walking.size) scene.setTrips(trips(all, scene.walking));
    player.update(all, true);
    player.endLive();
    player.playing = player.time < player.duration;
    status(`${current?.name ?? "run"}: done, ${all.length} events${d.code ? ` (exit ${d.code})` : ""}. Waiting for the next run…`, !!d.code);
  });
  src.addEventListener("problem", (m) => status(JSON.parse((m as MessageEvent).data).message, true));
}

function renderPeople(people: AttachedRun["manifest"]["people"]) {
  if (!people?.length) return;
  const h = document.createElement("h2");
  h.textContent = "The desk";
  const ul = document.createElement("ul");
  ul.className = "people";
  for (const p of people) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = p.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = p.name;
    li.append(a, ` ${p.roles.join(", ")}`);
    ul.append(li);
  }
  about.append(h, ul);
}

// Dev only: a handle for browser checks.
if (import.meta.env.DEV) Object.assign(window, { __viz: { scene, player } });

renderLegend();
requestAnimationFrame(loop);
if (new URLSearchParams(location.search).has("attach")) attach();
else loadLists().catch((e) => status(`The bridge is not answering: ${(e as Error).message}`, true));
