#########################################################################################
# Diagrammer: Diplomacy GraphML extraction
#########################################################################################

HELP_COMMANDS += \
"   graphml                    = generate (and locate) Diplomacy GraphML for CONFIG" \
"   diagrams                   = end-to-end pipeline: graphml -> svg -> pdf (set LEVEL=L1/L2/L3/L4)" \
"   diagram-levels             = emit hierarchy levels report JSON (design + per-L1-block depth)" \
"   diagram                    = generate SVG + layout JSON from Diplomacy GraphML for CONFIG" \
"   diagram-quick              = generate SVG + layout JSON using an existing GRAPHML_FILE only" \
"   l2-diagram                 = generate L2 internal diagram from hierarchy (use BLOCK=<L1 block name>)" \
"   l4-diagram                 = generate L4 internal diagram from hierarchy (use BLOCK=<L3 block name>)" \
"   diagram-pdf                = export PDF from generated SVG using Inkscape" \
"   diagram-test               = run diagrammer regression tests"

GRAPHML_FILE ?= $(build_dir)/$(long_name).graphml
DIAGRAMMER_DIR ?= $(base_dir)/tools/diagrammer
DIAGRAM_RULES ?= $(DIAGRAMMER_DIR)/rules/L1_soc.yaml
DIAGRAM_OUT_DIR ?= $(build_dir)/diagrams
DIAGRAM_SVG ?= $(DIAGRAM_OUT_DIR)/$(long_name).svg
DIAGRAM_LAYOUT ?= $(DIAGRAM_OUT_DIR)/$(long_name).layout.json
DIAGRAM_PDF ?= $(DIAGRAM_OUT_DIR)/$(long_name).pdf
DIAGRAMMER_MAIN ?= $(DIAGRAMMER_DIR)/dist/main.js
DIAGRAMMER_L2_MAIN ?= $(DIAGRAMMER_DIR)/dist/l2_from_hierarchy.js
DIAGRAMMER_L3_MAIN ?= $(DIAGRAMMER_DIR)/dist/l3_from_hierarchy.js
DIAGRAMMER_L4_MAIN ?= $(DIAGRAMMER_DIR)/dist/l4_from_hierarchy.js
DIAGRAMMER_LEVELS_MAIN ?= $(DIAGRAMMER_DIR)/dist/levels_from_hierarchy.js
DIAGRAMMER_EXPORT_PDF ?= $(DIAGRAMMER_DIR)/dist/export_pdf.js
DIAGRAM_LEVELS_JSON ?= $(DIAGRAM_OUT_DIR)/levels.json
DIAGRAM_STAMP ?= $(DIAGRAM_OUT_DIR)/.$(long_name).diagram.stamp
DIAGRAMMER_NPM_STAMP ?= $(DIAGRAMMER_DIR)/node_modules/.diagrammer-npm.stamp
LEVEL ?= L1
ACC ?=
ARRAY ?=
BLOCK ?= $(ACC)
L2_DEPTH ?= 1
HIERARCHY_FILE ?= $(build_dir)/model_module_hierarchy.uniquified.json

ifeq ($(LEVEL),L1)
  DIAGRAM_LEVEL_RULES ?= $(DIAGRAMMER_DIR)/rules/L1_soc.yaml
  DIAGRAM_LEVEL_BASE ?= L1_soc
else ifeq ($(LEVEL),L2)
  DIAGRAM_LEVEL_RULES ?=
  DIAGRAM_LEVEL_BASE ?= L2$(if $(strip $(BLOCK)),_$(BLOCK),)
else ifeq ($(LEVEL),L3)
  DIAGRAM_LEVEL_RULES ?=
  DIAGRAM_LEVEL_BASE ?= L3$(if $(strip $(BLOCK)),_$(BLOCK),$(if $(strip $(ARRAY)),_$(ARRAY),))
else ifeq ($(LEVEL),L4)
  DIAGRAM_LEVEL_RULES ?=
  DIAGRAM_LEVEL_BASE ?= L4$(if $(strip $(BLOCK)),_$(BLOCK),$(if $(strip $(ARRAY)),_$(ARRAY),))
else
  DIAGRAM_LEVEL_RULES ?=
  DIAGRAM_LEVEL_BASE ?=
endif

