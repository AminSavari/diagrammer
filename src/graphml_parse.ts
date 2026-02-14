import fs from "fs";
import { pathToFileURL } from "url";
import { XMLParser } from "fast-xml-parser";
import { Graph, Node, Edge, asArray } from "./util.js";

function extractText(val: any): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
    return String(val);
  }
  if (typeof val === "object") {
    if ("#text" in val && val["#text"] != null) return String(val["#text"]);
  }
  return undefined;
}

function findLabelDeep(val: any): string | undefined {
  if (val === undefined || val === null) return undefined;
  const scalar = extractText(val);
  if (scalar) return scalar;
  if (typeof val !== "object") return undefined;

  for (const key of ["y:NodeLabel", "y:EdgeLabel", "y:Label"]) {
    if (val[key] !== undefined) {
      const nested = findLabelDeep(val[key]);
      if (nested) return nested;
    }
  }
  for (const v of Object.values(val)) {
    const nested = findLabelDeep(v);
    if (nested) return nested;
  }
  return undefined;
}

function extractLabel(dataItems: any[]): string | undefined {
  for (const d of dataItems) {
    const label = findLabelDeep(d);
    if (label) return label;
  }
  return undefined;
}

function parseNode(n: any, keyMap: Record<string, string>): Node {
  const id = n["@_id"] ?? "";
  const dataItems = asArray<any>(n.data);
  const attrs: Record<string, string> = {};
  for (const d of dataItems) {
    const key = d?.["@_key"];
    const value = extractText(d);
    if (key && value !== undefined) {
      const mapped = keyMap[key] ?? key;
      attrs[mapped] = String(value);
    }
  }
  const label = extractLabel(dataItems) ?? attrs.Description;
  return { id, label, attrs };
}

function parseEdge(e: any, keyMap: Record<string, string>): Edge {
  const id = e["@_id"];
  const source = e["@_source"];
  const target = e["@_target"];
  const dataItems = asArray<any>(e.data);
  const label = extractLabel(dataItems);
  const attrs: Record<string, string> = {};
  for (const d of dataItems) {
    const key = d?.["@_key"];
    const value = extractText(d);
    if (key && value !== undefined) {
      const mapped = keyMap[key] ?? key;
      attrs[mapped] = String(value);
    }
  }
  return { id, source, target, label, attrs };
}

export function parseGraphml(text: string): Graph {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const doc = parser.parse(text);
  const graphml = doc.graphml;
  if (!graphml) {
    return { nodes: [], edges: [] };
  }

  const keyMap: Record<string, string> = {};
  for (const k of asArray<any>(graphml.key)) {
    const keyId = k?.["@_id"];
    const attrName = k?.["@_attr.name"];
    if (keyId && attrName) {
      keyMap[keyId] = String(attrName);
    }
  }

  const roots = asArray<any>(graphml.graph);
  if (roots.length === 0) {
    return { nodes: [], edges: [] };
  }

  const nodeMap = new Map<string, Node>();
  const edgeMap = new Map<string, Edge>();

  const visitGraph = (g: any): void => {
    for (const n of asArray<any>(g?.node)) {
      const parsed = parseNode(n, keyMap);
      if (parsed.id) nodeMap.set(parsed.id, parsed);
      for (const nested of asArray<any>(n?.graph)) {
        visitGraph(nested);
      }
    }
    for (const e of asArray<any>(g?.edge)) {
      const parsed = parseEdge(e, keyMap);
      if (!parsed.source || !parsed.target) continue;
      const key = parsed.id ?? `${parsed.source}->${parsed.target}::${parsed.label ?? ""}`;
      edgeMap.set(key, parsed);
    }
  };

  for (const g of roots) visitGraph(g);
  return { nodes: Array.from(nodeMap.values()), edges: Array.from(edgeMap.values()) };
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv.length >= 4) {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) {
    console.error("Usage: node dist/graphml_parse.js <in.graphml> <out.json>");
    process.exit(1);
  }
  const text = fs.readFileSync(input, "utf8");
  const graph = parseGraphml(text);
  fs.writeFileSync(output, JSON.stringify(graph, null, 2), "utf8");
  console.error(`graphml_parse: nodes=${graph.nodes.length} edges=${graph.edges.length}`);
}
