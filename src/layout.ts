import fs from "fs";
import { pathToFileURL } from "url";
import yaml from "js-yaml";
import ELK from "elkjs/lib/elk.bundled.js";
import { Graph, Node } from "./util.js";

type LayoutRules = {
  layout?: {
    direction?: string;
    edge_routing?: string;
    node_node_between_layers?: number;
    node_node?: number;
    crossing_semi_interactive?: boolean;
    consider_model_order?: boolean;
    category_order?: string[];
    options?: Record<string, string | number | boolean>;
    floorplan?: string;
  };
};

function inferLayoutCategory(n: Node): string {
  const explicit = (n.category ?? "").toLowerCase();
  if (["compute", "mem", "bus", "io", "ctrl"].includes(explicit)) return explicit;
  if (/compute/.test(explicit)) return "compute";
  if (/mem/.test(explicit)) return "mem";
  if (/(bus|interconnect)/.test(explicit)) return "bus";
  if (/(io|periph)/.test(explicit)) return "io";
  if (/(debug|ctrl|control)/.test(explicit)) return "ctrl";
  const text = `${n.category ?? ""} ${n.label ?? ""} ${n.id}`.toLowerCase();
  if (/(bus|xbar|crossbar|tl-|tilelink|noc)/.test(text)) return "bus";
  if (/(mem|cache|scratch|spad|sram|dram|rom|bank|axi)/.test(text)) return "mem";
  if (/(core|tile|cpu|gemmini|array|pe|compute|vector|fpu|alu|accelerator)/.test(text)) return "compute";
  if (/(uart|gpio|spi|i2c|plic|clint|serial|dma|pcie|ethernet|io)/.test(text)) return "io";
  return "ctrl";
}

function toElkValue(v: string | number | boolean): string {
  return typeof v === "string" ? v : String(v);
}

function buildLayoutOptions(rules?: LayoutRules): Record<string, string> {
  const cfg = rules?.layout ?? {};
  const opts: Record<string, string> = {
    "elk.algorithm": "org.eclipse.elk.layered",
    "elk.direction": cfg.direction ?? "RIGHT",
    "elk.edgeRouting": cfg.edge_routing ?? "ORTHOGONAL",
    "elk.layered.spacing.nodeNodeBetweenLayers": String(cfg.node_node_between_layers ?? 40),
    "elk.spacing.nodeNode": String(cfg.node_node ?? 30),
    "org.eclipse.elk.layered.crossingMinimization.semiInteractive": String(cfg.crossing_semi_interactive ?? true),
    "org.eclipse.elk.layered.considerModelOrder.strategy": (cfg.consider_model_order ?? true) ? "NODES_AND_EDGES" : "NONE",
    "org.eclipse.elk.layered.crossingMinimization.forceNodeModelOrder": (cfg.consider_model_order ?? true) ? "true" : "false",
  };
  for (const [k, v] of Object.entries(cfg.options ?? {})) {
    opts[k] = toElkValue(v);
  }
  return opts;
}

function orderNodesForHints(nodes: Node[], rules?: LayoutRules): Node[] {
  const ordered = [...nodes];
  const categoryOrder = rules?.layout?.category_order ?? ["mem", "io", "ctrl", "bus", "compute"];
  const rank = new Map<string, number>();
  categoryOrder.forEach((c, i) => rank.set(c.toLowerCase(), i));
  const defaultRank = categoryOrder.length + 1;
  ordered.sort((a, b) => {
    const ca = inferLayoutCategory(a).toLowerCase();
    const cb = inferLayoutCategory(b).toLowerCase();
    const ra = rank.get(ca) ?? defaultRank;
    const rb = rank.get(cb) ?? defaultRank;
    if (ra !== rb) return ra - rb;
    return (a.label ?? a.id).localeCompare(b.label ?? b.id);
  });
  return ordered;
}

function matchLabel(label: string | undefined, re: RegExp): boolean {
  return re.test((label ?? "").toLowerCase());
}

