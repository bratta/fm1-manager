// The 32 DX7 algorithms: which operator modulates which, which ones are heard
// (carriers), and where the feedback loop is. Operators are numbered 1-6.
// Every modulator has a higher number than the operator it modulates.

export interface Algorithm {
  /** [modulator, target] pairs */
  edges: [number, number][];
  carriers: number[];
  /** [from, to]: the output of `from` is fed back into `to` (usually the same operator) */
  feedback: [number, number];
}

const e = (spec: string): [number, number][] =>
  spec.split(" ").filter(Boolean).map((p) => p.split(">").map(Number) as [number, number]);

const A = (edges: string, carriers: number[], fb: number | [number, number]): Algorithm => ({
  edges: e(edges),
  carriers,
  feedback: typeof fb === "number" ? [fb, fb] : fb,
});

export const ALGORITHMS: Algorithm[] = [
  A("2>1 6>5 5>4 4>3", [1, 3], 6), // 1
  A("2>1 6>5 5>4 4>3", [1, 3], 2),
  A("3>2 2>1 6>5 5>4", [1, 4], 6),
  A("3>2 2>1 6>5 5>4", [1, 4], [4, 6]),
  A("2>1 4>3 6>5", [1, 3, 5], 6), // 5
  A("2>1 4>3 6>5", [1, 3, 5], [5, 6]),
  A("2>1 4>3 5>3 6>5", [1, 3], 6),
  A("2>1 4>3 5>3 6>5", [1, 3], 4),
  A("2>1 4>3 5>3 6>5", [1, 3], 2),
  A("3>2 2>1 5>4 6>4", [1, 4], 3), // 10
  A("3>2 2>1 5>4 6>4", [1, 4], 6),
  A("2>1 4>3 5>3 6>3", [1, 3], 2),
  A("2>1 4>3 5>3 6>3", [1, 3], 6),
  A("2>1 4>3 5>4 6>4", [1, 3], 6),
  A("2>1 4>3 5>4 6>4", [1, 3], 2), // 15
  A("2>1 3>1 4>3 5>1 6>5", [1], 6),
  A("2>1 3>1 4>3 5>1 6>5", [1], 2),
  A("2>1 3>1 4>1 5>4 6>5", [1], 3),
  A("3>2 2>1 6>4 6>5", [1, 4, 5], 6),
  A("3>1 3>2 5>4 6>4", [1, 2, 4], 3), // 20
  A("3>1 3>2 6>4 6>5", [1, 2, 4, 5], 3),
  A("2>1 6>3 6>4 6>5", [1, 3, 4, 5], 6),
  A("3>2 6>4 6>5", [1, 2, 4, 5], 6),
  A("6>3 6>4 6>5", [1, 2, 3, 4, 5], 6),
  A("6>4 6>5", [1, 2, 3, 4, 5], 6), // 25
  A("3>2 5>4 6>4", [1, 2, 4], 6),
  A("3>2 5>4 6>4", [1, 2, 4], 3),
  A("2>1 4>3 5>4", [1, 3, 6], 5),
  A("4>3 6>5", [1, 2, 3, 5], 6),
  A("4>3 5>4", [1, 2, 3, 6], 5), // 30
  A("6>5", [1, 2, 3, 4, 5], 6),
  A("", [1, 2, 3, 4, 5, 6], 6),
];

export const algorithm = (n: number): Algorithm => ALGORITHMS[Math.max(1, Math.min(32, n)) - 1]!;

/** Operators that `op` is modulated by. */
export const modulatorsOf = (alg: Algorithm, op: number) => alg.edges.filter(([, t]) => t === op).map(([m]) => m);
/** Operators that `op` modulates. */
export const targetsOf = (alg: Algorithm, op: number) => alg.edges.filter(([m]) => m === op).map(([, t]) => t);

/** "Carrier" or "Modulates 2 and 3", for labels. */
export function roleOf(alg: Algorithm, op: number): string {
  if (alg.carriers.includes(op)) return "Carrier";
  const t = targetsOf(alg, op);
  return `Modulates ${t.length > 1 ? `${t.slice(0, -1).join(", ")} and ${t.at(-1)}` : t[0]}`;
}

// ------------------------------------------------------------------- layout

export interface Placed {
  op: number;
  /** column, in operator widths; may be fractional */
  x: number;
  /** row counted up from the carriers (0) */
  y: number;
}

/**
 * Lay out an algorithm like the chart printed on a DX7: carriers in a row
 * at the bottom in operator order, each one's modulators stacked above it.
 * An operator that modulates several carriers sits centred over them.
 */
export function layout(alg: Algorithm): { placed: Placed[]; width: number; height: number } {
  const shared = new Set([1, 2, 3, 4, 5, 6].filter((op) => targetsOf(alg, op).length > 1));
  const children = (op: number) => modulatorsOf(alg, op).filter((m) => !shared.has(m));
  const widthOf = (op: number): number => Math.max(1, children(op).reduce((n, c) => n + widthOf(c), 0));

  const pos = new Map<number, Placed>();
  const place = (op: number, left: number, y: number) => {
    const w = widthOf(op);
    pos.set(op, { op, x: left + w / 2 - 0.5, y });
    let cursor = left;
    for (const c of children(op).sort((a, b) => a - b)) {
      place(c, cursor, y + 1);
      cursor += widthOf(c);
    }
  };

  let left = 0;
  for (const c of alg.carriers) {
    place(c, left, 0);
    left += widthOf(c);
  }
  for (const op of shared) {
    const ts = targetsOf(alg, op).map((t) => pos.get(t)!);
    pos.set(op, { op, x: ts.reduce((s, p) => s + p.x, 0) / ts.length, y: Math.max(...ts.map((p) => p.y)) + 1 });
  }
  const placed = [...pos.values()].sort((a, b) => a.op - b.op);
  return { placed, width: left, height: Math.max(...placed.map((p) => p.y)) + 1 };
}
