import fs from "fs";
import { placeAndRoute, type PrNode, type PrEdge } from "./place_route.js";

type HierNode = {
  instance_name?: string;
  module_name?: string;
  instances?: HierNode[];
  children?: HierNode[];
};

type FlatNode = {
  path: string;
  inst: string;
  mod: string;
  ref: HierNode;
};

type Candidate = {
  raw: string;
  clean: string;
  text: string;
  score: number;
};

type GroupKey = "control" | "memory" | "compute" | "frontend" | "output" | "interconnect";

type Panel = {
  key: GroupKey;
  roleTitle: string;
  rep: string;
  rows: string[];
};

type Link = { from: GroupKey; to: GroupKey; label: string; weight: number; widthBits?: number };

type L2Model = {
  targetTitle: string;
  archetype: string;
  themeCategory: "compute" | "mem" | "bus" | "io" | "ctrl";
  panels: Panel[];
  links: Link[];
  metadata: Record<string, unknown>;
};

type Box = { x: number; y: number; w: number; h: number };
type RoutedLink = { from: GroupKey; to: GroupKey; label: string; widthBits?: number; points: Array<{ x: number; y: number }>; labelAt: { x: number; y: number } };

type GroupCfg = {
  include: RegExp[];
  prefer: RegExp[];
  avoid?: RegExp[];
  roleTitle: string;
};

const GROUPS: Record<GroupKey, GroupCfg> = {
  control: {
    include: [/\bcontroller\b|\bcontrol\b|\btlb\b|\bcounter\b|\btracker\b|\bscheduler\b|\bmshr\b|\bpma\b|\bpmp\b/i],
    prefer: [/executecontroller|loadcontroller|storecontroller|frontendtlb|countercontroller|bankedstore/i],
    avoid: [/queue|monitor|repeater|barrier|pipeline/i],
    roleTitle: "Control",
  },
  memory: {
    include: [/\bmem\b|\bsram\b|\bdram\b|\bram\b|\bbank\b|\bdataarray\b|\btag\b|scratchpad|accumulatormem|dcache|icache/i],
    prefer: [/accumulatormem|scratchpadbank|scratchpad|inclusivecachebankscheduler|dcachedataarray|icache/i],
    avoid: [/queue|monitor|repeater|barrier/i],
    roleTitle: "Memory",
  },
  compute: {
    include: [/meshwithdelays|\bmesh\b|\bpe\b|\baccpipe\b|\bcompute\b|\bdatapath\b|\bbankscheduler\b|\bpipeline\b/i],
    prefer: [/meshwithdelays|accpipeshared|accpipe|inclusivecachebankscheduler|mesh|\bpe\b/i],
    avoid: [/queue|monitor|repeater|barrier|tlmonitor/i],
    roleTitle: "Datapath",
  },
  frontend: {
    include: [/transposer|im2col|frontend|tlb|probe|acquire|release|client|request|tltoaxi4|axi4/i],
    prefer: [/alwaysouttransposer|im2col|frontendtlb|tltoaxi4|axi4idindexer/i],
    avoid: [/queue|monitor|repeater/i],
    roleTitle: "Frontend",
  },
  output: {
    include: [/scale|relu|activation|quant|writeback|response|resp|output|refill|release/i],
    prefer: [/accumulatorscale|scalepipe|writeback|response/i],
    avoid: [/queue|monitor|repeater|recfn|muladd|raw/i],
    roleTitle: "Output",
  },
  interconnect: {
    include: [/xbar|bus|coupler|fragmenter|buffer|tlxbar|interconnect|axi/i],
    prefer: [/tlxbar|systembus|frontbus|memorybus|peripherybus|interconnectcoupler/i],
    avoid: [/monitor|queue|repeater|tlmonitor/i],
    roleTitle: "Interconnect",
  },
};

function kids(n: HierNode): HierNode[] {
  return (n.instances ?? n.children ?? []) as HierNode[];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cleanLabel(raw: string): string {
  let s = raw.trim();
  if (s.includes(":")) {
    const rhs = s.split(":").slice(1).join(":").trim();
    if (rhs) s = rhs;
  }
  s = s.replace(/[_]+/g, " ");
  s = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  s = s.replace(/\s+/g, " ").trim();
  return s || raw;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => `${c}${c}`).join("") : h, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function rgbToHex(r: number, g: number, b: number): string {
  const v = (Math.max(0, Math.min(255, r)) << 16) | (Math.max(0, Math.min(255, g)) << 8) | Math.max(0, Math.min(255, b));
  return `#${v.toString(16).padStart(6, "0")}`;
}

function tint(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(
    Math.round(r + (255 - r) * amount),
    Math.round(g + (255 - g) * amount),
    Math.round(b + (255 - b) * amount)
  );
}

function themeCategoryFromArchetype(archetype: string): "compute" | "mem" | "bus" | "io" | "ctrl" {
  if (archetype === "accelerator") return "compute";
  if (archetype === "cache") return "mem";
  if (archetype === "interconnect") return "bus";
  if (archetype === "tile") return "ctrl";
  return "ctrl";
}

function themeBase(cat: "compute" | "mem" | "bus" | "io" | "ctrl"): string {
  if (cat === "compute") return "#1f4f96";
  if (cat === "mem") return "#236a3f";
  if (cat === "bus") return "#5b3f8f";
  if (cat === "io") return "#9a4f10";
  return "#374151";
}

function flatten(root: HierNode): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (n: HierNode, path: string[]) => {
    const inst = n.instance_name ?? "";
    const mod = n.module_name ?? "";
    const cur = [...path, `${inst}:${mod}`];
    out.push({ path: cur.join(" -> "), inst, mod, ref: n });
    for (const c of kids(n)) walk(c, cur);
  };
  walk(root, []);
  return out;
}

