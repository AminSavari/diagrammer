import fs from "fs";
import yaml from "js-yaml";
import { parseGraphml } from "./graphml_parse.js";
import { abstractGraph } from "./abstract.js";
import { sizeGraph } from "./size.js";
import { layoutGraph } from "./layout.js";
import { renderSvg } from "./render_svg.js";

async function main() {
  const [graphmlPath, rulesPath, outSvg, outJson] = process.argv.slice(2);
  if (!graphmlPath || !rulesPath || !outSvg) {
    console.error("Usage: node dist/main.js <in.graphml> <rules.yaml> <out.svg> [out.json]");
    process.exit(1);
  }
  const graphmlText = fs.readFileSync(graphmlPath, "utf8");
  const g0 = parseGraphml(graphmlText);
  const rules = yaml.load(fs.readFileSync(rulesPath, "utf8"));
  const g1 = abstractGraph(g0, rules);
  const g2 = sizeGraph(g1, rules);
  const g3 = await layoutGraph(g2, rules as any);
  const svg = renderSvg(g3, new URL("../styles/jssc.css", import.meta.url).pathname, rules as any);
  fs.writeFileSync(outSvg, svg, "utf8");
  if (outJson) fs.writeFileSync(outJson, JSON.stringify(g3, null, 2), "utf8");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
