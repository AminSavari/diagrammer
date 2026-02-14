import test from "node:test";
import assert from "node:assert/strict";

import { layoutGraph } from "../dist/layout.js";

test("layoutGraph is deterministic and returns routed points", async () => {
  const graph = {
    nodes: [
      { id: "a", label: "system_bus_xbar", width: 140, height: 50 },
      { id: "b", label: "RocketTile0", width: 120, height: 80 },
      { id: "c", label: "uart_0", width: 110, height: 60 },
      { id: "d", label: "L2Cache", width: 130, height: 70 },
    ],
    edges: [
      { source: "a", target: "b" },
      { source: "a", target: "c" },
      { source: "a", target: "d" },
    ],
  };

  const rules = {
    layout: {
      direction: "RIGHT",
      edge_routing: "ORTHOGONAL",
      node_node_between_layers: 45,
      node_node: 35,
      crossing_semi_interactive: true,
      consider_model_order: true,
    },
  };

  const out1 = await layoutGraph(graph, rules);
  const out2 = await layoutGraph(graph, rules);
  assert.deepEqual(out1, out2);
  assert.equal(out1.nodes.length, 4);
  assert.equal(out1.edges.length, 3);
  for (const n of out1.nodes) {
    assert.ok(typeof n.x === "number");
    assert.ok(typeof n.y === "number");
    assert.ok(n.width > 0);
    assert.ok(n.height > 0);
  }
  for (const e of out1.edges) {
    assert.ok(Array.isArray(e.points));
    assert.ok(e.points.length >= 2);
  }
});

test("layoutGraph accepts layout option overrides", async () => {
  const graph = {
    nodes: [
      { id: "n1", label: "A", width: 100, height: 60 },
      { id: "n2", label: "B", width: 100, height: 60 },
    ],
    edges: [{ source: "n1", target: "n2" }],
  };
  const out = await layoutGraph(graph, {
    layout: {
      direction: "DOWN",
      edge_routing: "ORTHOGONAL",
      options: {
        "org.eclipse.elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      },
    },
  });
  assert.equal(out.nodes.length, 2);
  assert.equal(out.edges.length, 1);
});
