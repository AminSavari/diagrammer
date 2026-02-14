export type PrRole = "control" | "memory" | "compute" | "interconnect" | "frontend" | "output" | "io";

export type PrNode = {
  id: string;
  role: PrRole;
  title: string;
  lines: string[];
  synthetic?: boolean;
};

export type PrEdge = {
  from: string;
  to: string;
  label: string;
  weight: number;
};

export type PrBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type PrPoint = {
  x: number;
  y: number;
};

export type PrWire = {
  from: string;
  to: string;
  label: string;
  weight: number;
  points: PrPoint[];
  labelAt: PrPoint;
};

export type PlaceRouteInput = {
  nodes: PrNode[];
  edges: PrEdge[];
  canvas: { width: number; height: number };
  region: { x: number; y: number; w: number; h: number };
  estimateNodeSize: (n: PrNode) => { w: number; h: number };
};

export type PlaceRouteResult = {
  boxes: Record<string, PrBox>;
  wires: PrWire[];
};

type Slot = { x: number; y: number; w: number; h: number };
type Side = "left" | "right" | "top" | "bottom";

const ROLE_TARGET: Record<PrRole, { x: number; y: number }> = {
  control: { x: 0.18, y: 0.16 },
  frontend: { x: 0.5, y: 0.16 },
  interconnect: { x: 0.5, y: 0.45 },
  memory: { x: 0.25, y: 0.74 },
  compute: { x: 0.7, y: 0.62 },
  output: { x: 0.84, y: 0.78 },
  io: { x: 0.86, y: 0.24 },
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function manhattan(a: PrPoint, b: PrPoint): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function boxCenter(b: PrBox): PrPoint {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function segmentIntersectsBox(a: PrPoint, b: PrPoint, r: PrBox): boolean {
  if (a.x === b.x) {
    const x = a.x;
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    return x > r.x && x < r.x + r.w && y1 > r.y && y0 < r.y + r.h;
  }
  if (a.y === b.y) {
    const y = a.y;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    return y > r.y && y < r.y + r.h && x1 > r.x && x0 < r.x + r.w;
  }
  return false;
}

function crossingCount(lines: PrPoint[][]): number {
  const segs: Array<{ a: PrPoint; b: PrPoint }> = [];
  for (const l of lines) {
    for (let i = 0; i + 1 < l.length; i += 1) segs.push({ a: l[i], b: l[i + 1] });
  }
  let c = 0;
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      const s = segs[i];
      const t = segs[j];
      if (s.a.x === s.b.x && t.a.y === t.b.y) {
        if (Math.min(t.a.x, t.b.x) < s.a.x && s.a.x < Math.max(t.a.x, t.b.x) && Math.min(s.a.y, s.b.y) < t.a.y && t.a.y < Math.max(s.a.y, s.b.y)) c += 1;
      } else if (s.a.y === s.b.y && t.a.x === t.b.x) {
        if (Math.min(s.a.x, s.b.x) < t.a.x && t.a.x < Math.max(s.a.x, s.b.x) && Math.min(t.a.y, t.b.y) < s.a.y && s.a.y < Math.max(t.a.y, t.b.y)) c += 1;
      }
    }
  }
  return c;
}

function makeSlots(region: { x: number; y: number; w: number; h: number }, n: number): Slot[] {
  const cols = n <= 4 ? 2 : n <= 6 ? 3 : 4;
  const rows = Math.ceil(n / cols);
  const gapX = 28;
  const gapY = 26;
  const cellW = Math.floor((region.w - gapX * (cols + 1)) / cols);
  const cellH = Math.floor((region.h - gapY * (rows + 1)) / rows);
  const out: Slot[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      out.push({
        x: region.x + gapX + c * (cellW + gapX),
        y: region.y + gapY + r * (cellH + gapY),
        w: cellW,
        h: cellH,
      });
    }
  }
  return out;
}

