import test from "node:test";
import assert from "node:assert/strict";

import { sizeGraph } from "../dist/size.js";

test("sizeGraph is deterministic and snaps to grid with clamped ranges", () => {
  const graph = {
    nodes: [
      { id: "n_bus", label: "system_bus_xbar" },
      { id: "n_mem", label: "L2CacheBank" },
      { id: "n_comp", label: "RocketTile0" },
      { id: "n_io", label: "uart_0" },
      { id: "n_ctrl", label: "clock_gater" },
    ],
    edges: [],
  };
  const rules = {
    size: {
      base_area: 5000,
      k: 800,
      min_w: 90,
      max_w: 220,
      min_h: 50,
      max_h: 140,
      grid: 10,
    },
  };

  const a = sizeGraph(graph, rules);
  const b = sizeGraph(graph, rules);
  assert.deepEqual(a, b);

  for (const n of a.nodes) {
    assert.ok(n.width >= 90 && n.width <= 220);
    assert.ok(n.height >= 50 && n.height <= 140);
    assert.equal(n.width % 10, 0);
    assert.equal(n.height % 10, 0);
  }
});

test("sizeGraph honors numeric metric attrs and preserves explicit dimensions", () => {
  const graph = {
    nodes: [
      { id: "small", label: "compute0", attrs: { metric: "1" } },
      { id: "big", label: "compute1", attrs: { metric: "100" } },
      { id: "fixed", label: "fixed", width: 111, height: 77 },
    ],
    edges: [],
  };
  const out = sizeGraph(graph, { size: { grid: 1, min_w: 10, min_h: 10, max_w: 600, max_h: 600 } });
  const small = out.nodes.find((n) => n.id === "small");
  const big = out.nodes.find((n) => n.id === "big");
  const fixed = out.nodes.find((n) => n.id === "fixed");
  assert.ok(big.width > small.width);
  assert.ok(big.height > small.height);
  assert.equal(fixed.width, 111);
  assert.equal(fixed.height, 77);
});