function routeOrthEdges(graph: Graph): Graph {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const allNodes = graph.nodes.map((n) => ({
    id: n.id,
    x0: (n.x ?? 0) - 8,
    y0: (n.y ?? 0) - 8,
    x1: (n.x ?? 0) + (n.width ?? 0) + 8,
    y1: (n.y ?? 0) + (n.height ?? 0) + 8,
  }));
  const minY = Math.min(...allNodes.map((n) => n.y0));
  const maxY = Math.max(...allNodes.map((n) => n.y1));
  // Keep emergency reroute lanes inside the SoC envelope.
  const laneCandidates = [
    minY + 18,
    minY + 70,
    maxY - 70,
    maxY - 18,
  ];
  const nodeLabel = (id: string): string => (byId.get(id)?.label ?? "").toLowerCase();
  const is = (id: string, re: RegExp): boolean => re.test(nodeLabel(id));
  const cx = (id: string): number => {
    const n = byId.get(id);
    return (n?.x ?? 0) + (n?.width ?? 0) / 2;
  };
  const cy = (id: string): number => {
    const n = byId.get(id);
    return (n?.y ?? 0) + (n?.height ?? 0) / 2;
  };
  const centerByLabel = (re: RegExp): { x: number; y: number } | undefined => {
    const n = graph.nodes.find((m) => re.test((m.label ?? "").toLowerCase()));
    if (!n) return undefined;
    return { x: (n.x ?? 0) + (n.width ?? 0) / 2, y: (n.y ?? 0) + (n.height ?? 0) / 2 };
  };
  const socBand = (() => {
    const sbus = centerByLabel(/system bus/);
    const pbus = centerByLabel(/periphery bus/);
    const fbus = centerByLabel(/front bus/);
    const yTop = fbus ? fbus.y - 26 : minY + 90;
    const yMid = sbus ? sbus.y : Math.round((minY + maxY) / 2);
    const yBot = pbus ? pbus.y + 35 : maxY - 110;
    return { yTop, yMid, yBot };
  })();
  const sidePoint = (id: string, side: "left" | "right" | "top" | "bottom") => {
    const n = byId.get(id);
    if (!n) return { x: 0, y: 0 };
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const w = n.width ?? 0;
    const h = n.height ?? 0;
    if (side === "left") return { x, y: y + h / 2 };
    if (side === "right") return { x: x + w, y: y + h / 2 };
    if (side === "top") return { x: x + w / 2, y };
    return { x: x + w / 2, y: y + h };
  };

  const compressPoints = (pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> => {
    if (pts.length <= 1) return pts;
    const out: Array<{ x: number; y: number }> = [pts[0]];
    for (let i = 1; i < pts.length; i += 1) {
      const p = pts[i];
      const prev = out[out.length - 1];
      if (p.x === prev.x && p.y === prev.y) continue;
      out.push(p);
    }
    return out;
  };

  const segHitsRect = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    r: { x0: number; y0: number; x1: number; y1: number }
  ): boolean => {
    if (a.x === b.x) {
      const x = a.x;
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y, b.y);
      return x >= r.x0 && x <= r.x1 && y1 >= r.y0 && y0 <= r.y1;
    }
    if (a.y === b.y) {
      const y = a.y;
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      return y >= r.y0 && y <= r.y1 && x1 >= r.x0 && x0 <= r.x1;
    }
    return false;
  };

  const pathHitsNodes = (pts: Array<{ x: number; y: number }>, srcId: string, dstId: string): boolean => {
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      for (const n of allNodes) {
        if (n.id === srcId || n.id === dstId) continue;
        if (segHitsRect(a, b, n)) return true;
      }
    }
    return false;
  };

  const rerouteViaLane = (
    srcId: string,
    dstId: string,
    laneY: number
  ): Array<{ x: number; y: number }> => {
    const p0 = sidePoint(srcId, "right");
    const p1 = sidePoint(dstId, "left");
    return compressPoints([
      p0,
      { x: p0.x + 30, y: p0.y },
      { x: p0.x + 30, y: laneY },
      { x: p1.x - 30, y: laneY },
      { x: p1.x - 30, y: p1.y },
      p1,
    ]);
  };

  const routeByIntent = (e: any): { x: number; y: number }[] | undefined => {
    const s = e.source as string;
    const t = e.target as string;
    const lbl = (e.label ?? "").toLowerCase();

    // RoCC <-> L1 stays local to the tile to avoid long global detours.
    if (/l1 access path|core<->l1/.test(lbl)) {
      const p0 = sidePoint(s, "top");
      const p1 = sidePoint(t, "top");
      const laneY = Math.max(80, Math.min(p0.y, p1.y) - 28);
      return [p0, { x: p0.x, y: laneY }, { x: p1.x, y: laneY }, p1];
    }

    // Keep main datapath a clean horizontal spine.
    if (
      (is(s, /gemmini accelerator/) && is(t, /rocc interface/)) ||
      (is(s, /rocc interface/) && is(t, /rocket core/)) ||
      (is(s, /rocket core/) && is(t, /l1 i\$\/d\$ caches/)) ||
      (is(s, /l1 i\$\/d\$ caches/) && is(t, /system bus/)) ||
      (is(s, /system bus/) && is(t, /shared l2 cache/)) ||
      (is(s, /shared l2 cache/) && is(t, /memory bus/)) ||
      (is(s, /memory bus/) && is(t, /dram interface/))
    ) {
      const p0 = sidePoint(s, "right");
      const p1 = sidePoint(t, "left");
      return [p0, { x: p1.x, y: p0.y }, p1];
    }

    // Route Gemmini DMA on an upper lane to avoid crossing RoCC/L1 links.
    if (lbl.includes("dma tilelink") || (is(s, /gemmini/) && is(t, /system bus/))) {
      const p0 = sidePoint(s, "right");
      const p1 = sidePoint(t, "left");
      const laneY = socBand.yTop + 6;
      return [p0, { x: p0.x + 40, y: p0.y }, { x: p0.x + 40, y: laneY }, { x: p1.x - 40, y: laneY }, { x: p1.x - 40, y: p1.y }, p1];
    }

    // System bus to front/periphery go vertical through dedicated bus taps.
    if ((is(s, /system bus/) && is(t, /front bus/)) || (is(s, /front bus/) && is(t, /system bus/))) {
      const p0 = sidePoint(s, is(s, /system bus/) ? "top" : "bottom");
      const p1 = sidePoint(t, is(t, /system bus/) ? "top" : "bottom");
      const tapX = cx("merged:label:system_bus_tl_uh_128_bit") || ((p0.x + p1.x) / 2);
      return [p0, { x: tapX, y: p0.y }, { x: tapX, y: p1.y }, p1];
    }
    if ((is(s, /system bus/) && is(t, /periphery bus/)) || (is(s, /periphery bus/) && is(t, /system bus/))) {
      const p0 = sidePoint(s, is(s, /system bus/) ? "bottom" : "top");
      const p1 = sidePoint(t, is(t, /system bus/) ? "bottom" : "top");
      const tapX = cx("merged:label:system_bus_tl_uh_128_bit") || ((p0.x + p1.x) / 2);
      return [p0, { x: tapX, y: p0.y }, { x: tapX, y: p1.y }, p1];
    }

    // Peripheral fanout uses short orthogonal taps (avoid large rectangular detours).
    if (is(s, /periphery bus/) || is(t, /periphery bus/)) {
      const bus = is(s, /periphery bus/) ? s : t;
      const dev = bus === s ? t : s;
      const busToDev = e.source === bus;
      const pBus = sidePoint(bus, "right");
      const pDev = sidePoint(dev, "left");
      const span = pDev.x - pBus.x;
      const tapX = span > 220 ? (pDev.x - 26) : Math.min(pDev.x - 28, pBus.x + 46);
      if (busToDev) {
        return [pBus, { x: tapX, y: pBus.y }, { x: tapX, y: pDev.y }, pDev];
      }
      if (is(dev, /debug module/)) {
        const laneY = pBus.y + 145;
        const x0 = pDev.x - 28;
        return [pDev, { x: x0, y: pDev.y }, { x: x0, y: laneY }, { x: pBus.x, y: laneY }, pBus];
      }
      return [pDev, { x: tapX, y: pDev.y }, { x: tapX, y: pBus.y }, pBus];
    }

    return undefined;
  };

  const edges = graph.edges.map((e) => {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) return e;
    const routed = routeByIntent(e);
    if (routed) {
      let pts = compressPoints(routed);
      if (pathHitsNodes(pts, e.source, e.target)) {
        const candidates = laneCandidates.map((ly) => rerouteViaLane(e.source, e.target, ly));
        const good = candidates.find((p) => !pathHitsNodes(p, e.source, e.target));
        pts = good ?? candidates[candidates.length - 1];
      }
      return { ...e, points: pts };
    }
    const sx = (s.x ?? 0) + (s.width ?? 0);
    const sy = (s.y ?? 0) + (s.height ?? 0) / 2;
    const tx = t.x ?? 0;
    const ty = (t.y ?? 0) + (t.height ?? 0) / 2;
    const mx = Math.round((sx + tx) / 2);
    let pts = compressPoints([
      { x: sx, y: sy },
      { x: mx, y: sy },
      { x: mx, y: ty },
      { x: tx, y: ty },
    ]);
    if (pathHitsNodes(pts, e.source, e.target)) {
      const candidates = laneCandidates.map((ly) => rerouteViaLane(e.source, e.target, ly));
      const good = candidates.find((p) => !pathHitsNodes(p, e.source, e.target));
      pts = good ?? candidates[candidates.length - 1];
    }
    return {
      ...e,
      points: pts,
    };
  });
  return { ...graph, edges };
}

