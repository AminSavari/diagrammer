# AI Diagrams (Generic Flow)

This flow works for any Chipyard `CONFIG`, any diagram `LEVEL` (`L1`/`L2`/`L3`/`L4`), and any `BLOCK` used by hierarchical levels.

## Prerequisites

```bash
source env.sh
pip install -r tools/diagrammer/requirements-ai.txt
export OPENAI_API_KEY=<your_key>
```

## Usage from Chipyard

```bash
source env.sh
make -C sims/vcs CONFIG=<ConfigName> LEVEL=L1 ai-diagram
```

Examples:

```bash
make -C sims/vcs CONFIG=CustomGemminiRocketConfig LEVEL=L1 ai-diagram
make -C sims/vcs CONFIG=CustomGemminiRocketConfig LEVEL=L2 BLOCK=gemmini ai-diagram
make -C sims/vcs CONFIG=CustomGemminiRocketConfig LEVEL=L3 BLOCK=meshWithDelays ai-diagram
make -C sims/vcs CONFIG=CustomGemminiRocketConfig LEVEL=L4 BLOCK=transposer ai-diagram
```

Outputs are emitted beside standard diagram outputs under:

`sims/vcs/generated-src/chipyard.harness.TestHarness.<ConfigName>/diagrams/`

- `<level>.ai.prompt.txt`
- `<level>.ai.png`

## How It Works

`ai-diagram` reuses diagrammer-generated `SVG` and layout JSON as structural input, then calls the OpenAI image API to render a polished architecture figure while preserving topology and labels.
