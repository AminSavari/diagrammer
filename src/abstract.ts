import fs from "fs";
import { pathToFileURL } from "url";
import yaml from "js-yaml";
import { Edge, Graph, Node } from "./util.js";

type CollapseRule = {
  pattern: string;
  as: string;
};

type RenameRule = {
  pattern: string;
  as: string;
};

type InferEdgeRule = {
  from_label: string;
  to_label: string;
  label?: string;
  bidirectional?: boolean;
};

type AddNodeRule = {
  label: string;
  category?: string;
};

function sanitizeId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function compileMatchers(patterns: unknown): RegExp[] {
  if (!Array.isArray(patterns)) return [];
  return patterns
    .map((p) => (typeof p === "string" ? p : ""))
    .filter((p) => p.length > 0)
    .map((p) => new RegExp(p, "i"));
}

function nodeHaystack(n: Node, includeAttrs = true): string {
  const base = `${n.id} ${n.label ?? ""}`;
  if (!includeAttrs) return base;
  const attrs = n.attrs ? Object.values(n.attrs).join(" ") : "";
  return `${base} ${attrs}`;
}

function matchesAny(n: Node, matchers: RegExp[], includeAttrs = true): boolean {
  if (matchers.length === 0) return false;
  const text = nodeHaystack(n, includeAttrs);
  return matchers.some((m) => m.test(text));
}

function parseClusterRules(rules: any): Array<{ category: string; matchers: RegExp[] }> {
  const out: Array<{ category: string; matchers: RegExp[] }> = [];
  if (!rules || typeof rules !== "object" || !rules.clusters || typeof rules.clusters !== "object") {
    return out;
  }
  for (const [category, spec] of Object.entries<any>(rules.clusters)) {
    const patterns = Array.isArray(spec) ? spec : spec?.match;
    const matchers = compileMatchers(patterns);
    if (matchers.length > 0) out.push({ category, matchers });
  }
  return out;
}

function parseCollapseRules(rules: any): CollapseRule[] {
  if (!rules || !Array.isArray(rules.collapse_repeats)) return [];
  return rules.collapse_repeats
    .filter((r: any) => typeof r?.pattern === "string" && typeof r?.as === "string")
    .map((r: any) => ({ pattern: r.pattern, as: r.as }));
}

function parseRenameRules(rules: any): RenameRule[] {
  if (!rules || !Array.isArray(rules.rename_nodes)) return [];
  return rules.rename_nodes
    .filter((r: any) => typeof r?.pattern === "string" && typeof r?.as === "string")
    .map((r: any) => ({ pattern: r.pattern, as: r.as }));
}

function parseIncludeMatchers(rules: any): RegExp[] {
  return compileMatchers(rules?.include);
}

function computeIncludedNodeIds(graph: Graph, includeMatchers: RegExp[], hops: number): Set<string> {
  if (includeMatchers.length === 0) return new Set(graph.nodes.map((n) => n.id));
  const seeds = new Set(graph.nodes.filter((n) => matchesAny(n, includeMatchers)).map((n) => n.id));
  const neighbors = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (!neighbors.has(e.source)) neighbors.set(e.source, new Set<string>());
    if (!neighbors.has(e.target)) neighbors.set(e.target, new Set<string>());
    neighbors.get(e.source)!.add(e.target);
    neighbors.get(e.target)!.add(e.source);
  }
  let frontier = new Set(seeds);
  const visited = new Set(seeds);
  for (let step = 0; step < Math.max(0, hops); step += 1) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const n of neighbors.get(id) ?? []) {
        if (!visited.has(n)) {
          visited.add(n);
          next.add(n);
        }
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }
  return visited;
}

function renameLabel(n: Node, renameRules: RenameRule[]): string | undefined {
  const text = nodeHaystack(n, true);
  for (const r of renameRules) {
    if (new RegExp(r.pattern, "i").test(text)) return r.as;
  }
  return n.label;
}

function relabelEdge(e: Edge, mode: string | undefined): string | undefined {
  if (!mode || mode !== "descriptive") return e.label;
  const raw = (e.label ?? "").trim();
  if (!raw) return e.label;
  if (/^\d+$/.test(raw)) return `TL ${raw}-bit`;
  return raw;
}

function parseInferEdgeRules(rules: any): InferEdgeRule[] {
  if (!rules || !Array.isArray(rules.infer_edges)) return [];
  return rules.infer_edges
    .filter((r: any) => typeof r?.from_label === "string" && typeof r?.to_label === "string")
    .map((r: any) => ({
      from_label: r.from_label,
      to_label: r.to_label,
      label: r.label,
      bidirectional: r.bidirectional === true,
    }));
}

