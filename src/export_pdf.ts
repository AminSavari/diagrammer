import fs from "fs";
import { spawnSync } from "child_process";
import { pathToFileURL } from "url";

type SpawnFn = typeof spawnSync;

function buildArgs(svg: string, pdf: string): string[] {
  return ["--export-area-drawing", `--export-filename=${pdf}`, svg];
}

export function exportPdf(
  svg: string,
  pdf: string,
  inkscapeBin = process.env.INKSCAPE_BIN && process.env.INKSCAPE_BIN.trim().length > 0
    ? process.env.INKSCAPE_BIN
    : "inkscape",
  spawn: SpawnFn = spawnSync,
): void {
  if (!fs.existsSync(svg)) {
    throw new Error(`SVG input not found: ${svg}`);
  }
  const res = spawn(inkscapeBin, buildArgs(svg, pdf), {
    stdio: "inherit",
  });

  if (res.error) {
    const code = (res.error as any)?.code;
    if (code === "ENOENT") {
      throw new Error(
        `Inkscape not found ('${inkscapeBin}'). Install Inkscape or set INKSCAPE_BIN to the executable path.`,
      );
    }
    throw new Error(`Failed to launch Inkscape ('${inkscapeBin}'): ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`Inkscape export failed with exit code ${res.status}`);
  }
  if (!fs.existsSync(pdf)) {
    throw new Error(`Inkscape reported success but PDF was not created: ${pdf}`);
  }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv.length >= 4) {
  const svg = process.argv[2];
  const pdf = process.argv[3];
  if (!svg || !pdf) {
    console.error("Usage: node dist/export_pdf.js <in.svg> <out.pdf>");
    process.exit(1);
  }
  try {
    exportPdf(svg, pdf);
  } catch (e: any) {
    console.error(e?.message ?? String(e));
    process.exit(1);
  }
}
