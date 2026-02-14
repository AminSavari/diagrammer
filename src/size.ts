import fs from "fs";
import yaml from "js-yaml";
import { pathToFileURL } from "url";
import { Graph, Node } from "./util.js";

type CategorySizing = {
  metric?: number;
  aspect?: number;
};

type SizeRules = {
  base_area?: number;
  k?: number;
  min_w?: number;
  max_w?: number;
  min_h?: number;
  max_h?: number;
  grid?: number;
  default_metric?: number;
  metric_attrs?: string[];
  categories?: Record<string, CategorySizing>;
};

const defaultSizeRules: Required<Omit<SizeRules, "categories" | "metric_attrs">> & {
  metric_attrs: string[];
  categories: Record<string, Required<CategorySizing>>;
} = {
  base_area: 6400,
  k: 1200,
  min_w: 80,
  max_w: 320,
  min_h: 40,
  max_h: 180,
  grid: 10,
  default_metric: 1,
  metric_attrs: ["metric", "area", "weight", "size"],
  categories: {
    bus: { metric: 6, aspect: 4.0 },
    mem: { metric: 5, aspect: 2.5 },
    compute: { metric: 7, aspect: 1.2 },
    ctrl: { metric: 3, aspect: 1.4 },
    io: { metric: 3, aspect: 1.6 },
  },
};

function asNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function snap(x: number, grid: number): number {
  if (grid <= 1) return x;
  return Math.round(x / grid) * grid;
}

function inferSizingCategory(n: Node): string {
  const text = `${n.category ?? ""} ${n.label ?? ""} ${n.id}`.toLowerCase();
  if (/(bus|xbar|crossbar|tl-|tilelink|axi|noc)/.test(text)) return "bus";
  if (/(mem|cache|scratch|spad|sram|dram|rom|bank)/.test(text)) return "mem";
  if (/(core|tile|cpu|gemmini|array|pe|compute|vector|fpu|alu)/.test(text)) return "compute";
  if (/(uart|gpio|spi|i2c|plic|clint|serial|dma|pcie|ethernet|io)/.test(text)) return "io";
  return "ctrl";
}

function nodeMetric(n: Node, cfg: typeof defaultSizeRules, cat: string): number {
  for (const key of cfg.metric_attrs) {
    const raw = n.attrs?.[key];
    const parsed = asNum(raw);
    if (parsed !== undefined && parsed >= 0) return parsed;
  }
  return cfg.categories[cat]?.metric ?? cfg.default_metric;
}

function mergeRules(rules: any): typeof defaultSizeRules {
  const raw: SizeRules = rules?.size ?? {};
  const mergedCategories: Record<string, Required<CategorySizing>> = { ...defaultSizeRules.categories };
  for (const [k, v] of Object.entries(raw.categories ?? {})) {
    const metric = asNum(v?.metric);
    const aspect = asNum(v?.aspect);
    mergedCategories[k] = {
      metric: metric ?? (mergedCategories[k]?.metric ?? defaultSizeRules.default_metric),
      aspect: aspect ?? (mergedCategories[k]?.aspect ?? 1.4),
    };
  }
  return {
    base_area: asNum(raw.base_area) ?? defaultSizeRules.base_area,
    k: asNum(raw.k) ?? defaultSizeRules.k,
    min_w: asNum(raw.min_w) ?? defaultSizeRules.min_w,
    max_w: asNum(raw.max_w) ?? defaultSizeRules.max_w,
    min_h: asNum(raw.min_h) ?? defaultSizeRules.min_h,
    max_h: asNum(raw.max_h) ?? defaultSizeRules.max_h,
    grid: asNum(raw.grid) ?? defaultSizeRules.grid,
    default_metric: asNum(raw.default_metric) ?? defaultSizeRules.default_metric,
    metric_attrs: Array.isArray(raw.metric_attrs) ? raw.metric_attrs.filter((x): x is string => typeof x === "string") : defaultSizeRules.metric_attrs,
    categories: mergedCategories,
  };
}

export function sizeGraph(graph: Graph, rules?: any): Graph {
  const cfg = mergeRules(rules);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.width !== undefined && n.height !== undefined) return n;
      const cat = inferSizingCategory(n);
      const metric = Math.max(0, nodeMetric(n, cfg, cat));
      const area = cfg.base_area + cfg.k * Math.sqrt(metric);
      const aspect = cfg.categories[cat]?.aspect ?? 1.4;
      let w = Math.sqrt(area * aspect);
      let h = Math.sqrt(area / aspect);
      w = snap(clamp(w, cfg.min_w, cfg.max_w), cfg.grid);
      h = snap(clamp(h, cfg.min_h, cfg.max_h), cfg.grid);
      return { ...n, width: w, height: h };
    }),
  };
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv.length >= 3) {
  const input = process.argv[2];
  const output = process.argv[3] ?? "-";
  const rulesPath = process.argv[4];
  const graph = JSON.parse(fs.readFileSync(input, "utf8"));
  const rules = rulesPath ? yaml.load(fs.readFileSync(rulesPath, "utf8")) : undefined;
  const out = sizeGraph(graph, rules);
  const data = JSON.stringify(out, null, 2);
  if (output === "-") {
    process.stdout.write(data);
  } else {
    fs.writeFileSync(output, data, "utf8");
  }
}