function findTarget(root: HierNode, needle: string): FlatNode | undefined {
  const n = norm(needle);
  const flat = flatten(root);
  const scored = flat
    .map((f) => {
      const instN = norm(f.inst);
      const modN = norm(f.mod);
      const pathN = norm(f.path);
      let score = 0;
      if (instN === n || modN === n) score = 100;
      else if (instN.includes(n) || modN.includes(n)) score = 85;
      else if (pathN.includes(n)) score = 55;
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.f.path.length - b.f.path.length);
  return scored[0]?.f;
}

function descendants(root: HierNode): HierNode[] {
  const out: HierNode[] = [];
  const walk = (n: HierNode) => {
    for (const c of kids(n)) {
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

function archetypeOf(target: FlatNode, ds: HierNode[]): string {
  const t = `${target.inst} ${target.mod} ${ds.map((d) => `${d.instance_name ?? ""} ${d.module_name ?? ""}`).join(" ")}`.toLowerCase();
  if (/gemmini|meshwithdelays|alwaysouttransposer|im2col|accumulatormem/.test(t)) return "accelerator";
  if (/inclusivecache|coherencemanager|bankscheduler|cache/.test(t)) return "cache";
  if (/rockettile|tile/.test(t)) return "tile";
  if (/xbar|systembus|frontbus|memorybus|peripherybus|interconnect/.test(t)) return "interconnect";
  return "generic";
}

function uniqueByNorm(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = norm(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function scoreGroup(ds: HierNode[], cfg: GroupCfg): Candidate[] {
  const out = ds
    .map((d) => {
      const raw = `${d.instance_name ?? ""}:${d.module_name ?? ""}`;
      const text = `${d.instance_name ?? ""} ${d.module_name ?? ""}`;
      const clean = cleanLabel(raw);
      const match = `${text} ${clean}`;
      if (!cfg.include.some((r) => r.test(match))) return undefined;
      let score = 0;
      if (cfg.prefer.some((r) => r.test(match))) score += 32;
      if (cfg.avoid && cfg.avoid.some((r) => r.test(match))) score -= 24;
      if (/queue|monitor|repeater|barrier|optimization/.test(match.toLowerCase())) score -= 14;
      if (/controller|cache|mem|sram|array|mesh|xbar|tlb|accumulator|scratchpad|scale/.test(match.toLowerCase())) score += 8;
      return { raw, clean, text: match, score };
    })
    .filter((x): x is Candidate => !!x)
    .sort((a, b) => b.score - a.score || a.clean.localeCompare(b.clean));

  const seen = new Set<string>();
  const uniq: Candidate[] = [];
  for (const c of out) {
    const k = norm(c.clean);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(c);
  }
  return uniq;
}

function rolePriority(archetype: string): GroupKey[] {
  if (archetype === "accelerator") return ["control", "memory", "compute", "frontend", "output", "interconnect"];
  if (archetype === "cache") return ["control", "memory", "compute", "interconnect", "frontend", "output"];
  if (archetype === "tile") return ["control", "memory", "interconnect", "compute", "frontend", "output"];
  if (archetype === "interconnect") return ["interconnect", "control", "memory", "compute", "frontend", "output"];
  return ["control", "memory", "compute", "interconnect", "frontend", "output"];
}

function roleTitleFor(key: GroupKey, archetype: string): string {
  if (archetype === "accelerator") {
    if (key === "memory") return "Local Memory";
    if (key === "compute") return "Compute Array";
    if (key === "frontend") return "Input Transform";
    if (key === "output") return "Output Path";
  }
  if (archetype === "cache") {
    if (key === "control") return "Control Plane";
    if (key === "memory") return "Data/Tag Arrays";
    if (key === "compute") return "Bank Datapath";
    if (key === "frontend") return "Client/Probe Frontend";
    if (key === "output") return "Refill/Response";
  }
  if (archetype === "tile") {
    if (key === "control") return "Tile Control";
    if (key === "memory") return "Cache/TLB Memory";
    if (key === "interconnect") return "Tile Interconnect";
  }
  return GROUPS[key].roleTitle;
}


function parseRamDims(text: string): { depth: number; bits: number } | undefined {
  const m = text.match(/(\d+)x(\d+)/);
  if (!m) return undefined;
  const depth = Number(m[1]);
  const bits = Number(m[2]);
  if (!Number.isFinite(depth) || !Number.isFinite(bits)) return undefined;
  return { depth, bits };
}

function cleanupCacheToken(text: string): string {
  let s = text.replace(/^ListBuffer_/i, "").replace(/^Queue\d+_/i, "").replace(/^TLBundle[ABCDE]_?/i, "");
  s = s.replace(/_q\d+_e\d+$/i, "");
  s = s.replace(/[_]+/g, " ");
  s = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  s = s.replace(/\bentry\b/gi, "entry");
  return s.trim();
}

function makeCacheRowsFromDesign(ds: HierNode[]): Partial<Record<GroupKey, { rep: string; rows: string[] }>> {
  const mods = ds.map((d) => `${d.instance_name ?? ""}:${d.module_name ?? ""}`);

  const ramMods = mods.filter((m) => /:ram(_|\b)|:ram_data_/i.test(m));
  const ramDims = ramMods
    .map((m) => parseRamDims(m))
    .filter((x): x is { depth: number; bits: number } => !!x);
  const uniqDims = uniqueByNorm(ramDims.map((d) => `${d.depth}x${d.bits}`));
  const widest = ramDims.slice().sort((a, b) => b.bits - a.bits)[0];
  const deepest = ramDims.slice().sort((a, b) => b.depth - a.depth)[0];

  const listBuf = mods.filter((m) => /ListBuffer_|Queue\d+_|Sink[ABCDEX]|Source[ABCDEX]/i.test(m));
  const listKinds = uniqueByNorm(
    listBuf
      .map((m) => {
        const rhs = m.split(":")[1] ?? m;
        const lb = rhs.match(/ListBuffer_([A-Za-z0-9]+)_q(\d+)_e(\d+)/i);
        if (lb) return `${cleanupCacheToken(lb[1])} (q${lb[2]}, e${lb[3]})`;
        const tldb = rhs.match(/Queue\d+_TLBundle([ABCDE])_/i);
        if (tldb) return `TL-${tldb[1]} channel queue`;
        const q = rhs.match(/Queue\d+_([A-Za-z0-9]+)/i);
        if (q) return `${cleanupCacheToken(q[1])} queue`;
        return cleanupCacheToken(rhs);
      })
      .map((x) => x.replace(/\ba\d+d\d+s\d+k\d+z\d+c\b/ig, "").trim())
      .filter((x) => !!x && !/^(source|sink)\s*[abcdeyx]?$/i.test(x))
  );

  const hasBankSched = mods.some((m) => /InclusiveCacheBankScheduler/i.test(m));
  const hasMSHR = mods.some((m) => /\bMSHR\b/i.test(m));

  const out: Partial<Record<GroupKey, { rep: string; rows: string[] }>> = {};

  if (ramMods.length > 0) {
    const rows: string[] = [];
    rows.push(`SRAM macro variants: ${Math.max(1, uniqDims.length)}`);
    if (widest) rows.push(`Widest macro: ${widest.depth}x${widest.bits}`);
    if (deepest) rows.push(`Deepest macro: ${deepest.depth}x${deepest.bits}`);
    if (mods.some((m) => /ram_data_|data_\d+x\d+/i.test(m))) rows.push("Includes data-array storage");
    out.memory = { rep: "Tag/Data SRAM Arrays", rows: uniqueByNorm(rows).slice(0, 4) };
  }

  if (listBuf.length > 0) {
    const rows = listKinds.slice(0, 4);
    out.interconnect = {
      rep: listKinds.some((k) => /put buffer/i.test(k)) ? "Request/Probe Buffer Fabric" : "Queue/Buffer Fabric",
      rows,
    };
  }

  if (hasBankSched && !mods.some((m) => /mesh|compute|datapath/i.test(m))) {
    const rows: string[] = [];
    if (hasMSHR) rows.push("MSHR issue/retire path");
    if (mods.some((m) => /Sink[ABCDEX]/i.test(m))) rows.push("Sink pipelines (A/C/D/E/X)");
    if (mods.some((m) => /Source[ABCDEX]/i.test(m))) rows.push("Source pipelines (A/B/C/D/E/X)");
    out.compute = { rep: "Bank Scheduler Datapath", rows: rows.slice(0, 4) };
  }

  return out;
}

function applyCacheSemanticNames(panels: Panel[], ds: HierNode[]): void {
  const overrides = makeCacheRowsFromDesign(ds);
  for (const p of panels) {
    const o = overrides[p.key];
    if (!o) continue;
    p.rep = o.rep;
    p.rows = o.rows;
  }
}

function buildPanels(target: FlatNode, ds: HierNode[], archetype: string): Panel[] {
  const byGroup: Record<GroupKey, Candidate[]> = {
    control: scoreGroup(ds, GROUPS.control),
    memory: scoreGroup(ds, GROUPS.memory),
    compute: scoreGroup(ds, GROUPS.compute),
    frontend: scoreGroup(ds, GROUPS.frontend),
    output: scoreGroup(ds, GROUPS.output),
    interconnect: scoreGroup(ds, GROUPS.interconnect),
  };

  const pri = rolePriority(archetype);
  const chosen: Panel[] = [];
  const used = new Set<string>();

  for (const g of pri) {
    const cands = byGroup[g].filter((c) => c.score >= 0 && !used.has(norm(c.clean)));
    if (cands.length === 0) continue;
    const rep = cands[0].clean;
    used.add(norm(rep));
    const rows = uniqueByNorm(cands.slice(1).map((c) => c.clean).filter((r) => !used.has(norm(r)))).slice(0, 4);
    rows.forEach((r) => used.add(norm(r)));
    chosen.push({ key: g, roleTitle: roleTitleFor(g, archetype), rep, rows });
    if (chosen.length >= 5) break;
  }

  if (chosen.length < 4) {
    const fallbackGroups: GroupKey[] = ["control", "memory", "compute", "interconnect"];
    for (const g of fallbackGroups) {
      if (chosen.some((p) => p.key === g)) continue;
      chosen.push({ key: g, roleTitle: roleTitleFor(g, archetype), rep: `No clear ${g} module`, rows: [] });
      if (chosen.length >= 4) break;
    }
  }

  // Keep accumulator SRAM in memory only for accelerator-like designs.
  if (archetype === "accelerator") {
    const mem = chosen.find((p) => p.key === "memory");
    const out = chosen.find((p) => p.key === "output");
    const hasAcc = ds.some((d) => /accumulatormem/i.test(`${d.module_name ?? ""} ${d.instance_name ?? ""}`));
    if (mem && hasAcc && ![mem.rep, ...mem.rows].some((x) => /accumulatormem|accumulator sram/i.test(x))) {
      mem.rows = ["Accumulator SRAM (AccumulatorMem)", ...mem.rows].slice(0, 4);
    }
    if (out) {
      out.rows = out.rows.filter((x) => !/accumulatormem|accumulator sram/i.test(x));
      if (/accumulatormem|accumulator sram/i.test(out.rep)) out.rep = "Accumulator Scale";
    }
  }

  if (archetype === "cache") applyCacheSemanticNames(chosen, ds);

  return chosen;
}

function linksFor(archetype: string, panels: Panel[]): Link[] {
  const has = new Set(panels.map((p) => p.key));
  const out: Link[] = [];
  const add = (from: GroupKey, to: GroupKey, label: string, weight = 1, widthBits?: number) => {
    if (!has.has(from) || !has.has(to) || from === to) return;
    out.push({ from, to, label, weight, widthBits });
  };

  if (archetype === "accelerator") {
    add("control", "compute", "Compute Commands", 2, 64);
    add("control", "memory", "DMA + Load/Store Ctrl", 2, 64);
    add("memory", "compute", "Operand / Partial-Sum Data", 3, 128);
    add("frontend", "compute", "Transformed Inputs", 2, 128);
    add("compute", "output", "Partial Sums -> Scaled Output", 3, 128);
  } else if (archetype === "cache") {
    add("control", "interconnect", "Control / Requests", 2, 64);
    add("frontend", "interconnect", "Client / Probe Traffic", 2, 64);
    add("interconnect", "memory", "Array Accesses", 3, 128);
    add("memory", "compute", "Tag + Data Operations", 2, 128);
    add("compute", "output", "Responses / Refills", 2, 64);
  } else {
    add("control", "interconnect", "Control / Requests", 2, 64);
    add("control", "memory", "Metadata / Control", 1, 64);
    add("interconnect", "memory", "Data Path", 2, 128);
    add("memory", "compute", "Data Path", 2, 128);
    add("compute", "output", "Responses / Outputs", 1, 64);
    add("frontend", "interconnect", "Input Path", 1, 64);
  }

  if (out.length === 0) {
    for (let i = 0; i + 1 < panels.length; i += 1) {
      out.push({ from: panels[i].key, to: panels[i + 1].key, label: "Data Path", weight: 1, widthBits: 64 });
    }
  }
  return out;
}

function strokeByBits(bits?: number): number {
  if (!bits || bits <= 0) return 2.2;
  if (bits >= 512) return 6.4;
  if (bits >= 256) return 5.2;
  if (bits >= 128) return 4.2;
  if (bits >= 64) return 3.2;
  return 2.4;
}

function segKey(p0: { x: number; y: number }, p1: { x: number; y: number }): string {
  const a = `${p0.x},${p0.y}`;
  const b = `${p1.x},${p1.y}`;
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

function segCrossCount(
  a0: { x: number; y: number },
  a1: { x: number; y: number },
  b0: { x: number; y: number },
  b1: { x: number; y: number }
): number {
  if (a0.x === a1.x && b0.y === b1.y) {
    if (Math.min(b0.x, b1.x) < a0.x && a0.x < Math.max(b0.x, b1.x) && Math.min(a0.y, a1.y) < b0.y && b0.y < Math.max(a0.y, a1.y)) return 1;
  } else if (a0.y === a1.y && b0.x === b1.x) {
    if (Math.min(a0.x, a1.x) < b0.x && b0.x < Math.max(a0.x, a1.x) && Math.min(b0.y, b1.y) < a0.y && a0.y < Math.max(b0.y, b1.y)) return 1;
  }
  return 0;
}

function buildCongestionMap(wires: Array<{ points: Array<{ x: number; y: number }> }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of wires) {
    for (let i = 0; i + 1 < w.points.length; i += 1) {
      const k = segKey(w.points[i], w.points[i + 1]);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  }
  return m;
}

function lanePath(a: Box, b: Box, laneY: number): Array<{ x: number; y: number }> {
  const acx = Math.round(a.x + a.w / 2);
  const bcx = Math.round(b.x + b.w / 2);
  const asy = laneY < a.y + a.h / 2 ? a.y : a.y + a.h;
  const bsy = laneY < b.y + b.h / 2 ? b.y : b.y + b.h;
  return [
    { x: acx, y: asy },
    { x: acx, y: laneY },
    { x: bcx, y: laneY },
    { x: bcx, y: bsy },
  ];
}

function linkPathCost(path: Array<{ x: number; y: number }>, from: GroupKey, to: GroupKey, placement: Record<GroupKey, Box>, used: Array<{ x0: number; y0: number; x1: number; y1: number }>): number {
  let score = 0;
  const keys = Object.keys(placement) as GroupKey[];
  for (let i = 0; i + 1 < path.length; i += 1) {
    const p0 = path[i];
    const p1 = path[i + 1];
    score += Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y);
    for (const k of keys) {
      if (k === from || k === to) continue;
      if (segmentRectIntersect(p0.x, p0.y, p1.x, p1.y, placement[k])) score += 12000;
    }
    for (const s of used) score += segCrossCount(p0, p1, { x: s.x0, y: s.y0 }, { x: s.x1, y: s.y1 }) * 500;
  }
  return score;
}

function negotiateLinks(links: Link[], placement: Record<GroupKey, Box>): RoutedLink[] {
  const ordered = links.slice().sort((a, b) => b.weight - a.weight);
  let prev: Array<{ points: Array<{ x: number; y: number }> }> = [];
  let best: RoutedLink[] = [];
  let bestCost = Number.POSITIVE_INFINITY;
  for (let iter = 0; iter < 4; iter += 1) {
    const congestion = buildCongestionMap(prev);
    const out: RoutedLink[] = [];
    const used: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    let total = 0;
    for (const e of ordered) {
      const a = placement[e.from];
      const b = placement[e.to];
      if (!a || !b) continue;
      const cands = [
        pathFor(a, b),
        lanePath(a, b, 250),
        lanePath(a, b, 540),
        lanePath(a, b, 830),
      ];
      let choice = cands[0];
      let bestSc = Number.POSITIVE_INFINITY;
      for (const c of cands) {
        let sc = linkPathCost(c, e.from, e.to, placement, used);
        for (let i = 0; i + 1 < c.length; i += 1) sc += (congestion.get(segKey(c[i], c[i + 1])) ?? 0) * 300;
        sc += (c.length - 1) * 35;
        if (sc < bestSc) {
          bestSc = sc;
          choice = c;
        }
      }
      for (let i = 0; i + 1 < choice.length; i += 1) used.push({ x0: choice[i].x, y0: choice[i].y, x1: choice[i + 1].x, y1: choice[i + 1].y });
      total += bestSc;
      const mid = choice[Math.floor(choice.length / 2) - 1] ?? choice[1] ?? choice[0];
      out.push({ from: e.from, to: e.to, label: e.label, widthBits: e.widthBits, points: choice, labelAt: mid });
    }
    if (total < bestCost) {
      bestCost = total;
      best = out;
    }
    prev = out;
  }
  return best;
}

type LabelReq = { x: number; y: number; text: string; align: "start" | "middle"; priority: number; lane?: "top" | "midA" | "midB" | "midC" | "bot" };
type Rect = { x: number; y: number; w: number; h: number };
type Seg = { x1: number; y1: number; x2: number; y2: number };

function distPointToOrthSeg(px: number, py: number, s: Seg): number {
  if (s.x1 === s.x2) {
    const x = s.x1;
    const y0 = Math.min(s.y1, s.y2);
    const y1 = Math.max(s.y1, s.y2);
    const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
    return Math.hypot(px - x, dy);
  }
  const y = s.y1;
  const x0 = Math.min(s.x1, s.x2);
  const x1 = Math.max(s.x1, s.x2);
  const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
  return Math.hypot(dx, py - y);
}

function overlaps(a: Rect, b: Rect): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function placeLabels(reqs: LabelReq[], avoidRects: Rect[], segs: Seg[], bounds: Rect): Array<LabelReq & { px: number; py: number }> {
  const placed: Array<LabelReq & { px: number; py: number; box: Rect }> = [];
  const ordered = reqs.slice().sort((a, b) => b.priority - a.priority);
  const cands = [
    { dx: 0, dy: -8 },
    { dx: 0, dy: 14 },
    { dx: 10, dy: -8 },
    { dx: 10, dy: 14 },
    { dx: -90, dy: -8 },
    { dx: -90, dy: 14 },
    { dx: 24, dy: -20 },
  ];
  const laneY: Record<NonNullable<LabelReq["lane"]>, number> = {
    top: bounds.y + 18,
    midA: bounds.y + Math.floor(bounds.h * 0.46),
    midB: bounds.y + Math.floor(bounds.h * 0.50),
    midC: bounds.y + Math.floor(bounds.h * 0.54),
    bot: bounds.y + bounds.h - 12,
  };
  for (const r of ordered) {
    const tw = Math.max(36, Math.min(280, r.text.length * 7 + 6));
    const th = 14;
    let best: { px: number; py: number; box: Rect; score: number } | undefined;
    const laneCandidates = r.lane
      ? [{ dx: -140, dy: laneY[r.lane] - r.y }, { dx: -60, dy: laneY[r.lane] - r.y }, { dx: 20, dy: laneY[r.lane] - r.y }, { dx: 100, dy: laneY[r.lane] - r.y }]
      : cands;
    for (const c of laneCandidates) {
      const px = r.x + c.dx;
      const py = r.y + c.dy;
      const bx = r.align === "middle" ? px - tw / 2 : px;
      const by = py - th + 2;
      const box = { x: bx, y: by, w: tw, h: th };
      if (box.x < bounds.x || box.y < bounds.y || box.x + box.w > bounds.x + bounds.w || box.y + box.h > bounds.y + bounds.h) continue;
      if (avoidRects.some((a) => overlaps(box, a))) continue;
      if (placed.some((p) => overlaps(box, p.box))) continue;
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      let score = Math.abs(c.dx) + Math.abs(c.dy) * 0.3;
      if (r.lane) score += Math.abs((box.y + box.h / 2) - laneY[r.lane]) * 0.7;
      const dseg = segs.length ? Math.min(...segs.map((s) => distPointToOrthSeg(cx, cy, s))) : 30;
      if (dseg < 8) score += (8 - dseg) * 12;
      if (!best || score < best.score) best = { px, py, box, score };
    }
    if (!best) {
      // Hard constraint mode: drop unresolved low-priority labels to avoid clutter.
      if (r.priority < 9) continue;
      // For highest-priority labels, allow a bounded fallback near anchor.
      const px = r.x + 8;
      const py = r.lane ? laneY[r.lane] : r.y - 8;
      const bx = r.align === "middle" ? px - tw / 2 : px;
      const by = py - th + 2;
      const fb = { x: bx, y: by, w: tw, h: th };
      if (avoidRects.some((a) => overlaps(fb, a)) || placed.some((p) => overlaps(fb, p.box))) continue;
      placed.push({ ...r, px, py, box: fb });
      continue;
    }
    placed.push({ ...r, px: best.px, py: best.py, box: best.box });
  }
  return placed.map(({ box, ...x }) => x);
}

function textWrapLines(s: string, maxChars: number, maxLines: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [s];
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const nxt = cur ? `${cur} ${w}` : w;
    if (nxt.length <= maxChars || cur.length === 0) {
      cur = nxt;
      continue;
    }
    lines.push(cur);
    cur = w;
    if (lines.length === maxLines - 1) break;
  }
  const used = lines.join(" ").split(/\s+/).filter(Boolean).length;
  const rest = words.slice(used).join(" ");
  if (lines.length < maxLines && rest) lines.push(rest.length > maxChars ? `${rest.slice(0, Math.max(4, maxChars - 1)).trimEnd()}…` : rest);
  return lines.slice(0, maxLines);
}

function estimatePanelBox(p: Panel): { w: number; h: number } {
  const content = [p.roleTitle, p.rep, ...p.rows];
  const maxLen = Math.max(...content.map((s) => s.length), 24);
  const w = Math.max(400, Math.min(560, 220 + maxLen * 6));
  const h = 120 + Math.min(4, p.rows.length) * 54;
  return { w, h };
}

function segmentRectIntersect(ax: number, ay: number, bx: number, by: number, r: Box): boolean {
  if (ax === bx) {
    const x = ax;
    const y0 = Math.min(ay, by);
    const y1 = Math.max(ay, by);
    return x > r.x && x < r.x + r.w && y1 > r.y && y0 < r.y + r.h;
  }
  if (ay === by) {
    const y = ay;
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    return y > r.y && y < r.y + r.h && x1 > r.x && x0 < r.x + r.w;
  }
  return false;
}

function pathFor(a: Box, b: Box): Array<{ x: number; y: number }> {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  const dx = bcx - acx;
  const dy = bcy - acy;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const sx = dx >= 0 ? a.x + a.w : a.x;
    const sy = acy;
    const tx = dx >= 0 ? b.x : b.x + b.w;
    const ty = bcy;
    const mx = Math.round((sx + tx) / 2);
    return [
      { x: Math.round(sx), y: Math.round(sy) },
      { x: mx, y: Math.round(sy) },
      { x: mx, y: Math.round(ty) },
      { x: Math.round(tx), y: Math.round(ty) },
    ];
  }

  const sx = acx;
  const sy = dy >= 0 ? a.y + a.h : a.y;
  const tx = bcx;
  const ty = dy >= 0 ? b.y : b.y + b.h;
  const my = Math.round((sy + ty) / 2);
  return [
    { x: Math.round(sx), y: Math.round(sy) },
    { x: Math.round(sx), y: my },
    { x: Math.round(tx), y: my },
    { x: Math.round(tx), y: Math.round(ty) },
  ];
}

function countCrossings(lines: Array<Array<{ x: number; y: number }>>): number {
  const segs: Array<{ ax: number; ay: number; bx: number; by: number }> = [];
  for (const l of lines) {
    for (let i = 0; i + 1 < l.length; i += 1) {
      segs.push({ ax: l[i].x, ay: l[i].y, bx: l[i + 1].x, by: l[i + 1].y });
    }
  }
  let c = 0;
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      const s = segs[i];
      const t = segs[j];
      if (s.ax === s.bx && t.ay === t.by) {
        if (Math.min(t.ax, t.bx) < s.ax && s.ax < Math.max(t.ax, t.bx) && Math.min(s.ay, s.by) < t.ay && t.ay < Math.max(s.ay, s.by)) c += 1;
      } else if (s.ay === s.by && t.ax === t.bx) {
        if (Math.min(s.ax, s.bx) < t.ax && t.ax < Math.max(s.ax, s.bx) && Math.min(t.ay, t.by) < s.ay && s.ay < Math.max(t.ay, t.by)) c += 1;
      }
    }
  }
  return c;
}

function permute<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr.slice()];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += 1) {
    const head = arr[i];
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permute(rest)) out.push([head, ...p]);
  }
  return out;
}