function applySocL1Floorplan(graph: Graph): Graph {
  const outNodes = graph.nodes.map((n) => ({ ...n }));
  const set = (re: RegExp, x: number, y: number) => {
    for (const n of outNodes) {
      if (matchLabel(n.label, re)) {
        n.x = x;
        n.y = y;
      }
    }
  };
  const setGeom = (re: RegExp, w: number, h: number) => {
    for (const n of outNodes) {
      if (matchLabel(n.label, re)) {
        n.width = w;
        n.height = h;
      }
    }
  };

  // Strict architecture spine: Tile -> System Bus -> L2 -> Memory.
  set(/gemmini accelerator/, 220, 210);
  set(/rocc interface/, 430, 210);
  set(/rocket core/, 640, 210);
  set(/l1 i\$\/d\$ caches/, 790, 210);

  set(/system bus/, 1020, 250);
  setGeom(/system bus/, 340, 34);
  set(/front bus/, 1020, 110);
  setGeom(/front bus/, 300, 30);
  set(/periphery bus/, 1020, 420);
  setGeom(/periphery bus/, 300, 30);

  set(/shared l2 cache/, 1390, 250);
  set(/memory bus/, 1570, 250);
  setGeom(/memory bus/, 280, 30);
  set(/dram interface/, 1860, 240);

  set(/interrupt controller/, 1390, 500);
  set(/timer and ipi/, 1540, 500);
  set(/uart console/, 1390, 620);
  set(/debug module/, 1540, 620);

  // Keep any remaining nodes in a fallback strip.
  let fy = 40;
  for (const n of outNodes) {
    if (n.x === undefined || n.y === undefined) {
      n.x = 40;
      n.y = fy;
      fy += (n.height ?? 60) + 20;
    }
  }
  return routeOrthEdges({ nodes: outNodes, edges: graph.edges });
}

