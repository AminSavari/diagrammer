import fs from "fs";

type HierNode = {
  instance_name?: string;
  module_name?: string;
  instances?: HierNode[];
  children?: HierNode[];
};

type BlockSummary = {
  block: string;
  instance: string;
  module: string;
  max_depth_from_block: number;
  total_levels_from_block: number;
};

type LevelsReport = {
  design_root: string;
  total_levels_in_design: number;
  max_depth_edges: number;
  l1_block_count: number;
  l1_blocks: string[];
  block_summaries: BlockSummary[];
  supported_diagram_levels: string[];
  l4_candidates: Array<{
    block: string;
    instance: string;
    module: string;
    descendant_count: number;
    has_subcomponents: boolean;
    suggested_abstraction: "sub-block" | "gate-level" | "functional-fallback";
    reason: string;
  }>;
  notes: string[];
};

function kids(n: HierNode): HierNode[] {
  return (n.instances ?? n.children ?? []) as HierNode[];
}

function label(n: HierNode): string {
  const i = (n.instance_name ?? "").trim();
  const m = (n.module_name ?? "").trim();
  if (i && m) return `${i}:${m}`;
  return i || m || "Unknown";
}

function maxDepthEdges(n: HierNode): number {
  const ks = kids(n);
  if (ks.length === 0) return 0;
  let best = 0;
  for (const c of ks) best = Math.max(best, 1 + maxDepthEdges(c));
  return best;
}

function countDesc(n: HierNode): number {
  let c = 0;
  for (const k of kids(n)) c += 1 + countDesc(k);
  return c;
}

function isNoisyName(n: HierNode): boolean {
  const s = `${n.instance_name ?? ""} ${n.module_name ?? ""}`.toLowerCase();
  return /(queue|monitor|repeater|barrier|optimization|clock|reset|assert|checker|plusarg|regmapper)/.test(s);
}

function isLikelyL4Block(n: HierNode): boolean {
  const s = `${n.instance_name ?? ""} ${n.module_name ?? ""}`.toLowerCase();
  return /(pe|mac|mesh|array|tile|controller|mshr|cache|directory|scheduler|tlb|accumulator|transposer|alu|datapath)/.test(s);
}

function l4AbstractionHint(n: HierNode, descCount: number): { mode: "sub-block" | "gate-level" | "functional-fallback"; reason: string } {
  const s = `${n.instance_name ?? ""} ${n.module_name ?? ""}`.toLowerCase();
  if (descCount === 0) {
    if (/(pe|alu|mac|compute|logic)/.test(s)) return { mode: "gate-level", reason: "leaf compute block; use functional gate-style decomposition" };
    return { mode: "functional-fallback", reason: "leaf block without children; infer functional internals" };
  }
  const gateLike = /(^|[^a-z])(and|or|xor|mux|adder|logic|inv|not)($|[^a-z])/.test(s);
  if (gateLike) return { mode: "gate-level", reason: "logic-dominant naming detected" };
  return { mode: "sub-block", reason: "hierarchy contains sub-components" };
}

function summarizeL4Candidates(root: HierNode): LevelsReport["l4_candidates"] {
  const out: LevelsReport["l4_candidates"] = [];
  const walk = (n: HierNode, depth: number) => {
    if (depth >= 2 && depth <= 6 && isLikelyL4Block(n) && !isNoisyName(n)) {
      const d = countDesc(n);
      const hint = l4AbstractionHint(n, d);
      out.push({
        block: label(n),
        instance: n.instance_name ?? "",
        module: n.module_name ?? "",
        descendant_count: d,
        has_subcomponents: d > 0,
        suggested_abstraction: hint.mode,
        reason: hint.reason,
      });
    }
    for (const c of kids(n)) walk(c, depth + 1);
  };
  walk(root, 1);
  out.sort((a, b) => Number(b.has_subcomponents) - Number(a.has_subcomponents) || b.descendant_count - a.descendant_count || a.block.localeCompare(b.block));

  // Keep report concise and useful.
  const seen = new Set<string>();
  const uniq: typeof out = [];
  for (const x of out) {
    const k = `${(x.instance || "").toLowerCase()}|${(x.module || "").toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(x);
    if (uniq.length >= 80) break;
  }
  return uniq;
}

function summarizeL1Blocks(root: HierNode): BlockSummary[] {
  return kids(root).map((b) => {
    const depth = maxDepthEdges(b);
    return {
      block: label(b),
      instance: b.instance_name ?? "",
      module: b.module_name ?? "",
      max_depth_from_block: depth,
      total_levels_from_block: depth + 1,
    };
  });
}

async function main() {
  const [hierPath, outJson] = process.argv.slice(2);
  if (!hierPath || !outJson) {
    console.error("Usage: node dist/levels_from_hierarchy.js <hier.json> <out.json>");
    process.exit(1);
  }

  const root = JSON.parse(fs.readFileSync(hierPath, "utf8")) as HierNode;
  const maxDepth = maxDepthEdges(root);
  const summaries = summarizeL1Blocks(root).sort((a, b) => b.max_depth_from_block - a.max_depth_from_block || a.block.localeCompare(b.block));
  const l4 = summarizeL4Candidates(root);

  const report: LevelsReport = {
    design_root: label(root),
    total_levels_in_design: maxDepth + 1,
    max_depth_edges: maxDepth,
    l1_block_count: summaries.length,
    l1_blocks: summaries.map((x) => x.block),
    block_summaries: summaries,
    supported_diagram_levels: ["L1", "L2", "L3", "L4"],
    l4_candidates: l4,
    notes: [
      "total_levels_in_design counts root as level 1",
      "total_levels_from_block counts the selected L1 block as level 1",
      "supported_diagram_levels are currently what the toolchain can render",
      "l4_candidates includes likely blocks for LEVEL=L4 plus abstraction hints",
    ],
  };

  fs.writeFileSync(outJson, JSON.stringify(report, null, 2), "utf8");
  console.error(`Levels report: ${outJson}`);
  console.error(`Design levels: ${report.total_levels_in_design} (max depth edges=${report.max_depth_edges})`);
  console.error(`L1 blocks: ${report.l1_block_count}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
