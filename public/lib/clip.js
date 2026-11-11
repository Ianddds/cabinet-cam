// Thin wrapper around Clipper (public/lib/vendor/clipper.js, loaded as a global
// ClipperLib) for robust polygon offsets and booleans. Units are inches.
const SCALE = 1e5;
const C = () => {
  const c = globalThis.ClipperLib;
  if (!c) throw new Error('ClipperLib not loaded');
  return c;
};

const toPaths = (loops) => loops.map((l) => l.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
const fromPaths = (paths) => paths.filter((p) => p.length >= 3).map((p) => p.map((q) => [q.X / SCALE, q.Y / SCALE]));

// Offset (positive grows). join: 'round' | 'miter' | 'square'
export function offset(loops, delta, join = 'round') {
  const L = C();
  const co = new L.ClipperOffset(2, 0.0005 * SCALE);
  const jt = join === 'miter' ? L.JoinType.jtMiter : join === 'square' ? L.JoinType.jtSquare : L.JoinType.jtRound;
  co.AddPaths(toPaths(loops), jt, L.EndType.etClosedPolygon);
  const out = new L.Paths();
  co.Execute(out, delta * SCALE);
  return fromPaths(out);
}

function boolOp(a, b, type, fill = 'evenodd') {
  const L = C();
  const c = new L.Clipper();
  c.AddPaths(toPaths(a), L.PolyType.ptSubject, true);
  c.AddPaths(toPaths(b), L.PolyType.ptClip, true);
  const out = new L.Paths();
  const ft = fill === 'nonzero' ? L.PolyFillType.pftNonZero : L.PolyFillType.pftEvenOdd;
  c.Execute(type(L), out, ft, ft);
  return fromPaths(out);
}
// fill 'nonzero' merges overlapping loops; 'evenodd' treats nested loops as holes
export const union = (a, b, fill) => boolOp(a, b, (L) => L.ClipType.ctUnion, fill);
export const intersect = (a, b) => boolOp(a, b, (L) => L.ClipType.ctIntersection);
export const difference = (a, b) => boolOp(a, b, (L) => L.ClipType.ctDifference);

// Even-odd point test over a set of loops (outer + holes).
export function inRegion([x, y], loops) {
  let inside = false;
  for (const poly of loops) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export const area = (loops) => {
  let a = 0;
  for (const l of loops) {
    let s = 0;
    for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; s += p[0] * q[1] - q[0] * p[1]; }
    a += s / 2;
  }
  return Math.abs(a);
};