DIAGRAMS_SVG ?= $(DIAGRAM_OUT_DIR)/$(DIAGRAM_LEVEL_BASE).svg
DIAGRAMS_LAYOUT ?= $(DIAGRAM_OUT_DIR)/$(DIAGRAM_LEVEL_BASE).layout.json
DIAGRAMS_PDF ?= $(DIAGRAM_OUT_DIR)/$(DIAGRAM_LEVEL_BASE).pdf
DIAGRAMS_STAMP ?= $(DIAGRAM_OUT_DIR)/.$(DIAGRAM_LEVEL_BASE).diagram.stamp

.PHONY: graphml
graphml: $(GRAPHML_FILE)

.PHONY: diagrams
diagrams:
	@if [ -z "$(DIAGRAM_LEVEL_BASE)" ]; then \
		echo "ERROR: Unsupported LEVEL='$(LEVEL)'. Use LEVEL=L1, LEVEL=L2, LEVEL=L3, or LEVEL=L4." 1>&2; \
		exit 1; \
	fi
	@if [ "$(LEVEL)" = "L2" ]; then \
		$(MAKE) l2-diagram \
			DIAGRAM_SVG="$(DIAGRAMS_SVG)" \
			DIAGRAM_LAYOUT="$(DIAGRAMS_LAYOUT)" \
			DIAGRAM_STAMP="$(DIAGRAMS_STAMP)"; \
	elif [ "$(LEVEL)" = "L3" ]; then \
		$(MAKE) l3-diagram \
			DIAGRAM_SVG="$(DIAGRAMS_SVG)" \
			DIAGRAM_LAYOUT="$(DIAGRAMS_LAYOUT)" \
			DIAGRAM_STAMP="$(DIAGRAMS_STAMP)"; \
	elif [ "$(LEVEL)" = "L4" ]; then \
		$(MAKE) l4-diagram \
			DIAGRAM_SVG="$(DIAGRAMS_SVG)" \
			DIAGRAM_LAYOUT="$(DIAGRAMS_LAYOUT)" \
			DIAGRAM_STAMP="$(DIAGRAMS_STAMP)"; \
	else \
		if [ ! -f "$(DIAGRAM_LEVEL_RULES)" ]; then \
			echo "ERROR: Rules file not found for LEVEL $(LEVEL): $(DIAGRAM_LEVEL_RULES)" 1>&2; \
			exit 1; \
		fi; \
		$(MAKE) graphml; \
		$(MAKE) diagram \
			DIAGRAM_RULES="$(DIAGRAM_LEVEL_RULES)" \
			DIAGRAM_SVG="$(DIAGRAMS_SVG)" \
			DIAGRAM_LAYOUT="$(DIAGRAMS_LAYOUT)" \
			DIAGRAM_STAMP="$(DIAGRAMS_STAMP)"; \
	fi
	$(MAKE) diagram-pdf \
		DIAGRAM_SVG="$(DIAGRAMS_SVG)" \
		DIAGRAM_PDF="$(DIAGRAMS_PDF)"
	@echo "Diagrams complete for LEVEL=$(LEVEL)"
	@echo "  SVG   : $(DIAGRAMS_SVG)"
	@echo "  LAYOUT: $(DIAGRAMS_LAYOUT)"
	@echo "  PDF   : $(DIAGRAMS_PDF)"

$(DIAGRAMMER_NPM_STAMP): $(DIAGRAMMER_DIR)/package.json $(DIAGRAMMER_DIR)/package-lock.json
	cd $(DIAGRAMMER_DIR) && npm install
	@touch $@

