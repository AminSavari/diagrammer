import test from "node:test";
import assert from "node:assert/strict";

import { renderSvg } from "../dist/render_svg.js";

test("renderSvg emits JSSC layers, semantic classes, and escaped labels", () => {
  const graph = {
    nodes: [
      {
        id: "collapsed:TLMonitors",
        label: "TLMonitors <A>",
        category: "compute",
        attrs: { collapsed: "3" },
        x: 20,
        y: 20,
        width: 120,
        height: 60,
      },
      {
        id: "uart0",
        label: "UART0",
        category: "io",
        x: 220,
        y: 20,
        width: 120,
        height: 60,
      },
    ],
    edges: [
      {
        source: "collapsed:TLMonitors",
        target: "uart0",
        label: "TL-C",
        points: [{ x: 140, y: 50 }, { x: 220, y: 50 }],
      },
    ],
  };

  const svg = renderSvg(graph);
  assert.ok(svg.includes('id="layer-wires"'));
  assert.ok(svg.includes('id="layer-blocks"'));
  assert.ok(svg.includes('id="layer-labels"'));
  assert.ok(svg.includes('class="cluster compute"'));
  assert.ok(svg.includes('class="cluster io"'));
  assert.ok(svg.includes('class="node compute collapsed"'));
  assert.ok(svg.includes('class="node io"'));
  assert.ok(svg.includes("TLMonitors &lt;A&gt; x3"));
  assert.ok(svg.includes('class="edgeLabel"'));
  assert.ok(svg.includes(">TL-C<"));
  assert.ok(svg.includes('<path class="edge" d="M140,50 L220,50"/>'));
});