function initialAssignment(nodes: PrNode[], slots: Slot[], region: { x: number; y: number; w: number; h: number }): number[] {
  const used = new Set<number>();
  const asg = new Array(nodes.length).fill(0);
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    const t = ROLE_TARGET[n.role];
    const tx = region.x + t.x * region.w;
    const ty = region.y + t.y * region.h;
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let s = 0; s < slots.length; s += 1) {
      if (used.has(s)) continue;
      const c = { x: slots[s].x + slots[s].w / 2, y: slots[s].y + slots[s].h / 2 };
      const d = Math.abs(c.x - tx) + Math.abs(c.y - ty);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best < 0) best = i % slots.length;
    used.add(best);
    asg[i] = best;
  }
  return asg;
}

function boxFromSlot(slot: Slot, size: { w: number; h: number }): PrBox {
  return {
    x: slot.x + Math.floor((slot.w - size.w) / 2),
    y: slot.y + Math.floor((slot.h - size.h) / 2),
    w: size.w,
    h: size.h,
  };
}

function buildBoxes(nodes: PrNode[], slots: Slot[], sizes: Map<string, { w: number; h: number }>, asg: number[]): Record<string, PrBox> {
  const out: Record<string, PrBox> = {};
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    out[n.id] = boxFromSlot(slots[asg[i]], sizes.get(n.id)!);
  }
  return out;
}

function choosePorts(a: PrBox, b: PrBox): { aSide: Side; bSide: Side } {
  const ac = boxCenter(a);
  const bc = boxCenter(b);
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { aSide: "right", bSide: "left" } : { aSide: "left", bSide: "right" };
  }
  return dy >= 0 ? { aSide: "bottom", bSide: "top" } : { aSide: "top", bSide: "bottom" };
}

function sidePoint(b: PrBox, side: Side): PrPoint {
  if (side === "left") return { x: Math.round(b.x), y: Math.round(b.y + b.h / 2) };
  if (side === "right") return { x: Math.round(b.x + b.w), y: Math.round(b.y + b.h / 2) };
  if (side === "top") return { x: Math.round(b.x + b.w / 2), y: Math.round(b.y) };
  return { x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h) };
}

function inflateBox(b: PrBox, pad: number): PrBox {
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

function blockedAt(x: number, y: number, obstacles: PrBox[]): boolean {
  for (const b of obstacles) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return true;
  }
  return false;
}

function keyOf(x: number, y: number): string {
  return `${x},${y}`;
}

function orthAStar(start: PrPoint, goal: PrPoint, blocked: (x: number, y: number) => boolean, bounds: { x0: number; y0: number; x1: number; y1: number }, step: number): PrPoint[] {
  const sx = Math.round(start.x / step) * step;
  const sy = Math.round(start.y / step) * step;
  const gx = Math.round(goal.x / step) * step;
  const gy = Math.round(goal.y / step) * step;

  const open = new Set<string>([keyOf(sx, sy)]);
  const came = new Map<string, string>();
  const g = new Map<string, number>([[keyOf(sx, sy), 0]]);
  const f = new Map<string, number>([[keyOf(sx, sy), Math.abs(sx - gx) + Math.abs(sy - gy)]]);

  const dirs = [
    { dx: step, dy: 0 },
    { dx: -step, dy: 0 },
    { dx: 0, dy: step },
    { dx: 0, dy: -step },
  ];

  const bestOpen = (): string | undefined => {
    let best: string | undefined;
    let bestV = Number.POSITIVE_INFINITY;
    for (const k of open) {
      const v = f.get(k) ?? Number.POSITIVE_INFINITY;
      if (v < bestV) {
        bestV = v;
        best = k;
      }
    }
    return best;
  };

  let iters = 0;
  while (open.size > 0 && iters < 25000) {
    iters += 1;
    const cur = bestOpen();
    if (!cur) break;
    open.delete(cur);
    const [cx, cy] = cur.split(",").map(Number);
    if (cx === gx && cy === gy) {
      const out: PrPoint[] = [{ x: gx, y: gy }];
      let t = cur;
      while (came.has(t)) {
        const p = came.get(t)!;
        const [px, py] = p.split(",").map(Number);
        out.push({ x: px, y: py });
        t = p;
      }
      out.reverse();
      return out;
    }
    for (const d of dirs) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      if (nx < bounds.x0 || nx > bounds.x1 || ny < bounds.y0 || ny > bounds.y1) continue;
      if (blocked(nx, ny) && !(nx === gx && ny === gy)) continue;
      const nk = keyOf(nx, ny);
      const prev = came.get(cur);
      const turnPenalty = prev
        ? (() => {
            const [px, py] = prev.split(",").map(Number);
            const pdx = cx - px;
            const pdy = cy - py;
            return pdx !== d.dx || pdy !== d.dy ? step * 0.7 : 0;
          })()
        : 0;
      const tg = (g.get(cur) ?? 0) + step + turnPenalty;
      if (tg < (g.get(nk) ?? Number.POSITIVE_INFINITY)) {
        came.set(nk, cur);
        g.set(nk, tg);
        f.set(nk, tg + Math.abs(nx - gx) + Math.abs(ny - gy));
        open.add(nk);
      }
    }
  }
  return [start, { x: start.x, y: goal.y }, goal];
}

