// The exact cut: what a program's moves take out of the sheet, as true shapes
// (not a grid). A flat-bottom bit moving at one Z sweeps a band with round
// ends; the cuts at each depth are the union of those bands (Clipper offsets of
// the paths, round ends, arc tolerance 0.0002"). Moves that change Z as they go
// (ramps, tab ramps) are cut in thin slices. Then a mesh: the top face, each
// depth's floor, and straight walls between depths - true arcs, at any zoom.
//
// Needs ClipperLib as a global (the browser's vendor/clipper.js, or clipper-lib
// in Node). No three.js here: triangulate(contour, holes) is passed in.

const SCALE = 1e5;            // Clipper integer units per inch
const ARC_TOL = 0.0002;       // inch: how far a round end may be from a true arc
const SLICE = 0.01;           // inch: Z step for moves that change depth as they go (tab and pocket ramps)
const C = () => {
  const c = globalThis.ClipperLib;
  if (!c) throw new Error('ClipperLib not loaded');
  return c;
};
const toInt = (v) => Math.round(v * SCALE);

/**
 * Where each depth's cut is. moves: [{ a: [x,y,z], b: [x,y,z], r (bit radius) }]
 * (rapids above the top can be left in: anything not below the top is skipped).
 * opts: { zTop, floorZ, W, H }. Returns { levels: [{ z, paths }] } deepest
 * first, paths = Clipper paths of everything cut to z or deeper (within the sheet).
 */
export function cutLevels(moves, opts) {
  const L = C();
  const { zTop, floorZ, W, H } = opts;
  const top = zTop - 1e-4;
  // pieces: [ax, ay, bx, by, z, r]
  const byZ = new Map();
  const add = (ax, ay, bx, by, z, r) => {
    if (z >= top) return;
    const zz = Math.max(z, floorZ);
    const key = `${zz.toFixed(4)}|${r.toFixed(5)}`;
    if (!byZ.has(key)) byZ.set(key, { z: +zz.toFixed(4), r, pieces: [] });
    byZ.get(key).pieces.push([ax, ay, bx, by]);
  };
  for (const m of moves) {
    const [ax, ay, az] = m.a, [bx, by, bz] = m.b;
    if (Math.min(az, bz) >= top) continue;
    const dz = bz - az, lxy = Math.hypot(bx - ax, by - ay);
    if (Math.abs(dz) < 1e-6) { add(ax, ay, bx, by, az, m.r); continue; }
    if (lxy < 1e-6) { add(bx, by, bx, by, Math.min(az, bz), m.r); continue; }   // straight down (or up): a hole the bit's size
    // a ramp: thin slices, each at its deeper end's depth (to the nearest SLICE)
    const n = Math.max(1, Math.ceil(Math.abs(dz) / SLICE));
    for (let k = 0; k < n; k++) {
      const t0 = k / n, t1 = (k + 1) / n;
      const z = Math.min(az + dz * t0, az + dz * t1);
      const zq = Math.round(z / SLICE) * SLICE;
      add(ax + (bx - ax) * t0, ay + (by - ay) * t0, ax + (bx - ax) * t1, ay + (by - ay) * t1, Math.max(zq, z - SLICE / 2), m.r);
    }
  }
  // per depth: join pieces end to end into paths, offset them with round ends
  const sweeps = new Map();   // z -> Paths
  for (const g of byZ.values()) {
    const paths = [];
    let cur = null;
    for (const [ax, ay, bx, by] of g.pieces) {
      const A = { X: toInt(ax), Y: toInt(ay) }, B = { X: toInt(bx), Y: toInt(by) };
      if (cur && cur[cur.length - 1].X === A.X && cur[cur.length - 1].Y === A.Y) { if (B.X !== A.X || B.Y !== A.Y) cur.push(B); }
      else { cur = [A]; if (B.X !== A.X || B.Y !== A.Y) cur.push(B); paths.push(cur); }
    }
    // a single point (a plunge): a tiny stroke, so the offset is the bit's circle
    for (const p of paths) if (p.length === 1) p.push({ X: p[0].X + 1, Y: p[0].Y });
    const co = new L.ClipperOffset(2, ARC_TOL * SCALE);
    co.AddPaths(paths, L.JoinType.jtRound, L.EndType.etOpenRound);
    const out = new L.Paths();
    co.Execute(out, g.r * SCALE);
    if (!sweeps.has(g.z)) sweeps.set(g.z, []);
    sweeps.get(g.z).push(...out);
  }
  // deepest first: each level is everything cut to that depth or deeper
  const sheet = [[{ X: 0, Y: 0 }, { X: toInt(W), Y: 0 }, { X: toInt(W), Y: toInt(H) }, { X: 0, Y: toInt(H) }]];
  const zs = [...sweeps.keys()].sort((p, q) => p - q);
  const levels = [];
  let acc = [];
  for (const z of zs) {
    const c = new L.Clipper();
    c.AddPaths(acc, L.PolyType.ptSubject, true);
    c.AddPaths(sweeps.get(z), L.PolyType.ptSubject, true);
    const u = new L.Paths();
    c.Execute(L.ClipType.ctUnion, u, L.PolyFillType.pftNonZero, L.PolyFillType.pftNonZero);
    acc = u;
    const ci = new L.Clipper();
    ci.AddPaths(acc, L.PolyType.ptSubject, true);
    ci.AddPaths(sheet, L.PolyType.ptClip, true);
    const inSheet = new L.Paths();
    ci.Execute(L.ClipType.ctIntersection, inSheet, L.PolyFillType.pftNonZero, L.PolyFillType.pftNonZero);
    levels.push({ z, paths: inSheet });
  }
  return { levels, sheet };
}

