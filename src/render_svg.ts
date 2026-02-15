import fs from "fs";
import { pathToFileURL } from "url";
import { Graph } from "./util.js";

type RenderContainer = {
  title: string;
  all?: boolean;
  match_labels?: string[];
  padding?: number;
  class?: string;
};

type RenderRules = {
  render?: {
    containers?: RenderContainer[];
    show_clusters?: boolean;
  };
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cls(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function inferRenderCategory(n: { id: string; label?: string; category?: string }): string {
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
  if (/(core|tile|cpu|gemmini|array|pe|compute|vector|fpu|alu|accelerator|rocc)/.test(text)) return "compute";
  if (/(uart|gpio|spi|i2c|plic|clint|serial|dma|pcie|ethernet|io)/.test(text)) return "io";
  return "ctrl";
}

function renderContainers(graph: Graph, rules?: RenderRules): { rects: string; titles: string } {
  const containers = rules?.render?.containers ?? [];
  const rects = containers.map((c) => {
    const pad = c.padding ?? 24;
    const matchers = (c.match_labels ?? []).map((p) => new RegExp(p, "i"));
    const nodes = c.all
      ? graph.nodes
      : graph.nodes.filter((n) => matchers.some((m) => m.test(n.label ?? "")));
    if (nodes.length === 0) return "";
    const minX = Math.min(...nodes.map((n) => n.x ?? 0)) - pad;
    const minY = Math.min(...nodes.map((n) => n.y ?? 0)) - (pad + 16);
    const maxX = Math.max(...nodes.map((n) => (n.x ?? 0) + (n.width ?? 120))) + pad;
    const maxY = Math.max(...nodes.map((n) => (n.y ?? 0) + (n.height ?? 60))) + pad;
    const ccls = cls(c.class ?? "soc");
    return `\n    <g class="diagramContainer ${ccls}">\n      <rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" rx="12" ry="12"/>\n    </g>`;
  }).join("");
  const titles = containers.map((c) => {
    const pad = c.padding ?? 24;
    const matchers = (c.match_labels ?? []).map((p) => new RegExp(p, "i"));
    const nodes = c.all
      ? graph.nodes
      : graph.nodes.filter((n) => matchers.some((m) => m.test(n.label ?? "")));
    if (nodes.length === 0) return "";
    const minX = Math.min(...nodes.map((n) => n.x ?? 0)) - pad;
    const minY = Math.min(...nodes.map((n) => n.y ?? 0)) - (pad + 16);
    const ccls = cls(c.class ?? "soc");
    return `\n    <text class="diagramContainerTitle ${ccls}" x="${minX + 10}" y="${minY + 14}">${esc(c.title)}</text>`;
  }).join("");
  return { rects, titles };
}

export function renderSvg(graph: Graph, cssPath?: string, rules?: RenderRules): string {
  const pad = 40;
  const maxX = Math.max(...graph.nodes.map((n) => (n.x ?? 0) + (n.width ?? 0)), 0) + pad;
  const maxY = Math.max(...graph.nodes.map((n) => (n.y ?? 0) + (n.height ?? 0)), 0) + pad;
  const css = cssPath ? fs.readFileSync(cssPath, "utf8") : "";
  const canvasScale = Math.max(0.92, Math.min(1.22, maxX / 2100));

  const clusterMargin = 18;
  const clusterTitleH = 18;
  const byCategory = new Map<string, typeof graph.nodes>();
  for (const n of graph.nodes) {
    const cat = n.category;
    if (!cat) continue;
    const arr = byCategory.get(cat) ?? [];
    arr.push(n);
    byCategory.set(cat, arr);
  }
  const clusters = Array.from(byCategory.entries()).map(([category, nodes]) => {
    const minX = Math.min(...nodes.map((n) => n.x ?? 0)) - clusterMargin;
    const minY = Math.min(...nodes.map((n) => n.y ?? 0)) - (clusterMargin + clusterTitleH);
    const maxXc = Math.max(...nodes.map((n) => (n.x ?? 0) + (n.width ?? 120))) + clusterMargin;
    const maxYc = Math.max(...nodes.map((n) => (n.y ?? 0) + (n.height ?? 60))) + clusterMargin;
    return { category, x: minX, y: minY, w: maxXc - minX, h: maxYc - minY };
  });
  const clusterBlockRects = clusters.map((c) => {
    const catCls = cls(c.category);
    return `\n    <g class="cluster ${catCls}" data-category="${esc(c.category)}">\n      <rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="10" ry="10"/>\n    </g>`;
  }).join("");
  const clusterTitles = clusters.map((c) => {
    const catCls = cls(c.category);
    return `\n    <text class="clusterTitle ${catCls}" x="${c.x + 10}" y="${c.y + 14}">${esc(c.category)}</text>`;
  }).join("");
  const showClusters = rules?.render?.show_clusters !== false;

  const containers = renderContainers(graph, rules);

  const rects = graph.nodes.map((n) => {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const w = n.width ?? 120;
    const h = n.height ?? 60;
    const collapsed = n.attrs?.collapsed;
    const catClass = inferRenderCategory(n);
    const collapsedClass = collapsed ? " collapsed" : "";
    return `\n    <g class="node ${catClass}${collapsedClass}" data-id="${esc(n.id)}">\n      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" ry="6"/>\n    </g>`;
  }).join("");

  const nodeLabels = graph.nodes.map((n) => {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const w = n.width ?? 120;
    const h = n.height ?? 60;
    const collapsed = n.attrs?.collapsed;
    const baseLabel = n.label ?? n.id;
    const label = collapsed ? `${baseLabel} x${collapsed}` : baseLabel;
    const catClass = inferRenderCategory(n);
    return `\n    <text class="nodeLabel ${catClass}" x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" dominant-baseline="middle">${esc(label)}</text>`;
  }).join("");

  const orthPoints = (pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> => {
    if (pts.length < 2) return pts;
    const out: Array<{ x: number; y: number }> = [pts[0]];
    for (let i = 1; i < pts.length; i += 1) {
      const prev = out[out.length - 1];
      const cur = pts[i];
      if (prev.x !== cur.x && prev.y !== cur.y) {
        out.push({ x: cur.x, y: prev.y });
      }
      out.push(cur);
    }
    return out;
  };

  const edgeLabelDisplay = (raw: string): string => {
    const s = raw.trim();
    if (!s) return "";
    if (/^tilelink\s+128-bit$/i.test(s)) return "TL-UH //128";
    if (/^dma\s+tl-uh\s+128-bit$/i.test(s)) return "DMA TL-UH //128";
    if (/^rocc command\/resp$/i.test(s)) return "RoCC cmd/rsp";
    const width = s.match(/(\d+)\s*-bit/i)?.[1] ?? s.match(/\/\s*(\d+)/)?.[1];
    const proto = s.match(/AXI4|TL-UH|TileLink|RoCC|TL-C\/TL-UH|core<->L1|L1 access path/i)?.[0];
    if (proto && width) return `${proto} //${width}`;
    if (width) return `//${width}`;
    return s;
  };

  const paths = graph.edges.map((e) => {
    const pts = orthPoints(e.points ?? []);
    if (pts.length < 2) return "";
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
    const inferredCls = e.attrs?.inferred === "true" ? " inferred" : "";
    const bidiCls = e.attrs?.bidirectional === "true" ? " bidirectional" : "";
    const nSrc = graph.nodes.find((n) => n.id === e.source);
    const nDst = graph.nodes.find((n) => n.id === e.target);
    const srcL = (nSrc?.label ?? "").toLowerCase();
    const dstL = (nDst?.label ?? "").toLowerCase();
    const majorBus =
      /(system bus|memory bus|periphery bus|front bus)/.test(srcL) ||
      /(system bus|memory bus|periphery bus|front bus)/.test(dstL);
    const majorBusCls = majorBus ? " majorBus" : "";
    const rawLbl = (e.label ?? "").toLowerCase();
    const bw = (rawLbl.match(/(\d+)\s*-bit/)?.[1] ?? rawLbl.match(/\/\/\s*(\d+)/)?.[1] ?? "");
    const bwCls = bw ? ` w${bw}` : "";
    const markerStart = e.attrs?.bidirectional === "true" ? ` marker-start="url(#arrowhead-bidi)"` : "";
    const markerEnd = e.attrs?.bidirectional === "true"
      ? ` marker-end="url(#arrowhead-bidi)"`
      : (e.attrs?.inferred === "true" ? ` marker-end="url(#arrowhead-inferred)"` : ` marker-end="url(#arrowhead)"`);
    return `\n    <path class="edge${inferredCls}${bidiCls}${majorBusCls}${bwCls}" d="${d}"${markerStart}${markerEnd}/>`;
  }).join("");

  const textFreq = new Map<string, number>();
  for (const e of graph.edges) {
    const raw = e.label?.trim();
    const t = raw ? edgeLabelDisplay(raw) : "";
    if (!t) continue;
    textFreq.set(t, (textFreq.get(t) ?? 0) + 1);
  }
  const labelSlots = new Map<string, number>();
  const seenLabels = new Set<string>();
  const edgeLabels = graph.edges.map((e) => {
    const rawText = e.label?.trim();
    const text = rawText ? edgeLabelDisplay(rawText) : undefined;
    const pts = orthPoints(e.points ?? []);
    if (!text || pts.length < 2) return "";
    const nSrc = graph.nodes.find((n) => n.id === e.source);
    const nDst = graph.nodes.find((n) => n.id === e.target);
    const srcL = (nSrc?.label ?? "").toLowerCase();
    const dstL = (nDst?.label ?? "").toLowerCase();
    const genericLink = /^(tl-uh|tilelink)\s*\/\/(64|128)$/i.test(text);
    const repeated = (textFreq.get(text) ?? 0) > 2;
    const hasMajorBus = /(system bus|memory bus|periphery bus|front bus)/.test(srcL + " " + dstL);
    const hasBackboneEndpoint = /(system bus|memory bus|front bus|shared l2 cache|dram interface)/.test(srcL + " " + dstL);
    if (/l1 access path/i.test(text)) return "";
    if (genericLink && repeated && (!hasMajorBus || !hasBackboneEndpoint)) return "";
    let bestI = 0;
    let bestLen = -1;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const dx = Math.abs(pts[i + 1].x - pts[i].x);
      const dy = Math.abs(pts[i + 1].y - pts[i].y);
      const len = dx + dy;
      if (len > bestLen) {
        bestLen = len;
        bestI = i;
      }
    }
    const pA = pts[bestI];
    const pB = pts[Math.min(bestI + 1, pts.length - 1)];
    const mid = { x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 };
    const lblKey = `${text.toLowerCase()}@${Math.round(mid.x / 60)}:${Math.round(mid.y / 40)}`;
    if (seenLabels.has(lblKey)) return "";
    seenLabels.add(lblKey);
    const slotKey = `${Math.round(mid.x / 10)}:${Math.round(mid.y / 10)}`;
    const slot = labelSlots.get(slotKey) ?? 0;
    labelSlots.set(slotKey, slot + 1);
    let y = mid.y - 8 + slot * 16;
    if (/l1 access path/i.test(text)) y -= 16;
    if (/core<->l1/i.test(text)) y += 16;
    const shortCritical = /(rocc command|^rocc$)/i.test(text);
    if (shortCritical) y -= 12;
    for (const n of graph.nodes) {
      const nx = (n.x ?? 0) + (n.width ?? 0) / 2;
      const ny = (n.y ?? 0) + (n.height ?? 0) / 2;
      if (Math.abs(nx - mid.x) < 105 && Math.abs(ny - y) < 24) {
        y += ny <= y ? 22 : -22;
      }
    }
    return `\n    <text class="edgeLabel" x="${mid.x}" y="${y}" text-anchor="middle">${esc(text)}</text>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${maxX}" height="${maxY}" viewBox="0 0 ${maxX} ${maxY}">\n<style>\n${css}\n.nodeLabel {\n  font-size: ${(12 * canvasScale).toFixed(1)}px;\n  font-weight: 600;\n  fill: #0f172a;\n}\n.edgeLabel {\n  font-size: ${(10 * canvasScale).toFixed(1)}px;\n  fill: #1f2937;\n  stroke-width: 2.6px;\n}\n.diagramContainerTitle {\n  font-size: ${(12 * canvasScale).toFixed(1)}px;\n  fill: #0f172a;\n}\n.edge.majorBus {\n  stroke-width: 2.2;\n  stroke: #1f4f96;\n}\n.edge.bidirectional.majorBus {\n  stroke-width: 2.4;\n}\n.edge.w32 { stroke-width: 1.0; }\n.edge.w64 { stroke-width: 1.35; }\n.edge.w128 { stroke-width: 1.9; }\n.edge.majorBus.w64 { stroke-width: 2.05; }\n.edge.majorBus.w128 { stroke-width: 2.55; }\n</style>\n<defs>\n  <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">\n    <path d="M0,0 L8,3 L0,6 z" fill="#222"/>\n  </marker>\n  <marker id="arrowhead-inferred" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">\n    <path d="M0,0 L8,3 L0,6 z" fill="#6b7280"/>\n  </marker>\n  <marker id="arrowhead-bidi" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">\n    <path d="M0,0 L8,3 L0,6 z" fill="#1f4f96"/>\n  </marker>\n</defs>\n<g id="layer-blocks-bg" class="layer blocks" inkscape:groupmode="layer" inkscape:label="blocks-bg">\n  <g class="diagramContainers">${containers.rects}\n  </g>\n  <g class="clusters">${showClusters ? clusterBlockRects : ""}\n  </g>\n</g>\n<g id="layer-wires" class="layer wires" inkscape:groupmode="layer" inkscape:label="wires">${paths}\n</g>\n<g id="layer-blocks-fg" class="layer blocks" inkscape:groupmode="layer" inkscape:label="blocks-fg">\n  <g class="nodes">${rects}\n  </g>\n</g>\n<g id="layer-labels" class="layer labels" inkscape:groupmode="layer" inkscape:label="labels">\n  <g class="diagramContainerTitles">${containers.titles}\n  </g>\n  <g class="clusterTitles">${showClusters ? clusterTitles : ""}\n  </g>\n  <g class="nodeLabels">${nodeLabels}\n  </g>\n  <g class="edgeLabels">${edgeLabels}\n  </g>\n</g>\n</svg>`;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv.length >= 3) {
  const input = process.argv[2];
  const output = process.argv[3];
  const css = process.argv[4];
  const rulesPath = process.argv[5];
  const graph = JSON.parse(fs.readFileSync(input, "utf8"));
  const rules = rulesPath ? JSON.parse(fs.readFileSync(rulesPath, "utf8")) : undefined;
  const svg = renderSvg(graph, css, rules);
  fs.writeFileSync(output, svg, "utf8");
}
