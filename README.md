# Diagrammer

![Diagrammer Logo](diagrammer_logo.png)

`diagrammer` generates hierarchical hardware architecture diagrams (L1/L2/L3/L4) from Chipyard hierarchy JSON and graph metadata.

## What It Does

- Builds architecture views at multiple abstraction levels.
- Uses deterministic placement/routing for readable block diagrams.
- Supports PE-style L4 logic views with schematic-like symbols.
- Exports SVG and PDF outputs.

## Repository Layout

- `src/` TypeScript generators and rendering pipeline
- `rules/` level rules and shape library
- `styles/` SVG/CSS style helpers
- `tests/` smoke checks
- `diagrammer.mk` Chipyard integration makefile

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Generate a Level Diagram

Example (L4):

```bash
node dist/l4_from_hierarchy.js \
  <hierarchy.json> \
  <block-name> \
  <out.svg> \
  <out.layout.json> \
  3
```

### 4. Export PDF

```bash
node dist/export_pdf.js <in.svg> <out.pdf>
```

## Chipyard Integration

This repository is intended to be consumed as a submodule at `tools/diagrammer`.

### Add as submodule

```bash
git submodule add git@github.com:AminSavari/diagrammer.git tools/diagrammer
```

### Update submodule

```bash
git submodule update --init --recursive
```

## Notes

- `templates/` is intentionally gitignored (large reference assets).
- Generated outputs (`*.svg`, `*.pdf`, `*.png`) are gitignored.