function optimizePlacement(panels: Panel[], links: Link[]): Record<GroupKey, Box> {
  const slots = [
    { x: 90, y: 180 },
    { x: 690, y: 180 },
    { x: 1290, y: 180 },
    { x: 90, y: 670 },
    { x: 690, y: 670 },
    { x: 1290, y: 670 },
  ];

  const sizes = new Map<GroupKey, { w: number; h: number }>();
  panels.forEach((p) => sizes.set(p.key, estimatePanelBox(p)));

  const panelKeys = panels.map((p) => p.key);
  const slotIdx = slots.map((_, i) => i).slice(0, Math.max(panelKeys.length, 4));
  const choices = permute(slotIdx).slice(0, 720);

  let bestScore = Number.POSITIVE_INFINITY;
  let best: Record<GroupKey, Box> | undefined;

  for (const choice of choices) {
    const map: Record<GroupKey, Box> = {} as Record<GroupKey, Box>;
    let ok = true;
    for (let i = 0; i < panelKeys.length; i += 1) {
      const k = panelKeys[i];
      const s = slots[choice[i]];
      const z = sizes.get(k)!;
      const b: Box = { x: s.x, y: s.y, w: z.w, h: z.h };
      if (b.x + b.w > 1810 || b.y + b.h > 1130) ok = false;
      map[k] = b;
    }
    if (!ok) continue;

    let score = 0;
    const lines: Array<Array<{ x: number; y: number }>> = [];
    for (const e of links) {
      const a = map[e.from];
      const b = map[e.to];
      if (!a || !b) continue;
      const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      score += (Math.abs(ac.x - bc.x) + Math.abs(ac.y - bc.y)) * e.weight;

      const p = pathFor(a, b);
      lines.push(p);
      for (let i = 0; i + 1 < p.length; i += 1) {
        const q0 = p[i];
        const q1 = p[i + 1];
        for (const k of panelKeys) {
          if (k === e.from || k === e.to) continue;
          if (segmentRectIntersect(q0.x, q0.y, q1.x, q1.y, map[k])) score += 1800;
        }
      }
    }

    score += countCrossings(lines) * 900;

    if (score < bestScore) {
      bestScore = score;
      best = map;
    }
  }

  if (!best) {
    const fallback: Record<GroupKey, Box> = {} as Record<GroupKey, Box>;
    panels.forEach((p, i) => {
      const s = slots[i];
      const z = sizes.get(p.key)!;
      fallback[p.key] = { x: s.x, y: s.y, w: z.w, h: z.h };
    });
    return fallback;
  }
  return best;
}

