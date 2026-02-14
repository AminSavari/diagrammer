import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { exportPdf } from "../dist/export_pdf.js";

const TMP_DIR = path.join(process.cwd(), "tests", ".tmp");
fs.mkdirSync(TMP_DIR, { recursive: true });

test("exportPdf fails when SVG input is missing", () => {
  const missingSvg = path.join(TMP_DIR, "no_such.svg");
  const outPdf = path.join(TMP_DIR, "out.pdf");
  assert.throws(
    () => exportPdf(missingSvg, outPdf, "inkscape", () => ({ status: 0 })),
    /SVG input not found/,
  );
});

test("exportPdf reports missing Inkscape executable clearly", () => {
  const svg = path.join(TMP_DIR, "in.svg");
  const outPdf = path.join(TMP_DIR, "out_missing_bin.pdf");
  fs.writeFileSync(svg, "<svg/>", "utf8");
  assert.throws(
    () => exportPdf(svg, outPdf, "inkscape", () => ({ error: { code: "ENOENT", message: "not found" }, status: null })),
    /Inkscape not found/,
  );
});

test("exportPdf reports non-zero exit code", () => {
  const svg = path.join(TMP_DIR, "in_fail.svg");
  const outPdf = path.join(TMP_DIR, "out_fail.pdf");
  fs.writeFileSync(svg, "<svg/>", "utf8");
  assert.throws(
    () => exportPdf(svg, outPdf, "inkscape", () => ({ status: 2 })),
    /exit code 2/,
  );
});

test("exportPdf succeeds when spawn succeeds and output exists", () => {
  const svg = path.join(TMP_DIR, "in_ok.svg");
  const outPdf = path.join(TMP_DIR, "out_ok.pdf");
  fs.writeFileSync(svg, "<svg/>", "utf8");
  exportPdf(svg, outPdf, "inkscape", (_bin, _args) => {
    fs.writeFileSync(outPdf, "%PDF-1.4\n", "utf8");
    return { status: 0 };
  });
  assert.ok(fs.existsSync(outPdf));
});
