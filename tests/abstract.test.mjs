import test from "node:test";
import assert from "node:assert/strict";

import { abstractGraph } from "../dist/abstract.js";

test("abstractGraph applies hide, cluster tagging, and collapse_repeats", () => {
  const graph = {
    nodes: [
      { id: "n1", label: "RocketTile" },
      { id: "n2", label: "TLMonitor_0" },
      { id: "n3", label: "TLMonitor_1" },
      { id: "n4", label: "UART0" },
      { id: "n5", label: "DebugModule" },
    ],
    edges: [
      { source: "n1", target: "n2" },
      { source: "n1", target: "n3" },
      { source: "n1", target: "n2" },
      { source: "n2", target: "n4" },
      { source: "n3", target: "n4" },
      { source: "n5", target: "n1" },
    ],
  };

  const rules = {
    clusters: {
      Core: { match: ["Rocket"] },
      Peripherals: { match: ["UART", "PLIC", "CLINT"] },
    },
    hide: ["Debug"],
    collapse_repeats: [{ pattern: "TLMonitor.*", as: "TLMonitors" }],
  };

  const out = abstractGraph(graph, rules);
  const nodeIds = out.nodes.map((n) => n.id).sort();
  assert.deepEqual(nodeIds, ["collapsed:TLMonitors", "n1", "n4"]);

  const n1 = out.nodes.find((n) => n.id === "n1");
  const n4 = out.nodes.find((n) => n.id === "n4");
  const collapsed = out.nodes.find((n) => n.id === "collapsed:TLMonitors");
  assert.equal(n1?.category, "Core");
  assert.equal(n4?.category, "Peripherals");
  assert.equal(collapsed?.attrs?.collapsed, "2");

  assert.equal(out.edges.length, 2);
  assert.ok(out.edges.some((e) => e.source === "n1" && e.target === "collapsed:TLMonitors"));
  assert.ok(out.edges.some((e) => e.source === "collapsed:TLMonitors" && e.target === "n4"));
});
