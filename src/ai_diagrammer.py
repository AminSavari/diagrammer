import argparse
import base64
import json
import os
import re
import sys
from pathlib import Path
from typing import Optional

DEFAULT_MODEL = "gpt-image-1"
DEFAULT_SIZE = "1536x1024"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate an AI-rendered architecture diagram from diagrammer SVG/layout outputs."
    )
    parser.add_argument("--input-svg", type=Path, required=True, help="Input diagram SVG path.")
    parser.add_argument("--layout-json", type=Path, default=None, help="Optional input layout JSON path.")
    parser.add_argument("--config", default="", help="Chipyard CONFIG label.")
    parser.add_argument("--level", default="", help="Diagram level label (L1/L2/L3/L4).")
    parser.add_argument("--block", default="", help="Optional selected block name for L2/L3/L4.")
    parser.add_argument("--prompt-out", type=Path, required=True, help="Path to write generated prompt text.")
    parser.add_argument("--image-out", type=Path, required=True, help="Path to write generated PNG.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="OpenAI image model name.")
    parser.add_argument("--size", default=DEFAULT_SIZE, help="Image size for generation API.")
    return parser.parse_args()


def read_layout_stats(layout_path: Optional[Path]) -> tuple[int, int]:
    if layout_path is None or not layout_path.is_file():
        return (0, 0)
    try:
        payload = json.loads(layout_path.read_text())
    except Exception:
        return (0, 0)

    nodes = payload.get("nodes", [])
    edges = payload.get("edges", [])
    node_count = len(nodes) if isinstance(nodes, list) else 0
    edge_count = len(edges) if isinstance(edges, list) else 0
    return (node_count, edge_count)


def extract_svg_labels(svg_text: str, max_labels: int = 80) -> list[str]:
    labels = []
    for match in re.finditer(r"<text[^>]*>(.*?)</text>", svg_text, flags=re.IGNORECASE | re.DOTALL):
        raw = re.sub(r"<[^>]+>", "", match.group(1))
        label = raw.strip()
        if not label:
            continue
        labels.append(label)
        if len(labels) >= max_labels:
            break
    return labels


def build_prompt(
    svg_text: str,
    labels: list[str],
    node_count: int,
    edge_count: int,
    config: str,
    level: str,
    block: str,
) -> str:
    lines = []
    lines.append("Create a polished hardware architecture block diagram image.")
    lines.append("Use the supplied SVG as structural ground truth.")
    lines.append("Preserve block names and connectivity intent.")
    lines.append("")
    lines.append("Context:")
    if config:
        lines.append(f"- CONFIG: {config}")
    if level:
        lines.append(f"- LEVEL: {level}")
    if block:
        lines.append(f"- BLOCK: {block}")
    if node_count > 0:
        lines.append(f"- Approximate block count from layout JSON: {node_count}")
    if edge_count > 0:
        lines.append(f"- Approximate edge count from layout JSON: {edge_count}")
    if labels:
        lines.append("- Labels discovered in source SVG:")
        for label in labels:
            lines.append(f"  - {label}")
    lines.append("")
    lines.append("Style constraints:")
    lines.append("- clean professional engineering style")
    lines.append("- white background")
    lines.append("- crisp readable labels")
    lines.append("- clear directional arrows")
    lines.append("- balanced spacing")
    lines.append("- no cartoon style")
    lines.append("- no code snippets")
    lines.append("- no electrical schematic symbols")
    lines.append("")
    lines.append("Output requirements:")
    lines.append("- Keep exact visible module names where possible.")
    lines.append("- Preserve high-level topology from the source SVG.")
    lines.append("- Improve visual clarity and slide-readability.")
    lines.append("")
    lines.append("Source SVG (for structure reference):")
    lines.append(svg_text[:18000])
    return "\n".join(lines)


def generate_image(prompt: str, model: str, size: str) -> bytes:
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError(
            "Missing Python package 'openai'. Install it with "
            "'pip install -r tools/diagrammer/requirements-ai.txt'."
        ) from exc

    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is not set.")

    client = OpenAI()
    result = client.images.generate(model=model, prompt=prompt, size=size)
    image_b64 = result.data[0].b64_json
    return base64.b64decode(image_b64)


def main() -> int:
    args = parse_args()

    input_svg = args.input_svg.resolve()
    if not input_svg.is_file():
        print(f"ERROR: input SVG not found: {input_svg}", file=sys.stderr)
        return 2

    layout_json = args.layout_json.resolve() if args.layout_json else None
    svg_text = input_svg.read_text(errors="ignore")
    labels = extract_svg_labels(svg_text)
    node_count, edge_count = read_layout_stats(layout_json)

    prompt = build_prompt(
        svg_text=svg_text,
        labels=labels,
        node_count=node_count,
        edge_count=edge_count,
        config=args.config,
        level=args.level,
        block=args.block,
    )

    prompt_out = args.prompt_out.resolve()
    image_out = args.image_out.resolve()
    prompt_out.parent.mkdir(parents=True, exist_ok=True)
    image_out.parent.mkdir(parents=True, exist_ok=True)
    prompt_out.write_text(prompt)

    image_bytes = generate_image(prompt=prompt, model=args.model, size=args.size)
    image_out.write_bytes(image_bytes)

    print(f"Input SVG:      {input_svg}")
    if layout_json and layout_json.is_file():
        print(f"Layout JSON:    {layout_json}")
    print(f"Saved prompt:   {prompt_out}")
    print(f"Saved image:    {image_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