$(DIAGRAMMER_MAIN): $(DIAGRAMMER_NPM_STAMP) $(DIAGRAMMER_DIR)/tsconfig.json $(wildcard $(DIAGRAMMER_DIR)/src/*.ts)
	cd $(DIAGRAMMER_DIR) && npm run build

.PHONY: diagram
diagram: $(DIAGRAM_STAMP)

$(DIAGRAM_STAMP): $(GRAPHML_FILE) $(DIAGRAMMER_MAIN) $(DIAGRAM_RULES)
	@mkdir -p $(dir $(DIAGRAM_SVG))
	node $(DIAGRAMMER_MAIN) $(GRAPHML_FILE) $(DIAGRAM_RULES) $(DIAGRAM_SVG) $(DIAGRAM_LAYOUT)
	@touch $@
	@echo "Diagram SVG: $(DIAGRAM_SVG)"
	@echo "Diagram layout JSON: $(DIAGRAM_LAYOUT)"

.PHONY: diagram-quick
diagram-quick: $(DIAGRAMMER_MAIN) $(DIAGRAM_RULES)
	@if [ ! -f "$(GRAPHML_FILE)" ]; then \
		echo "ERROR: GRAPHML_FILE does not exist: $(GRAPHML_FILE)" 1>&2; \
		echo "Run 'make ... graphml' first or set GRAPHML_FILE=<path/to/file.graphml>." 1>&2; \
		exit 1; \
	fi
	@mkdir -p $(dir $(DIAGRAM_SVG))
	node $(DIAGRAMMER_MAIN) $(GRAPHML_FILE) $(DIAGRAM_RULES) $(DIAGRAM_SVG) $(DIAGRAM_LAYOUT)
	@touch $(DIAGRAM_STAMP)
	@echo "Diagram SVG: $(DIAGRAM_SVG)"
	@echo "Diagram layout JSON: $(DIAGRAM_LAYOUT)"

.PHONY: l2-diagram
l2-diagram: $(DIAGRAMMER_MAIN)
	@if [ -z "$(strip $(BLOCK))" ]; then \
		echo "ERROR: LEVEL=L2 requires BLOCK=<name from L1 diagram>, e.g. BLOCK=Gemmini or BLOCK=PLIC" 1>&2; \
		exit 1; \
	fi
	@hier="$(HIERARCHY_FILE)"; \
	if [ ! -f "$$hier" ]; then \
		if command -v rg >/dev/null 2>&1; then \
			hier=$$(rg --files "$(build_dir)" 2>/dev/null | rg 'model_module_hierarchy(\\.uniquified)?\\.json$$' | head -n 1); \
		else \
			hier=$$(find "$(build_dir)" -name "model_module_hierarchy*.json" -print 2>/dev/null | head -n 1); \
		fi; \
	fi; \
	if [ -z "$$hier" ] || [ ! -f "$$hier" ]; then \
		echo "ERROR: hierarchy JSON not found. Expected $(HIERARCHY_FILE) or model_module_hierarchy*.json in $(build_dir)." 1>&2; \
		exit 1; \
	fi; \
	mkdir -p "$(dir $(DIAGRAM_SVG))"; \
	node "$(DIAGRAMMER_L2_MAIN)" "$$hier" "$(BLOCK)" "$(DIAGRAM_SVG)" "$(DIAGRAM_LAYOUT)" "$(L2_DEPTH)"; \
	touch "$(DIAGRAM_STAMP)"; \
	echo "Hierarchy JSON: $$hier"; \
	echo "L2 BLOCK: $(BLOCK)"; \
	echo "Diagram SVG: $(DIAGRAM_SVG)"; \
	echo "Diagram layout JSON: $(DIAGRAM_LAYOUT)"

.PHONY: l3-diagram
l3-diagram: $(DIAGRAMMER_MAIN)
	@target="$(strip $(BLOCK))"; \
	if [ -z "$$target" ]; then target="$(strip $(ARRAY))"; fi; \
	if [ -z "$$target" ]; then \
		echo "ERROR: LEVEL=L3 requires BLOCK=<name from L2 diagram> (or ARRAY=... for compatibility)" 1>&2; \
		exit 1; \
	fi; \
	hier="$(HIERARCHY_FILE)"; \
	if [ ! -f "$$hier" ]; then \
		if command -v rg >/dev/null 2>&1; then \
			hier=$$(rg --files "$(build_dir)" 2>/dev/null | rg 'model_module_hierarchy(\\.uniquified)?\\.json$$' | head -n 1); \
		else \
			hier=$$(find "$(build_dir)" -name "model_module_hierarchy*.json" -print 2>/dev/null | head -n 1); \
		fi; \
	fi; \
	if [ -z "$$hier" ] || [ ! -f "$$hier" ]; then \
		echo "ERROR: hierarchy JSON not found. Expected $(HIERARCHY_FILE) or model_module_hierarchy*.json in $(build_dir)." 1>&2; \
		exit 1; \
	fi; \
	mkdir -p "$(dir $(DIAGRAM_SVG))"; \
	node "$(DIAGRAMMER_L3_MAIN)" "$$hier" "$$target" "$(DIAGRAM_SVG)" "$(DIAGRAM_LAYOUT)"; \
	touch "$(DIAGRAM_STAMP)"; \
	echo "Hierarchy JSON: $$hier"; \
	echo "L3 BLOCK: $$target"; \
	echo "Diagram SVG: $(DIAGRAM_SVG)"; \
	echo "Diagram layout JSON: $(DIAGRAM_LAYOUT)"

.PHONY: l4-diagram
l4-diagram: $(DIAGRAMMER_MAIN)
	@target="$(strip $(BLOCK))"; \
	if [ -z "$$target" ]; then target="$(strip $(ARRAY))"; fi; \
	if [ -z "$$target" ]; then \
		echo "ERROR: LEVEL=L4 requires BLOCK=<name from L3 diagram> (or ARRAY=... for compatibility)" 1>&2; \
		exit 1; \
	fi; \
	hier="$(HIERARCHY_FILE)"; \
	if [ ! -f "$$hier" ]; then \
		if command -v rg >/dev/null 2>&1; then \
			hier=$$(rg --files "$(build_dir)" 2>/dev/null | rg 'model_module_hierarchy(\\.uniquified)?\\.json$$' | head -n 1); \
		else \
			hier=$$(find "$(build_dir)" -name "model_module_hierarchy*.json" -print 2>/dev/null | head -n 1); \
		fi; \
	fi; \
	if [ -z "$$hier" ] || [ ! -f "$$hier" ]; then \
		echo "ERROR: hierarchy JSON not found. Expected $(HIERARCHY_FILE) or model_module_hierarchy*.json in $(build_dir)." 1>&2; \
		exit 1; \
	fi; \
	mkdir -p "$(dir $(DIAGRAM_SVG))"; \
	node "$(DIAGRAMMER_L4_MAIN)" "$$hier" "$$target" "$(DIAGRAM_SVG)" "$(DIAGRAM_LAYOUT)"; \
	touch "$(DIAGRAM_STAMP)"; \
	echo "Hierarchy JSON: $$hier"; \
	echo "L4 BLOCK: $$target"; \
	echo "Diagram SVG: $(DIAGRAM_SVG)"; \
	echo "Diagram layout JSON: $(DIAGRAM_LAYOUT)"

.PHONY: diagram-levels
diagram-levels: $(DIAGRAMMER_MAIN)
	@hier="$(HIERARCHY_FILE)"; \
	if [ ! -f "$$hier" ]; then \
		if command -v rg >/dev/null 2>&1; then \
			hier=$$(rg --files "$(build_dir)" 2>/dev/null | rg 'model_module_hierarchy(\\.uniquified)?\\.json$$' | head -n 1); \
		else \
			hier=$$(find "$(build_dir)" -name "model_module_hierarchy*.json" -print 2>/dev/null | head -n 1); \
		fi; \
	fi; \
	if [ -z "$$hier" ] || [ ! -f "$$hier" ]; then \
		echo "ERROR: hierarchy JSON not found. Expected $(HIERARCHY_FILE) or model_module_hierarchy*.json in $(build_dir)." 1>&2; \
		exit 1; \
	fi; \
	mkdir -p "$(dir $(DIAGRAM_LEVELS_JSON))"; \
	node "$(DIAGRAMMER_LEVELS_MAIN)" "$$hier" "$(DIAGRAM_LEVELS_JSON)"; \
	echo "Hierarchy JSON: $$hier"; \
	echo "Levels report JSON: $(DIAGRAM_LEVELS_JSON)"

.PHONY: diagram-test
diagram-test: $(DIAGRAMMER_NPM_STAMP)
	cd $(DIAGRAMMER_DIR) && npm test

.PHONY: diagram-pdf
diagram-pdf: $(DIAGRAM_PDF)

$(DIAGRAM_PDF): $(DIAGRAM_SVG) $(DIAGRAMMER_EXPORT_PDF)
	@mkdir -p $(dir $(DIAGRAM_PDF))
	INKSCAPE_BIN="$(INKSCAPE_BIN)" node $(DIAGRAMMER_EXPORT_PDF) $(DIAGRAM_SVG) $(DIAGRAM_PDF)
	@echo "Diagram PDF: $(DIAGRAM_PDF)"

$(GRAPHML_FILE):
	@# GraphML is emitted as an ElaborationArtefact during FIRRTL generation.
	@if [ -f "$@" ]; then \
		echo "GraphML: $@"; \
	else \
		found=""; \
		if command -v rg >/dev/null 2>&1; then \
			found=$$(rg --files -g "$(long_name).graphml" "$(build_dir)" 2>/dev/null | head -n 1); \
		else \
			found=$$(find "$(build_dir)" -name "$(long_name).graphml" -print 2>/dev/null | head -n 1); \
		fi; \
		if [ -n "$$found" ]; then \
			cp -f "$$found" "$@"; \
			echo "GraphML: $$found"; \
		else \
			echo "ERROR: GraphML not found for $(long_name). Run verilog/firrtl generation first." 1>&2; \
			exit 1; \
		fi; \
	fi
