import fs from "fs";

export type Node = {
  id: string;
  label?: string;
  attrs?: Record<string, string>;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  category?: string;
};

export type Edge = {
  id?: string;
  source: string;
  target: string;
  label?: string;
  attrs?: Record<string, string>;
  points?: { x: number; y: number }[];
};

export type Graph = {
  nodes: Node[];
  edges: Edge[];
};

export function die(msg: string): never {
  throw new Error(msg);
}

export function readText(path: string): string {
  return fs.readFileSync(path, "utf8");
}

export function writeText(path: string, data: string): void {
  fs.writeFileSync(path, data, "utf8");
}

export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
