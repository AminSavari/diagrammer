import fs from "fs";
import { renderSvg } from "./render_svg.js";
import { Graph, Node, Edge } from "./util.js";

type HierNode = {
  instance_name?: string;
  module_name?: string;
  instances?: HierNode[];
  children?: HierNode[];
};

function childrenOf(n: HierNode): HierNode[] {
  return (n.instances ?? n.children ?? []) as HierNode[];
}

function findGemmini(root: HierNode): HierNode | undefined {
  const name = `${root.instance_name ?? ""} ${root.module_name ?? ""}`.toLowerCase();
  if (name.includes("gemmini")) return root;
  for (const c of childrenOf(root)) {
    const hit = findGemmini(c);
    if (hit) return hit;
  }
  return undefined;
}

function hasModule(gem: HierNode, re: RegExp): boolean {
  for (const c of childrenOf(gem)) {
    if (re.test((c.module_name ?? "").toLowerCase()) || re.test((c.instance_name ?? "").toLowerCase())) return true;
  }
  return false;
}

function side(n: Node, where: "left" | "right" | "top" | "bottom"): { x: number; y: number } {
  const x = n.x ?? 0;
  const y = n.y ?? 0;
  const w = n.width ?? 0;
  const h = n.height ?? 0;
  if (where === "left") return { x, y: y + h / 2 };
  if (where === "right") return { x: x + w, y: y + h / 2 };
  if (where === "top") return { x: x + w / 2, y };
  return { x: x + w / 2, y: y + h };
}

function node(id: string, label: string, category: string, x: number, y: number, width: number, height: number): Node {
  return { id, label, category, x, y, width, height };
}

function orthPath(...pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (!prev || prev.x !== p.x || prev.y !== p.y) out.push(p);
  }
  return out;
}