export async function layoutGraph(graph: Graph, rules?: LayoutRules): Promise<Graph> {
  const elk = new (ELK as any)();
  const orderedNodes = orderNodesForHints(graph.nodes, rules);
  const elkGraph: any = {
    id: "root",
    layoutOptions: buildLayoutOptions(rules),
    children: orderedNodes.map((n) => ({
      id: n.id,
      width: n.width ?? 120,
      height: n.height ?? 60,
    })),
    edges: graph.edges.map((e, i) => ({
      id: e.id ?? `e${i}`,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  const laid = await elk.layout(elkGraph);
  const nodeMap: Record<string, any> = {};
  for (const c of laid.children ?? []) {
    nodeMap[c.id] = c;
  }
  const laidGraph: Graph = {
    nodes: graph.nodes.map((n) => ({
      ...n,
      x: nodeMap[n.id]?.x ?? 0,
      y: nodeMap[n.id]?.y ?? 0,
      width: nodeMap[n.id]?.width ?? n.width,
      height: nodeMap[n.id]?.height ?? n.height,
    })),
    edges: graph.edges.map((e, i) => {
      const le = (laid.edges ?? []).find((x: any) => x.id === (e.id ?? `e${i}`));
      const sections = le?.sections ?? [];
      const points = sections.flatMap((s: any) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]);
      return { ...e, points };
    }),
  };
  if (rules?.layout?.floorplan === "soc_l1") {
    return applySocL1Floorplan(laidGraph);
  }
  return laidGraph;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv.length >= 3) {
  const input = process.argv[2];
  const output = process.argv[3] ?? "-";
  const rulesPath = process.argv[4];
  const graph = JSON.parse(fs.readFileSync(input, "utf8"));
  const rules = rulesPath ? yaml.load(fs.readFileSync(rulesPath, "utf8")) : undefined;
  layoutGraph(graph, rules as LayoutRules).then((out) => {
    const data = JSON.stringify(out, null, 2);
    if (output === "-") {
      process.stdout.write(data);
    } else {
      fs.writeFileSync(output, data, "utf8");
    }
  });
}
