import fs from "fs";
import { placeAndRoute, type PrEdge, type PrNode } from "./place_route.js";
import { execFileSync } from "child_process";

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

type Role = "control" | "memory" | "compute" | "interconnect" | "frontend" | "output" | "io" | "gate";
type GateKind = "AND" | "OR" | "XOR" | "NOT" | "MUX" | "ADD" | "MUL" | "CMP" | "MAX" | "LOGIC";

type Component = {
  id: string;
  role: Role;
  module: string;
  count: number;
  score: number;
  samples: string[];
  hints: string[];
  gateKind?: GateKind;
  synthetic?: boolean;
};

type Edge = {
  from: string;
  to: string;
  label: string;
  weight: number;
  widthBits?: number;
};

type Wire = {
  from: string;
  to: string;
  label: string;
  weight: number;
  points: Array<{ x: number; y: number }>;
  labelAt: { x: number; y: number };
};

type Box = { x: number; y: number; w: number; h: number };
type AbstractionKind = "sub-block" | "gate-informed sub-block" | "pure-logic gate-level" | "rtl-symbolic";

type RtlOps = {
  mux: number;
  add: number;
  sub: number;
  mul: number;
  div: number;
  and: number;
  or: number;
  xor: number;
  not: number;
  shift: number;
  cmp: number;
  regs: number;
};

type ShapeLibrary = {
  defs: string;
  byGate: Partial<Record<GateKind, { viewW: number; viewH: number; content: string }>>;
  reg?: { viewW: number; viewH: number; content: string };
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

function loadShapeLibrary(): ShapeLibrary {
  const candidates = [
    "rules/shapes/shapes.xml",
    "../tools/diagrammer/rules/shapes/shapes.xml",
    "tools/diagrammer/rules/shapes/shapes.xml",
  ];
  let xml = "";
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        xml = fs.readFileSync(p, "utf8");
        if (xml.trim()) break;
      } catch {
        // keep trying
      }
    }
  }
  if (!xml) return { defs: "", byGate: {} };

  const symbolMatches = xml.match(/<symbol\b[\s\S]*?<\/symbol>/g) ?? [];
  const styleMatches = xml.match(/<style\b[\s\S]*?<\/style>/g) ?? [];
  const symbolsById = new Map<string, string>();
  for (const s of symbolMatches) {
    const idm = s.match(/id="([^"]+)"/);
    if (!idm?.[1]) continue;
    symbolsById.set(idm[1], s);
  }

  const defsParts: string[] = [];
  if (styleMatches.length) defsParts.push(...styleMatches);
  if (symbolsById.size) defsParts.push(...symbolsById.values());
  const defs = defsParts.join("\n");
  const parseSym = (id: string): { viewW: number; viewH: number; content: string } | undefined => {
    const s = symbolsById.get(id);
    if (!s) return undefined;
    const vm = s.match(/viewBox="([^"]+)"/);
    const vb = (vm?.[1] ?? "0 0 80 60").trim().split(/\s+/).map((x) => Number(x));
    const viewW = Number.isFinite(vb[2]) ? vb[2] : 80;
    const viewH = Number.isFinite(vb[3]) ? vb[3] : 60;
    const content = s.replace(/^<symbol\b[^>]*>/, "").replace(/<\/symbol>\s*$/, "");
    return { viewW, viewH, content };
  };

  const byGate: Partial<Record<GateKind, { viewW: number; viewH: number; content: string }>> = {};
  const mux = parseSym("mux2");
  const adder = parseSym("adder");
  const cmp = parseSym("cmp");
  const and2 = parseSym("and2");
  const or2 = parseSym("or2");
  const xor2 = parseSym("xor2");
  const not1 = parseSym("not1");
  if (mux) byGate.MUX = mux;
  if (adder) byGate.ADD = adder;
  if (cmp) byGate.CMP = cmp;
  if (cmp) byGate.MAX = cmp;
  if (and2) byGate.AND = and2;
  if (or2) byGate.OR = or2;
  if (xor2) byGate.XOR = xor2;
  if (not1) byGate.NOT = not1;

  return { defs, byGate, reg: parseSym("dff") };
}

const SHAPES = loadShapeLibrary();

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

function subtreeLabels(n: HierNode, cap = 300): string[] {
  const out: string[] = [];
  const walk = (x: HierNode) => {
    if (out.length >= cap) return;
    out.push(`${x.instance_name ?? ""} ${x.module_name ?? ""}`.toLowerCase());
    for (const c of kids(x)) walk(c);
  };
  walk(n);
  return out;
}

function inferLeafFeatures(root: HierNode, target: FlatNode): { preload: boolean; bypass: boolean; quant: boolean; relu: boolean } {
  const flat = flatten(root);
  const byPath = new Map(flat.map((f) => [f.path, f]));
  const parts = target.path.split(" -> ");
  const parentPath = parts.length > 1 ? parts.slice(0, -1).join(" -> ") : "";
  const grandPath = parts.length > 2 ? parts.slice(0, -2).join(" -> ") : "";
  const parent = parentPath ? byPath.get(parentPath)?.ref : undefined;
  const grand = grandPath ? byPath.get(grandPath)?.ref : undefined;
  const local = [
    `${target.inst} ${target.mod}`.toLowerCase(),
    ...(parent ? subtreeLabels(parent, 240) : []),
    ...(grand ? subtreeLabels(grand, 240) : []),
  ].join(" ");
  const preload = /(preload|accumulator|acc[_ ]?read|partial[_ ]?sum)/.test(local);
  const bypass = /(bypass|forward|passthrough|skip)/.test(local);
  const quant = /(quant|scale|normalize|clamp|round|saturat)/.test(local);
  const relu = /(relu|maxpool|max[_ ]?act|activation)/.test(local);
  return { preload, bypass, quant, relu };
}

function dirnameOf(p: string): string {
  const n = p.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(0, i) || "." : ".";
}

