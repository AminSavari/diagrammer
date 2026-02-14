import test from "node:test";
import assert from "node:assert/strict";

import { parseGraphml } from "../dist/graphml_parse.js";

test("parseGraphml recursively collects nested graph nodes and edges", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:y="http://www.yworks.com/xml/graphml">
  <key id="d0" for="node" attr.name="Description" attr.type="string"/>
  <graph id="G" edgedefault="directed">
    <node id="top">
      <data key="d0"><y:ShapeNode><y:NodeLabel>Top</y:NodeLabel></y:ShapeNode></data>
      <graph id="top::" edgedefault="directed">
        <node id="childA"><data key="d0">A desc</data></node>
        <node id="childB"><data key="d0"><y:ShapeNode><y:NodeLabel>B</y:NodeLabel></y:ShapeNode></data></node>
        <edge id="e1" source="childA" target="childB"><data key="d0"><y:PolyLineEdge><y:EdgeLabel>AB</y:EdgeLabel></y:PolyLineEdge></data></edge>
      </graph>
    </node>
  </graph>
</graphml>`;

  const out = parseGraphml(xml);
  const ids = out.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["childA", "childB", "top"]);
  assert.equal(out.nodes.find((n) => n.id === "top")?.label, "Top");
  assert.equal(out.nodes.find((n) => n.id === "childA")?.label, "A desc");
  assert.equal(out.nodes.find((n) => n.id === "childB")?.label, "B");
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0].source, "childA");
  assert.equal(out.edges[0].target, "childB");
  assert.equal(out.edges[0].label, "AB");
});