function simplifyPath(points: PrPoint[]): PrPoint[] {
  if (points.length <= 2) return points.slice();
  const out: PrPoint[] = [points[0]];
  for (let i = 1; i + 1 < points.length; i += 1) {
    const a = out[out.length - 1];
    const b = points[i];
    const c = points[i + 1];
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) continue;
    out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

function pathHitsObstacles(path: PrPoint[], obstacles: PrBox[]): boolean {
  for (let i = 0; i + 1 < path.length; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    for (const o of obstacles) {
      if (segmentIntersectsBox(a, b, o)) return true;
    }
  }
  return false;
}

function directOrthPath(start: PrPoint, goal: PrPoint, obstacles: PrBox[], bounds: { x0: number; y0: number; x1: number; y1: number }): PrPoint[] | undefined {
  const sx = clamp(start.x, bounds.x0, bounds.x1);
  const sy = clamp(start.y, bounds.y0, bounds.y1);
  const gx = clamp(goal.x, bounds.x0, bounds.x1);
  const gy = clamp(goal.y, bounds.y0, bounds.y1);
  const cands: PrPoint[][] = [
    [{ x: sx, y: sy }, { x: gx, y: sy }, { x: gx, y: gy }],
    [{ x: sx, y: sy }, { x: sx, y: gy }, { x: gx, y: gy }],
    [{ x: sx, y: sy }, { x: Math.round((sx + gx) / 2), y: sy }, { x: Math.round((sx + gx) / 2), y: gy }, { x: gx, y: gy }],
    [{ x: sx, y: sy }, { x: sx, y: Math.round((sy + gy) / 2) }, { x: gx, y: Math.round((sy + gy) / 2) }, { x: gx, y: gy }],
  ];
  for (const p of cands) {
    const s = simplifyPath(p);
    if (!pathHitsObstacles(s, obstacles)) return s;
  }
  return undefined;
}

function labelPoint(path: PrPoint[]): PrPoint {
  if (path.length < 2) return path[0] ?? { x: 0, y: 0 };
  let total = 0;
  const segLen: number[] = [];
  for (let i = 0; i + 1 < path.length; i += 1) {
    const l = manhattan(path[i], path[i + 1]);
    segLen.push(l);
    total += l;
  }
  let target = total / 2;
  for (let i = 0; i < segLen.length; i += 1) {
    if (target <= segLen[i]) {
      const a = path[i];
      const b = path[i + 1];
      if (a.x === b.x) {
        const dir = b.y >= a.y ? 1 : -1;
        return { x: a.x, y: Math.round(a.y + dir * target) };
      }
      const dir = b.x >= a.x ? 1 : -1;
      return { x: Math.round(a.x + dir * target), y: a.y };
    }
    target -= segLen[i];
  }
  return path[Math.floor(path.length / 2)];
}

function routeEdges(nodes: PrNode[], edges: PrEdge[], boxes: Record<string, PrBox>, region: { x: number; y: number; w: number; h: number }): PrWire[] {
  const step = 16;
  const margin = 10;
  const routed: PrWire[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const obstacleBase = Object.values(boxes).map((b) => inflateBox(b, 8));
  const bounds = {
    x0: region.x + margin,
    y0: region.y + margin,
    x1: region.x + region.w - margin,
    y1: region.y + region.h - margin,
  };

  const sorted = edges.slice().sort((a, b) => b.weight - a.weight);
  for (const e of sorted) {
    const a = boxes[e.from];
    const b = boxes[e.to];
    if (!a || !b) continue;

    const ports = choosePorts(a, b);
    const pa = sidePoint(a, ports.aSide);
    const pb = sidePoint(b, ports.bSide);
    const paOut: PrPoint =
      ports.aSide === "left" ? { x: pa.x - step, y: pa.y } :
      ports.aSide === "right" ? { x: pa.x + step, y: pa.y } :
      ports.aSide === "top" ? { x: pa.x, y: pa.y - step } : { x: pa.x, y: pa.y + step };
    const pbIn: PrPoint =
      ports.bSide === "left" ? { x: pb.x - step, y: pb.y } :
      ports.bSide === "right" ? { x: pb.x + step, y: pb.y } :
      ports.bSide === "top" ? { x: pb.x, y: pb.y - step } : { x: pb.x, y: pb.y + step };

    const localObstacles = obstacleBase
      .filter((o) => !(o.x >= a.x - 20 && o.x <= a.x + a.w + 20 && o.y >= a.y - 20 && o.y <= a.y + a.h + 20))
      .filter((o) => !(o.x >= b.x - 20 && o.x <= b.x + b.w + 20 && o.y >= b.y - 20 && o.y <= b.y + b.h + 20));
    const hardObstacles = localObstacles;
    const direct = directOrthPath(paOut, pbIn, hardObstacles, bounds);

    const blocked = (x: number, y: number): boolean => blockedAt(x, y, hardObstacles);
    const core = direct ?? orthAStar(paOut, pbIn, blocked, bounds, step);
    const points = simplifyPath([pa, ...core, pb]);
    routed.push({ from: e.from, to: e.to, label: e.label, weight: e.weight, points, labelAt: labelPoint(points) });

  }

  // Local repair: penalize through-box segments by rerouting offending edges one-by-one.
  for (let ri = 0; ri < routed.length; ri += 1) {
    const w = routed[ri];
    const a = boxes[w.from];
    const b = boxes[w.to];
    if (!a || !b) continue;
    let bad = false;
    for (let i = 0; i + 1 < w.points.length; i += 1) {
      for (const n of nodes) {
        if (n.id === w.from || n.id === w.to) continue;
        if (segmentIntersectsBox(w.points[i], w.points[i + 1], boxes[n.id])) bad = true;
      }
    }
    if (!bad) continue;

    const ports = choosePorts(a, b);
    const pa = sidePoint(a, ports.aSide);
    const pb = sidePoint(b, ports.bSide);
    const paOut: PrPoint =
      ports.aSide === "left" ? { x: pa.x - step * 2, y: pa.y } :
      ports.aSide === "right" ? { x: pa.x + step * 2, y: pa.y } :
      ports.aSide === "top" ? { x: pa.x, y: pa.y - step * 2 } : { x: pa.x, y: pa.y + step * 2 };
    const pbIn: PrPoint =
      ports.bSide === "left" ? { x: pb.x - step * 2, y: pb.y } :
      ports.bSide === "right" ? { x: pb.x + step * 2, y: pb.y } :
      ports.bSide === "top" ? { x: pb.x, y: pb.y - step * 2 } : { x: pb.x, y: pb.y + step * 2 };

    const obstacleBase2 = Object.values(boxes).map((bx) => inflateBox(bx, 14));
    const blocked2 = (x: number, y: number) => {
      const os = obstacleBase2
        .filter((o) => !(x >= a.x - 16 && x <= a.x + a.w + 16 && y >= a.y - 16 && y <= a.y + a.h + 16))
        .filter((o) => !(x >= b.x - 16 && x <= b.x + b.w + 16 && y >= b.y - 16 && y <= b.y + b.h + 16));
      return blockedAt(x, y, os);
    };
    const rerouted = simplifyPath([pa, paOut, ...orthAStar(paOut, pbIn, blocked2, bounds, step), pb]);
    routed[ri] = { ...w, points: rerouted, labelAt: labelPoint(rerouted) };
  }
  void byId; // keep for future role-based routing extensions.
  return routed;
}

function placementCost(nodes: PrNode[], edges: PrEdge[], boxes: Record<string, PrBox>, region: { x: number; y: number; w: number; h: number }): number {
  let score = 0;
  const lines: PrPoint[][] = [];
  for (const e of edges) {
    const a = boxes[e.from];
    const b = boxes[e.to];
    if (!a || !b) continue;
    const ac = boxCenter(a);
    const bc = boxCenter(b);
    score += manhattan(ac, bc) * Math.max(1, e.weight);
    const mid: PrPoint[] = [
      sidePoint(a, choosePorts(a, b).aSide),
      { x: Math.round((ac.x + bc.x) / 2), y: Math.round(ac.y) },
      { x: Math.round((ac.x + bc.x) / 2), y: Math.round(bc.y) },
      sidePoint(b, choosePorts(a, b).bSide),
    ];
    lines.push(mid);
    for (let i = 0; i + 1 < mid.length; i += 1) {
      for (const n of nodes) {
        if (n.id === e.from || n.id === e.to) continue;
        if (segmentIntersectsBox(mid[i], mid[i + 1], boxes[n.id])) score += 1600;
      }
    }
  }
  score += crossingCount(lines) * 700;
  for (const n of nodes) {
    const b = boxes[n.id];
    const cx = (b.x - region.x + b.w / 2) / region.w;
    const cy = (b.y - region.y + b.h / 2) / region.h;
    const t = ROLE_TARGET[n.role];
    score += (Math.abs(cx - t.x) + Math.abs(cy - t.y)) * 240;
  }
  return score;
}

export function placeAndRoute(input: PlaceRouteInput): PlaceRouteResult {
  const { nodes, edges, region, estimateNodeSize } = input;
  const slots = makeSlots(region, nodes.length);
  const sizes = new Map(nodes.map((n) => [n.id, estimateNodeSize(n)]));
  let bestAsg = initialAssignment(nodes, slots, region);
  let bestBoxes = buildBoxes(nodes, slots, sizes, bestAsg);
  let bestCost = placementCost(nodes, edges, bestBoxes, region);

  let improved = true;
  let iter = 0;
  while (improved && iter < 55) {
    improved = false;
    iter += 1;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const cand = bestAsg.slice();
        const t = cand[i];
        cand[i] = cand[j];
        cand[j] = t;
        const boxes = buildBoxes(nodes, slots, sizes, cand);
        const cost = placementCost(nodes, edges, boxes, region);
        if (cost + 1e-6 < bestCost) {
          bestAsg = cand;
          bestBoxes = boxes;
          bestCost = cost;
          improved = true;
        }
      }
    }
  }

  const wires = routeEdges(nodes, edges, bestBoxes, region);
  return { boxes: bestBoxes, wires };
}