function renderPanelTitle(cx: number, y: number, w: number, text: string): { svg: string; h: number } {
  const lines = textWrapLines(text, Math.max(22, Math.floor((w - 32) / 10)), 2);
  const lineH = 28;
  const t = lines
    .map((ln, i) => `<tspan x="${cx}" dy="${i === 0 ? 0 : lineH}">${esc(ln)}</tspan>`)
    .join("");
  return { svg: `<text x="${cx}" y="${y + 30}" text-anchor="middle" class="panelTitle">${t}</text>`, h: 16 + lines.length * lineH };
}

function renderRows(x: number, y: number, w: number, rows: string[]): string {
  const rh = 48;
  return rows
    .slice(0, 4)
    .map((r, i) => {
      const yy = y + i * rh;
      const rr = textWrapLines(r, Math.max(14, Math.floor((w - 18) / 9)), 1)[0];
      return `<rect x="${x}" y="${yy}" width="${w}" height="${rh}" class="subRow"/><text x="${x + w / 2}" y="${yy + 31}" text-anchor="middle" class="subLabel">${esc(rr)}</text>`;
    })
    .join("\n");
}

function inferPanelPrims(p: Panel): string[] {
  const s = `${p.rep} ${p.rows.join(" ")}`.toLowerCase();
  const out: string[] = [];
  const add = (k: string) => {
    if (!out.includes(k)) out.push(k);
  };
  if (/mux|arbiter|select/.test(s)) add("MUX");
  if (/sum|acc|mac|add/.test(s)) add("SUM");
  if (/max|relu/.test(s)) add("MAX");
  if (/\band\b/.test(s)) add("AND");
  if (/\bor\b/.test(s)) add("OR");
  if (/xor/.test(s)) add("XOR");
  if (out.length === 0 && p.key === "control") add("MUX");
  if (out.length === 0 && p.key === "compute") add("SUM");
  return out.slice(0, 2);
}