function tryFindModuleBody(hierPath: string, moduleName: string): string | undefined {
  const rootDir = fs.statSync(hierPath).isFile() ? dirnameOf(hierPath) : hierPath;
  const pattern = `module\\s+${moduleName}\\b`;
  try {
    const out = execFileSync("rg", ["-l", "-P", pattern, rootDir, "-g", "*.v", "-g", "*.sv"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const files = out.split(/\r?\n/).map((s: string) => s.trim()).filter(Boolean).slice(0, 8);
    for (const f of files) {
      let txt = "";
      try {
        txt = fs.readFileSync(f, "utf8");
      } catch {
        continue;
      }
      const re = new RegExp(`module\\s+${moduleName}\\b[\\s\\S]*?endmodule`, "m");
      const m = txt.match(re);
      if (m?.[0]) return m[0];
    }
  } catch {
    // ignore rg failures and fallback below
  }
  return undefined;
}

function countMatches(s: string, re: RegExp): number {
  const m = s.match(re);
  return m ? m.length : 0;
}

function inferOpsFromInstantiations(body: string): Partial<RtlOps> {
  const out: Partial<RtlOps> = {};
  const modInstRe = /^\s*([A-Za-z_][A-Za-z0-9_$]*)\s*(?:#\s*\([\s\S]*?\)\s*)?([A-Za-z_][A-Za-z0-9_$]*)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = modInstRe.exec(body)) !== null) {
    const mod = (m[1] ?? "").toLowerCase();
    if (!mod || /^(module|if|for|while|case|assign|always|wire|reg|logic|input|output|inout)$/.test(mod)) continue;
    if (/mux|select|arb/.test(mod)) out.mux = (out.mux ?? 0) + 1;
    if (/mul|mult|mac/.test(mod)) out.mul = (out.mul ?? 0) + 1;
    if (/add|sub|acc|sum|mac/.test(mod)) out.add = (out.add ?? 0) + 1;
    if (/(and|nand)\b/.test(mod)) out.and = (out.and ?? 0) + 1;
    if (/(^|_)or(_|$)|nor/.test(mod)) out.or = (out.or ?? 0) + 1;
    if (/xor|xnor/.test(mod)) out.xor = (out.xor ?? 0) + 1;
    if (/not|inv/.test(mod)) out.not = (out.not ?? 0) + 1;
    if (/cmp|compare|max|min|relu/.test(mod)) out.cmp = (out.cmp ?? 0) + 1;
    if (/reg|dff|ff|flop|latch|state/.test(mod)) out.regs = (out.regs ?? 0) + 1;
    if (/shift|shl|shr|barrel/.test(mod)) out.shift = (out.shift ?? 0) + 1;
  }
  return out;
}

function extractRtlOps(body: string): RtlOps {
  const clean = body
    .replace(/\/\/.*$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/"([^"\\]|\\.)*"/g, " ")
    .toLowerCase();
  const infer = inferOpsFromInstantiations(clean);
  return {
    mux: countMatches(clean, /\?/g) + countMatches(clean, /\bif\s*\(/g) + (infer.mux ?? 0),
    add: countMatches(clean, /\+/g) + (infer.add ?? 0),
    sub: countMatches(clean, /-/g),
    mul: countMatches(clean, /\*/g) + (infer.mul ?? 0),
    div: countMatches(clean, /\//g),
    and: countMatches(clean, /&&|&/g) + (infer.and ?? 0),
    or: countMatches(clean, /\|\||\|/g) + (infer.or ?? 0),
    xor: countMatches(clean, /\^/g) + (infer.xor ?? 0),
    not: countMatches(clean, /~|!/g) + (infer.not ?? 0),
    shift: countMatches(clean, /<<|>>/g) + (infer.shift ?? 0),
    cmp: countMatches(clean, /==|!=|>=|<=|>|</g) + (infer.cmp ?? 0),
    regs: countMatches(clean, /\balways(_ff)?\b[\s\S]{0,180}\b(posedge|negedge)\b/g) + countMatches(clean, /\b(reg|logic)\b[^;]*;/g) + (infer.regs ?? 0),
  };
}

function buildRtlSymbolicModel(target: FlatNode, ops: RtlOps): { comps: Component[]; edges: Edge[] } | undefined {
  const opTotal = ops.mux + ops.add + ops.sub + ops.mul + ops.div + ops.and + ops.or + ops.xor + ops.not + ops.shift + ops.cmp;
  if (opTotal <= 0) return undefined;

  const comps: Component[] = [
    { id: "if_in", role: "frontend", module: "Input Interface", count: 1, score: 20, samples: ["from RTL ports"], hints: ["Input"], synthetic: true },
  ];
  const addOp = (id: string, module: string, kind: GateKind, count: number) => {
    if (count <= 0) return;
    comps.push({
      id,
      role: "gate",
      module,
      count,
      score: 22,
      samples: [`rtl count: ${count}`],
      hints: [module],
      gateKind: kind,
      synthetic: true,
    });
  };
  addOp("op_mux", "MUX Network", "MUX", ops.mux);
  addOp("op_mul", "Multiply Units", "MUL", ops.mul);
  addOp("op_add", "Adder/Subtract", "ADD", ops.add + ops.sub);
  addOp("op_and", "AND Gates", "AND", ops.and);
  addOp("op_or", "OR Gates", "OR", ops.or);
  addOp("op_xor", "XOR Gates", "XOR", ops.xor);
  addOp("op_not", "Inverters", "NOT", ops.not);
  addOp("op_shift", "Shift Units", "LOGIC", ops.shift);
  addOp("op_cmp", "Compare/Select", "CMP", ops.cmp);
  if (ops.regs > 0) {
    comps.push({
      id: "regs",
      role: "memory",
      module: "Registers",
      count: ops.regs,
      score: 20,
      samples: [`rtl count: ${ops.regs}`],
      hints: ["Sequential State"],
      synthetic: true,
    });
  }
  comps.push({ id: "if_out", role: "output", module: "Output Interface", count: 1, score: 20, samples: ["to RTL ports"], hints: ["Output"], synthetic: true });

  const chain = comps.filter((c) => c.id.startsWith("op_")).map((c) => c.id);
  const gateKinds = new Set(comps.filter((c) => c.id.startsWith("op_")).map((c) => c.gateKind ?? "LOGIC"));
  const peLike = /(pe|mac|alu|systolic)/i.test(`${target.inst} ${target.mod}`);
  if (peLike && gateKinds.size < 3) {
    if (!chain.includes("op_mul")) {
      comps.push({
        id: "op_mul",
        role: "gate",
        module: "Multiply Units",
        count: 1,
        score: 21,
        samples: ["inferred from PE archetype"],
        hints: ["Multiply Units"],
        gateKind: "MUL",
        synthetic: true,
      });
      chain.splice(Math.min(1, chain.length), 0, "op_mul");
    }
    if (!chain.includes("op_add")) {
      comps.push({
        id: "op_add",
        role: "gate",
        module: "Adder/Subtract",
        count: 1,
        score: 21,
        samples: ["inferred from PE archetype"],
        hints: ["Adder/Subtract"],
        gateKind: "ADD",
        synthetic: true,
      });
      const idx = Math.min(2, chain.length);
      chain.splice(idx, 0, "op_add");
    }
  }
  const edges: Edge[] = [];
  if (chain.length === 0) {
    edges.push({ from: "if_in", to: "if_out", label: "data path", weight: 2, widthBits: 64 });
  } else {
    edges.push({ from: "if_in", to: chain[0], label: "input path", weight: 3, widthBits: 64 });
    for (let i = 0; i + 1 < chain.length; i += 1) edges.push({ from: chain[i], to: chain[i + 1], label: "rtl op path", weight: 3, widthBits: 64 });
    edges.push({ from: chain[chain.length - 1], to: "if_out", label: "result path", weight: 3, widthBits: 64 });
    if (ops.regs > 0) {
      edges.push({ from: chain[Math.floor(chain.length / 2)], to: "regs", label: "state update", weight: 2, widthBits: 64 });
      edges.push({ from: "regs", to: chain[Math.min(chain.length - 1, Math.floor(chain.length / 2) + 1)], label: "state feedback", weight: 2, widthBits: 64 });
    }
  }
  return { comps: comps.slice(0, 12), edges: edges.slice(0, 24) };
}

function collectDesc(target: FlatNode, maxDepth: number): Desc[] {
  const out: Desc[] = [];
  const walk = (n: HierNode, parentPath: string, depth: number) => {
    if (depth > maxDepth) return;
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

function archetypeOf(target: FlatNode, ds: Desc[]): string {
  const t = `${target.inst} ${target.mod} ${ds.map((d) => `${d.inst} ${d.mod}`).join(" ")}`.toLowerCase();
  if (/gemmini|mesh|systolic|pe|mac|accpipe|transposer/.test(t)) return "accelerator";
  if (/cache|mshr|refill|directory|coherence/.test(t)) return "cache";
  if (/xbar|interconnect|bus|axi|tilelink/.test(t)) return "interconnect";
  if (/tile|rocket|boom/.test(t)) return "tile";
  return "generic";
}

function roleOf(text: string): Role {
  const s = text.toLowerCase();
  if (/(^|[^a-z])(and|or|xor|xnor|nand|nor|not|inv|mux|adder|add|sub|max|min|cmp|comparator|logic)($|[^a-z])/.test(s)) return "gate";
  if (/(controller|control|scheduler|mshr|tlb|counter|state|cmd|issue|decode)/.test(s)) return "control";
  if (/(cache|scratch|spad|sram|ram|mem|bank|array|tag|directory)/.test(s)) return "memory";
  if (/(mesh|tile|pe|mac|pipe|compute|datapath|alu|fpu|execute|accpipe)/.test(s)) return "compute";
  if (/(xbar|bus|interconnect|coupler|fragmenter|tlxbar|axi|tltoaxi)/.test(s)) return "interconnect";
  if (/(frontend|fetch|probe|acquire|input|transposer|im2col)/.test(s)) return "frontend";
  if (/(output|writeback|response|resp|scale|relu|activation|quant)/.test(s)) return "output";
  return "io";
}

function gateKindOf(text: string): GateKind {
  const s = text.toLowerCase();
  if (/mux|select|arbiter/.test(s)) return "MUX";
  if (/\band\b|nand/.test(s)) return "AND";
  if (/\bor\b|nor/.test(s)) return "OR";
  if (/xor|xnor/.test(s)) return "XOR";
  if (/not|inv/.test(s)) return "NOT";
  if (/\bmul\b|multiply/.test(s)) return "MUL";
  if (/max|relu/.test(s)) return "MAX";
  if (/cmp|compare/.test(s)) return "CMP";
  if (/add|sub|adder|acc|sum|mac/.test(s)) return "ADD";
  return "LOGIC";
}

function isNoisy(inst: string, mod: string): boolean {
  const s = `${inst} ${mod}`.toLowerCase();
  return /(queue|monitor|repeater|barrier|optimization|clock|reset|assert|checker|plusarg|regmapper|blackbox|dmi)/.test(s);
}

function familyKey(inst: string, mod: string, role: Role): string {
  const s = `${inst} ${mod}`.toLowerCase();
  if (role === "gate") {
    const g = gateKindOf(s).toLowerCase();
    return `gate_${g}`;
  }
  if (role === "control") {
    if (/mshr/.test(s)) return "mshr";
    if (/scheduler/.test(s)) return "scheduler";
    if (/controller|control/.test(s)) return "controller";
    if (/tlb/.test(s)) return "tlb";
  }
  if (role === "memory") {
    if (/directory/.test(s)) return "directory";
    if (/tag/.test(s)) return "tag_arrays";
    if (/bank/.test(s)) return "memory_banks";
    if (/scratch/.test(s)) return "scratchpad";
    if (/accumulator/.test(s)) return "accumulator_mem";
    if (/sram|ram|mem|array/.test(s)) return "sram_arrays";
  }
  if (role === "compute") {
    if (/mesh/.test(s)) return "mesh";
    if (/\bpe\b|pes_/.test(s)) return "pe";
    if (/tile/.test(s)) return "tile";
    if (/mac/.test(s)) return "mac";
    if (/accpipe/.test(s)) return "acc_pipe";
    if (/alu/.test(s)) return "alu";
  }
  if (role === "interconnect") return "interconnect";
  if (role === "frontend") return "frontend";
  if (role === "output") return "output";
  return norm(mod || inst || role);
}

function familyLabel(key: string, archetype: string): string {
  const m: Record<string, string> = {
    gate_and: "AND Logic",
    gate_or: "OR Logic",
    gate_xor: "XOR Logic",
    gate_not: "NOT/Inverter",
    gate_mux: "Mux/Select",
    gate_add: "Adder/Sum",
    gate_mul: "Multiply Units",
    gate_cmp: "Compare Units",
    gate_max: "Max/Compare",
    gate_logic: "Combinational Logic",
    mshr: "MSHR",
    scheduler: "Scheduler",
    controller: archetype === "cache" ? "Cache Controller" : "Controller",
    tlb: "TLB",
    directory: "Directory",
    tag_arrays: "Tag Arrays",
    memory_banks: "Memory Banks",
    scratchpad: "Scratchpad",
    accumulator_mem: "Accumulator SRAM",
    sram_arrays: "SRAM Arrays",
    mesh: "Mesh",
    pe: "Processing Elements",
    tile: "Tile Block",
    mac: "MAC Units",
    acc_pipe: "Accumulator Pipe",
    alu: "ALU Pipeline",
    interconnect: "Interconnect",
    frontend: "Input Frontend",
    output: "Output/Writeback",
  };
  return m[key] ?? cleanLabel(key);
}

function inferWidthBits(text: string): number | undefined {
  const s = text.toLowerCase();
  const m = s.match(/\b([0-9]{2,4})\s*(?:bit|b)\b/) ?? s.match(/\bw([0-9]{2,4})\b/) ?? s.match(/d([0-9]{2,4})/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 8 || n > 4096) return undefined;
  return n;
}

function strokeByBits(bits?: number): number {
  if (!bits || bits <= 0) return 2.1;
  if (bits >= 512) return 6.0;
  if (bits >= 256) return 5.0;
  if (bits >= 128) return 4.0;
  if (bits >= 64) return 3.1;
  return 2.3;
}

function aggregateComponents(ds: Desc[], archetype: string): { comps: Component[]; gateHeavy: boolean; pureLogic: boolean } {
  const gateRaw = ds.filter((d) => roleOf(`${d.inst} ${d.mod}`) === "gate");
  const gateHeavy = ds.length > 0 && gateRaw.length / ds.length >= 0.35;
  const memRaw = ds.filter((d) => roleOf(`${d.inst} ${d.mod}`) === "memory").length;
  const icRaw = ds.filter((d) => roleOf(`${d.inst} ${d.mod}`) === "interconnect").length;
  const pureLogic = ds.length > 0 && gateRaw.length / ds.length >= 0.45 && (memRaw + icRaw) / ds.length <= 0.2;

  const map = new Map<string, Component>();
  for (const d of ds) {
    if (!d.mod) continue;
    if (isNoisy(d.inst, d.mod)) continue;
    const role = roleOf(`${d.inst} ${d.mod}`);
    if (!gateHeavy && role === "gate") continue;
    const id = familyKey(d.inst, d.mod, role);
    const module = familyLabel(id, archetype);
    const scoreBase = d.depth === 1 ? 10 : d.depth === 2 ? 7 : 3;
    const roleBonus = role === "gate" ? 6 : role === "compute" ? 4 : role === "control" ? 4 : role === "memory" ? 3 : 1;
    const score = scoreBase + roleBonus;
    const prev = map.get(id);
    if (!prev) {
      map.set(id, {
        id,
        role,
        module,
        count: 1,
        score,
        samples: [cleanLabel(d.inst || d.mod)],
        hints: [cleanLabel(d.mod || d.inst)],
        gateKind: role === "gate" ? gateKindOf(`${d.inst} ${d.mod}`) : undefined,
      });
    } else {
      prev.count += 1;
      prev.score += score;
      if (prev.samples.length < 3) prev.samples.push(cleanLabel(d.inst || d.mod));
      const h = cleanLabel(d.mod || d.inst);
      if (h && !prev.hints.includes(h) && prev.hints.length < 4) prev.hints.push(h);
    }
  }

  let comps = [...map.values()]
    .map((c) => ({ ...c, score: c.score + Math.min(15, c.count) }))
    .sort((a, b) => b.score - a.score || a.module.localeCompare(b.module));

  const limit = gateHeavy ? 10 : 9;
  comps = comps.slice(0, limit);

  const has = new Set(comps.map((c) => c.role));
  if (gateHeavy && !has.has("output")) {
    comps.push({
      id: "if_out",
      role: "output",
      module: "Output Interface",
      count: 1,
      score: 15,
      samples: ["synthetic"],
      hints: ["Output Interface"],
      synthetic: true,
    });
  }
  if (gateHeavy && !has.has("frontend")) {
    comps.push({
      id: "if_in",
      role: "frontend",
      module: "Input Interface",
      count: 1,
      score: 15,
      samples: ["synthetic"],
      hints: ["Input Interface"],
      synthetic: true,
    });
  }
  return { comps: comps.slice(0, 10), gateHeavy, pureLogic };
}

function roleFlowLabel(a: Role, b: Role, gateHeavy: boolean): string {
  if (gateHeavy) {
    if (a === "frontend" && b === "gate") return "input logic";
    if (a === "gate" && b === "gate") return "logic path";
    if (a === "gate" && b === "output") return "result path";
    if (a === "control" && b === "gate") return "control select";
  }
  if (a === "control") return "control";
  if (a === "memory" && b === "compute") return "data feed";
  if (a === "interconnect") return "fabric";
  if (b === "output") return "output";
  return "data path";
}

function inferEdges(ds: Desc[], comps: Component[], gateHeavy: boolean): Edge[] {
  const byId = new Map(comps.map((c) => [c.id, c]));
  const parentByPath = new Map(ds.map((d) => [d.path, d]));
  const w = new Map<string, number>();
  const lbl = new Map<string, string>();
  const bits = new Map<string, number | undefined>();

  for (const d of ds) {
    const cRole = roleOf(`${d.inst} ${d.mod}`);
    const cId = familyKey(d.inst, d.mod, cRole);
    const p = parentByPath.get(d.parentPath);
    if (!p) continue;
    const pRole = roleOf(`${p.inst} ${p.mod}`);
    const pId = familyKey(p.inst, p.mod, pRole);
    const a = byId.get(pId);
    const b = byId.get(cId);
    if (!a || !b || a.id === b.id) continue;
    const k = `${a.id}->${b.id}`;
    w.set(k, (w.get(k) ?? 0) + 1);
    if (!lbl.has(k)) lbl.set(k, roleFlowLabel(a.role, b.role, gateHeavy));
    if (!bits.has(k)) bits.set(k, inferWidthBits(`${d.inst} ${d.mod} ${p.inst} ${p.mod}`));
  }

  let out = [...w.entries()].map(([k, weight]) => {
    const [from, to] = k.split("->");
    return { from, to, weight, label: lbl.get(k) ?? "path", widthBits: bits.get(k) };
  });

  if (out.length === 0) {
    const topByRole = new Map<Role, Component>();
    for (const c of comps) if (!topByRole.has(c.role)) topByRole.set(c.role, c);
    const add = (ra: Role, rb: Role, weight: number, label: string) => {
      const a = topByRole.get(ra);
      const b = topByRole.get(rb);
      if (!a || !b || a.id === b.id) return;
      out.push({ from: a.id, to: b.id, weight, label, widthBits: undefined });
    };
    add("frontend", gateHeavy ? "gate" : "compute", 3, gateHeavy ? "input logic" : "input path");
    add("control", gateHeavy ? "gate" : "compute", 2, "control");
    add(gateHeavy ? "gate" : "compute", "output", 3, "result path");
    add("memory", gateHeavy ? "gate" : "compute", 2, "data feed");
  }

  if (gateHeavy) {
    const g = comps.find((c) => c.role === "gate");
    const inIf = comps.find((c) => c.id === "if_in");
    const outIf = comps.find((c) => c.id === "if_out");
    if (g && inIf && !out.some((e) => e.from === inIf.id && e.to === g.id)) out.push({ from: inIf.id, to: g.id, label: "input logic", weight: 3, widthBits: 128 });
    if (g && outIf && !out.some((e) => e.from === g.id && e.to === outIf.id)) out.push({ from: g.id, to: outIf.id, label: "result path", weight: 3, widthBits: 128 });
  }

  return out.sort((a, b) => b.weight - a.weight).slice(0, 18);
}

function synthesizeLeafModel(target: FlatNode, archetype: string, features?: { preload: boolean; bypass: boolean; quant: boolean; relu: boolean }): { comps: Component[]; edges: Edge[]; gateHeavy: boolean; pureLogic: boolean; abstraction: AbstractionKind } {
  const s = `${target.inst} ${target.mod} ${target.path}`.toLowerCase();
  if (/(^|[^a-z])(pe|mac|alu|compute|systolic)($|[^a-z])/.test(s)) {
    const f = features ?? { preload: false, bypass: false, quant: false, relu: false };
    const comps: Component[] = [
      { id: "if_act", role: "frontend", module: "Activation Input", count: 1, score: 20, samples: ["activation stream"], hints: ["Act In"], synthetic: true },
      { id: "if_wgt", role: "frontend", module: "Weight Input", count: 1, score: 20, samples: ["weight stream"], hints: ["Wgt In"], synthetic: true },
      { id: "ctrl", role: "control", module: "Control Decode", count: 1, score: 20, samples: ["issue / valid"], hints: ["Sequencer"], synthetic: true },
      { id: "mux", role: "gate", module: "Mux/Select", count: 1, score: 20, samples: ["operand select"], hints: ["MUX"], gateKind: "MUX", synthetic: true },
      { id: "mul", role: "gate", module: "Multiply Core", count: 1, score: 20, samples: ["a * b"], hints: ["MUL"], gateKind: "MUL", synthetic: true },
      { id: "adder", role: "gate", module: "Adder/Sum", count: 1, score: 20, samples: ["accumulate"], hints: ["ADD"], gateKind: "ADD", synthetic: true },
      { id: "cmp", role: "gate", module: "Max/Compare", count: 1, score: 20, samples: ["activation clamp"], hints: ["CMP"], gateKind: "CMP", synthetic: true },
      { id: "regs", role: "memory", module: "Pipeline Registers", count: 1, score: 18, samples: ["state/register file"], hints: ["Local State"], synthetic: true },
      { id: "if_out", role: "output", module: "Output Interface", count: 1, score: 20, samples: ["partial sum / output"], hints: ["Result Path"], synthetic: true },
    ];
    if (f.preload) comps.push({ id: "pre_mux", role: "gate", module: "Preload Mux", count: 1, score: 18, samples: ["acc preload select"], hints: ["PRELOAD"], gateKind: "MUX", synthetic: true });
    if (f.bypass) comps.push({ id: "bypass_mux", role: "gate", module: "Bypass Mux", count: 1, score: 18, samples: ["bypass / forward"], hints: ["BYPASS"], gateKind: "MUX", synthetic: true });
    if (f.quant) comps.push({ id: "quant", role: "gate", module: "Quantize/Scale", count: 1, score: 18, samples: ["scale/round"], hints: ["QUANT"], gateKind: "LOGIC", synthetic: true });
    if (f.relu) comps.push({ id: "relu", role: "gate", module: "ReLU Clamp", count: 1, score: 18, samples: ["max(0,x)"], hints: ["RELU"], gateKind: "MAX", synthetic: true });
    const edges: Edge[] = [
      { from: "if_act", to: "mux", label: "activation path", weight: 4, widthBits: 128 },
      { from: "if_wgt", to: "mux", label: "weight path", weight: 4, widthBits: 128 },
      { from: "ctrl", to: "mux", label: "control select", weight: 3, widthBits: 32 },
      { from: "mux", to: "mul", label: "operand path", weight: 4, widthBits: 128 },
      { from: "mul", to: "adder", label: "product path", weight: 4, widthBits: 128 },
      { from: "adder", to: "cmp", label: "compute path", weight: 4, widthBits: 128 },
      { from: "adder", to: "regs", label: "acc update", weight: 3, widthBits: 64 },
      { from: "cmp", to: "if_out", label: "result path", weight: 4, widthBits: 128 },
    ];
    if (f.preload) {
      edges.push({ from: "regs", to: "pre_mux", label: "preload state", weight: 3, widthBits: 64 });
      edges.push({ from: "pre_mux", to: "adder", label: "preload inject", weight: 3, widthBits: 64 });
      edges.push({ from: "ctrl", to: "pre_mux", label: "preload select", weight: 2, widthBits: 32 });
    }
    if (f.bypass) {
      edges.push({ from: "mul", to: "bypass_mux", label: "bypass candidate", weight: 3, widthBits: 128 });
      edges.push({ from: "cmp", to: "bypass_mux", label: "normal result", weight: 3, widthBits: 128 });
      edges.push({ from: "ctrl", to: "bypass_mux", label: "bypass select", weight: 2, widthBits: 32 });
      edges.push({ from: "bypass_mux", to: "if_out", label: "forwarded out", weight: 3, widthBits: 128 });
      for (let i = edges.length - 1; i >= 0; i -= 1) {
        if (edges[i].from === "cmp" && edges[i].to === "if_out") {
          edges.splice(i, 1);
          break;
        }
      }
    }
    if (f.quant) {
      edges.push({ from: f.bypass ? "bypass_mux" : "cmp", to: "quant", label: "quantize", weight: 3, widthBits: 64 });
      edges.push({ from: "quant", to: "if_out", label: "scaled out", weight: 3, widthBits: 64 });
      for (let i = edges.length - 1; i >= 0; i -= 1) {
        if (edges[i].from === (f.bypass ? "bypass_mux" : "cmp") && edges[i].to === "if_out") {
          edges.splice(i, 1);
          break;
        }
      }
    }
    if (f.relu) {
      const src = f.quant ? "quant" : (f.bypass ? "bypass_mux" : "cmp");
      edges.push({ from: src, to: "relu", label: "activation clamp", weight: 3, widthBits: 64 });
      edges.push({ from: "relu", to: "if_out", label: "relu out", weight: 3, widthBits: 64 });
      for (let i = edges.length - 1; i >= 0; i -= 1) {
        if (edges[i].from === src && edges[i].to === "if_out") {
          edges.splice(i, 1);
          break;
        }
      }
    }
    return { comps, edges, gateHeavy: true, pureLogic: true, abstraction: "pure-logic gate-level" };
  }

  if (/(mshr|cache|directory|refill|coherence)/.test(s)) {
    const comps: Component[] = [
      { id: "if_req", role: "frontend", module: "Request Interface", count: 1, score: 18, samples: ["incoming miss/probe"], hints: ["Input"], synthetic: true },
      { id: "state", role: "control", module: "State Machine", count: 1, score: 20, samples: ["allocation / retire"], hints: ["Controller"], synthetic: true },
      { id: "match", role: "gate", module: "Match/Conflict Logic", count: 1, score: 20, samples: ["dependency compare"], hints: ["LOG"], gateKind: "LOGIC", synthetic: true },
      { id: "queue", role: "memory", module: "Entry Storage", count: 1, score: 20, samples: ["MSHR entries"], hints: ["Queue/Table"], synthetic: true },
      { id: "if_mem", role: "interconnect", module: "Memory Fabric Interface", count: 1, score: 18, samples: ["acquire/release"], hints: ["TL/AXI"], synthetic: true },
      { id: "if_out", role: "output", module: "Response Interface", count: 1, score: 18, samples: ["refill/resp"], hints: ["Output"], synthetic: true },
    ];
    const edges: Edge[] = [
      { from: "if_req", to: "state", label: "request path", weight: 3, widthBits: 64 },
      { from: "state", to: "match", label: "control", weight: 3, widthBits: 32 },
      { from: "match", to: "queue", label: "entry update", weight: 3, widthBits: 64 },
      { from: "state", to: "if_mem", label: "memory commands", weight: 3, widthBits: 64 },
      { from: "queue", to: "if_out", label: "response path", weight: 3, widthBits: 64 },
    ];
    return { comps, edges, gateHeavy: false, pureLogic: false, abstraction: "sub-block" };
  }

  const comps: Component[] = [
    { id: "ctrl", role: "control", module: "Control Logic", count: 1, score: 16, samples: ["sequencing"], hints: ["Controller"], synthetic: true },
    { id: "datapath", role: "compute", module: "Datapath Core", count: 1, score: 16, samples: ["core operations"], hints: ["Compute"], synthetic: true },
    { id: "storage", role: "memory", module: "Local Storage", count: 1, score: 14, samples: ["state/buffers"], hints: ["Memory"], synthetic: true },
    { id: "if_in", role: "frontend", module: "Input Interface", count: 1, score: 14, samples: ["input"], hints: ["Input"], synthetic: true },
    { id: "if_out", role: "output", module: "Output Interface", count: 1, score: 14, samples: ["output"], hints: ["Output"], synthetic: true },
  ];
  const edges: Edge[] = [
    { from: "if_in", to: "datapath", label: "input path", weight: 3, widthBits: 64 },
    { from: "ctrl", to: "datapath", label: "control", weight: 2, widthBits: 32 },
    { from: "storage", to: "datapath", label: "data feed", weight: 2, widthBits: 64 },
    { from: "datapath", to: "if_out", label: "result path", weight: 3, widthBits: 64 },
  ];
  return { comps, edges, gateHeavy: false, pureLogic: false, abstraction: "sub-block" };
}

function shouldUseRtlSymbolic(target: FlatNode, archetype: string): boolean {
  if (archetype === "cache" || archetype === "interconnect") return false;
  const s = `${target.inst} ${target.mod} ${target.path}`.toLowerCase();
  if (/(mshr|cache|directory|coherence|scheduler|tlb|xbar|interconnect|router|bus|axi|tilelink)/.test(s)) return false;
  return /(^|[^a-z])(pe|alu|mac|compute|datapath|logic|systolic)($|[^a-z])/.test(s);
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

function routeWithBoxes(edges: Edge[], boxes: Record<string, Box>): Wire[] {
  const out: Wire[] = [];
  for (const e of edges) {
    const a = boxes[e.from];
    const b = boxes[e.to];
    if (!a || !b) continue;
    const pts = pathFor(a, b);
    const m = pts[Math.floor(pts.length / 2) - 1] ?? pts[1] ?? pts[0];
    out.push({ from: e.from, to: e.to, label: e.label, weight: e.weight, points: pts, labelAt: m });
  }
  return out;
}

function routeRtlSymbolicWires(edges: Edge[], boxes: Record<string, Box>): Wire[] {
  const out: Wire[] = [];
  const midY = Math.round((boxes["if_in"]?.y ?? 500) + (boxes["if_in"]?.h ?? 140) / 2);
  const chain = ["if_in", "op_mux", "op_mul", "op_add", "op_and", "op_or", "op_xor", "op_not", "op_shift", "op_cmp", "if_out"]
    .filter((id) => !!boxes[id]);
  const inChain = new Set(chain);
  const edgeMap = new Map(edges.map((e) => [`${e.from}->${e.to}`, e]));

  const push = (e: Edge, pts: Array<{ x: number; y: number }>, lx?: number, ly?: number) => {
    const labelAt = { x: lx ?? pts[Math.max(0, Math.floor(pts.length / 2) - 1)].x, y: ly ?? pts[Math.max(0, Math.floor(pts.length / 2) - 1)].y };
    out.push({ from: e.from, to: e.to, label: e.label, weight: e.weight, points: pts, labelAt });
  };

  for (let i = 0; i + 1 < chain.length; i += 1) {
    const from = chain[i];
    const to = chain[i + 1];
    const e = edgeMap.get(`${from}->${to}`);
    if (!e) continue;
    const a = boxes[from];
    const b = boxes[to];
    const sx = a.x + a.w;
    const tx = b.x;
    const my = midY;
    push(e, [{ x: sx, y: my }, { x: tx, y: my }], Math.round((sx + tx) / 2), my - 8);
  }

  for (const e of edges) {
    if (inChain.has(e.from) && inChain.has(e.to)) continue;
    const a = boxes[e.from];
    const b = boxes[e.to];
    if (!a || !b) continue;
    const acx = Math.round(a.x + a.w / 2);
    const bcx = Math.round(b.x + b.w / 2);
    const ay = Math.round(a.y + a.h / 2);
    const by = Math.round(b.y + b.h / 2);
    const pts = [
      { x: acx, y: ay },
      { x: acx, y: Math.round((ay + by) / 2) },
      { x: bcx, y: Math.round((ay + by) / 2) },
      { x: bcx, y: by },
    ];
    push(e, pts);
  }
  return out;
}

function tint(hex: string, amount: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => `${c}${c}`).join("") : h, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const rr = Math.round(r + (255 - r) * amount);
  const gg = Math.round(g + (255 - g) * amount);
  const bb = Math.round(b + (255 - b) * amount);
  const v = (Math.max(0, Math.min(255, rr)) << 16) | (Math.max(0, Math.min(255, gg)) << 8) | Math.max(0, Math.min(255, bb));
  return `#${v.toString(16).padStart(6, "0")}`;
}

function themeBase(archetype: string): string {
  if (archetype === "accelerator") return "#1f4f96";
  if (archetype === "cache") return "#236a3f";
  if (archetype === "interconnect") return "#5b3f8f";
  return "#374151";
}

function gateSymbol(kind: GateKind, x: number, y: number, w: number, h: number): string {
  const lib = SHAPES.byGate[kind];
  if (lib) {
    const sx = w / Math.max(1, lib.viewW);
    const sy = h / Math.max(1, lib.viewH);
    return `<g transform="translate(${x},${y}) scale(${sx},${sy})">${lib.content}</g>`;
  }
  const stroke = `stroke="#1f4f96" stroke-width="1.1"`;
  if (kind === "MUX") {
    return `<polygon points="${x},${y} ${x + w - 5},${y + 2} ${x + w},${y + h / 2} ${x + w - 5},${y + h - 2} ${x},${y + h}" fill="#f8fbff" ${stroke}/><text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" class="gateLbl">MUX</text>`;
  }
  if (kind === "ADD") {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.min(w, h) / 2 - 1;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#f8fbff" ${stroke}/><text x="${cx}" y="${cy + 4}" text-anchor="middle" class="gateLbl">+</text>`;
  }
  if (kind === "MUL") {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.min(w, h) / 2 - 1;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#f8fbff" ${stroke}/><text x="${cx}" y="${cy + 4}" text-anchor="middle" class="gateLbl">&#215;</text>`;
  }
  if (kind === "CMP") {
    return `<polygon points="${x + 2},${y} ${x + w - 2},${y} ${x + w},${y + h / 2} ${x + w - 2},${y + h} ${x + 2},${y + h} ${x},${y + h / 2}" fill="#f8fbff" ${stroke}/><text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" class="gateLbl">&gt;=</text>`;
  }
  if (kind === "MAX") {
    return `<polygon points="${x + 2},${y} ${x + w - 2},${y} ${x + w},${y + h / 2} ${x + w - 2},${y + h} ${x + 2},${y + h} ${x},${y + h / 2}" fill="#f8fbff" ${stroke}/><text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" class="gateLbl">MAX</text>`;
  }
  if (kind === "NOT") {
    return `<polygon points="${x},${y} ${x + w - 8},${y + h / 2} ${x},${y + h}" fill="#f8fbff" ${stroke}/><circle cx="${x + w - 3}" cy="${y + h / 2}" r="3" fill="#f8fbff" ${stroke}/><text x="${x + w / 2 - 4}" y="${y + h / 2 + 4}" text-anchor="middle" class="gateLbl">NOT</text>`;
  }
  if (kind === "AND") {
    const r = Math.round(h / 2);
    const left = x + 4;
    const right = x + w - 4;
    const mid = x + Math.round(w * 0.62);
    const cy = y + Math.round(h / 2);
    return `<path d="M${left},${y + 2} L${mid},${y + 2} A${r - 2},${r - 2} 0 0 1 ${mid},${y + h - 2} L${left},${y + h - 2} Z" fill="#f8fbff" ${stroke}/><text x="${Math.round((left + right) / 2)}" y="${cy + 4}" text-anchor="middle" class="gateLbl">AND</text>`;
  }
  if (kind === "OR" || kind === "XOR") {
    const off = kind === "XOR" ? 5 : 0;
    const p = [
      `M${x + 6 + off},${y + 2}`,
      `Q${x + 24 + off},${y + h / 2} ${x + 6 + off},${y + h - 2}`,
      `Q${x + w - 14},${y + h - 2} ${x + w - 4},${y + h / 2}`,
      `Q${x + w - 14},${y + 2} ${x + 6 + off},${y + 2}`,
      "Z",
    ].join(" ");
    const back = kind === "XOR"
      ? `<path d="M${x + 3},${y + 2} Q${x + 21},${y + h / 2} ${x + 3},${y + h - 2}" fill="none" ${stroke}/>`
      : "";
    const txt = kind === "XOR" ? "XOR" : "OR";
    return `${back}<path d="${p}" fill="#f8fbff" ${stroke}/><text x="${x + w / 2 + 2}" y="${y + h / 2 + 4}" text-anchor="middle" class="gateLbl">${txt}</text>`;
  }
  const txt = kind === "LOGIC" ? "LOG" : "GATE";
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" ry="4" fill="#f8fbff" ${stroke}/><text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" class="gateLbl">${txt}</text>`;
}

function registerSymbol(x: number, y: number, w: number, h: number): string {
  if (SHAPES.reg) {
    const sx = w / Math.max(1, SHAPES.reg.viewW);
    const sy = h / Math.max(1, SHAPES.reg.viewH);
    return `<g transform="translate(${x},${y}) scale(${sx},${sy})">${SHAPES.reg.content}</g>`;
  }
  const midY = y + h / 2;
  const tri = `${x + 8},${midY - 5} ${x + 8},${midY + 5} ${x + 16},${midY}`;
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" ry="3" fill="#f8fbff" stroke="#1f4f96" stroke-width="1.2"/>`,
    `<polygon points="${tri}" fill="#e6eefb" stroke="#1f4f96" stroke-width="0.9"/>`,
    `<line x1="${x + 4}" y1="${y + 4}" x2="${x + w - 4}" y2="${y + 4}" stroke="#1f4f96" stroke-width="0.9" opacity="0.6"/>`,
    `<text x="${x + w / 2 + 6}" y="${y + h / 2 + 4}" text-anchor="middle" class="gateLbl">REG</text>`,
  ].join("");
}

function pathFromChain(boxes: Record<string, Box>, ids: string[]): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < ids.length; i += 1) {
    const b = boxes[ids[i]];
    if (!b) continue;
    const cx = Math.round(b.x + b.w / 2);
    const cy = Math.round(b.y + b.h / 2);
    pts.push({ x: cx, y: cy });
  }
  return pts;
}

function isRtlSymbolicChainId(id: string): boolean {
  return /^op_(mux|mul|add|and|or|xor|not|shift|cmp)$/.test(id);
}

function render(target: FlatNode, archetype: string, comps: Component[], edges: Edge[], gateHeavy: boolean, pureLogic: boolean, abstraction: AbstractionKind, outSvg: string): Record<string, Box> {
  const base = themeBase(archetype);
  const deep = tint(base, -0.14);
  const cont = tint(base, 0.92);
  const panel = tint(base, 0.86);
  const region = { x: 95, y: 170, w: 1710, h: 950 };

  const nodeSize = (n: PrNode): { w: number; h: number } => {
    const maxLen = Math.max(n.title.length, ...(n.lines.length ? n.lines : [""]).map((s) => s.length), 18);
    return { w: Math.max(250, Math.min(410, 170 + maxLen * 6)), h: 140 };
  };

  const prNodes: PrNode[] = comps.map((c) => ({
    id: c.id,
    role: (c.role === "gate" ? "compute" : c.role),
    title: c.module,
    lines: [c.hints[0] ?? "", c.count > 1 ? `instances: ${c.count}` : c.samples[0] ?? ""].filter(Boolean),
  }));
  const prEdges: PrEdge[] = edges.map((e) => ({ from: e.from, to: e.to, label: e.label, weight: e.weight }));
  let pr = placeAndRoute({
    nodes: prNodes,
    edges: prEdges,
    canvas: { width: 1900, height: 1200 },
    region,
    estimateNodeSize: nodeSize,
  });
  let boxes = pr.boxes as Record<string, Box>;
  let wires = pr.wires;

  const rtlSymbolic = pureLogic && abstraction === "rtl-symbolic";
  if (pureLogic) {
    const put = (id: string, ax: number, ay: number) => {
      const c = comps.find((x) => x.id === id);
      if (!c) return;
      let s = nodeSize({ id: c.id, role: (c.role === "gate" ? "compute" : c.role), title: c.module, lines: [] });
      if (rtlSymbolic && c.id.startsWith("op_")) s = { w: 170, h: 130 };
      if (rtlSymbolic && c.id === "regs") s = { w: 310, h: 165 };
      if (rtlSymbolic && (c.id === "if_in" || c.id === "if_out")) s = { w: 320, h: 165 };
      const cx = region.x + Math.round(ax * region.w);
      const cy = region.y + Math.round(ay * region.h);
      boxes[id] = {
        x: Math.max(region.x, Math.min(region.x + region.w - s.w, Math.round(cx - s.w / 2))),
        y: Math.max(region.y, Math.min(region.y + region.h - s.h, Math.round(cy - s.h / 2))),
        w: s.w,
        h: s.h,
      };
    };
    const rtlChainOrder = ["op_mux", "op_mul", "op_add", "op_and", "op_or", "op_xor", "op_not", "op_shift", "op_cmp"];
    const hasRtlChain = abstraction === "rtl-symbolic" || comps.some((c) => isRtlSymbolicChainId(c.id));
    if (hasRtlChain) {
      const present = rtlChainOrder.filter((id) => comps.some((c) => c.id === id));
      const chain = ["if_in", ...present, "if_out"].filter((id) => comps.some((c) => c.id === id));
      const baseW = (id: string) => {
        if (id === "if_in" || id === "if_out") return 360;
        return 210;
      };
      const baseH = (id: string) => {
        if (id === "if_in" || id === "if_out") return 185;
        return 160;
      };
      const gapBase = 72;
      const rawW = chain.reduce((a, id) => a + baseW(id), 0) + Math.max(0, chain.length - 1) * gapBase;
      const availW = region.w - 120;
      const scale = Math.max(0.72, Math.min(1.18, availW / Math.max(1, rawW)));
      const gap = Math.round(gapBase * scale);
      const widths = chain.map((id) => Math.round(baseW(id) * scale));
      const heights = chain.map((id) => Math.round(baseH(id) * scale));
      const totalW = widths.reduce((a, b) => a + b, 0) + Math.max(0, chain.length - 1) * gap;
      let x = region.x + Math.round((region.w - totalW) / 2);
      const cy = region.y + Math.round(region.h * 0.47);
      chain.forEach((id, i) => {
        const w = widths[i];
        const h = heights[i];
        boxes[id] = { x, y: Math.round(cy - h / 2), w, h };
        x += w + gap;
      });

      if (comps.some((c) => c.id === "regs")) {
        const addB = boxes["op_add"] ?? boxes["op_cmp"] ?? boxes[chain[Math.floor(chain.length / 2)]];
        const regsW = Math.round(340 * scale);
        const regsH = Math.round(175 * scale);
        boxes["regs"] = {
          x: Math.round((addB?.x ?? (region.x + region.w / 2)) - regsW / 2),
          y: Math.round(region.y + region.h * 0.68 - regsH / 2),
          w: regsW,
          h: regsH,
        };
      }
    } else {
      put("if_act", 0.18, 0.16);
      put("if_wgt", 0.18, 0.34);
      put("ctrl", 0.18, 0.52);
      put("regs", 0.18, 0.74);
      put("mux", 0.52, 0.20);
      put("mul", 0.52, 0.38);
      put("adder", 0.52, 0.56);
      put("cmp", 0.52, 0.74);
      put("pre_mux", 0.36, 0.56);
      put("bypass_mux", 0.70, 0.62);
      put("quant", 0.78, 0.62);
      put("relu", 0.86, 0.62);
      put("if_out", 0.90, 0.38);
    }
    // Any remaining nodes fall back to role-aware placement.
    const unplaced = comps.filter((c) => !boxes[c.id]);
    const fallbackByRole: Record<Role, { x: number; y: number }> = {
      control: { x: 0.18, y: 0.60 },
      memory: { x: 0.20, y: 0.78 },
      compute: { x: 0.52, y: 0.60 },
      interconnect: { x: 0.82, y: 0.20 },
      frontend: { x: 0.16, y: 0.24 },
      output: { x: 0.88, y: 0.40 },
      io: { x: 0.82, y: 0.78 },
      gate: { x: 0.62, y: 0.72 },
    };
    unplaced.forEach((c, i) => {
      const a = fallbackByRole[c.role];
      put(c.id, Math.min(0.92, a.x + 0.02 * i), Math.min(0.84, a.y + 0.05 * (i % 3)));
    });
    wires = rtlSymbolic ? routeRtlSymbolicWires(edges, boxes) : routeWithBoxes(edges, boxes);
  }

  const roleFill: Record<Role, string> = {
    control: tint(base, 0.90),
    memory: tint(base, 0.80),
    compute: tint(base, 0.72),
    interconnect: tint(base, 0.86),
    frontend: tint(base, 0.94),
    output: tint(base, 0.76),
    io: tint(base, 0.88),
    gate: tint(base, 0.66),
  };

  const compSvg: string[] = [];
  const overlaySvg: string[] = [];
  const byId = new Map(comps.map((c) => [c.id, c]));
  for (const c of comps) {
    const b = boxes[c.id];
    const drawSymbolNode = pureLogic && c.role === "gate" && !!c.gateKind;
    if (drawSymbolNode) {
      const gw = Math.max(140, Math.min(220, Math.round(b.w * 0.84)));
      const gh = Math.max(88, Math.min(128, Math.round(b.h * 0.78)));
      const gx = b.x + Math.round((b.w - gw) / 2);
      const gy = b.y + Math.round((b.h - gh) / 2) - 10;
      compSvg.push(gateSymbol(c.gateKind as GateKind, gx, gy, gw, gh));
      const compactName = c.module
        .replace(/ units?/i, "")
        .replace(/ network/i, "")
        .replace(/\/select/i, "")
        .trim();
      compSvg.push(`<text x="${b.x + b.w / 2}" y="${Math.min(b.y + b.h - 22, gy + gh + 20)}" text-anchor="middle" class="compRow">${esc(compactName)}</text>`);
      let r2 = c.count > 1 ? `instances: ${c.count}` : c.samples[0] ?? "";
      if (/inferred from pe archetype/i.test(r2)) r2 = "inferred";
      if (r2) compSvg.push(`<text x="${b.x + b.w / 2}" y="${Math.min(b.y + b.h - 4, gy + gh + 40)}" text-anchor="middle" class="compMeta">${esc(cleanLabel(r2))}</text>`);
    } else {
      compSvg.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="7" ry="7" fill="${roleFill[c.role]}" stroke="${deep}" stroke-width="2.0"/>`);
      compSvg.push(`<text x="${b.x + b.w / 2}" y="${b.y + 31}" text-anchor="middle" class="compTitle">${esc(c.module)}</text>`);
      const r1 = c.hints[0] ?? "";
      const r2 = c.count > 1 ? `instances: ${c.count}` : c.samples[0] ?? "";
      if (r1) compSvg.push(`<text x="${b.x + 14}" y="${b.y + 64}" text-anchor="start" class="compRow">${esc(cleanLabel(r1))}</text>`);
      if (r2) compSvg.push(`<text x="${b.x + 14}" y="${b.y + 90}" text-anchor="start" class="compRow">${esc(cleanLabel(r2))}</text>`);
    }
    if (pureLogic && /register|state|entry storage/i.test(`${c.module} ${c.hints.join(" ")}`)) {
      const rw = 78;
      const rh = 30;
      const rx = b.x + Math.round((b.w - rw) / 2);
      const ry = b.y + b.h - rh - 18;
      compSvg.push(registerSymbol(rx, ry, rw, rh));
    }
  }

  if (pureLogic && !rtlSymbolic) {
    const chain = comps.some((c) => isRtlSymbolicChainId(c.id))
      ? ["if_in", "op_mux", "op_mul", "op_add", "op_and", "op_or", "op_xor", "op_not", "op_shift", "op_cmp", "if_out"]
      : ["if_act", "mux", "mul", "adder", "cmp", "bypass_mux", "quant", "relu", "if_out"];
    const valid = chain.filter((id) => !!boxes[id]);
    if (valid.length >= 3) {
      const pts = pathFromChain(boxes, valid);
      for (let i = 0; i + 1 < pts.length; i += 1) {
        const a = pts[i];
        const b = pts[i + 1];
        const mx = Math.round((a.x + b.x) / 2);
        overlaySvg.push(`<path d="M${a.x},${a.y} L${mx},${a.y} L${mx},${b.y} L${b.x},${b.y}" class="hlWire"/>`);
      }
    }
    if (boxes["adder"] && boxes["regs"]) {
      const a = boxes["adder"];
      const r = boxes["regs"];
      const ax = a.x + Math.round(a.w * 0.78);
      const ay = a.y + a.h;
      const rx = r.x + Math.round(r.w * 0.22);
      const ry = r.y;
      const my = Math.round((ay + ry) / 2);
      overlaySvg.push(`<path d="M${ax},${ay} L${ax},${my} L${rx},${my} L${rx},${ry}" class="hlWire"/>`);
      overlaySvg.push(`<text x="${Math.round((ax + rx) / 2) + 6}" y="${my - 6}" class="wireLabel">acc feedback</text>`);
    }
    const leftX = region.x + 120;
    const rightX = region.x + region.w - 120;
    const topY = region.y + 90;
    const botY = region.y + region.h - 90;
    overlaySvg.unshift(`<rect x="${leftX}" y="${topY}" width="${rightX - leftX}" height="${botY - topY}" rx="10" ry="10" class="logicCluster"/>`);
    overlaySvg.unshift(`<text x="${leftX + 12}" y="${topY + 18}" class="clusterLabel">PE Datapath Pipeline</text>`);
  }

  const edgeSvg: string[] = [];
  const labels: Array<{ x: number; y: number; text: string }> = [];
  const labelSeen = new Set<string>();
  const widthMap = new Map(edges.map((e) => [`${e.from}->${e.to}`, e.widthBits]));
  const weightMap = new Map(edges.map((e) => [`${e.from}->${e.to}`, e.weight]));
  const labelBudget = gateHeavy ? 5 : 6;
  let used = 0;
  const minLabelDist = 58;
  for (const e of wires) {
    const d = e.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
    const wb = widthMap.get(`${e.from}->${e.to}`);
    edgeSvg.push(`<path d="${d}" class="wire" style="stroke-width:${strokeByBits(wb)}"/>`);
    const w = weightMap.get(`${e.from}->${e.to}`) ?? 0;
    const t = e.label;
    if (used < labelBudget && (w >= 3 || /logic|result|control|data|input|output|path/.test(t))) {
      const key = norm(t);
      if (!labelSeen.has(key)) {
        const lx = e.labelAt.x + 8;
        const ly = e.labelAt.y - 8;
        const close = labels.some((q) => Math.hypot(q.x - lx, q.y - ly) < minLabelDist);
        if (!close) {
          labels.push({ x: lx, y: ly, text: t });
          labelSeen.add(key);
          used += 1;
        }
      }
    }
  }
  labels.forEach((l) => edgeSvg.push(`<text x="${l.x}" y="${l.y}" text-anchor="start" class="wireLabel">${esc(l.text)}</text>`));

  const subtitle = `Archetype: ${archetype} | abstraction: ${abstraction} | components: ${comps.length}`;
  const title = `${cleanLabel(target.inst || target.mod)} (${cleanLabel(target.mod || "module")})`;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1900" height="1200" viewBox="0 0 1900 1200">
<defs>
  ${SHAPES.defs}
  <marker id="arr" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto"><path d="M0,0 L9,3.5 L0,7 z" fill="${deep}"/></marker>
</defs>
<style>
  svg { font-family: "Georgia", "Times New Roman", serif; background: #efefef; }
  .title { font-size: 36px; font-weight: 600; fill: #111; }
  .subtitle { font-size: 18px; fill: #333; }
  .container { fill: ${cont}; stroke: ${base}; stroke-width: 3.2; }
  .compTitle { font-size: 22px; fill: #111; }
  .compRow { font-size: 16px; fill: #111; }
  .compMeta { font-size: 13px; fill: #222; }
  .gateLbl { font-size: 12px; fill: #111; }
  .wire { stroke: ${deep}; fill: none; marker-end: url(#arr); }
  .hlWire { stroke: ${tint(base, -0.22)}; stroke-width: 2.6; fill: none; marker-end: url(#arr); }
  .logicCluster { fill: none; stroke: ${tint(base, -0.12)}; stroke-width: 1.6; stroke-dasharray: 7 4; }
  .clusterLabel { font-size: 12px; fill: #222; font-style: italic; }
  .wireLabel { font-size: 13px; fill: #111; paint-order: stroke; stroke: #efefef; stroke-width: 3; }
</style>
<text x="70" y="70" class="title">L4 Internal View: ${esc(title)}</text>
<text x="72" y="98" class="subtitle">${esc(subtitle)}</text>
<rect x="50" y="120" width="1800" height="1045" rx="10" ry="10" class="container"/>
${edgeSvg.join("\n")}
${overlaySvg.join("\n")}
${compSvg.join("\n")}
</svg>`;
  fs.writeFileSync(outSvg, svg, "utf8");
  return boxes;
}

async function main() {
  const [hierPath, blockName, outSvg, outLayoutJson, depthArg] = process.argv.slice(2);
  if (!hierPath || !blockName || !outSvg) {
    console.error("Usage: node dist/l4_from_hierarchy.js <hier.json> <block-name> <out.svg> [out.layout.json] [max-depth]");
    process.exit(1);
  }
  const maxDepth = Math.max(1, Math.min(5, Number(depthArg ?? "3") || 3));
  const root = JSON.parse(fs.readFileSync(hierPath, "utf8")) as HierNode;
  const target = findTarget(root, blockName);
  if (!target) {
    console.error(`Block '${blockName}' not found in hierarchy.`);
    process.exit(2);
    return;
  }
  const foundTarget = target as FlatNode;
  const ds = collectDesc(foundTarget, maxDepth);
  const archetype = archetypeOf(foundTarget, ds);
  let { comps, gateHeavy, pureLogic } = aggregateComponents(ds, archetype);
  let abstraction: AbstractionKind = pureLogic ? "pure-logic gate-level" : gateHeavy ? "gate-informed sub-block" : "sub-block";
  let edges = inferEdges(ds, comps, gateHeavy);
  if (comps.length === 0 || edges.length === 0) {
    const feat = inferLeafFeatures(root, foundTarget);
    const fallback = synthesizeLeafModel(foundTarget, archetype, feat);
    const rtlEligible = fallback.pureLogic && shouldUseRtlSymbolic(foundTarget, archetype);
    const rtlBody = rtlEligible ? tryFindModuleBody(hierPath, foundTarget.mod) : undefined;
    const rtl = rtlBody ? buildRtlSymbolicModel(foundTarget, extractRtlOps(rtlBody)) : undefined;
    if (rtl) {
      comps = rtl.comps;
      edges = rtl.edges;
      gateHeavy = true;
      pureLogic = true;
      abstraction = "rtl-symbolic";
    } else {
      comps = fallback.comps;
      edges = fallback.edges;
      gateHeavy = fallback.gateHeavy;
      pureLogic = fallback.pureLogic;
      abstraction = fallback.abstraction;
    }
  }
  const layout = render(foundTarget, archetype, comps, edges, gateHeavy, pureLogic, abstraction, outSvg);

  if (outLayoutJson) {
    fs.writeFileSync(
      outLayoutJson,
      JSON.stringify(
        {
          kind: "l4_generic_functional",
          target: foundTarget.path,
          archetype,
          abstraction,
          depth: maxDepth,
          extracted_nodes: ds.length,
          components: comps,
          edges,
          layout,
        },
        null,
        2
      ),
      "utf8"
    );
  }
  console.error(`L4 target: ${foundTarget.path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