function parseAddNodeRules(rules: any): AddNodeRule[] {
  if (!rules || !Array.isArray(rules.add_nodes)) return [];
  return rules.add_nodes
    .filter((r: any) => typeof r?.label === "string")
    .map((r: any) => ({ label: r.label, category: typeof r?.category === "string" ? r.category : undefined }));
}

function deriveEdgesThroughHidden(
  graph: Graph,
  includedIds: Set<string>,
  visibleIds: Set<string>,
  maxHops: number
): Edge[] {
  const adj = new Map<string, Edge[]>();
  for (const e of graph.edges) {
    if (!includedIds.has(e.source) || !includedIds.has(e.target)) continue;
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source)!.push(e);
    adj.get(e.target)!.push({
      source: e.target,
      target: e.source,
      label: e.label,
      attrs: e.attrs,
    });
  }

  const out: Edge[] = [];
  for (const source of visibleIds) {
    const queue: Array<{ node: string; label?: string; depth: number }> = [];
    for (const e of adj.get(source) ?? []) {
      queue.push({ node: e.target, label: e.label, depth: 1 });
    }
    const seenHidden = new Set<string>();
    const reachedVisible = new Set<string>();
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.depth > maxHops) continue;
      if (visibleIds.has(cur.node)) {
        if (cur.node !== source && !reachedVisible.has(cur.node)) {
          reachedVisible.add(cur.node);
          out.push({ source, target: cur.node, label: cur.label });
        }
        continue;
      }
      if (seenHidden.has(cur.node)) continue;
      seenHidden.add(cur.node);
      for (const e of adj.get(cur.node) ?? []) {
        queue.push({
          node: e.target,
          label: cur.label ?? e.label,
          depth: cur.depth + 1,
        });
      }
    }
  }
  return out;
}