// a region (paths) as polygons with their holes, in inches: [{ outer, holes }]
function exPolys(subject, clip, type) {
  const L = C();
  const c = new L.Clipper();
  c.AddPaths(subject, L.PolyType.ptSubject, true);
  if (clip) c.AddPaths(clip, L.PolyType.ptClip, true);
  const tree = new L.PolyTree();
  c.Execute(type ?? L.ClipType.ctUnion, tree, L.PolyFillType.pftNonZero, L.PolyFillType.pftNonZero);
  const ex = L.JS.PolyTreeToExPolygons(tree);
  const pts = (p) => p.map((q) => [q.X / SCALE, q.Y / SCALE]);
  return ex.map((e) => ({ outer: pts(e.outer), holes: e.holes.map(pts) }));
}

/**
 * The mesh of the cut sheet: non-indexed triangles. Returns { position, normal,
 * kind } (Float32Arrays; kind per vertex: 0 top face, 1 wall, 2 floor) and the
 * levels (z and area cut to that depth, sq in).
 * opts: { zTop, floorZ, W, H, triangulate(contour, holes) -> [[i, j, k], ...] }
 * (contour, holes: [x, y] points; indices count through the contour, then each hole)
 */
export function cutMesh(moves, opts) {
  const L = C();
  const { zTop, floorZ, triangulate } = opts;
  const { levels, sheet } = cutLevels(moves, opts);
  const P = [], N = [], K = [];
  const face = (polys, z, kind) => {
    for (const { outer, holes } of polys) {
      if (outer.length < 3) continue;
      const tris = triangulate(outer, holes);
      const all = [outer, ...holes].flat();
      for (const t of tris) for (const i of t) { const q = all[i]; P.push(q[0], q[1], z); N.push(0, 0, 1); K.push(kind); }
    }
  };
  // the top: the sheet less the shallowest cut
  const shallow = levels.length ? levels[levels.length - 1].paths : [];
  face(exPolys(sheet, shallow, L.ClipType.ctDifference), zTop, 0);
  // floors and walls, shallowest first. A wall edge that's the same at several
  // depths (a straight wall down through stepdowns or ramp slices) is one tall
  // wall: open walls carry on down while the next depth still has the edge.
  let open = new Map();   // edge key -> { a, b, na, nb, top, bottom }
  const emit = (w) => {
    const quad = [[w.a, w.top, w.na], [w.b, w.bottom, w.nb], [w.a, w.bottom, w.na], [w.a, w.top, w.na], [w.b, w.top, w.nb], [w.b, w.bottom, w.nb]];
    for (const [p, z, nn] of quad) { P.push(p[0], p[1], z); N.push(nn[0], nn[1], 0); K.push(1); }
  };
  for (let i = levels.length - 1; i >= 0; i--) {
    const lv = levels[i];
    const deeper = i > 0 ? levels[i - 1].paths : null;
    // floor at this depth: cut to here but not deeper (a cut right through shows the table)
    if (lv.z > floorZ + 1e-5) face(exPolys(lv.paths, deeper, deeper ? L.ClipType.ctDifference : L.ClipType.ctUnion), lv.z, 2);
    // walls round this depth's cut, from the depth above (or the top) down to it
    const zUp = i < levels.length - 1 ? levels[i + 1].z : zTop;
    const next = new Map();
    for (const path of lv.paths) {
      const n = path.length;
      if (n < 3) continue;
      const pts = path.map((q) => [q.X / SCALE, q.Y / SCALE]);
      // edge normals: Clipper winds outers CCW and holes CW, so the cut is always
      // on the left; the wall faces into the cut
      const en = [];
      for (let k = 0; k < n; k++) {
        const a = pts[k], b = pts[(k + 1) % n];
        const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
        en.push([-dy / l, dx / l]);
      }
      // smooth across gentle bends (an arc), sharp at real corners (over about 20 degrees)
      const blend = (u, v) => {
        if (u[0] * v[0] + u[1] * v[1] < 0.94) return v;
        const sx = u[0] + v[0], sy = u[1] + v[1], l = Math.hypot(sx, sy) || 1;
        return [sx / l, sy / l];
      };
      for (let k = 0; k < n; k++) {
        const key = `${path[k].X},${path[k].Y},${path[(k + 1) % n].X},${path[(k + 1) % n].Y}`;
        const w = open.get(key);
        if (w) { open.delete(key); w.bottom = lv.z; next.set(key, w); continue; }
        next.set(key, { a: pts[k], b: pts[(k + 1) % n], na: blend(en[(k - 1 + n) % n], en[k]), nb: blend(en[(k + 1) % n], en[k]), top: zUp, bottom: lv.z });
      }
    }
    for (const w of open.values()) emit(w);   // these stop at the depth above
    open = next;
  }
  for (const w of open.values()) emit(w);
  const areaOf = (paths) => paths.reduce((s, p) => s + L.Clipper.Area(p), 0) / (SCALE * SCALE);
  return {
    position: new Float32Array(P), normal: new Float32Array(N), kind: new Float32Array(K),
    levels: levels.map((lv) => ({ z: lv.z, area: areaOf(lv.paths) })),
  };
}
