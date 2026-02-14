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

type Desc = {
  path: string;
  parentPath: string;
  inst: string;
  mod: string;
  depth: number;
};

type Role = "control" | "memory" | "compute" | "interconnect" | "frontend" | "output" | "io";

type Component = {
  id: string;
  role: Role;
  module: string;
  count: number;
  score: number;
  samples: string[];
  moduleHints: string[];
  synthetic?: boolean;
};

type Edge = {
  from: string;
  to: string;
  weight: number;
  label: string;
  widthBits?: number;
};

type ProtoInfo = {
  protocol?: "TL" | "AXI" | "APB" | "AHB";
  widthBits?: number;
};

type Box = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type Prim = "MUX" | "AND" | "OR" | "XOR" | "SUM" | "MAX";

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

function compactLabel(raw: string): string {
  return cleanLabel(raw)
    .replace(/\bmodule\b/gi, "")
    .replace(/\bwrapper\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeHint(raw: string): string {
  let s = compactLabel(raw);
  s = s.replace(/inclusivecachecontrol/ig, "Inclusive Cache Control");
  s = s.replace(/inclusivecachebankscheduler/ig, "Inclusive Cache Bank Scheduler");
  s = s.replace(/maxperiodfibonaccilfsr/ig, "Victim LFSR PRNG");
  s = s.replace(/plusargreader/ig, "Plusarg Reader");
  s = s.replace(/\ba\d+d\d+s\d+k\d+z\d+c\b/ig, "");
  s = s.replace(/\bq\d+\b/ig, "");
  s = s.replace(/\be\d+\b/ig, "");
  s = s.replace(/\b\d+x\d+\b/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (/^[a-z0-9 ]+$/.test(s)) {
    s = s
      .split(" ")
      .filter(Boolean)
      .map((w) => (w.length <= 3 ? w.toUpperCase() : `${w[0].toUpperCase()}${w.slice(1)}`))
      .join(" ");
  }
  s = s.replace(/\bmshrs?\b/gi, "MSHR");
  s = s.replace(/\bcc\s*banks?\b/gi, "CC Banks");
  s = s.replace(/\bcc\s*dir\s*ext\b/gi, "CC Directory Ext");
  s = s.replace(/\bcc\s*dir\b/gi, "CC Directory");
  s = s.replace(/\bpes?\b/gi, "PE");
  s = s.replace(/\bmac\s*unit\b/gi, "MAC Unit");
  s = s.replace(/\bsource\s+([abcdeyx])\b/gi, (_, ch) => `Source ${String(ch).toUpperCase()}`);
  s = s.replace(/\bsink\s+([abcdeyx])\b/gi, (_, ch) => `Sink ${String(ch).toUpperCase()}`);
  s = s.replace(/^MSHR\s+(\d+)$/i, "MSHR Bank $1");
  s = s.replace(/^CC Banks\s+(\d+)$/i, "CC Bank $1");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function roleLabel(r: Role): string {
  if (r === "control") return "Control";
  if (r === "memory") return "Memory";
  if (r === "compute") return "Compute";
  if (r === "interconnect") return "Interconnect";
  if (r === "frontend") return "Frontend";
  if (r === "output") return "Output";
  return "I/O";
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

function findArrayAlias(root: HierNode): FlatNode | undefined {
  const flat = flatten(root);
  const countDesc = (n: HierNode): number => {
    let c = 0;
    for (const k of kids(n)) c += 1 + countDesc(k);
    return c;
  };
  const strong = flat
    .filter((f) => /(meshwithdelays|mesh|systolic|array)/i.test(`${f.inst} ${f.mod}`))
    .map((f) => {
      const name = `${f.inst} ${f.mod}`.toLowerCase();
      let score = countDesc(f.ref) * 3;
      if (/meshwithdelays|mesh|systolic|array/.test(name)) score += 800;
      if (/pe\\b/.test(name)) score += 80;
      return { f, score };
    })
    .sort((a, b) => b.score - a.score || a.f.path.length - b.f.path.length);
  if (strong[0]?.f) return strong[0].f;

  const fallback = flat
    .filter((f) => /(pe|tile)/i.test(`${f.inst} ${f.mod}`))
    .map((f) => ({ f, score: countDesc(f.ref) }))
    .sort((a, b) => b.score - a.score);
  return fallback[0]?.f;
}

function collectDesc(target: FlatNode): Desc[] {
  const out: Desc[] = [];
  const walk = (n: HierNode, parentPath: string, depth: number) => {
    for (const c of kids(n)) {
      const inst = c.instance_name ?? "";
      const mod = c.module_name ?? "";
      const path = `${parentPath} -> ${inst}:${mod}`;
      out.push({ path, parentPath, inst, mod, depth });
      walk(c, path, depth + 1);
    }
  };
  walk(target.ref, target.path, 1);
  return out;
}

function roleOf(text: string): Role {
  const s = text.toLowerCase();
  if (/(controller|control|scheduler|tlb|counter|pmp|pma|state|cmd|tracker|mshr)/.test(s)) return "control";
  if (/(cache|scratch|spad|sram|ram|mem|bank|dataarray|tag|accumulatormem|directory)/.test(s)) return "memory";
  if (/(mesh|array|pe|mac|pipe|compute|datapath|alu|fpu|execute|accpipe)/.test(s)) return "compute";
  if (/(xbar|bus|interconnect|coupler|fragmenter|tlxbar|axi|tltoaxi|tlbuffer)/.test(s)) return "interconnect";
  if (/(frontend|decode|fetch|im2col|transposer|input|probe|acquire|client)/.test(s)) return "frontend";
  if (/(output|writeback|response|resp|scale|relu|activation|quant|norm)/.test(s)) return "output";
  return "io";
}

function archetypeOf(target: FlatNode, ds: Desc[]): string {
  const t = `${target.inst} ${target.mod} ${ds.map((d) => `${d.inst} ${d.mod}`).join(" ")}`.toLowerCase();
  if (/gemmini|meshwithdelays|transposer|im2col|accumulatormem/.test(t)) return "accelerator";
  if (/inclusivecache|cache|coherencemanager|mshr|refill/.test(t)) return "cache";
  if (/tile|rockettile|boomtile/.test(t)) return "tile";
  if (/xbar|bus|interconnect|axi|tilelink/.test(t)) return "interconnect";
  return "generic";
}

function isNoisy(inst: string, mod: string): boolean {
  const s = `${inst} ${mod}`;
  if (/(queue|monitor|repeater|barrier|optimization|clock|reset|assert|checker|buffer put|list buffer|pipeline\\d*|ram[^a-z0-9]*\\d+x\\d+[a-z0-9_]*|plusarg|lfsr|prng|regmapper)/i.test(s)) return true;
  return false;
}

function familyKey(inst: string, mod: string, role: Role): string {
  const s = `${inst} ${mod}`.toLowerCase();
  if (role === "control") {
    if (/executecontroller/.test(s)) return "execute_controller";
    if (/loadcontroller/.test(s)) return "load_controller";
    if (/storecontroller/.test(s)) return "store_controller";
    if (/tlb/.test(s)) return "tlb";
    if (/mshr/.test(s)) return "mshr";
    if (/controller|scheduler|control/.test(s)) return "controller";
  }
  if (role === "memory") {
    if (/accumulatormem/.test(s)) return "accumulator_mem";
    if (/scratchpadbank/.test(s)) return "scratchpad_bank";
    if (/scratchpad/.test(s)) return "scratchpad";
    if (/dcachedataarray/.test(s)) return "dcache_data";
    if (/icache/.test(s)) return "icache";
    if (/cache/.test(s)) return "cache_mem";
    if (/bank/.test(s)) return "bank_mem";
    if (/tag/.test(s)) return "tag_mem";
  }
  if (role === "compute") {
    if (/meshwithdelays/.test(s)) return "mesh_with_delays";
    if (/mesh\\b/.test(s)) return "mesh";
    if (/\\bpe\\b|pes_/.test(s)) return "pe";
    if (/tile/.test(s)) return "tile";
    if (/mac/.test(s)) return "mac";
    if (/accpipe/.test(s)) return "acc_pipe";
    if (/alu/.test(s)) return "alu";
  }
  if (role === "frontend") {
    if (/transposer/.test(s)) return "transposer";
    if (/im2col/.test(s)) return "im2col";
    if (/frontend/.test(s)) return "frontend";
    if (/probe|acquire|client/.test(s)) return "client_probe";
  }
  if (role === "interconnect") {
    if (/tlxbar|xbar/.test(s)) return "xbar";
    if (/coupler|interconnect/.test(s)) return "coupler";
    if (/fragmenter/.test(s)) return "fragmenter";
    if (/axi|tltoaxi/.test(s)) return "axi_bridge";
    if (/bus/.test(s)) return "bus";
  }
  if (role === "output") {
    if (/accumulatorscale/.test(s)) return "accumulator_scale";
    if (/scalepipe/.test(s)) return "scale_pipe";
    if (/relu|activation/.test(s)) return "activation";
    if (/writeback|response|resp|refill/.test(s)) return "response";
  }
  if (role === "io") {
    if (/(sink|source)[abcdeyx]/.test(s)) return "tl_channels";
  }
  return norm(mod || inst || role);
}

function familyLabel(key: string, archetype: string): string {
  const map: Record<string, string> = {
    execute_controller: "Execute Controller",
    load_controller: "Load Controller",
    store_controller: "Store Controller",
    tlb: "TLB",
    mshr: "MSHR",
    controller: archetype === "cache" ? "Cache Controller" : "Controller",
    accumulator_mem: "Accumulator SRAM",
    scratchpad_bank: "Scratchpad Banks",
    scratchpad: "Scratchpad",
    dcache_data: "DCache Data Array",
    icache: "ICache Arrays",
    cache_mem: "Cache Arrays",
    bank_mem: "Memory Banks",
    tag_mem: "Tag Arrays",
    mesh_with_delays: "Systolic Mesh",
    mesh: "Mesh Fabric",
    pe: "Processing Elements",
    tile: "Tile Grid",
    mac: "MAC Units",
    acc_pipe: "Accumulator Pipe",
    alu: "ALU Pipeline",
    transposer: "Transposer",
    im2col: "Im2Col",
    frontend: "Frontend",
    client_probe: "Client/Probe Interface",
    xbar: "Crossbar",
    coupler: "Interconnect Coupler",
    fragmenter: "Fragmenter",
    axi_bridge: "AXI/TL Bridge",
    bus: "Bus Fabric",
    accumulator_scale: "Accumulator Scale",
    scale_pipe: "Scale Pipeline",
    activation: "Activation",
    response: archetype === "cache" ? "Refill/Response" : "Writeback/Response",
    tl_channels: "TL Channel Pipes",
  };
  return map[key] ?? cleanLabel(key);
}

function inferProtocolInfo(text: string): ProtoInfo {
  const s = text.toLowerCase();
  let protocol: ProtoInfo["protocol"];
  if (/(tilelink|tlxbar|tlbuffer|tltoaxi|tlf|tlul|\btl\b)/.test(s)) protocol = "TL";
  else if (/(axi4|axi)/.test(s)) protocol = "AXI";
  else if (/\bapb\b/.test(s)) protocol = "APB";
  else if (/\bahb\b/.test(s)) protocol = "AHB";

  const widthMatch =
    s.match(/(?:databits|beatsbytes|beatbytes|buswidth|tlwidth|axiwidth|xlen|flen)[^0-9]{0,6}([0-9]{2,4})/) ??
    s.match(/\b([0-9]{2,4})\s*(?:bit|b)\b/) ??
    s.match(/\bw([0-9]{2,4})\b/);

  let widthBits: number | undefined;
  if (widthMatch) {
    const n = Number(widthMatch[1]);
    if (Number.isFinite(n) && n >= 16 && n <= 2048) widthBits = n;
  }
  if (!widthBits && /beatbytes/.test(s) && widthMatch) {
    const n = Number(widthMatch[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 256) widthBits = n * 8;
  }
  return { protocol, widthBits };
}

function mergeProtocolInfo(a: ProtoInfo, b: ProtoInfo): ProtoInfo {
  const protocol = a.protocol ?? b.protocol;
  const widthBits = a.widthBits ?? b.widthBits;
  return { protocol, widthBits };
}

function protocolSuffix(p: ProtoInfo): string {
  if (!p.protocol) return "";
  if (!p.widthBits) return ` (${p.protocol})`;
  return ` (${p.protocol} ${p.widthBits}-b)`;
}

function strokeByBits(bits?: number): number {
  if (!bits || bits <= 0) return 2.2;
  if (bits >= 512) return 6.4;
  if (bits >= 256) return 5.2;
  if (bits >= 128) return 4.2;
  if (bits >= 64) return 3.2;
  return 2.4;
}

function roleToDirectionLabel(a: Role, b: Role, archetype: string): string {
  if (archetype === "accelerator") {
    if (a === "control" && (b === "compute" || b === "frontend")) return "control -> issue";
    if ((a === "memory" && b === "compute") || (a === "compute" && b === "memory")) return "dma <-> data";
    if (a === "frontend" && b === "compute") return "input -> compute";
    if (a === "compute" && b === "output") return "results -> output";
    if (a === "control" && b === "memory") return "control -> dma/tlb";
    return "dataflow";
  }
  if (archetype === "cache") {
    if (a === "control" && b === "interconnect") return "control -> requests";
    if (a === "interconnect" && b === "memory") return "interconnect -> arrays";
    if (a === "memory" && b === "output") return "arrays -> refill/resp";
    if (a === "memory" && b === "compute") return "arrays -> tag/data";
    return "cache path";
  }
  if (a === "control") return "control path";
  if (a === "interconnect" || b === "interconnect") return "interconnect path";
  if (b === "output") return "response path";
  return "data path";
}

function refineComponentName(c: Component): string {
  const generic = new Set([
    "Controller",
    "Frontend",
    "Bus Fabric",
    "Crossbar",
    "Interconnect Coupler",
    "Cache Arrays",
    "Memory Banks",
    "Tile Grid",
    "Processing Elements",
    "Mesh Fabric",
  ]);
  const hint = c.moduleHints[0];
  if (hint && (generic.has(c.module) || c.module.length < 8)) {
    const h = sanitizeHint(hint);
    if (h && h.length >= 4) return h;
  }
  return c.module;
}

function compressedEdgeLabel(raw: string): string {
  const s = raw.toLowerCase();
  if (/^dataflow$/.test(s)) return "compute fabric";
  if (/control/.test(s) && /issue/.test(s)) return "control issue";
  if (/control/.test(s) && /dma|tlb/.test(s)) return "control dma/tlb";
  if (/dma/.test(s) && /data/.test(s)) return "dma/data";
  if (/input/.test(s) && /compute/.test(s)) return "input stream";
  if (/result/.test(s) || /output/.test(s)) return "result path";
  if (/interconnect/.test(s) && /array/.test(s)) return "array access";
  if (/tag/.test(s) || /cache/.test(s)) return "tag/data path";
  return wrap1(raw, 16);
}

function pickDetailHint(c: Component): string {
  const titleN = norm(c.module);
  for (const h0 of c.moduleHints) {
    const h = sanitizeHint(h0);
    if (!h) continue;
    if (norm(h) === titleN) continue;
    if (h.length < 3) continue;
    return h;
  }
  for (const s0 of c.samples) {
    const s = sanitizeHint(s0);
    if (!s) continue;
    if (norm(s) === titleN) continue;
    if (s.length < 3) continue;
    return s;
  }
  return "";
}

function aggregateComponents(ds: Desc[], archetype: string): Component[] {
  const map = new Map<string, Component>();
  for (const d of ds) {
    if (!d.mod) continue;
    if (isNoisy(d.inst, d.mod)) continue;

    const role = roleOf(`${d.inst} ${d.mod}`);
    const key = familyKey(d.inst, d.mod, role);
    if (!key) continue;
    const module = familyLabel(key, archetype);

    let score = d.depth === 1 ? 14 : d.depth === 2 ? 7 : 2;
    if (/controller|cache|mem|mesh|array|xbar|transposer|scale|accumulator|pe|tile|mac/i.test(`${d.inst} ${d.mod}`)) score += 4;
    if (archetype === "accelerator" && /meshwithdelays|accumulatormem|scratchpad|transposer|accpipe|executecontroller/i.test(`${d.inst} ${d.mod}`)) score += 8;
    if (archetype === "cache" && /cache|mshr|refill|bank|tag|dataarray|scheduler/i.test(`${d.inst} ${d.mod}`)) score += 8;

    const prev = map.get(key);
    if (!prev) {
        map.set(key, {
          id: key,
          role,
          module,
          count: 1,
          score,
          samples: [cleanLabel(d.inst || d.mod)],
          moduleHints: [compactLabel(d.mod || d.inst)],
        });
      } else {
        prev.count += 1;
        prev.score += score;
        if (prev.samples.length < 3) prev.samples.push(cleanLabel(d.inst || d.mod));
        const h = compactLabel(d.mod || d.inst);
        if (h && !prev.moduleHints.includes(h) && prev.moduleHints.length < 4) prev.moduleHints.push(h);
      }
  }

  let comps = [...map.values()]
    .map((c) => ({ ...c, score: c.score + Math.min(14, c.count) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.module.localeCompare(b.module));

  comps = comps.filter((c) => !(/^ram\d+x\d+/i.test(c.id) && c.role === "memory" && c.count <= 2));

  // Ensure role diversity.
  const picked: Component[] = [];
  const used = new Set<string>();
  const roleOrder: Role[] =
    archetype === "accelerator"
      ? ["control", "memory", "compute", "frontend", "output", "interconnect", "io"]
      : archetype === "cache"
      ? ["control", "memory", "interconnect", "compute", "frontend", "output", "io"]
      : ["control", "memory", "compute", "interconnect", "frontend", "output", "io"];

  for (const r of roleOrder) {
    const c = comps.find((x) => x.role === r && !used.has(x.id));
    if (c) {
      picked.push(c);
      used.add(c.id);
    }
  }

  for (const c of comps) {
    if (picked.length >= 8) break;
    if (used.has(c.id)) continue;
    picked.push(c);
    used.add(c.id);
  }

  if (picked.length < 4) picked.push(...comps.filter((c) => !used.has(c.id)).slice(0, 4 - picked.length));

  let out = picked.slice(0, 8);
  if (archetype === "cache") {
    const io = out.filter((c) => c.role === "io" && !c.synthetic);
    if (io.length > 2) {
      const pref = io
        .slice()
        .sort((a, b) => {
          const pa = /tl channel|channel/i.test(a.module) ? 2 : /atomics|directory|mshr/i.test(a.module) ? 1 : 0;
          const pb = /tl channel|channel/i.test(b.module) ? 2 : /atomics|directory|mshr/i.test(b.module) ? 1 : 0;
          return pb - pa || b.score - a.score;
        })
        .slice(0, 2)
        .map((c) => c.id);
      const keep = new Set(pref);
      out = out.filter((c) => c.role !== "io" || keep.has(c.id));
    }
  }
  for (const c of out) {
    const refined = refineComponentName(c);
    c.module = sanitizeHint(refined) || refined;
  }
  return out;
}

function addSyntheticInterfaces(comps: Component[], archetype: string): Component[] {
  const out = comps.slice();
  const hasRole = (r: Role) => out.some((c) => c.role === r);
  const computeCount = out.filter((c) => c.role === "compute").length;
  const nonCompute = out.length - computeCount;
  const computeHeavy = computeCount >= 3 && nonCompute <= 2;

  const add = (id: string, role: Role, module: string) => {
    if (out.some((c) => c.id === id)) return;
    out.push({
      id,
      role,
      module,
      count: 1,
      score: 18,
      samples: ["inferred architecture interface"],
      moduleHints: [module],
      synthetic: true,
    });
  };

  if (archetype === "accelerator" || computeHeavy) {
    if (!hasRole("control")) add("if_cmd", "control", "Command Interface");
    if (!hasRole("frontend")) add("if_input", "frontend", "Input Streams");
    if (!hasRole("memory")) add("if_mem", "memory", "Memory Interface");
    if (!hasRole("output")) add("if_out", "output", "Result / Writeback Interface");
  }

  if (archetype === "cache") {
    if (!hasRole("control")) add("if_ctrl", "control", "Cache Control Interface");
    if (!hasRole("interconnect")) add("if_xbar", "interconnect", "TileLink/AXI Interface");
    if (!hasRole("output")) add("if_resp", "output", "Refill / Response Interface");
  }

  return out.slice(0, 10);
}

function componentProto(c: Component): ProtoInfo {
  const src = [c.id, c.module, ...c.moduleHints, ...c.samples].join(" ");
  return inferProtocolInfo(src);
}

function augmentLinksWithInterfaces(comps: Component[], edges: Edge[], archetype: string): Edge[] {
  const out = edges.slice();
  const byRole = new Map<Role, Component[]>();
  for (const c of comps) {
    const arr = byRole.get(c.role) ?? [];
    arr.push(c);
    byRole.set(c.role, arr);
  }
  const top = (r: Role) => byRole.get(r)?.[0];
  const add = (ra: Role, rb: Role, w = 3) => {
    const a = top(ra);
    const b = top(rb);
    if (!a || !b || a.id === b.id) return;
    if (out.some((e) => e.from === a.id && e.to === b.id)) return;
    out.push({ from: a.id, to: b.id, weight: w, label: roleToDirectionLabel(ra, rb, archetype) });
  };

  add("control", "compute");
  add("control", "memory");
  add("frontend", "compute");
  add("memory", "compute");
  add("compute", "output");
  add("interconnect", "memory");
  return out;
}

function inferEdges(ds: Desc[], comps: Component[], archetype: string): Edge[] {
  const compById = new Map<string, Component>();
  for (const c of comps) compById.set(c.id, c);

  const descByPath = new Map<string, Desc>();
  for (const d of ds) descByPath.set(d.path, d);

  const weightMap = new Map<string, number>();
  const labelMap = new Map<string, string>();

  for (const d of ds) {
    const childRole = roleOf(`${d.inst} ${d.mod}`);
    const childK = familyKey(d.inst, d.mod, childRole);
    const p = descByPath.get(d.parentPath);
    if (!p) continue;
    const parentRole = roleOf(`${p.inst} ${p.mod}`);
    const parentK = familyKey(p.inst, p.mod, parentRole);
    if (!parentK || !childK) continue;

    const a = compById.get(parentK);
    const b = compById.get(childK);
    if (!a || !b || a.id === b.id) continue;

    const key = `${a.id}->${b.id}`;
    weightMap.set(key, (weightMap.get(key) ?? 0) + 1);
    if (!labelMap.has(key)) {
      const proto = mergeProtocolInfo(componentProto(a), componentProto(b));
      labelMap.set(key, `${roleToDirectionLabel(a.role, b.role, archetype)}${protocolSuffix(proto)}`);
    }
  }

  let edges: Edge[] = [...weightMap.entries()].map(([k, w]) => {
    const [from, to] = k.split("->");
    const a = compById.get(from);
    const b = compById.get(to);
    const proto = mergeProtocolInfo(a ? componentProto(a) : {}, b ? componentProto(b) : {});
    return { from, to, weight: w, label: labelMap.get(k) ?? "path", widthBits: proto.widthBits };
  });

  if (edges.length === 0) {
    const idx = new Map(comps.map((c, i) => [c.role, i]));
    const add = (ra: Role, rb: Role, w = 2) => {
      const ia = idx.get(ra);
      const ib = idx.get(rb);
      if (ia == null || ib == null || ia === ib) return;
      const a = comps[ia];
      const b = comps[ib];
      const proto = mergeProtocolInfo(componentProto(a), componentProto(b));
      edges.push({
        from: a.id,
        to: b.id,
        weight: w,
        label: `${roleToDirectionLabel(ra, rb, archetype)}${protocolSuffix(proto)}`,
        widthBits: proto.widthBits,
      });
    };
    add("control", "interconnect");
    add("interconnect", "memory");
    add("memory", "compute");
    add("compute", "output");
  }

  edges = augmentLinksWithInterfaces(comps, edges, archetype);
  edges = edges.sort((a, b) => b.weight - a.weight).slice(0, 18);
  return edges;
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

function themeCategory(target: FlatNode, archetype: string): "compute" | "mem" | "bus" | "io" | "ctrl" {
  if (archetype === "accelerator") return "compute";
  if (archetype === "cache") return "mem";
  if (archetype === "interconnect") return "bus";
  const r = roleOf(`${target.inst} ${target.mod}`);
  if (r === "memory") return "mem";
  if (r === "compute") return "compute";
  if (r === "interconnect") return "bus";
  if (r === "io") return "io";
  return "ctrl";
}

function themeBase(cat: "compute" | "mem" | "bus" | "io" | "ctrl"): string {
  if (cat === "compute") return "#1f4f96";
  if (cat === "mem") return "#236a3f";
  if (cat === "bus") return "#5b3f8f";
  if (cat === "io") return "#9a4f10";
  return "#374151";
}

function estimateSize(c: Component): { w: number; h: number } {
  const maxLen = Math.max(c.module.length, ...c.samples.map((s) => s.length), 20);
  const w = Math.max(260, Math.min(430, 170 + maxLen * 6));
  const h = 110 + Math.min(3, c.samples.length) * 34;
  return { w, h };
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

function semanticPathFor(a: Box, b: Box, label: string): Array<{ x: number; y: number }> {
  const acx = Math.round(a.x + a.w / 2);
  const acy = Math.round(a.y + a.h / 2);
  const bcx = Math.round(b.x + b.w / 2);
  const bcy = Math.round(b.y + b.h / 2);
  const sidePt = (bx: Box, s: "left" | "right" | "top" | "bottom") => {
    if (s === "left") return { x: bx.x, y: Math.round(bx.y + bx.h / 2) };
    if (s === "right") return { x: bx.x + bx.w, y: Math.round(bx.y + bx.h / 2) };
    if (s === "top") return { x: Math.round(bx.x + bx.w / 2), y: bx.y };
    return { x: Math.round(bx.x + bx.w / 2), y: bx.y + bx.h };
  };
  const s = label.toLowerCase();
  // Lane reservation for dense compute-heavy views.
  const topLane = 205;
  const midLane = 640;
  const lowLane = 1110;
  if (/control/.test(s)) {
    const ps = sidePt(a, "top");
    const pt = sidePt(b, "top");
    return [
      ps,
      { x: ps.x, y: topLane },
      { x: pt.x, y: topLane },
      pt,
    ];
  }
  if (/dma|mem/.test(s)) {
    const rightward = b.x >= a.x + a.w / 2;
    const ps = sidePt(a, rightward ? "right" : "left");
    const pt = sidePt(b, rightward ? "left" : "right");
    const mx = Math.round((ps.x + pt.x) / 2);
    return [
      ps,
      { x: mx, y: ps.y },
      { x: mx, y: pt.y },
      pt,
    ];
  }
  if (/input/.test(s)) {
    const ps = sidePt(a, "right");
    const pt = sidePt(b, "left");
    return [
      ps,
      { x: ps.x, y: midLane },
      { x: pt.x, y: midLane },
      pt,
    ];
  }
  if (/result|output/.test(s)) {
    const ps = sidePt(a, "right");
    const pt = sidePt(b, "left");
    return [
      ps,
      { x: ps.x, y: lowLane },
      { x: pt.x, y: lowLane },
      pt,
    ];
  }
  if (Math.abs(bcx - acx) >= Math.abs(bcy - acy)) {
    const ps = sidePt(a, bcx >= acx ? "right" : "left");
    const pt = sidePt(b, bcx >= acx ? "left" : "right");
    const mx = Math.round((ps.x + pt.x) / 2);
    return [ps, { x: mx, y: ps.y }, { x: mx, y: pt.y }, pt];
  }
  const ps = sidePt(a, bcy >= acy ? "bottom" : "top");
  const pt = sidePt(b, bcy >= acy ? "top" : "bottom");
  const my = Math.round((ps.y + pt.y) / 2);
  return [ps, { x: ps.x, y: my }, { x: pt.x, y: my }, pt];
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

function segKey(p0: { x: number; y: number }, p1: { x: number; y: number }): string {
  const a = `${p0.x},${p0.y}`;
  const b = `${p1.x},${p1.y}`;
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
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

function pathCost(
  path: Array<{ x: number; y: number }>,
  from: string,
  to: string,
  layout: Record<string, Box>,
  used: Array<{ x0: number; y0: number; x1: number; y1: number }>
): number {
  let score = 0;
  for (let i = 0; i + 1 < path.length; i += 1) {
    const p0 = path[i];
    const p1 = path[i + 1];
    score += Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y);
    for (const [id, b] of Object.entries(layout)) {
      if (id === from || id === to) continue;
      if (segIntersectsRect(p0, p1, b)) score += 12000;
    }
    for (const s of used) score += segCrossCount(p0, p1, { x: s.x0, y: s.y0 }, { x: s.x1, y: s.y1 }) * 600;
  }
  return score;
}

function routeComputeHeavy(
  edges: Edge[],
  layout: Record<string, Box>
): Array<{ from: string; to: string; label: string; weight: number; widthBits?: number; points: Array<{ x: number; y: number }>; labelAt: { x: number; y: number } }> {
  const ordered = edges.slice().sort((a, b) => b.weight - a.weight);
  let prev: Array<{ points: Array<{ x: number; y: number }> }> = [];
  let bestOut: Array<{ from: string; to: string; label: string; weight: number; widthBits?: number; points: Array<{ x: number; y: number }>; labelAt: { x: number; y: number } }> = [];
  let bestCost = Number.POSITIVE_INFINITY;

  for (let iter = 0; iter < 4; iter += 1) {
    const congestion = buildCongestionMap(prev);
    const out: Array<{ from: string; to: string; label: string; weight: number; widthBits?: number; points: Array<{ x: number; y: number }>; labelAt: { x: number; y: number } }> = [];
    const used: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    let total = 0;

    for (const e of ordered) {
      const a = layout[e.from];
      const b = layout[e.to];
      if (!a || !b) continue;
      const candidates: Array<Array<{ x: number; y: number }>> = [
        semanticPathFor(a, b, e.label),
        pathFor(a, b),
        lanePath(a, b, 205),
        lanePath(a, b, 640),
        lanePath(a, b, 1110),
        lanePath(a, b, 300),
        lanePath(a, b, 930),
      ];
      let chosen = candidates[0];
      let chosenScore = Number.POSITIVE_INFINITY;
      for (const c of candidates) {
        let sc = pathCost(c, e.from, e.to, layout, used);
        for (let i = 0; i + 1 < c.length; i += 1) {
          const k = segKey(c[i], c[i + 1]);
          sc += (congestion.get(k) ?? 0) * 380;
        }
        sc += (c.length - 1) * 45;
        if (sc < chosenScore) {
          chosen = c;
          chosenScore = sc;
        }
      }
      for (let i = 0; i + 1 < chosen.length; i += 1) used.push({ x0: chosen[i].x, y0: chosen[i].y, x1: chosen[i + 1].x, y1: chosen[i + 1].y });
      total += chosenScore;
      const m = chosen[Math.floor(chosen.length / 2) - 1] ?? chosen[1] ?? chosen[0];
      out.push({ from: e.from, to: e.to, label: e.label, weight: e.weight, widthBits: e.widthBits, points: chosen, labelAt: m });
    }
    if (total < bestCost) {
      bestCost = total;
      bestOut = out;
    }
    prev = out;
  }
  return bestOut;
}

function segIntersectsRect(a: { x: number; y: number }, b: { x: number; y: number }, r: Box): boolean {
  if (a.x === b.x) {
    const x = a.x;
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    return x > r.x && x < r.x + r.w && y1 > r.y && y0 < r.y + r.h;
  }
  if (a.y === b.y) {
    const y = a.y;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    return y > r.y && y < r.y + r.h && x1 > r.x && x0 < r.x + r.w;
  }
  return false;
}

function crossingCount(lines: Array<Array<{ x: number; y: number }>>): number {
  const segs: Array<{ a: { x: number; y: number }; b: { x: number; y: number } }> = [];
  for (const l of lines) {
    for (let i = 0; i + 1 < l.length; i += 1) segs.push({ a: l[i], b: l[i + 1] });
  }
  let c = 0;
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      const s = segs[i];
      const t = segs[j];
      if (s.a.x === s.b.x && t.a.y === t.b.y) {
        if (Math.min(t.a.x, t.b.x) < s.a.x && s.a.x < Math.max(t.a.x, t.b.x) && Math.min(s.a.y, s.b.y) < t.a.y && t.a.y < Math.max(s.a.y, s.b.y)) c += 1;
      } else if (s.a.y === s.b.y && t.a.x === t.b.x) {
        if (Math.min(s.a.x, s.b.x) < t.a.x && t.a.x < Math.max(s.a.x, s.b.x) && Math.min(t.a.y, t.b.y) < s.a.y && s.a.y < Math.max(t.a.y, t.b.y)) c += 1;
      }
    }
  }
  return c;
}

function roleTarget(role: Role): { x: number; y: number } {
  if (role === "control") return { x: 0.2, y: 0.18 };
  if (role === "frontend") return { x: 0.5, y: 0.18 };
  if (role === "interconnect") return { x: 0.5, y: 0.45 };
  if (role === "memory") return { x: 0.25, y: 0.72 };
  if (role === "compute") return { x: 0.65, y: 0.62 };
  if (role === "output") return { x: 0.8, y: 0.82 };
  return { x: 0.8, y: 0.2 };
}

function optimizePlacement(comps: Component[], edges: Edge[]): Record<string, Box> {
  const x0 = 95;
  const y0 = 170;
  const W = 1710;
  const H = 950;
  const n = comps.length;
  const cols = n <= 4 ? 2 : n <= 6 ? 3 : 4;
  const rows = Math.ceil(n / cols);
  const gapX = 26;
  const gapY = 24;
  const cellW = Math.floor((W - gapX * (cols + 1)) / cols);
  const cellH = Math.floor((H - gapY * (rows + 1)) / rows);

  const slots: Box[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = x0 + gapX + c * (cellW + gapX);
      const y = y0 + gapY + r * (cellH + gapY);
      slots.push({ x, y, w: cellW, h: cellH });
    }
  }

  const sizes = new Map(comps.map((c) => [c.id, estimateSize(c)]));
  let assign = comps.map((_, i) => i); // comp i -> slot index

  const layoutFrom = (as: number[]): Record<string, Box> => {
    const out: Record<string, Box> = {};
    for (let i = 0; i < comps.length; i += 1) {
      const s = slots[as[i]];
      const z = sizes.get(comps[i].id)!;
      out[comps[i].id] = {
        x: s.x + Math.floor((s.w - z.w) / 2),
        y: s.y + Math.floor((s.h - z.h) / 2),
        w: z.w,
        h: z.h,
      };
    }
    return out;
  };

  const costOf = (as: number[]): number => {
    const L = layoutFrom(as);
    let score = 0;
    const lines: Array<Array<{ x: number; y: number }>> = [];

    for (const e of edges) {
      const a = L[e.from];
      const b = L[e.to];
      if (!a || !b) continue;
      const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      score += (Math.abs(ac.x - bc.x) + Math.abs(ac.y - bc.y)) * Math.max(1, e.weight);

      const p = pathFor(a, b);
      lines.push(p);
      for (let i = 0; i + 1 < p.length; i += 1) {
        for (const c of comps) {
          if (c.id === e.from || c.id === e.to) continue;
          if (segIntersectsRect(p[i], p[i + 1], L[c.id])) score += 1500;
        }
      }
    }

    score += crossingCount(lines) * 700;

    // role-shape preference penalty
    for (const c of comps) {
      const b = L[c.id];
      const cx = (b.x - x0 + b.w / 2) / W;
      const cy = (b.y - y0 + b.h / 2) / H;
      const t = roleTarget(c.role);
      score += (Math.abs(cx - t.x) + Math.abs(cy - t.y)) * 280;
    }

    return score;
  };

  // Hill-climbing swap optimization.
  let best = assign.slice();
  let bestCost = costOf(best);
  let improved = true;
  let iter = 0;
  while (improved && iter < 40) {
    improved = false;
    iter += 1;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const cand = best.slice();
        const t = cand[i];
        cand[i] = cand[j];
        cand[j] = t;
        const cst = costOf(cand);
        if (cst + 1e-6 < bestCost) {
          best = cand;
          bestCost = cst;
          improved = true;
        }
      }
    }
  }

  return layoutFrom(best);
}

function wrap1(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(6, maxChars - 1)).trimEnd()}…`;
}

function arrayDims(n: number): { r: number; c: number } {
  if (n <= 1) return { r: 1, c: 1 };
  let bestR = 1;
  let bestC = n;
  let bestGap = n - 1;
  for (let r = 1; r * r <= n; r += 1) {
    const c = Math.ceil(n / r);
    const gap = Math.abs(c - r);
    if (gap < bestGap) {
      bestGap = gap;
      bestR = r;
      bestC = c;
    }
  }
  return { r: bestR, c: bestC };
}

function renderArrayGlyph(b: Box, role: Role, count: number): string {
  if (count < 8) return "";
  const gx = b.x + b.w - 118;
  const gy = b.y + b.h - 76;
  const gw = 98;
  const gh = 56;
  const cells = Math.min(16, count);
  const d = arrayDims(cells);
  const cw = Math.max(6, Math.floor((gw - 10) / d.c) - 2);
  const ch = Math.max(6, Math.floor((gh - 10) / d.r) - 2);
  const rects: string[] = [];
  let k = 0;
  for (let r = 0; r < d.r && k < cells; r += 1) {
    for (let c = 0; c < d.c && k < cells; c += 1) {
      const x = gx + 6 + c * (cw + 2);
      const y = gy + 6 + r * (ch + 2);
      rects.push(`<rect x="${x}" y="${y}" width="${cw}" height="${ch}" class="arrCell role-${role}"/>`);
      k += 1;
    }
  }
  const dim = arrayDims(count);
  return `<rect x="${gx}" y="${gy}" width="${gw}" height="${gh}" class="arrBox"/><g>${rects.join("")}</g><text x="${gx + gw / 2}" y="${gy - 3}" text-anchor="middle" class="arrLbl">${dim.r}x${dim.c}</text>`;
}

function inferPrims(c: Component): Prim[] {
  const s = `${c.id} ${c.module} ${c.moduleHints.join(" ")} ${c.samples.join(" ")}`.toLowerCase();
  const out: Prim[] = [];
  const add = (p: Prim) => {
    if (!out.includes(p)) out.push(p);
  };
  if (/mux|select|arbiter|arb/.test(s)) add("MUX");
  if (/\band\b/.test(s)) add("AND");
  if (/\bor\b/.test(s)) add("OR");
  if (/xor/.test(s)) add("XOR");
  if (/mac|acc|sum|add|accumulator/.test(s)) add("SUM");
  if (/max|relu/.test(s)) add("MAX");
  if (out.length === 0 && c.role === "control") add("MUX");
  if (out.length === 0 && c.role === "compute") add("SUM");
  return out.slice(0, 3);
}

function renderPrimShape(kind: Prim, x: number, y: number, w: number, h: number): string {
  const sty = `fill="#f7fbff" stroke="#1f4f96" stroke-width="1.1"`;
  if (kind === "MUX") {
    return `<polygon points="${x},${y} ${x + w - 6},${y + 2} ${x + w},${y + h / 2} ${x + w - 6},${y + h - 2} ${x},${y + h}" class="primShape" ${sty}/><text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" class="primLbl">MUX</text>`;
  }
  if (kind === "SUM") {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.min(w, h) / 2 - 1;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" class="primShape" ${sty}/><text x="${cx}" y="${cy + 4}" text-anchor="middle" class="primLbl">+</text>`;
  }
  if (kind === "MAX") {
    return `<polygon points="${x + 3},${y} ${x + w - 3},${y} ${x + w},${y + h / 2} ${x + w - 3},${y + h} ${x + 3},${y + h} ${x},${y + h / 2}" class="primShape" ${sty}/><text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" class="primLbl">MAX</text>`;
  }
  if (kind === "AND") {
    const p = `M${x},${y} L${x + w / 2},${y} A${w / 2},${h / 2} 0 0 1 ${x + w / 2},${y + h} L${x},${y + h} Z`;
    return `<path d="${p}" class="primShape" ${sty}/><text x="${x + w / 3}" y="${y + h / 2 + 4}" text-anchor="middle" class="primLbl">AND</text>`;
  }
  if (kind === "OR") {
    const p = `M${x},${y} Q${x + w * 0.2},${y + h / 2} ${x},${y + h} Q${x + w * 0.65},${y + h} ${x + w},${y + h / 2} Q${x + w * 0.65},${y} ${x},${y}`;
    return `<path d="${p}" class="primShape" fill="none" stroke="#1f4f96" stroke-width="1.1"/><text x="${x + w * 0.55}" y="${y + h / 2 + 4}" text-anchor="middle" class="primLbl">OR</text>`;
  }
  const p = `M${x + 4},${y} Q${x + w * 0.25},${y + h / 2} ${x + 4},${y + h} M${x},${y} Q${x + w * 0.2},${y + h / 2} ${x},${y + h} Q${x + w * 0.65},${y + h} ${x + w},${y + h / 2} Q${x + w * 0.65},${y} ${x},${y}`;
  return `<path d="${p}" class="primShape" fill="none" stroke="#1f4f96" stroke-width="1.1"/><text x="${x + w * 0.58}" y="${y + h / 2 + 4}" text-anchor="middle" class="primLbl">XOR</text>`;
}

function renderPrimStrip(c: Component, b: Box): string {
  const ps = inferPrims(c);
  if (ps.length === 0) return "";
  const shown = ps.slice(0, 1);
  const w = 36;
  const h = 20;
  const gap = 6;
  let x = b.x + b.w - 12 - (w * shown.length + gap * (shown.length - 1));
  const y = b.y + 40;
  return shown.map((p) => {
    const s = renderPrimShape(p, x, y, w, h);
    x += w + gap;
    return s;
  }).join("");
}

function fixLabelCollisions(
  labels: Array<{ x: number; y: number; text: string; lane?: "top" | "mid" | "bot" }>,
  boxes: Box[],
  segs: Array<{ x1: number; y1: number; x2: number; y2: number }>
): Array<{ x: number; y: number; text: string }> {
  const out: Array<{ x: number; y: number; text: string; box: Box }> = [];
  const overlaps = (a: Box, b: Box) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  const distSeg = (px: number, py: number, s: { x1: number; y1: number; x2: number; y2: number }) => {
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
  };
  const laneY: Record<NonNullable<(typeof labels)[number]["lane"]>, number> = { top: 150, mid: 640, bot: 1110 };
  for (const l of labels) {
    const tw = Math.max(28, Math.min(220, l.text.length * 7 + 6));
    const th = 13;
    const cands = l.lane
      ? [
          { dx: 8, dy: laneY[l.lane] - l.y },
          { dx: -70, dy: laneY[l.lane] - l.y },
          { dx: 24, dy: laneY[l.lane] - l.y + 12 },
        ]
      : [
      { dx: 8, dy: -8 },
      { dx: 8, dy: 12 },
      { dx: -70, dy: -8 },
      { dx: 22, dy: -18 },
      { dx: -70, dy: 12 },
      ];
    let best: { x: number; y: number; box: Box; score: number } | undefined;
    for (const c of cands) {
      const x = l.x + c.dx;
      const y = l.y + c.dy;
      const box = { x, y: y - th + 2, w: tw, h: th };
      if (box.x < 58 || box.y < 126 || box.x + box.w > 1835 || box.y + box.h > 1160) continue;
      if (boxes.some((b) => overlaps(box, b))) continue;
      if (out.some((p) => overlaps(box, p.box))) continue;
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const d = segs.length ? Math.min(...segs.map((s) => distSeg(cx, cy, s))) : 20;
      let score = Math.abs(c.dx) + Math.abs(c.dy) * 0.4 + (d < 10 ? (10 - d) * 8 : 0);
      if (l.lane) score += Math.abs((box.y + box.h / 2) - laneY[l.lane]) * 0.7;
      if (!best || score < best.score) best = { x, y, box, score };
    }
    if (!best) {
      // Hard constraint mode: drop unresolved labels rather than overlap.
      continue;
    }
    out.push({ x: best.x, y: best.y, text: l.text, box: best.box });
  }
  return out.map(({ box, ...r }) => r);
}

function renderL3(target: FlatNode, archetype: string, comps: Component[], edges: Edge[], outSvg: string): { layout: Record<string, Box>; theme: string } {
  const cat = themeCategory(target, archetype);
  const base = themeBase(cat);
  const deep = tint(base, -0.14);
  const cont = tint(base, 0.92);
  const panel = tint(base, 0.86);
  const region = { x: 95, y: 170, w: 1710, h: 950 };

  const prNodes: PrNode[] = comps.map((c) => ({
    id: c.id,
    role: c.role,
    title: c.module,
    lines: c.synthetic ? ["interface"] : [c.moduleHints[0] ?? "", c.count > 1 ? `instances: ${c.count}` : c.samples[0] ?? ""].filter(Boolean),
    synthetic: c.synthetic,
  }));
  const prEdges: PrEdge[] = edges.map((e) => ({ from: e.from, to: e.to, label: e.label, weight: e.weight }));
  const nodeSize = (n: PrNode): { w: number; h: number } => {
    const maxLen = Math.max(n.title.length, ...(n.lines.length ? n.lines : [""]).map((s) => s.length), 20);
    const baseH = 110 + Math.min(3, n.lines.length) * 34;
    const count = comps.find((c) => c.id === n.id)?.count ?? 1;
    const glyphH = count >= 64 ? 52 : count >= 16 ? 34 : 0;
    return { w: Math.max(260, Math.min(430, 170 + maxLen * 6)), h: baseH + glyphH };
  };
  const pr = placeAndRoute({
    nodes: prNodes,
    edges: prEdges,
    canvas: { width: 1900, height: 1200 },
    region,
    estimateNodeSize: nodeSize,
  });
  let layout = pr.boxes as Record<string, Box>;
  let wires = pr.wires;
  const clusterSvg: string[] = [];

  const computeHeavy =
    comps.filter((c) => c.role === "compute" && !c.synthetic).length >= 3 &&
    comps.some((c) => /mesh|tile|pe|mac/i.test(c.id));
  if (!computeHeavy) {
    // For medium-complexity blocks, a role-banded placement is often more readable than free placement.
    layout = optimizePlacement(comps, edges);
    wires = routeComputeHeavy(edges, layout);
  }
  if (computeHeavy) {
    const roleAnchor: Record<Role, { x: number; y: number }> = {
      control: { x: 0.12, y: 0.18 },
      memory: { x: 0.12, y: 0.34 },
      frontend: { x: 0.18, y: 0.58 },
      output: { x: 0.86, y: 0.58 },
      interconnect: { x: 0.5, y: 0.86 },
      compute: { x: 0.5, y: 0.5 },
      io: { x: 0.85, y: 0.2 },
    };
    const fixed: Record<string, { x: number; y: number }> = {
      mesh: { x: 0.52, y: 0.30 },
      tile: { x: 0.52, y: 0.56 },
      pe: { x: 0.36, y: 0.76 },
      mac: { x: 0.68, y: 0.76 },
      transposer: { x: 0.18, y: 0.56 },
      if_cmd: { x: 0.18, y: 0.18 },
      if_mem: { x: 0.18, y: 0.34 },
      if_out: { x: 0.86, y: 0.56 },
      if_input: { x: 0.18, y: 0.70 },
    };
    const newLayout: Record<string, Box> = {};
    for (const n of prNodes) {
      const s = nodeSize(n);
      const a = fixed[n.id] ?? roleAnchor[n.role];
      const cx = region.x + Math.round(a.x * region.w);
      const cy = region.y + Math.round(a.y * region.h);
      newLayout[n.id] = {
        x: Math.max(region.x, Math.min(region.x + region.w - s.w, cx - Math.round(s.w / 2))),
        y: Math.max(region.y, Math.min(region.y + region.h - s.h, cy - Math.round(s.h / 2))),
        w: s.w,
        h: s.h,
      };
    }
    layout = newLayout;
    wires = routeComputeHeavy(edges, layout);
    const cb = comps.filter((c) => c.role === "compute" && !c.synthetic).map((c) => layout[c.id]).filter((b): b is Box => !!b);
    if (cb.length >= 2) {
      const minX = Math.min(...cb.map((b) => b.x)) - 40;
      const minY = Math.min(...cb.map((b) => b.y)) - 50;
      const maxX = Math.max(...cb.map((b) => b.x + b.w)) + 40;
      const maxY = Math.max(...cb.map((b) => b.y + b.h)) + 40;
      clusterSvg.push(`<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" rx="8" ry="8" class="computeCluster"/>`);
      clusterSvg.push(`<rect x="${minX + 8}" y="${maxY - 20}" width="132" height="16" rx="3" ry="3" class="clusterTag"/>`);
      clusterSvg.push(`<text x="${minX + 12}" y="${maxY - 8}" text-anchor="start" class="clusterLabel">Compute Cluster</text>`);
      const tileB = layout["tile"];
      const peB = layout["pe"];
      const macB = layout["mac"];
      if (tileB) {
        const tx = tileB.x - 22;
        const ty = tileB.y - 18;
        const tw = tileB.w + 44;
        const th = tileB.h + 36;
        clusterSvg.push(`<rect x="${tx}" y="${ty}" width="${tw}" height="${th}" rx="7" ry="7" class="macroCluster"/>`);
        clusterSvg.push(`<rect x="${tx + 6}" y="${ty + 4}" width="96" height="14" rx="3" ry="3" class="clusterTag"/>`);
        clusterSvg.push(`<text x="${tx + 10}" y="${ty + 15}" text-anchor="start" class="macroLabel">Tile Subarray</text>`);
      }
      if (peB && macB) {
        const px = Math.min(peB.x, macB.x) - 20;
        const py = Math.min(peB.y, macB.y) - 18;
        const pw = Math.max(peB.x + peB.w, macB.x + macB.w) - px + 20;
        const ph = Math.max(peB.y + peB.h, macB.y + macB.h) - py + 18;
        clusterSvg.push(`<rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="7" ry="7" class="macroCluster"/>`);
        clusterSvg.push(`<rect x="${px + 6}" y="${py + 4}" width="118" height="14" rx="3" ry="3" class="clusterTag"/>`);
        clusterSvg.push(`<text x="${px + 10}" y="${py + 15}" text-anchor="start" class="macroLabel">PE/MAC Subarray</text>`);
      }
    }
  }

  const compSvg: string[] = [];
  for (const c of comps) {
    const b = layout[c.id];
    const pi = componentProto(c);
    const hint = pickDetailHint(c);
    const r1 = c.synthetic
      ? `${roleLabel(c.role)} interface${protocolSuffix(pi)}`.trim()
      : hint
      ? wrap1(hint, Math.max(14, Math.floor((b.w - 20) / 8)))
      : "";
    const r2 = c.synthetic
      ? ""
      : c.count > 1
      ? `instances: ${c.count}`
      : c.samples[0]
      ? wrap1(sanitizeHint(c.samples[0]), Math.max(14, Math.floor((b.w - 20) / 8)))
      : "";
    const row2 = r1 && r2 && norm(r1) === norm(r2) ? "" : r2;
    compSvg.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="7" ry="7" class="comp role-${c.role}${c.synthetic ? " synthetic" : ""}"/>`);
    if (!c.synthetic) compSvg.push(renderArrayGlyph(b, c.role, c.count));
    if (!c.synthetic) compSvg.push(renderPrimStrip(c, b));
    compSvg.push(`<text x="${b.x + b.w / 2}" y="${b.y + 30}" text-anchor="middle" class="compTitle">${esc(wrap1(c.module, Math.max(14, Math.floor((b.w - 26) / 8))))}</text>`);
    if (r1) compSvg.push(`<text x="${b.x + 14}" y="${b.y + 62}" text-anchor="start" class="compRow">${esc(r1)}</text>`);
    if (row2) compSvg.push(`<text x="${b.x + 14}" y="${b.y + 88}" text-anchor="start" class="compRow">${esc(row2)}</text>`);
  }

  const edgeSvg: string[] = [];
  const edgeLabels: Array<{ x: number; y: number; text: string; lane?: "top" | "mid" | "bot" }> = [];
  const seenEdgeLabels = new Set<string>();
  const labelBudget = computeHeavy ? 4 : 5;
  let labelsUsed = 0;
  const edgeWidth = new Map(edges.map((e) => [`${e.from}->${e.to}`, e.widthBits]));
  const edgeWeight = new Map(edges.map((e) => [`${e.from}->${e.to}`, e.weight]));
  const segs: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (const e of wires) {
    const d = e.points.map((q, i) => `${i === 0 ? "M" : "L"}${q.x},${q.y}`).join(" ");
    const m = e.labelAt;
    const bidi = /<->/.test(e.label);
    const wb = edgeWidth.get(`${e.from}->${e.to}`);
    edgeSvg.push(`<path d="${d}" class="wire${bidi ? " wireBidi" : ""}" style="stroke-width:${strokeByBits(wb)}"/>`);
    for (let i = 0; i + 1 < e.points.length; i += 1) segs.push({ x1: e.points[i].x, y1: e.points[i].y, x2: e.points[i + 1].x, y2: e.points[i + 1].y });
    const k = `${e.from}->${e.to}`;
    const wt = edgeWeight.get(k) ?? 0;
    if ((wt >= 3 || /dma|control|result|input|output|array|tag/i.test(e.label)) && labelsUsed < labelBudget) {
      const s = e.label.toLowerCase();
      const lane = /control/.test(s) ? "top" : /dma|input/.test(s) ? "mid" : /result|output/.test(s) ? "bot" : undefined;
      const text = compressedEdgeLabel(e.label);
      if (!seenEdgeLabels.has(text)) {
        edgeLabels.push({ x: m.x + 8, y: m.y - 8, text, lane });
        seenEdgeLabels.add(text);
        labelsUsed += 1;
      }
    }
  }
  const adjusted = fixLabelCollisions(edgeLabels, comps.map((c) => layout[c.id]), segs);
  for (const l of adjusted) edgeSvg.push(`<text x="${l.x}" y="${l.y}" text-anchor="start" class="wireLabel">${esc(l.text)}</text>`);
  if (computeHeavy) {
    edgeSvg.unshift(`<line x1="${region.x + 20}" y1="205" x2="${region.x + region.w - 20}" y2="205" class="laneGuide"/>`);
    edgeSvg.unshift(`<line x1="${region.x + 20}" y1="640" x2="${region.x + region.w - 20}" y2="640" class="laneGuide"/>`);
    edgeSvg.unshift(`<line x1="${region.x + 20}" y1="1110" x2="${region.x + region.w - 20}" y2="1110" class="laneGuide"/>`);
  }

  const title = `${cleanLabel(target.inst || target.mod)} (${cleanLabel(target.mod || "module")})`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1900" height="1200" viewBox="0 0 1900 1200">
<defs>
  <marker id="arr" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto"><path d="M0,0 L9,3.5 L0,7 z" fill="${deep}"/></marker>
  <marker id="arrS" markerWidth="9" markerHeight="7" refX="1" refY="3.5" orient="auto"><path d="M9,0 L0,3.5 L9,7 z" fill="${deep}"/></marker>
</defs>
<style>
  svg { font-family: "Georgia", "Times New Roman", serif; background: #efefef; }
  .title { font-size: 36px; font-weight: 600; fill: #111; }
  .subtitle { font-size: 18px; fill: #333; }
  .container { fill: ${cont}; stroke: ${base}; stroke-width: 3.2; }
  .comp { fill: ${panel}; stroke: ${deep}; stroke-width: 2.0; }
  .comp.synthetic { stroke-dasharray: 6 3; }
  .role-control { fill: ${tint(base, 0.90)}; }
  .role-memory { fill: ${tint(base, 0.80)}; }
  .role-compute { fill: ${tint(base, 0.70)}; }
  .role-interconnect { fill: ${tint(base, 0.86)}; }
  .role-frontend { fill: ${tint(base, 0.94)}; }
  .role-output { fill: ${tint(base, 0.76)}; }
  .role-io { fill: ${tint(base, 0.88)}; }
  .compTitle { font-size: 21px; fill: #111; }
  .compRow { font-size: 14px; fill: #111; }
  .wire { stroke: ${deep}; stroke-width: 2.2; fill: none; marker-end: url(#arr); }
  .wireBidi { marker-start: url(#arrS); }
  .wireLabel { font-size: 12px; fill: #111; paint-order: stroke; stroke: #efefef; stroke-width: 3; }
  .laneGuide { stroke: ${tint(base, 0.25)}; stroke-width: 0.8; stroke-dasharray: 5 6; opacity: 0.55; }
  .arrBox { fill: rgba(255,255,255,0.45); stroke: ${deep}; stroke-width: 1.1; }
  .arrCell { fill: rgba(255,255,255,0.65); stroke: ${deep}; stroke-width: 0.7; }
  .arrLbl { font-size: 12px; fill: #111; }
  .primShape { stroke: ${deep}; stroke-width: 1.2; fill: rgba(255,255,255,0.72); }
  .primLbl { font-size: 8px; fill: #111; }
  .computeCluster { fill: none; stroke: ${deep}; stroke-width: 1.8; stroke-dasharray: 7 4; }
  .clusterTag { fill: #eef2f7; stroke: ${tint(base, -0.1)}; stroke-width: 0.8; }
  .clusterLabel { font-size: 12px; fill: #111; font-style: italic; }
  .macroCluster { fill: none; stroke: ${deep}; stroke-width: 1.2; stroke-dasharray: 4 3; opacity: 0.9; }
  .macroLabel { font-size: 11px; fill: #111; font-style: italic; }
</style>

<text x="70" y="70" class="title">L3 Internal View: ${esc(title)}</text>
<text x="72" y="98" class="subtitle">Archetype: ${esc(archetype)} | components: ${comps.length}</text>
<rect x="50" y="120" width="1800" height="1045" rx="10" ry="10" class="container"/>
${clusterSvg.join("\n")}
${edgeSvg.join("\n")}
${compSvg.join("\n")}
</svg>`;

  fs.writeFileSync(outSvg, svg, "utf8");
  return { layout, theme: cat };
}

async function main() {
  const [hierPath, blockName, outSvg, outLayoutJson] = process.argv.slice(2);
  if (!hierPath || !blockName || !outSvg) {
    console.error("Usage: node dist/l3_from_hierarchy.js <hier.json> <block-name> <out.svg> [out.layout.json]");
    process.exit(1);
  }

  const root = JSON.parse(fs.readFileSync(hierPath, "utf8")) as HierNode;
  const target = findTarget(root, blockName);
  let found = target as FlatNode | undefined;
  if (!found && /(systolic|array|mesh|pe|tile)/i.test(blockName)) {
    found = findArrayAlias(root);
  }
  if (!found) {
    console.error(`Block '${blockName}' not found in hierarchy.`);
    process.exit(2);
  }
  const foundTarget = found as FlatNode;

  const ds = collectDesc(foundTarget);
  const archetype = archetypeOf(foundTarget, ds);
  const comps = addSyntheticInterfaces(aggregateComponents(ds, archetype), archetype);
  const edges = inferEdges(ds, comps, archetype);
  const rendered = renderL3(foundTarget, archetype, comps, edges, outSvg);

  if (outLayoutJson) {
    fs.writeFileSync(
      outLayoutJson,
      JSON.stringify(
        {
          kind: "l3_generic_optimized",
          target: foundTarget.path,
          archetype,
          theme_category: rendered.theme,
          extracted_nodes: ds.length,
          components: comps,
          edges,
          layout: rendered.layout,
        },
        null,
        2
      ),
      "utf8"
    );
  }

  console.error(`L3 target: ${foundTarget.path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