function renderPanelPrimStrip(p: Panel, b: Box): string {
  const ps = inferPanelPrims(p);
  if (ps.length === 0) return "";
  const pad = 12;
  const w = 42;
  const h = 18;
  const g = 6;
  const y = b.y + 42;
  let x = b.x + b.w - pad - (w * ps.length + g * (ps.length - 1));
  return ps.map((k) => {
    const r = `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="primBox" fill="#f7fbff" stroke="#1f4f96" stroke-width="0.9"/><text x="${x + w / 2}" y="${y + 13}" text-anchor="middle" class="primLbl">${esc(k)}</text>`;
    x += w + g;
    return r;
  }).join("");
}

function buildModel(target: FlatNode): L2Model {
  const ds = descendants(target.ref);
  const archetype = archetypeOf(target, ds);
  const themeCategory = themeCategoryFromArchetype(archetype);
  const panels = buildPanels(target, ds, archetype);
  const links = linksFor(archetype, panels);

  const targetTitle = `${cleanLabel(target.inst || target.mod)} (${cleanLabel(target.mod || "module")})`;

  return {
    targetTitle,
    archetype,
    themeCategory,
    panels,
    links,
    metadata: {
      archetype,
      theme_category: themeCategory,
      extracted_nodes: ds.length,
      panel_count: panels.length,
      panels,
      links,
    },
  };
}