function buildGemminiL2(gem: HierNode): Graph {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Fixed floorplan with left->right control/data flow and upper memory path.
  const nCmdQ = node("cmdq", "RoCC Cmd Queue", "ctrl", 120, 280, 170, 54);
  const nRs = node("rs", "Reservation Station", "ctrl", 340, 270, 200, 74);
  const nLoad = node("load", "Load Controller", "compute", 610, 200, 170, 72);
  const nExec = node("exec", "Execute Controller", "compute", 610, 300, 170, 72);
  const nStore = node("store", "Store Controller", "compute", 610, 400, 170, 72);
  const nSpad = node("spad", "Scratchpad SRAM", "mem", 860, 270, 220, 92);
  const nArray = node("array", "Systolic Array / PE Mesh", "compute", 1160, 300, 250, 84);
  const nTlb = node("tlb", "Frontend TLB", "ctrl", 900, 110, 180, 58);
  const nDma = node("dma", "DMA / TileLink Master", "bus", 1160, 110, 250, 58);

  nodes.push(nCmdQ, nRs, nLoad, nExec, nStore, nSpad, nArray, nTlb, nDma);

  if (hasModule(gem, /loopconv|loopmatmul|im2col/)) {
    nodes.push(node("pre", "Loop/Im2Col Preprocessor", "ctrl", 360, 150, 220, 58));
  }
  if (hasModule(gem, /countercontroller|counter/)) {
    nodes.push(node("cnt", "Counter Controller", "ctrl", 860, 420, 220, 58));
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const N = (id: string): Node => byId.get(id)!;

  const add = (id: string, s: string, t: string, label: string, pts: Array<{ x: number; y: number }>) => {
    edges.push({ id, source: s, target: t, label, attrs: { inferred: "true" }, points: orthPath(...pts) });
  };

  const cmdqR = side(N("cmdq"), "right");
  const rsL = side(N("rs"), "left");
  add("e_cmd_rs", "cmdq", "rs", "RoCC cmd/resp", [cmdqR, rsL]);

  const rsR = side(N("rs"), "right");
  add("e_rs_load", "rs", "load", "uop stream", [rsR, { x: 575, y: rsR.y }, { x: 575, y: side(N("load"), "left").y }, side(N("load"), "left")]);
  add("e_rs_exec", "rs", "exec", "uop stream", [rsR, { x: 575, y: rsR.y }, { x: 575, y: side(N("exec"), "left").y }, side(N("exec"), "left")]);
  add("e_rs_store", "rs", "store", "uop stream", [rsR, { x: 575, y: rsR.y }, { x: 575, y: side(N("store"), "left").y }, side(N("store"), "left")]);

  add("e_load_spad", "load", "spad", "read/write", [side(N("load"), "right"), { x: 820, y: side(N("load"), "right").y }, { x: 820, y: side(N("spad"), "top").y }, side(N("spad"), "top")]);
  add("e_exec_spad", "spad", "exec", "tensor data", [side(N("spad"), "left"), { x: 820, y: side(N("spad"), "left").y }, { x: 820, y: side(N("exec"), "right").y }, side(N("exec"), "right")]);
  add("e_store_spad", "store", "spad", "acc readback", [side(N("store"), "right"), { x: 820, y: side(N("store"), "right").y }, { x: 820, y: side(N("spad"), "bottom").y }, side(N("spad"), "bottom")]);

  add("e_spad_array", "spad", "array", "operand/acc data", [side(N("spad"), "right"), side(N("array"), "left")]);
  add(
    "e_exec_array",
    "exec",
    "array",
    "control + dataflow",
    [side(N("exec"), "right"), { x: 820, y: side(N("exec"), "right").y }, { x: 820, y: 392 }, { x: 1090, y: 392 }, { x: 1090, y: side(N("array"), "top").y }, side(N("array"), "top")]
  );

  add("e_load_tlb", "load", "tlb", "virt->phys", [side(N("load"), "top"), { x: side(N("load"), "top").x, y: 140 }, { x: side(N("tlb"), "left").x, y: 140 }, side(N("tlb"), "left")]);
  add("e_store_tlb", "store", "tlb", "virt->phys", [side(N("store"), "top"), { x: 810, y: side(N("store"), "top").y }, { x: 810, y: 150 }, { x: side(N("tlb"), "left").x, y: 150 }, side(N("tlb"), "left")]);
  add("e_tlb_dma", "tlb", "dma", "TL-UH //128", [side(N("tlb"), "right"), side(N("dma"), "left")]);

  if (byId.has("pre")) {
    add("e_pre_rs", "pre", "rs", "loop commands", [side(N("pre"), "bottom"), { x: side(N("pre"), "bottom").x, y: side(N("rs"), "top").y }, side(N("rs"), "top")]);
  }
  if (byId.has("cnt")) {
    add("e_cnt_exec", "cnt", "exec", "perf counters", [side(N("cnt"), "left"), { x: 790, y: side(N("cnt"), "left").y }, { x: 790, y: side(N("exec"), "bottom").y }, side(N("exec"), "bottom")]);
  }

  return { nodes, edges };
}

function main() {
  const [hierPath, outSvg, outJson] = process.argv.slice(2);
  if (!hierPath || !outSvg) {
    console.error("Usage: node dist/gemmini_l2_from_hierarchy.js <hier.json> <out.svg> [out.layout.json]");
    process.exit(1);
  }
  const root = JSON.parse(fs.readFileSync(hierPath, "utf8")) as HierNode;
  const gem = findGemmini(root);
  if (!gem) {
    console.error("Gemmini instance not found in module hierarchy.");
    process.exit(2);
  }
  const graph = buildGemminiL2(gem as HierNode);
  const rules = {
    render: {
      show_clusters: false,
      containers: [
        { title: "Gemmini Accelerator (L2 Internal View)", all: true, class: "chiptop", padding: 28 },
      ],
    },
  };
  const css = new URL("../styles/jssc.css", import.meta.url).pathname;
  const svg = renderSvg(graph, css, rules as any);
  fs.writeFileSync(outSvg, svg, "utf8");
  if (outJson) fs.writeFileSync(outJson, JSON.stringify(graph, null, 2), "utf8");
}

main();