export function abstractGraph(graph: Graph, rules: any): Graph {
  const hiddenMatchers = compileMatchers(rules?.hide);
  const includeMatchers = parseIncludeMatchers(rules);
  const clusterRules = parseClusterRules(rules);
  const collapseRules = parseCollapseRules(rules);
  const renameRules = parseRenameRules(rules);
  const includeHops = Number.isFinite(Number(rules?.include_hops)) ? Number(rules.include_hops) : 1;
  const dropIsolated = rules?.drop_isolated !== false;
  const mergeByLabel = rules?.merge_by_label === true;
  const mergeScope = rules?.merge_by_label_scope === "label" ? "label" : "category";
  const edgeLabelMode = typeof rules?.edge_labels === "string" ? rules.edge_labels : undefined;
  const connectViaHidden = rules?.connect_via_hidden !== false;
  const maxHiddenHops = Number.isFinite(Number(rules?.max_hidden_hops)) ? Number(rules.max_hidden_hops) : 8;
  const undirectedEdges = rules?.undirected_edges === true;
  const inferEdgeRules = parseInferEdgeRules(rules);
  const addNodeRules = parseAddNodeRules(rules);
  const includedIds = computeIncludedNodeIds(graph, includeMatchers, includeHops);

  const visibleNodes = graph.nodes
    .filter((n) => includedIds.has(n.id))
    .map((n) => {
      const category = clusterRules.find((r) => matchesAny(n, r.matchers, true))?.category ?? n.category;
      const label = renameLabel(n, renameRules);
      return { ...n, label, category };
    })
    .filter((n) => !matchesAny(n, hiddenMatchers, false));

  const byId = new Map(visibleNodes.map((n) => [n.id, n]));
  const replace = new Map<string, string>();
  const collapsedNodes: Node[] = [];
  const claimed = new Set<string>();

  for (const r of collapseRules) {
    const matcher = new RegExp(r.pattern, "i");
    const members = visibleNodes.filter((n) => !claimed.has(n.id) && matcher.test(nodeHaystack(n, false)));
    if (members.length < 2) continue;
    const id = `collapsed:${r.as}`;
    members.forEach((m) => {
      claimed.add(m.id);
      replace.set(m.id, id);
    });
    collapsedNodes.push({
      id,
      label: r.as,
      category: members[0]?.category ?? "cluster",
      attrs: { collapsed: String(members.length) },
    });
  }

  let finalNodes = [
    ...visibleNodes.filter((n) => !replace.has(n.id)),
    ...collapsedNodes,
  ];
  for (const r of addNodeRules) {
    const id = `synthetic:${sanitizeId(r.label)}`;
    if (finalNodes.some((n) => n.id === id || (n.label ?? "").toLowerCase() === r.label.toLowerCase())) continue;
    finalNodes.push({
      id,
      label: r.label,
      category: r.category ?? "ctrl",
      attrs: { synthetic: "true" },
    });
  }
  let finalNodeIds = new Set(finalNodes.map((n) => n.id));

  const mergeMap = new Map<string, string>();
  if (mergeByLabel) {
    const mergedNodes = new Map<string, Node>();
    for (const n of finalNodes) {
      const label = (n.label ?? n.id).trim();
      const category = (n.category ?? "cluster").trim();
      const key = mergeScope === "label" ? label.toLowerCase() : `${category}::${label.toLowerCase()}`;
      const canonicalId = mergeScope === "label"
        ? `merged:label:${sanitizeId(label)}`
        : `merged:${sanitizeId(category)}:${sanitizeId(label)}`;
      if (!mergedNodes.has(key)) {
        mergedNodes.set(key, {
          ...n,
          id: canonicalId,
          label,
          category,
        });
      }
      mergeMap.set(n.id, canonicalId);
    }
    finalNodes = Array.from(mergedNodes.values());
    finalNodeIds = new Set(finalNodes.map((n) => n.id));
  }

  const edgeMap = new Map<string, Edge>();
  const baseEdges = connectViaHidden
    ? deriveEdgesThroughHidden(graph, includedIds, new Set(byId.keys()), maxHiddenHops)
    : graph.edges;
  for (const e of baseEdges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    const source0 = replace.get(e.source) ?? e.source;
    const target0 = replace.get(e.target) ?? e.target;
    const source = mergeMap.get(source0) ?? source0;
    const target = mergeMap.get(target0) ?? target0;
    if (!finalNodeIds.has(source) || !finalNodeIds.has(target) || source === target) continue;
    const label = relabelEdge(e, edgeLabelMode);
    const [kSource, kTarget] = undirectedEdges && source > target ? [target, source] : [source, target];
    const key = `${kSource}->${kTarget}::${label ?? ""}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, {
        source: kSource,
        target: kTarget,
        label,
        attrs: e.attrs,
      });
    }
  }

  let edges = Array.from(edgeMap.values());
  if (inferEdgeRules.length > 0) {
    const byLabel = new Map<string, Node>();
    for (const n of finalNodes) byLabel.set((n.label ?? "").toLowerCase(), n);
    const existing = new Set(edges.map((e) => `${e.source}->${e.target}::${e.label ?? ""}`));
    for (const r of inferEdgeRules) {
      const src = byLabel.get(r.from_label.toLowerCase());
      const dst = byLabel.get(r.to_label.toLowerCase());
      if (!src || !dst || src.id === dst.id) continue;
      const [s, t] = undirectedEdges && src.id > dst.id ? [dst.id, src.id] : [src.id, dst.id];
      const key = `${s}->${t}::${r.label ?? ""}`;
      if (existing.has(key)) continue;
      edges.push({
        source: s,
        target: t,
        label: r.label,
        attrs: { inferred: "true", bidirectional: r.bidirectional ? "true" : "false" },
      });
      existing.add(key);
    }
  }
  if (rules?.keep_only_inferred_edges === true) {
    const inferred = edges.filter((e) => e.attrs?.inferred === "true");
    if (inferred.length > 0) edges = inferred;
  }

  let nodes = finalNodes;
  if (dropIsolated) {
    const connected = new Set<string>();
    for (const e of edges) {
      connected.add(e.source);
      connected.add(e.target);
    }
    nodes = finalNodes.filter((n) => connected.has(n.id));
    const allowed = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => allowed.has(e.source) && allowed.has(e.target));
  }

  return {
    nodes,
    edges,
  };
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv.length >= 4) {
  const input = process.argv[2];
  const rulesPath = process.argv[3];
  const output = process.argv[4] ?? "-";
  const graph = JSON.parse(fs.readFileSync(input, "utf8"));
  const rules = yaml.load(fs.readFileSync(rulesPath, "utf8"));
  const out = abstractGraph(graph, rules);
  const data = JSON.stringify(out, null, 2);
  if (output === "-") {
    process.stdout.write(data);
  } else {
    fs.writeFileSync(output, data, "utf8");
  }
}