function renderL2Svg(m: L2Model): string {
  const w = 1900;
  const h = 1200;
  const isAccel = m.archetype === "accelerator";
  const sizeByRole = new Map<GroupKey, { w: number; h: number }>();
  for (const p of m.panels) sizeByRole.set(p.key, estimatePanelBox(p));
  const placement: Record<GroupKey, Box> = {} as Record<GroupKey, Box>;
  if (isAccel) {
    const anchors: Record<GroupKey, { x: number; y: number }> = {
      memory: { x: 0.15, y: 0.28 },
      control: { x: 0.15, y: 0.72 },
      compute: { x: 0.50, y: 0.30 },
      output: { x: 0.82, y: 0.30 },
      frontend: { x: 0.82, y: 0.72 },
      interconnect: { x: 0.50, y: 0.10 },
    };
    const region = { x: 90, y: 180, w: 1720, h: 930 };
    for (const p of m.panels) {
      const a = anchors[p.key];
      const sz = sizeByRole.get(p.key) ?? { w: 480, h: 330 };
      const cx = region.x + Math.round(a.x * region.w);
      const cy = region.y + Math.round(a.y * region.h);
      placement[p.key] = {
        x: Math.max(region.x, Math.min(region.x + region.w - sz.w, cx - Math.round(sz.w / 2))),
        y: Math.max(region.y, Math.min(region.y + region.h - sz.h, cy - Math.round(sz.h / 2))),
        w: sz.w,
        h: sz.h,
      };
    }
  } else {
    const prNodes: PrNode[] = m.panels.map((p) => ({
      id: p.key,
      role: p.key,
      title: `${p.roleTitle}: ${p.rep}`,
      lines: p.rows.length ? p.rows.slice(0, 4) : ["(no dominant sub-blocks)"],
    }));
    const prEdges: PrEdge[] = m.links.map((e) => ({ from: e.from, to: e.to, label: e.label, weight: e.weight }));
    const pr = placeAndRoute({
      nodes: prNodes,
      edges: prEdges,
      canvas: { width: w, height: h },
      region: { x: 90, y: 180, w: 1720, h: 930 },
      estimateNodeSize: (n) => {
        const maxLen = Math.max(n.title.length, ...n.lines.map((s) => s.length), 24);
        return { w: Math.max(400, Math.min(560, 220 + maxLen * 6)), h: 120 + Math.min(4, n.lines.length) * 54 };
      },
    });
    Object.assign(placement, pr.boxes as Record<GroupKey, Box>);
  }
  const byKey = new Map(m.panels.map((p) => [p.key, p]));

  const base = themeBase(m.themeCategory);
  const baseDark = tint(base, -0.12);
  const containerFill = tint(base, 0.93);
  const panelFill = tint(base, 0.9);
  const roleFill: Record<GroupKey, string> = {
    control: tint(base, 0.88),
    memory: tint(base, 0.84),
    compute: tint(base, 0.8),
    frontend: tint(base, 0.9),
    output: tint(base, 0.86),
    interconnect: tint(base, 0.82),
  };

  const panelSvgs: string[] = [];
  for (const p of m.panels) {
    const b = placement[p.key];
    const title = `${p.roleTitle}: ${p.rep}`;
    const th = renderPanelTitle(b.x + b.w / 2, b.y + 8, b.w, title);
    panelSvgs.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" class="panel panel-${p.key}"/>`);
    panelSvgs.push(th.svg);
    panelSvgs.push(renderPanelPrimStrip(p, b));
    panelSvgs.push(renderRows(b.x + 14, b.y + 12 + th.h + 10, b.w - 28, p.rows.length ? p.rows : ["(no dominant sub-blocks)"]));
  }

  const linkSvgs: string[] = [];
  const busSvgs: string[] = [];
  const clusterSvgs: string[] = [];
  const labelReqs: LabelReq[] = [];
  const segs: Seg[] = [];
  if (isAccel) {
    type Bus = { id: string; name: string; type: string; width: string; widthBits: number; x1: number; x2: number; y: number };
    const buses: Bus[] = [
      { id: "out", name: "Output Bus", type: "stream", width: "128-b", widthBits: 128, x1: 250, x2: 1650, y: 160 },
      { id: "mem", name: "Memory Bus", type: "TL", width: "128-b", widthBits: 128, x1: 250, x2: 1650, y: 610 },
      { id: "cmd", name: "Command Bus", type: "RoCC/TL", width: "64-b", widthBits: 64, x1: 250, x2: 1650, y: 650 },
      { id: "inp", name: "Input Bus", type: "stream", width: "128-b", widthBits: 128, x1: 250, x2: 1650, y: 690 },
    ];
    const byRole = new Map(m.panels.map((p) => [p.key, placement[p.key]]));
    const clusterOf = (roles: GroupKey[], title: string, cls: string) => {
      const boxes = roles.map((r) => byRole.get(r)).filter((b): b is Box => !!b);
      if (boxes.length === 0) return;
      const minX = Math.min(...boxes.map((b) => b.x)) - 24;
      const minY = Math.min(...boxes.map((b) => b.y)) - 24;
      const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + 24;
      const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + 24;
      const padTop = 30;
      const y0 = minY - padTop;
      clusterSvgs.push(`<rect x="${minX}" y="${y0}" width="${maxX - minX}" height="${maxY - y0}" class="cluster ${cls}"/>`);
      clusterSvgs.push(`<rect x="${minX + 6}" y="${y0 + 4}" width="${Math.max(120, title.length * 7)}" height="18" class="clusterTag"/>`);
      clusterSvgs.push(`<text x="${minX + 10}" y="${y0 + 17}" text-anchor="start" class="clusterTitle">${esc(title)}</text>`);
    };
    clusterOf(["memory", "control"], "Control + Memory Plane", "cluster-cm");
    clusterOf(["compute"], "Compute Plane", "cluster-comp");
    clusterOf(["frontend", "output"], "I/O Transform + Output Plane", "cluster-io");
    const tapCache = new Map<string, { x: number; y: number }>();
    const tapFor = (role: GroupKey, bus: Bus): { x: number; y: number } | undefined => {
      const k = `${role}:${bus.id}`;
      if (tapCache.has(k)) return tapCache.get(k);
      const b = byRole.get(role);
      if (!b) return undefined;
      const x = Math.max(bus.x1 + 12, Math.min(bus.x2 - 12, Math.round(b.x + b.w / 2)));
      const p = { x, y: bus.y };
      tapCache.set(k, p);
      return p;
    };
    const edgePoint = (r: GroupKey, x: number, y: number): { x: number; y: number } | undefined => {
      const b = byRole.get(r);
      if (!b) return undefined;
      const cy = b.y + b.h / 2;
      const cx = b.x + b.w / 2;
      if (Math.abs(y - cy) >= Math.abs(x - cx)) {
        return y < cy ? { x: Math.round(cx), y: b.y } : { x: Math.round(cx), y: b.y + b.h };
      }
      return x < cx ? { x: b.x, y: Math.round(cy) } : { x: b.x + b.w, y: Math.round(cy) };
    };
    for (const b of buses) {
      busSvgs.push(`<path d="M${b.x1},${b.y} L${b.x2},${b.y}" class="bus" style="stroke-width:${strokeByBits(b.widthBits)}"/>`);
      segs.push({ x1: b.x1, y1: b.y, x2: b.x2, y2: b.y });
      const lane = b.id === "out" ? "top" : b.id === "mem" ? "midA" : b.id === "cmd" ? "midB" : "midC";
      labelReqs.push({ x: b.x1 + 8, y: b.y - 10, text: `${b.name} (${b.type}, ${b.width})`, align: "start", priority: 10, lane });
    }
    const busOf = (a: GroupKey, b: GroupKey): string => {
      if ((a === "control" && b === "compute") || (a === "compute" && b === "control")) return "cmd";
      if ((a === "control" && b === "memory") || (a === "memory" && b === "control")) return "cmd";
      if ((a === "memory" && b === "compute") || (a === "compute" && b === "memory")) return "mem";
      if ((a === "frontend" && b === "compute") || (a === "compute" && b === "frontend")) return "inp";
      if ((a === "compute" && b === "output") || (a === "output" && b === "compute")) return "out";
      return "mem";
    };
    let labelBudget = 3;
    for (const e of m.links) {
      const bus = buses.find((b) => b.id === busOf(e.from, e.to));
      if (!bus) continue;
      const sTap = tapFor(e.from, bus);
      const tTap = tapFor(e.to, bus);
      if (!sTap || !tTap) continue;
      const sEdge = edgePoint(e.from, sTap.x, sTap.y);
      const tEdge = edgePoint(e.to, tTap.x, tTap.y);
      if (!sEdge || !tEdge) continue;
      const wb = e.widthBits ?? bus.widthBits;
      linkSvgs.push(`<path d="M${sEdge.x},${sEdge.y} L${sTap.x},${sTap.y}" class="tap" style="stroke-width:${Math.max(1.8, strokeByBits(wb) - 0.6)}"/>`);
      linkSvgs.push(`<path d="M${sTap.x},${sTap.y} L${tTap.x},${tTap.y}" class="wire" style="stroke-width:${strokeByBits(wb)}"/>`);
      linkSvgs.push(`<path d="M${tTap.x},${tTap.y} L${tEdge.x},${tEdge.y}" class="tap" style="stroke-width:${Math.max(1.8, strokeByBits(wb) - 0.6)}"/>`);
      segs.push({ x1: sEdge.x, y1: sEdge.y, x2: sTap.x, y2: sTap.y });
      segs.push({ x1: sTap.x, y1: sTap.y, x2: tTap.x, y2: tTap.y });
      segs.push({ x1: tTap.x, y1: tTap.y, x2: tEdge.x, y2: tEdge.y });
      linkSvgs.push(`<circle cx="${sTap.x}" cy="${sTap.y}" r="4" class="tapDot"/>`);
      linkSvgs.push(`<circle cx="${tTap.x}" cy="${tTap.y}" r="4" class="tapDot"/>`);
      const important = /partial|operand|result|dma|command/i.test(e.label);
      if (labelBudget > 0 && important) {
        const lx = Math.round((sTap.x + tTap.x) / 2);
        const ly = bus.y - (bus.id === "out" ? 12 : 6);
        labelReqs.push({ x: lx, y: ly, text: textWrapLines(e.label, 24, 1)[0], align: "middle", priority: 8, lane: bus.id === "out" ? "top" : bus.id === "mem" ? "midA" : bus.id === "cmd" ? "midB" : "midC" });
        labelBudget -= 1;
      }
    }
  } else {
    const prNodes: PrNode[] = m.panels.map((p) => ({
      id: p.key,
      role: p.key,
      title: `${p.roleTitle}: ${p.rep}`,
      lines: p.rows.length ? p.rows.slice(0, 4) : ["(no dominant sub-blocks)"],
    }));
    const prEdges: PrEdge[] = m.links.map((e) => ({ from: e.from, to: e.to, label: e.label, weight: e.weight }));
    const pr = placeAndRoute({
      nodes: prNodes,
      edges: prEdges,
      canvas: { width: w, height: h },
      region: { x: 90, y: 180, w: 1720, h: 930 },
      estimateNodeSize: (n) => {
        const maxLen = Math.max(n.title.length, ...n.lines.map((s) => s.length), 24);
        return { w: Math.max(400, Math.min(560, 220 + maxLen * 6)), h: 120 + Math.min(4, n.lines.length) * 54 };
      },
    });
    const routed = negotiateLinks(m.links, placement);
    for (const e of routed) {
      const d = e.points.map((q, i) => `${i === 0 ? "M" : "L"}${q.x},${q.y}`).join(" ");
      const mid = e.labelAt;
      linkSvgs.push(`<path d="${d}" class="wire" style="stroke-width:${strokeByBits(e.widthBits)}"/>`);
      for (let i = 0; i + 1 < e.points.length; i += 1) segs.push({ x1: e.points[i].x, y1: e.points[i].y, x2: e.points[i + 1].x, y2: e.points[i + 1].y });
      labelReqs.push({ x: mid.x + 8, y: mid.y - 8, text: textWrapLines(e.label, 28, 1)[0], align: "start", priority: 6 });
    }
  }
  const avoidRects: Rect[] = Object.values(placement).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
  const labels = placeLabels(labelReqs, avoidRects, segs, { x: 60, y: 125, w: 1780, h: 1025 });
  for (const l of labels) linkSvgs.push(`<text x="${l.px}" y="${l.py}" text-anchor="${l.align}" class="wireLabel">${esc(l.text)}</text>`);

  const subtitle = `Archetype: ${m.archetype}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs>
  <marker id="arr" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto"><path d="M0,0 L9,3.5 L0,7 z" fill="#111"/></marker>
</defs>
<style>
  svg { font-family: "Times New Roman", serif; background: #efefef; }
  .title { font-size: 40px; font-weight: 600; fill: #111; }
  .subtitle { font-size: 20px; fill: #333; }
  .container { fill: ${containerFill}; stroke: ${base}; stroke-width: 3.2; }
  .panel { fill: ${panelFill}; stroke: ${baseDark}; stroke-width: 2.2; }
  .panel-control { fill: ${roleFill.control}; }
  .panel-memory { fill: ${roleFill.memory}; }
  .panel-compute { fill: ${roleFill.compute}; }
  .panel-frontend { fill: ${roleFill.frontend}; }
  .panel-output { fill: ${roleFill.output}; }
  .panel-interconnect { fill: ${roleFill.interconnect}; }
  .panelTitle { font-size: 28px; fill: #111; }
  .subRow { fill: #f7f7f7; stroke: #777; stroke-width: 1.0; }
  .subLabel { font-size: 19px; fill: #111; }
  .wire { stroke: ${baseDark}; stroke-width: 2.3; fill: none; marker-end: url(#arr); }
  .tap { stroke: ${baseDark}; stroke-width: 2.0; fill: none; }
  .tapDot { fill: ${baseDark}; }
  .bus { stroke: ${baseDark}; stroke-width: 4.6; fill: none; opacity: 0.85; }
  .busLabel { font-size: 13px; fill: #1a1a1a; font-style: italic; }
  .cluster { fill: none; stroke: ${tint(base, -0.08)}; stroke-width: 1.6; stroke-dasharray: 7 4; }
  .cluster-cm { stroke: ${tint(base, -0.12)}; }
  .cluster-comp { stroke: ${tint(base, -0.18)}; }
  .cluster-io { stroke: ${tint(base, -0.05)}; }
  .clusterTag { fill: #eef2f7; stroke: ${tint(base, -0.06)}; stroke-width: 0.9; }
  .clusterTitle { font-size: 12px; fill: #222; font-style: italic; }
  .primBox { fill: rgba(255,255,255,0.72); stroke: ${baseDark}; stroke-width: 1.2; }
  .primLbl { font-size: 8px; fill: #111; }
  .wireLabel { font-size: 12px; fill: #111; paint-order: stroke; stroke: #efefef; stroke-width: 3; }
</style>

<text x="70" y="70" class="title">L2 Internal View: ${esc(m.targetTitle)}</text>
<text x="72" y="98" class="subtitle">${esc(subtitle)}</text>
<rect x="50" y="115" width="1800" height="1045" class="container"/>
${clusterSvgs.join("\n")}
${busSvgs.join("\n")}
${linkSvgs.join("\n")}
${panelSvgs.join("\n")}
</svg>`;
}

async function main() {
  const [hierPath, blockName, outSvg, outLayoutJson] = process.argv.slice(2);
  if (!hierPath || !blockName || !outSvg) {
    console.error("Usage: node dist/l2_from_hierarchy.js <hier.json> <block-name> <out.svg> [out.layout.json]");
    process.exit(1);
  }

  const root = JSON.parse(fs.readFileSync(hierPath, "utf8")) as HierNode;
  const target = findTarget(root, blockName);
  if (!target) {
    const sample = flatten(root).slice(0, 50).map((x) => `${x.inst || "?"} (${x.mod || "?"})`).join(", ");
    console.error(`Block '${blockName}' not found in hierarchy.\\nExamples: ${sample}`);
    process.exit(2);
  }

  const foundTarget = target as FlatNode;
  const model = buildModel(foundTarget);
  const svg = renderL2Svg(model);
  fs.writeFileSync(outSvg, svg, "utf8");

  if (outLayoutJson) {
    fs.writeFileSync(
      outLayoutJson,
      JSON.stringify(
        {
          kind: "l2_generic_structured",
          target: foundTarget.path,
          ...model.metadata,
        },
        null,
        2
      ),
      "utf8"
    );
  }

  console.error(`L2 target: ${foundTarget.path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
