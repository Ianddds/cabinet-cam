// Toolpaths for one nested sheet: dado/rabbet pockets first, then profiles
// (holes before outlines, smallest parts first), with optional onion skin.
// Z is relative to the material top (0 = top, negative = into the material);
// the post-processor shifts it if the machine is zeroed on the table.
import { placedGeometry } from './nest.js';
import { ensureCCW, ensureCW, bbox, signedArea } from './geometry.js';
import { offset, union, intersect, difference, inRegion, area } from './clip.js';
import { usesSkin, usesTabs } from './settings.js';
import { machineTime } from './machine.js';

function levels(target, step) {
  const out = [];
  const n = Math.max(1, Math.ceil(target / step - 1e-6));
  for (let i = 1; i <= n; i++) out.push(-Math.min(target, (target * i) / n));
  return out;
}

class PathBuilder {
  constructor(safeZ) {
    this.moves = [];
    this.safeZ = safeZ;
    this.z = safeZ;
    this.x = null; this.y = null;
  }
  // low: a move within one part, before it is cut free, only clears the
  // material top by hopZ instead of going up to safe Z (nothing to hit there)
  rapidTo(x, y, low = false) {
    if (low && this.x != null) {
      const hz = Math.min(this.hopZ ?? 0.1, this.safeZ);
      if (this.z !== hz) this.rapidZ(hz);
      this.moves.push({ g: 0, x, y, z: hz });
      this.x = x; this.y = y;
      return;
    }
    if (this.z < this.safeZ) this.retract();
    this.moves.push({ g: 0, x, y, z: this.safeZ });
    this.x = x; this.y = y;
  }
  retract() {
    this.moves.push({ g: 0, x: this.x, y: this.y, z: this.safeZ });
    this.z = this.safeZ;
  }
  // Plunge with the loaded tool: entry ipm down to the entry depth, then plunge/drill ipm.
  plunge(z) {
    const t = this.tool || {};
    const df = t.drillFeed || t.plunge || 30;
    const ef = t.entryFeed || df;
    const ez = -(t.entryDepth || 0);
    const push = (zz, f) => { this.moves.push({ g: 1, x: this.x, y: this.y, z: zz, f, plunge: true, op: this.op }); this.z = zz; };
    if (this.z > ez + 1e-9 && z < ez - 1e-9) {
      push(ez, ef);
      push(z, df);
    } else {
      push(z, this.z > ez + 1e-9 ? ef : df);
    }
  }
  feed(x, y, f) {
    this.moves.push({ g: 1, x, y, z: this.z, f, op: this.op });
    this.x = x; this.y = y;
  }
  // feed in X, Y and Z together (a ramp)
  feed3(x, y, z, f, extra) {
    this.moves.push({ g: 1, x, y, z, f, op: this.op, ...extra });
    this.x = x; this.y = y; this.z = z;
  }
  // Go to (x,y,z): rapid when up, otherwise feed at depth if already there.
  startAt(x, y, z, low = false) {
    const here = this.x !== null && Math.abs(this.x - x) < 1e-6 && Math.abs(this.y - y) < 1e-6;
    if (!here) this.rapidTo(x, y, low);
    else if (this.z < z - 1e-9) this.rapidZ(z); // already in the cut but deeper than this op wants
    if (this.z > 0.05) this.rapidZ(0.05); // rapid down to just above the surface
    if (z < this.z) this.plunge(z);
  }
  // Short move inside one pocket: lift just clear of the material top, move
  // over at that height, plunge. Never drags the tool sideways through stock.
  hopTo(x, y, z) {
    const clear = 0.05;
    if (this.x == null) { this.startAt(x, y, z); return; }
    if (this.z < clear) this.rapidZ(clear);
    this.moves.push({ g: 0, x, y, z: this.z });
    this.x = x; this.y = y;
    if (z < this.z) this.plunge(z);
  }
  toolchange(tool, note) {
    if (this.z < this.safeZ) this.retract();
    this.moves.push({ toolchange: true, tool, note });
    this.tool = tool;
  }
  // feed straight up (over a tab)
  lift(z, f) {
    this.moves.push({ g: 1, x: this.x, y: this.y, z, f, op: this.op });
    this.z = z;
  }
  rapidZ(z) {
    this.moves.push({ g: 0, x: this.x, y: this.y, z });
    this.z = z;
  }
  comment(text) { this.moves.push({ comment: text }); }
  // stop for the operator: spindle off, wait for continue (posts: M5 + M0 / C7 + PAUSE)
  pause(note) {
    if (this.z < this.safeZ) this.retract();
    this.moves.push({ pause: true, note });
  }
}

// A sampled loop that is a circle -> { cx, cy, d }, else null.
function asCircle(loop) {
  if (loop.length < 8) return null;
  const b = bbox(loop);
  if (Math.abs(b.w - b.h) > 0.004) return null;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, r = (b.w + b.h) / 4;
  for (const [x, y] of loop) if (Math.abs(Math.hypot(x - cx, y - cy) - r) > 0.003) return null;
  return { cx, cy, d: 2 * r };
}
const DRILL_TOL = 0.006; // inch

const distToSeg = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
// inside the region, or on its boundary (within tol)
function inOrOn(p, loops, tol = 2e-3) {
  if (inRegion(p, loops)) return true;
  for (const l of loops) for (let k = 0; k < l.length; k++) if (distToSeg(p, l[k], l[(k + 1) % l.length]) < tol) return true;
  return false;
}

// Break an axis-aligned floor into legs: each grid cell joins the direction in
// which the floor runs longest through it, and cells are merged into strips.
// Returns [{ x0, y0, x1, y1, alongX }] or null if an edge isn't axis-aligned.
export function legsOf(floor, eps = 1e-4) {
  for (const l of floor) {
    for (let i = 0; i < l.length; i++) {
      const a = l[i], b = l[(i + 1) % l.length];
      if (Math.abs(a[0] - b[0]) > eps && Math.abs(a[1] - b[1]) > eps) return null;
    }
  }
  const uniq = (v) => v.sort((a, b) => a - b).filter((x, i, arr) => i === 0 || x - arr[i - 1] > eps);
  const xs = uniq(floor.flat().map((p) => p[0]));
  const ys = uniq(floor.flat().map((p) => p[1]));
  const nx = xs.length - 1, ny = ys.length - 1;
  const inF = [];
  for (let i = 0; i < nx; i++) {
    inF.push([]);
    for (let j = 0; j < ny; j++) inF[i].push(inRegion([(xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2], floor));
  }
  // run length through each cell, horizontally and vertically
  const orient = inF.map((col) => col.map(() => null));
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    if (!inF[i][j]) continue;
    let a = i, b = i;
    while (a > 0 && inF[a - 1][j]) a--;
    while (b < nx - 1 && inF[b + 1][j]) b++;
    let c = j, d = j;
    while (c > 0 && inF[i][c - 1]) c--;
    while (d < ny - 1 && inF[i][d + 1]) d++;
    orient[i][j] = xs[b + 1] - xs[a] >= ys[d + 1] - ys[c] ? 'H' : 'V';
  }
  const legs = [];
  // horizontal strips, then stack strips with identical x extents
  const hs = [];
  for (let j = 0; j < ny; j++) {
    let start = null;
    for (let i = 0; i <= nx; i++) {
      const on = i < nx && orient[i][j] === 'H';
      if (on && start === null) start = i;
      if (!on && start !== null) { hs.push({ x0: xs[start], x1: xs[i], y0: ys[j], y1: ys[j + 1] }); start = null; }
    }
  }
  for (const r of hs) {
    const m = legs.find((L) => L.alongX && Math.abs(L.x0 - r.x0) < eps && Math.abs(L.x1 - r.x1) < eps && Math.abs(L.y1 - r.y0) < eps);
    if (m) m.y1 = r.y1; else legs.push({ ...r, alongX: true });
  }
  // vertical strips, then place strips side by side with identical y extents
  const vs = [];
  for (let i = 0; i < nx; i++) {
    let start = null;
    for (let j = 0; j <= ny; j++) {
      const on = j < ny && orient[i][j] === 'V';
      if (on && start === null) start = j;
      if (!on && start !== null) { vs.push({ x0: xs[i], x1: xs[i + 1], y0: ys[start], y1: ys[j] }); start = null; }
    }
  }
  for (const r of vs) {
    const m = legs.find((L) => !L.alongX && Math.abs(L.y0 - r.y0) < eps && Math.abs(L.y1 - r.y1) < eps && Math.abs(L.x1 - r.x0) < eps);
    if (m) m.x1 = r.x1; else legs.push({ ...r, alongX: false });
  }
  return legs;
}

// Split round lobes (corner reliefs) off a pocket floor. A run of 2+ edges that
// aren't axis-aligned and whose chord is axis-aligned is treated as a circular
// lobe: it's replaced by its chord in the core, and returned as { c, r }.
// Anything else (real arcs) is left alone.
export function splitLobes(loops, eps = 1e-4) {
  const axis = (a, b) => Math.abs(a[0] - b[0]) < eps || Math.abs(a[1] - b[1]) < eps;
  const lobes = [];
  const core = loops.map((loop) => {
    const n = loop.length;
    let s0 = -1;
    for (let i = 0; i < n; i++) if (axis(loop[i], loop[(i + 1) % n])) { s0 = i; break; }
    if (s0 < 0) return loop;
    const L = loop.slice(s0 + 1).concat(loop.slice(0, s0 + 1)); // L[0] starts after an axis edge
    const out = [];
    let i = 0;
    while (i < n) {
      const p = L[i], q = L[(i + 1) % n];
      if (axis(p, q)) { out.push(p); i++; continue; }
      let k = i;
      while (k < n && !axis(L[k], L[(k + 1) % n])) k++;
      const run = L.slice(i, k + 1).concat(k + 1 > n ? [L[0]] : []);
      const first = run[0], last = run[run.length - 1];
      // overlapping reliefs merge into one run: split it at the cusps (sharp turns)
      const pieces = [];
      let st = 0;
      for (let m = 1; m < run.length - 1; m++) {
        const ax = run[m][0] - run[m - 1][0], ay = run[m][1] - run[m - 1][1];
        const bx = run[m + 1][0] - run[m][0], by = run[m + 1][1] - run[m][1];
        const cos = (ax * bx + ay * by) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1);
        if (cos < 0.5) { pieces.push(run.slice(st, m + 1)); st = m; }   // > 60 degree turn
      }
      pieces.push(run.slice(st));
      const fits = pieces.map((pc) => {
        if (pc.length < 3) return null;
        const c = circumcentre(pc[0], pc[Math.floor(pc.length / 2)], pc[pc.length - 1]);
        if (!c) return null;
        const r = Math.hypot(pc[0][0] - c[0], pc[0][1] - c[1]);
        const m = pc[Math.floor(pc.length / 2)], ol = Math.hypot(m[0] - c[0], m[1] - c[1]) || 1;
        // a, b: the chord ends; out: the way the relief bulges (away from the dado)
        return { c, r, a: pc[0], b: pc[pc.length - 1], out: [(m[0] - c[0]) / ol, (m[1] - c[1]) / ol] };
      });
      if (axis(first, last) && fits.every((f) => f)) {
        lobes.push(...fits);
        out.push(first);           // chord replaces the arc(s)
      } else {
        for (let m = i; m < k; m++) out.push(L[m]);
      }
      i = k;
    }
    return out;
  });
  return { core, lobes };
}

// Is p a vertex of the loops where the boundary actually turns (not a point
// along a straight run)?
function isCornerOf(p, loops, tol = 1e-3) {
  for (const l of loops) {
    for (let i = 0; i < l.length; i++) {
      if (Math.hypot(l[i][0] - p[0], l[i][1] - p[1]) > tol) continue;
      const a = l[(i - 1 + l.length) % l.length], b = l[(i + 1) % l.length];
      const ux = p[0] - a[0], uy = p[1] - a[1], vx = b[0] - p[0], vy = b[1] - p[1];
      const s = (ux * vy - uy * vx) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1);
      return Math.abs(s) > 0.5;
    }
  }
  return false;
}

function circumcentre(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
          (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

// Legs from the dado walls Cabinet build tagged ({ cut, seg }). Each cut's
// walls give its direction and the band between them (one wall = a rabbet: the
// band runs from the wall across the floor on its side); the leg runs as far
// along that band as the floor does. Longest first; each leg gives up the
// squares an earlier leg already covers (leg.clip). Returns null if the walls
// don't explain the whole floor (then the shape decides, as before).
export function legsFromWalls(core, walls) {
  const eps = 1e-3;
  const fb = bbox(core.flat());
  const BIG = 1 + Math.max(fb.w, fb.h);
  const byCut = new Map();
  for (const wl of walls) {
    const [a, b] = wl.seg;
    const alongX = Math.abs(b[1] - a[1]) < eps && Math.abs(b[0] - a[0]) > eps;
    const alongY = Math.abs(b[0] - a[0]) < eps && Math.abs(b[1] - a[1]) > eps;
    if (!alongX && !alongY) continue;            // not square to the part: skip that wall
    const at = alongX ? a[1] : a[0];             // across-coordinate of the wall
    const lo = alongX ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]);
    const hi = alongX ? Math.max(a[0], b[0]) : Math.max(a[1], b[1]);
    const k = wl.cut;
    if (!byCut.has(k)) byCut.set(k, []);
    byCut.get(k).push({ alongX, at, lo, hi });
  }
  const rect = (alongX, a0, a1, c0, c1) => alongX
    ? [[a0, c0], [a1, c0], [a1, c1], [a0, c1]]
    : [[c0, a0], [c0, a1], [c1, a1], [c1, a0]];
  const legs = [];
  for (const ws of byCut.values()) {
    const alongX = ws[0].alongX;
    if (ws.some((w) => w.alongX !== alongX)) continue;
    const ats = ws.map((w) => w.at);
    let c0 = Math.min(...ats), c1 = Math.max(...ats);
    const lo = Math.min(...ws.map((w) => w.lo)), hi = Math.max(...ws.map((w) => w.hi));
    if (c1 - c0 < eps) {
      // one wall (rabbet): the floor is on one side of it; go across to the floor's edge
      const mid = (lo + hi) / 2;
      const probe = (d) => inRegion(alongX ? [mid, c0 + d] : [c0 + d, mid], core);
      const dir = probe(0.01) ? 1 : probe(-0.01) ? -1 : 0;
      if (!dir) continue;
      const strip = intersect(core, [rect(alongX, lo, hi, c0, c0 + dir * BIG)]);
      if (!strip.length) continue;
      const sb = bbox(strip.flat());
      const far = alongX ? (dir > 0 ? sb.y1 : sb.y0) : (dir > 0 ? sb.x1 : sb.x0);
      c0 = Math.min(c0, far); c1 = Math.max(c1, far);
    }
    // run along the band as far as the floor goes (past reliefs that shortened the walls)
    const band = intersect(core, [rect(alongX, (alongX ? fb.x0 : fb.y0) - 1, (alongX ? fb.x1 : fb.y1) + 1, c0 + eps, c1 - eps)]);
    const mine = band.filter((l) => {
      const lb = bbox(l);
      const l0 = alongX ? lb.x0 : lb.y0, l1 = alongX ? lb.x1 : lb.y1;
      return l1 >= lo - eps && l0 <= hi + eps;   // the piece the walls belong to
    });
    if (!mine.length) continue;
    const mb = bbox(mine.flat());
    const a0 = alongX ? mb.x0 : mb.y0, a1 = alongX ? mb.x1 : mb.y1;
    legs.push(alongX ? { x0: a0, y0: c0, x1: a1, y1: c1, alongX, len: a1 - a0 }
                     : { x0: c0, y0: a0, x1: c1, y1: a1, alongX, len: a1 - a0 });
  }
  if (!legs.length) return null;
  legs.sort((p, q) => q.len - p.len);
  const box = (lg) => [[lg.x0, lg.y0], [lg.x1, lg.y0], [lg.x1, lg.y1], [lg.x0, lg.y1]];
  // every bit of floor must belong to some leg, or the records are incomplete
  const left = difference(core, union(legs.map(box), [], 'nonzero')).filter((l) => area([l]) > 1e-3);
  if (left.length) return null;
  legs.forEach((lg, i) => { if (i) lg.clip = union(legs.slice(0, i).map(box), [], 'nonzero'); });
  return legs;
}

// Zig-zag rows over a region; returns chains (polylines), one plunge each.
// range: [lo, hi] tool-centre limits across the rows (wall to wall of the leg);
// default = the region's extent.
function planRows(allowed, alongX, step, link = true, range = null, dropEnds = false) {
  const sw = (pts) => (alongX ? pts : pts.map(([x, y]) => [y, x]));
  const A = allowed.map(sw);
  const ab = bbox(A.flat());
  const eps = 1e-4;
  const lo0 = range ? Math.max(range[0], ab.y0) : ab.y0;
  const hi0 = range ? Math.min(range[1], ab.y1) : ab.y1;
  const span = Math.max(0, hi0 - lo0 - 2 * eps);
  const n = span < 1e-6 ? 1 : Math.ceil(span / step - 1e-9) + 1;
  const rows = [];
  for (let i = 0; i < n; i++) {
    // dropEnds: the outermost rows run on the region's edge, where a wall lap goes anyway
    if (dropEnds && n > 1 && (i === 0 || i === n - 1)) continue;
    const y = n === 1 ? (lo0 + hi0) / 2 : lo0 + eps + (span * i) / (n - 1);
    const xs = [];
    for (const l of A) {
      for (let k = 0; k < l.length; k++) {
        const [x1, y1] = l[k], [x2, y2] = l[(k + 1) % l.length];
        if ((y1 - y) * (y2 - y) < 0) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    xs.sort((p, q) => p - q);
    const segs = [];
    for (let k = 0; k + 1 < xs.length; k += 2) segs.push({ y, a: xs[k], b: xs[k + 1], used: false });
    rows.push(segs);
  }
  const safe = (p, q) => {
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const nS = Math.max(4, Math.ceil(L / 0.02));
    for (let k = 1; k < nS; k++) {
      const t = k / nS;
      if (!inOrOn([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t], A)) return false;
    }
    return true;
  };
  const chains = [];
  for (let i = 0; i < rows.length; i++) {
    for (const seg of rows[i]) {
      if (seg.used) continue;
      seg.used = true;
      const pts = [[seg.a, seg.y], [seg.b, seg.y]];
      for (let j = i + 1; link && j < rows.length; j++) {
        const end = pts[pts.length - 1];
        const near = (c) => Math.min(Math.abs(c.a - end[0]), Math.abs(c.b - end[0]));
        let linked = false;
        for (const c of rows[j].filter((c) => !c.used).sort((p, q) => near(p) - near(q))) {
          const nearB = Math.abs(c.b - end[0]) <= Math.abs(c.a - end[0]);
          const s0 = nearB ? [c.b, c.y] : [c.a, c.y];
          const s1 = nearB ? [c.a, c.y] : [c.b, c.y];
          if (safe(end, s0)) { c.used = true; pts.push(s0, s1); linked = true; break; }
        }
        if (!linked) break;
      }
      chains.push(sw(pts));
    }
  }
  return chains;
}


// ---- inside-out spiral for pockets with a closed end ----
// Rings: the tool-centre region's boundary (the wall lap) and its inward offsets
// a stepover apart, then 0.9 r apart until nothing is left, so the middle is
// always reached. The cut starts on the innermost ring and morphs out one ring
// per revolution (each point slides from the inner ring toward the outer one as
// it goes round, so there's no stepover move), then finishes with one full lap
// of the walls, dipping into the corner reliefs on the way. Every wall and
// end is finished by that one lap: no row ends against a wall, so no bumps.

// loop starting exactly at its nearest point to pos
function loopFrom(loop, pos) {
  const n = nearestOnLoop(loop, pos);
  const a = loop[n.i], b = loop[(n.i + 1) % loop.length];
  if (dist(n.p, a) < 1e-6) return loop.slice(n.i).concat(loop.slice(0, n.i));
  if (dist(n.p, b) < 1e-6) { const k = (n.i + 1) % loop.length; return loop.slice(k).concat(loop.slice(0, k)); }
  return [n.p, ...loop.slice(n.i + 1), ...loop.slice(0, n.i + 1)];
}
const perimeter = (loop) => loop.reduce((a, p, i) => a + dist(p, loop[(i + 1) % loop.length]), 0);
// point at normalised arc length u (0..1) on a closed loop that starts at loop[0]
function atU(loop, cum, total, u) {
  const t = u * total;
  let i = 0;
  while (i < loop.length - 1 && cum[i + 1] < t) i++;
  const a = loop[i], b = loop[(i + 1) % loop.length];
  const L = cum[i + 1] - cum[i] || 1e-12;
  const f = Math.max(0, Math.min(1, (t - cum[i]) / L));
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}
function cumOf(loop) {
  const cum = [0];
  for (let i = 0; i < loop.length; i++) cum.push(cum[i] + dist(loop[i], loop[(i + 1) % loop.length]));
  return cum;
}
// drop points that sit on the straight line between their neighbours
function simplify(pts, tol = 0.0005) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (distToSeg(pts[i], out[out.length - 1], pts[i + 1]) > tol) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// One lap of the tool-centre region's boundary (the walls and closed ends),
// starting at its nearest point to pos, taking each corner relief where the
// lap passes it. Returns [[x, y, tag]] from the start point round to it again.
function wallLapPath(R0, pos, plunges, inside) {
  const path = [];
  const push = (p, tag) => {
    const last = path[path.length - 1];
    if (!last || dist(last, p) > 1e-7 || tag === 'hop') path.push([p[0], p[1], tag]);
  };
  // the wall lap, with each corner relief taken where the lap passes it
  const W = loopFrom(R0, pos);
  push(W[0]);
  const stops = [];   // { i, t, moves }
  const cW = cumOf(W);
  const leftover = [];
  for (const q of plunges) {
    const target = q.approach ? q.approach[1] : q.c;
    const n = nearestOnLoop(W, target);
    const legOk = (a, b) => { for (let k = 0; k <= 20; k++) { const p = [a[0] + ((b[0] - a[0]) * k) / 20, a[1] + ((b[1] - a[1]) * k) / 20]; if (!inside(p) && dist(p, q.c) > q.slack + 0.015 && !(q.approach && distToSeg(p, q.approach[0], q.approach[1]) <= 0.015)) return false; } return true; };
    // straight in from the lap's corner when that's right there (no back-and-forth)
    const vi = [n.i, (n.i + 1) % W.length].find((i) => dist(W[i], n.p) < 0.05 && legOk(W[i], q.c));
    if (vi !== undefined) { stops.push({ s: cW[vi], p: W[vi], via: [q.c] }); continue; }
    const via = q.approach ? [q.approach[1], q.c, q.approach[1]] : [q.c];
    const seq = [n.p, ...via, n.p];
    if (seq.every((p, k) => k === 0 || legOk(seq[k - 1], p))) stops.push({ s: cW[n.i] + dist(W[n.i], n.p), p: n.p, via });
    else leftover.push(q);
  }
  stops.sort((a, b) => a.s - b.s);
  let si = 0;
  const emitStopsUpTo = (s) => {
    while (si < stops.length && stops[si].s <= s + 1e-9) {
      const st = stops[si++];
      push(st.p);
      for (const v of st.via) push(v, 'relief');
      push(st.p, 'relief');
    }
  };
  for (let i = 1; i <= W.length; i++) {
    emitStopsUpTo(cW[i] - 1e-9);
    push(W[i % W.length]);
  }
  emitStopsUpTo(Infinity);
  // reliefs the lap can't reach at depth: hop to them
  for (const q of leftover) { push(q.c, 'hop'); }
  return path;
}

// style: 'spiral' (morphs out one ring per revolution, then a wall lap) or
// 'rings' (the middle line once, then each ring lapped, inside out)
function spiralPlan(allowed, tool, plunges, climb, style = 'spiral', fromTip = 0) {
  const r = tool.dia / 2;
  const step = Math.max(tool.dia * (tool.stepover || 0.5), tool.dia * 0.85);
  const keep = (ls) => ls.filter((l) => area([l]) > 1e-7);
  const inset = (d) => (d <= 0 ? keep(allowed) : keep(offset(allowed, -d, 'round')));
  // how deep the region goes (largest inset that leaves something)
  let lo = 0, hi = 0.05;
  while (inset(hi).length && hi < 100) { lo = hi; hi *= 2; }
  for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; if (inset(m).length) lo = m; else hi = m; }
  const dMax = lo;
  // rings evenly spaced from the wall lap in to the middle, no more than a
  // stepover apart; the middle itself is a thin loop round the centre line
  const n = Math.max(1, Math.ceil((dMax - 1e-3) / step));
  const sp = dMax / n;
  const ringsRaw = [];
  for (let k = 0; k < n; k++) ringsRaw.push(inset(k * sp));
  const mid = inset(Math.max(0, dMax - 0.004));
  if (!mid.length || mid.length !== 1 || ringsRaw.some((rg) => rg.length !== 1)) return null;  // islands: rows instead
  const R = ringsRaw.map((rg) => windFor(rg[0], rg, climb));
  const M = windFor(mid[0], mid, climb);
  const inside = (p) => inOrOn(p, allowed, 3e-3);
  const path = [];   // [x, y, tag]  tag: 'relief' | 'hop'
  const push = (p, tag) => {
    const last = path[path.length - 1];
    if (!last || dist(last, p) > 1e-7 || tag === 'hop') path.push([p[0], p[1], tag]);
  };
  // the middle line: from one tip to the other along one side of the thin loop
  let ia = 0, ib = 0, best = -1;
  for (let i = 0; i < M.length; i++) for (let j = i + 1; j < M.length; j++) {
    const d = dist(M[i], M[j]);
    if (d > best) { best = d; ia = i; ib = j; }
  }
  if (fromTip) [ia, ib] = [ib, ia];   // start from the other end
  const Mloop = loopFrom(M, M[ia]);
  const kb = (ib - ia + M.length) % M.length;
  const segLegOk = (a, b) => { for (let k = 0; k <= 20; k++) if (!inside([a[0] + ((b[0] - a[0]) * k) / 20, a[1] + ((b[1] - a[1]) * k) / 20])) return false; return true; };
  push(Mloop[0]);
  // one ring (most dados): the middle line, then the wall lap. A morph would
  // only add a revolution and bring the bit back to where it started.
  if (style === 'rings' || n === 1) {
    for (let i = 1; i <= kb; i++) push(Mloop[i]);
    for (let k = n - 1; k >= 0; k--) {
      const pos = path[path.length - 1];
      const L = loopFrom(R[k], pos);
      push(L[0], segLegOk(pos, L[0]) ? undefined : 'hop');
      if (k > 0) { for (let i = 1; i < L.length; i++) push(L[i]); push(L[0]); }
    }
  } else {
    // morph out: each point slides from the inner ring to the outer one over
    // one revolution, matched by share of the way round
    const morph = (Iin, Oin) => {
      const pos = path[path.length - 1];
      const I = loopFrom(Iin, pos), O = loopFrom(Oin, pos);
      const cI = cumOf(I), cO = cumOf(O), tI = cI[cI.length - 1], tO = cO[cO.length - 1];
      const N = Math.max(64, Math.ceil(Math.max(tI, tO) / 0.04));
      const rev = [];
      for (let j = 0; j <= N; j++) {
        const u = j / N;
        const a = atU(I, cI, tI, u), b = atU(O, cO, tO, u);
        const q = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
        if (!inside(q)) return false;
        rev.push(q);
      }
      for (const q of simplify(rev).slice(1)) push(q);
      return true;
    };
    let cur = M;
    for (let k = n - 1; k >= 0; k--) {
      if (!morph(cur, R[k])) {
        // too different to morph safely: lap this ring and step out
        const pos = path[path.length - 1];
        const I = loopFrom(cur, pos);
        for (let i = 1; i < I.length; i++) push(I[i]);
        push(I[0]);
        const O = loopFrom(R[k], I[0]);
        push(O[0], segLegOk(I[0], O[0]) ? undefined : 'hop');
      }
      cur = R[k];
    }
  }
  for (const q of wallLapPath(R[0], path[path.length - 1], plunges, inside)) push(q, q[2]);
  return { path, rings: n };
}

// ===================== pockets =====================
// Pockets on a part that touch (a dado running into the back groove, drawer
// end dados meeting the bottom groove) are one operation. It is cut a depth
// level at a time, shallowest first; at each level the area to clear is every
// floor that goes at least that deep. Each level is cleared first, then its
// finished edges are cut:
//   finished edge = a wall (or the step down to a deeper floor) - part material
//                   on the far side; open edge = the part's own edge (air)
//   clearing      = rows along each leg (never across it), farthest from the
//                   finished edges first and working toward them: a dado from
//                   the middle out, a rabbet from its open edge in to its wall
//   finishing     = one pass along the finished edges only, through the corner
//                   reliefs, carried half the bit past any open edge it runs to
// Rows that would run along a finished edge are left to the finishing pass, so
// nothing extra is cut. Round / odd shapes enclosed all round (hinge cups) are a
// morphed spiral from the middle, which ends with the finishing lap.

// Where the tool centre may go at one level: it only touches this floor or the
// air outside the part, and runs at most ext past an open edge, straight on.
// openExtra: areas inside the part the bit may also run into at this depth
// (already cleared at least this deep, or a deeper pocket cut later)
function centreRegion(floorIn, g, r, ext, openExtra = [], avoid = []) {
  const partRegion = difference([g.outline], g.holes);
  // a modelled floor can run past the part's edge: only the part counts
  const floor = intersect(floorIn, partRegion).filter((l) => area([l]) > 1e-7);
  if (!floor.length) return { allowed: [], partRegion, floor };
  const isOpen = (p) => !inRegion(p, partRegion) || (openExtra.length > 0 && inRegion(p, openExtra));
  const fb = bbox(floor.flat());
  const pad = r + ext + 0.25;
  const zone = [[fb.x0 - pad, fb.y0 - pad], [fb.x1 + pad, fb.y0 - pad], [fb.x1 + pad, fb.y1 + pad], [fb.x0 - pad, fb.y1 + pad]];
  const outside = difference([zone], partRegion);
  // (clipper's own output: outers and holes already wound opposite ways)
  const free = union([...floor, ...outside, ...openExtra], [], 'nonzero');
  const eroded = offset(free, -r, 'round');
  // the band the centre uses inside the floor, pushed straight out (never
  // sideways) from each of its edges that lies on the part's edge
  const band = intersect(eroded, floor).filter((l) => area([l]) > 1e-7);
  const quads = [];
  for (const l of band.map(ensureCCW)) {
    for (let k = 0; k < l.length; k++) {
      const a = l[k], b = l[(k + 1) % l.length];
      const L = dist(a, b);
      if (L < 1e-6) continue;
      const n = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L];
      const m = [(a[0] + b[0]) / 2 + n[0] * 0.01, (a[1] + b[1]) / 2 + n[1] * 0.01];
      const mi = [(a[0] + b[0]) / 2 - n[0] * 0.01, (a[1] + b[1]) / 2 - n[1] * 0.01];
      if (!isOpen(m) || isOpen(mi)) continue;   // only edges facing open space
      quads.push(ensureCCW([a, b, [b[0] + n[0] * ext, b[1] + n[1] * ext], [a[0] + n[0] * ext, a[1] + n[1] * ext]]));
    }
  }
  const reach = union([...band.map(ensureCCW), ...quads], [], 'nonzero');
  // never more than ext past the part's own edge (some modelled floors run past it)
  let allowed = intersect(intersect(eroded, reach), offset([g.outline], ext + 1e-3, 'miter')).filter((l) => area([l]) > 1e-6);
  // a run-out never reaches the next part (bit edge stays 0.03 clear of it)
  let clipped = false;
  if (avoid.length) {
    const before = area(allowed);
    allowed = difference(allowed, avoid).filter((l) => area([l]) > 1e-6);
    clipped = before - area(allowed) > 1e-5;
  }
  return { allowed, partRegion, floor, isOpen, clipped };
}

// Corner reliefs (round lobes drawn for a 1/4 bit) -> where the loaded bit cuts
// them: centre on the dado's end line, one radius in from the side wall.
function reliefsOf(floor, r, warnings, label, tool) {
  const { core, lobes } = splitLobes(floor);
  const plunges = [];
  for (const lb of lobes) {
    const corner = [lb.a, lb.b].filter((e) => isCornerOf(e, core));
    if (corner.length === 1) {
      const e = corner[0], o = e === lb.a ? lb.b : lb.a;
      const L = Math.hypot(o[0] - e[0], o[1] - e[1]) || 1;
      const c = [e[0] + ((o[0] - e[0]) / L) * r, e[1] + ((o[1] - e[1]) / L) * r];
      const into = [c[0] - lb.out[0] * (r + 0.01), c[1] - lb.out[1] * (r + 0.01)];
      plunges.push({ c, approach: [c, into], slack: 0 });
    } else if (lb.r >= r - 0.004) {
      plunges.push({ c: lb.c, slack: Math.max(0, lb.r - r) });
    } else {
      warnings.push(`${label}: couldn't place a corner relief (R${lb.r.toFixed(3)}) for the ${tool.dia}" dado tool — not cut`);
    }
  }
  return { core, plunges };
}

// floor boundary edges with part material on the far side
function finishedEdges(floor, isOpen) {
  const out = [];
  for (const l of floor) {
    for (let k = 0; k < l.length; k++) {
      const a = l[k], b = l[(k + 1) % l.length];
      const L = dist(a, b);
      if (L < 1e-6) continue;
      const n = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L];
      // classify along the edge: one edge can be open in the middle and a wall
      // at its ends (a groove whose side opens into a notch)
      const ns = Math.max(1, Math.ceil(L / 0.05));
      const cls = [];
      for (let i = 0; i < ns; i++) {
        const m = [a[0] + ((b[0] - a[0]) * (i + 0.5)) / ns, a[1] + ((b[1] - a[1]) * (i + 0.5)) / ns];
        const s1 = [m[0] + n[0] * 0.01, m[1] + n[1] * 0.01], s2 = [m[0] - n[0] * 0.01, m[1] - n[1] * 0.01];
        cls.push(!isOpen(inRegion(s1, floor) ? s2 : s1));
      }
      let i0 = 0;
      for (let i = 1; i <= ns; i++) {
        if (i < ns && cls[i] === cls[i0]) continue;
        out.push({ a: [a[0] + ((b[0] - a[0]) * i0) / ns, a[1] + ((b[1] - a[1]) * i0) / ns], b: [a[0] + ((b[0] - a[0]) * i) / ns, a[1] + ((b[1] - a[1]) * i) / ns], finished: cls[i0] });
        i0 = i;
      }
    }
  }
  return out;
}

// The finishing passes: the parts of the centre region's boundary that run
// along finished edges, as chains; carried on past an open edge by up to ext.
// Wind a boundary loop of a region so the region is on its right (climb with a
// clockwise spindle: the wall is on the cutter's left) or on its left
// (conventional). Works for outer boundaries and islands alike.
function windFor(loop, region, climb) {
  let best = 0, bi = 0;
  for (let i = 0; i < loop.length; i++) { const d = dist(loop[i], loop[(i + 1) % loop.length]); if (d > best) { best = d; bi = i; } }
  const a = loop[bi], b = loop[(bi + 1) % loop.length], L = best || 1;
  const right = [(a[0] + b[0]) / 2 + ((b[1] - a[1]) / L) * 0.005, (a[1] + b[1]) / 2 - ((b[0] - a[0]) / L) * 0.005];
  const onRight = inRegion(right, region);
  return onRight === climb ? loop : loop.slice().reverse();
}

function finishChains(allowed, edges, isOpen, r, ext, climb) {
  const fin = edges.filter((e) => e.finished);
  const dTo = (p, list) => list.reduce((m, e) => Math.min(m, distToSeg(p, e.a, e.b)), Infinity);
  const chains = [];
  for (const raw of allowed) {
    const loop = windFor(raw, allowed, climb);
    // pieces of at most 0.05
    const pts = [];
    for (let k = 0; k < loop.length; k++) {
      const a = loop[k], b = loop[(k + 1) % loop.length];
      const n = Math.max(1, Math.ceil(dist(a, b) / 0.05));
      for (let i = 0; i < n; i++) pts.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
    }
    const N = pts.length;
    const isFin = pts.map((p, i) => {
      const q = pts[(i + 1) % N], m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      return dTo(m, fin) <= r + 0.012;
    });
    if (isFin.every(Boolean)) { chains.push({ pts: simplify(pts.concat([pts[0]])).slice(0, -1), closed: true }); continue; }
    if (!isFin.some(Boolean)) continue;
    // carry a run on past an open edge: following pieces outside the part,
    // straight on, up to ext
    const outsidePart = (i) => { const p = pts[i % N], q = pts[(i + 1) % N]; return isOpen([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]); };
    const dirOf = (i) => { const p = pts[(i + N) % N], q = pts[(i + 1 + N) % N]; const L = dist(p, q) || 1; return [(q[0] - p[0]) / L, (q[1] - p[1]) / L]; };
    const keep = isFin.slice();
    for (let i = 0; i < N; i++) {
      if (!isFin[i]) continue;
      if (!isFin[(i + 1) % N]) {           // run ends after piece i: carry forward
        const d0 = dirOf(i);
        let L = 0;
        for (let j = i + 1; j < i + N && L < ext + 0.01; j++) {
          const dj = dirOf(j);
          if (isFin[j % N] || !outsidePart(j) || d0[0] * dj[0] + d0[1] * dj[1] < 0.95) break;
          keep[j % N] = true; L += dist(pts[j % N], pts[(j + 1) % N]);
        }
      }
      if (!isFin[(i - 1 + N) % N]) {       // run starts at piece i: carry backward
        const d0 = dirOf(i);
        let L = 0;
        for (let j = i - 1; j > i - N && L < ext + 0.01; j--) {
          const dj = dirOf(j);
          if (isFin[(j + N) % N] || !outsidePart((j + N) % N) || d0[0] * dj[0] + d0[1] * dj[1] < 0.95) break;
          keep[(j + N) % N] = true; L += dist(pts[(j + N) % N], pts[(j + 1 + N) % N]);
        }
      }
    }
    // runs of kept pieces -> open chains
    let s0 = keep.findIndex((k, i) => k && !keep[(i - 1 + N) % N]);
    if (s0 < 0) { chains.push({ pts: simplify(pts.concat([pts[0]])).slice(0, -1), closed: true }); continue; }
    for (let c = 0, i = s0; c < N; ) {
      if (!keep[i % N]) { i++; c++; continue; }
      const run = [pts[i % N]];
      while (keep[i % N] && c < N) { run.push(pts[(i + 1) % N]); i++; c++; }
      chains.push({ pts: simplify(run), closed: false });
    }
  }
  return chains;
}

// a polyline's distance to a point
const distToPoly = (p, pts, closed) => {
  let d = Infinity;
  for (let i = 0; i + 1 < pts.length + (closed ? 1 : 0); i++) d = Math.min(d, distToSeg(p, pts[i], pts[(i + 1) % pts.length]));
  return d;
};

// Plan one group of touching pockets.
function planGroup(pockets, g, tool, warnings, label, opts) {
  const r = tool.dia / 2;
  const ext = opts.overtravel ?? r + 0.02;
  const legStep = Math.max(tool.dia * (tool.stepover || 0.5), tool.dia * 0.85);
  const regions = pockets.map((p) => union(p.loops, []));
  const all = union(regions.flat(), [], 'nonzero');
  const fb = bbox(all.flat());
  const depths = [...new Set(pockets.map((p) => +p.depth.toFixed(5)))].sort((a, b) => a - b);
  const desc = `${fb.w.toFixed(3)}x${fb.h.toFixed(3)} d${depths.map((d) => d.toFixed(3)).join('/')}`;
  // depth levels: down to each floor depth in steps of at most the stepdown
  // shallowest first, each depth at its own stepdown. While a shallower floor is
  // cut, a deeper one it touches counts as open (it gets cut away later); a
  // floor already cut at least this deep is open too.
  const classes = depths.map((d) => {
    const members = pockets.map((p, i) => ({ p, reg: regions[i] })).filter(({ p }) => Math.abs(p.depth - d) < 1e-5);
    return { d, members, reg: members.length === 1 ? members[0].reg : union(members.flatMap((m) => m.reg), [], 'nonzero') };
  });
  const lv = [];
  let fromRecords = false;
  const prevZ = new Map();
  for (const [ci, cl] of classes.entries()) for (const z of levels(cl.d, tool.stepdown)) {
    const zTop = prevZ.get(ci) ?? 0;   // material top here: the last level of this depth, or the sheet top
    prevZ.set(ci, z);
    const members = cl.members;
    const floorRaw = cl.reg;
    const openExtra = classes.filter((o) => o !== cl && (o.d > cl.d || o.d >= -z - 1e-6)).flatMap((o) => o.reg);
    const { allowed, partRegion, floor, isOpen, clipped } = centreRegion(floorRaw, g, r, ext, openExtra, opts.avoid || []);
    if (clipped) opts.onClip?.();
    if (!allowed.length) {
      warnings.push(`${label}: pocket ${desc} is narrower than the ${tool.dia}" dado tool at depth ${(-z).toFixed(3)} — skipped`);
      continue;
    }
    const { core, plunges } = reliefsOf(floor, r, lv.length ? [] : warnings, label, tool);
    const walls = members.flatMap(({ p }) => p.walls || []);
    const rec = walls.length ? legsFromWalls(core, walls) : null;
    if (rec) fromRecords = true;
    const legs = rec || legsOf(core);
    const edges = finishedEdges(floor, isOpen);
    const chains = finishChains(allowed, edges, isOpen, r, ext, opts.finishClimb);
    if (opts.finishEither) for (const c of chains) c.either = true;
    const inside = (p) => inOrOn(p, allowed, 3e-3);
    // fully enclosed, not square-sided: morphed spiral (ends with the wall lap)
    if (!legs && chains.length === allowed.length && chains.every((c) => c.closed)) {
      const sp = spiralPlan(allowed, tool, plunges, opts.finishClimb);
      const sp2 = sp && spiralPlan(allowed, tool, plunges, opts.finishClimb, 'spiral', 1);
      if (sp) { lv.push({ cls: ci, z, zTop, allowed, plunges, spiral: [sp.path, sp2?.path].filter(Boolean) }); continue; }
    }
    // clearing rows, per leg; the parts of rows that would run along a
    // finishing pass are left to it
    const fin = edges.filter((e) => e.finished);
    const reachPart = offset(floor, r - 0.005, 'round');   // rows only where they cut this floor
    const legPlans = [];
    const rowSets = [];
    if (legs) {
      const rect = (lg, e) => [[lg.x0 - e, lg.y0 - e], [lg.x1 + e, lg.y0 - e], [lg.x1 + e, lg.y1 + e], [lg.x0 - e, lg.y1 + e]];
      for (const leg of legs) {
        // the leg's area, run on past its open edges, but not into another leg
        // (a junction square lies in both legs: it stays in both here, and
        // leg.clip gives it to the longer one)
        const others = legs.filter((o) => o !== leg).map((o) => rect(o, 0));
        let region = intersect(allowed, [rect(leg, ext + 1e-3)]).filter((l) => area([l]) > 1e-5);
        if (others.length) region = difference(region, difference(union(others, [], 'nonzero'), [rect(leg, 1e-3)]));
        const mine = leg.clip ? difference(region, leg.clip) : region;
        const use = mine.filter((l) => area([l]) > 1e-5);
        if (use.length) rowSets.push({ alongX: leg.alongX, rows: planRows(use, leg.alongX, legStep, false, null) });
      }
    } else {
      const cb = bbox(core.flat());
      const ax = cb.w >= cb.h;
      rowSets.push({ alongX: ax, rows: planRows(allowed, ax, legStep, false, null) });
    }
    for (const { alongX, rows } of rowSets) {
      const across = (p) => (alongX ? p[1] : p[0]);
      const segs = [];
      for (const row of rows) {
        const [a, b] = [row[0], row[row.length - 1]];
        const L = dist(a, b);
        const n = Math.max(2, Math.ceil(L / 0.02));
        let runStart = null;
        const pushRun = (t0, t1) => {
          if ((t1 - t0) * L < 0.02) return;
          const p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
          // a stub wholly in the air past an open edge (the bit can't reach the part) cuts nothing
          let touches = false;
          for (let k = 0; k <= 8 && !touches; k++) { const q = [p0[0] + ((p1[0] - p0[0]) * k) / 8, p0[1] + ((p1[1] - p0[1]) * k) / 8]; if (inRegion(q, reachPart)) touches = true; }
          if (touches) segs.push([p0, p1]);
        };
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const covered = chains.some((c) => distToPoly(q, c.pts, c.closed) <= 0.01);
          if (!covered && runStart === null) runStart = t;
          if ((covered || k === n) && runStart !== null) { pushRun(runStart, covered ? Math.max(runStart, t - 1 / n) : t); runStart = null; }
        }
      }
      if (!segs.length) continue;
      // positions across the leg; start at the one farthest from the finished
      // edges, work out to one side, then the other (smaller side first)
      const posList = [...new Set(segs.map((sg) => +across(sg[0]).toFixed(4)))].sort((p, q) => p - q);
      const far = (pos) => Math.max(...segs.filter((sg) => Math.abs(across(sg[0]) - pos) < 1e-3).map((sg) => {
        const m = [(sg[0][0] + sg[1][0]) / 2, (sg[0][1] + sg[1][1]) / 2];
        return fin.length ? fin.reduce((mm, e) => Math.min(mm, distToSeg(m, e.a, e.b)), Infinity) : 0;
      }));
      let si = 0, best = -1;
      posList.forEach((p, k) => { const f = far(p); if (f > best + 1e-6) { best = f; si = k; } });
      const up = posList.slice(si + 1), down = posList.slice(0, si).reverse();
      const order = [posList[si], ...(up.length <= down.length ? [...up, ...down] : [...down, ...up])];
      legPlans.push(order.map((pos) => segs.filter((sg) => Math.abs(across(sg[0]) - pos) < 1e-3)));
    }
    // each relief goes with the finishing chain that passes nearest it
    for (const c of chains) c.reliefs = [];
    const loose = [];
    for (const q of plunges) {
      const target = q.approach ? q.approach[1] : q.c;
      let bc = null, bd = Infinity;
      for (const c of chains) { const d = distToPoly(target, c.pts, c.closed); if (d < bd) { bd = d; bc = c; } }
      if (bc && bd < r + 0.05) bc.reliefs.push(q); else loose.push(q);
    }
    lv.push({ cls: ci, z, zTop, allowed, plunges, legPlans, chains, loose, anyLink: !legs });
  }
  if (!lv.length) return null;
  return { label, desc, depth: depths[depths.length - 1], levels: lv, fromRecords };
}

// A finishing chain as a path from the end (or point) nearest pos, taking its
// reliefs where it passes them. [[x, y, tag]]
function chainPath(chain, pos, inside) {
  if (chain.closed) return wallLapPath(chain.pts, pos, chain.reliefs, inside);
  // wound for the cutting direction; only reversed when either way is allowed
  let pts = chain.pts;
  if (chain.either && dist(pts[pts.length - 1], pos) < dist(pts[0], pos)) pts = pts.slice().reverse();
  // reuse the lap logic on the open run: stops are placed along it in order
  const path = [];
  const push = (p, tag) => { const last = path[path.length - 1]; if (!last || dist(last, p) > 1e-7 || tag === 'hop') path.push([p[0], p[1], tag]); };
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const stops = [], left = [];
  for (const q of chain.reliefs) {
    const target = q.approach ? q.approach[1] : q.c;
    let bi = 0, bp = pts[0], bd = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-12;
      const t = Math.max(0, Math.min(1, ((target[0] - a[0]) * dx + (target[1] - a[1]) * dy) / L2));
      const p = [a[0] + t * dx, a[1] + t * dy];
      if (dist(p, target) < bd) { bd = dist(p, target); bi = i; bp = p; }
    }
    const legOk = (a, b) => { for (let k = 0; k <= 20; k++) { const p = [a[0] + ((b[0] - a[0]) * k) / 20, a[1] + ((b[1] - a[1]) * k) / 20]; if (!inside(p) && dist(p, q.c) > q.slack + 0.015 && !(q.approach && distToSeg(p, q.approach[0], q.approach[1]) <= 0.015)) return false; } return true; };
    const vi = [bi, bi + 1].find((i) => i < pts.length && dist(pts[i], bp) < 0.05 && legOk(pts[i], q.c));
    if (vi !== undefined) { stops.push({ s: cum[vi], p: pts[vi], via: [q.c] }); continue; }
    const via = q.approach ? [q.approach[1], q.c, q.approach[1]] : [q.c];
    const seq = [bp, ...via, bp];
    if (seq.every((p, k) => k === 0 || legOk(seq[k - 1], p))) stops.push({ s: cum[bi] + dist(pts[bi], bp), p: bp, via });
    else left.push(q);
  }
  stops.sort((a, b) => a.s - b.s);
  let si = 0;
  const upTo = (s) => { while (si < stops.length && stops[si].s <= s + 1e-9) { const st = stops[si++]; push(st.p); for (const v of st.via) push(v, 'relief'); push(st.p, 'relief'); } };
  push(pts[0]);
  for (let i = 1; i < pts.length; i++) { upTo(cum[i] - 1e-9); push(pts[i]); }
  upTo(Infinity);
  for (const q of left) push(q.c, 'hop');
  return path;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Closest point to pos on a closed loop: { d, i (edge from loop[i]), p }.
function nearestOnLoop(loop, pos) {
  let best = { d: Infinity, i: 0, p: loop[0] };
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-12;
    const t = Math.max(0, Math.min(1, ((pos[0] - a[0]) * dx + (pos[1] - a[1]) * dy) / L2));
    const p = [a[0] + t * dx, a[1] + t * dy];
    const d = dist(p, pos);
    if (d < best.d) best = { d, i, p };
  }
  return best;
}

// Rotate a closed loop so it starts where it is nearest pos (direction kept).
// onEdge: start part way along an edge if that's nearer than any corner (the
// start point is added as a vertex); otherwise at the nearest corner.
function startNearest(loop, pos, onEdge = false) {
  if (!pos) return loop;
  if (onEdge) {
    const n = nearestOnLoop(loop, pos);
    const a = loop[n.i], b = loop[(n.i + 1) % loop.length];
    if (dist(n.p, a) > 0.01 && dist(n.p, b) > 0.01) {
      return [n.p, ...loop.slice(n.i + 1), ...loop.slice(0, n.i + 1)];
    }
  }
  let k = 0, best = Infinity;
  loop.forEach(([x, y], i) => { const d = Math.hypot(x - pos[0], y - pos[1]); if (d < best) { best = d; k = i; } });
  return loop.slice(k).concat(loop.slice(0, k));
}
// travel to the nearest point on any of the loops
const nearestVertex = (loops, pos) => Math.min(...loops.map((l) => nearestOnLoop(l, pos).d));

// Order items to keep travel short. entry(item, pos) = travel to start the item
// from pos; exit(item, pos) = where the tool is left after it (entered from pos).
// Greedy nearest-neighbour, then 2-opt (reverse a run) and or-opt (move one item)
// judged on the real travel, entries and exits included, within a time budget.
function orderShortest(items, pos, entry, exit, budgetMs = 150) {
  if (items.length < 2) return items.slice();
  const left = items.slice();
  let seq = [];
  let cur = pos;
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((it, i) => { const d = entry(it, cur); if (d < bd) { bd = d; bi = i; } });
    const it = left.splice(bi, 1)[0];
    seq.push(it);
    cur = exit(it, cur);
  }
  if (seq.length < 3) return seq;
  const cost = (q) => { let d = 0, c = pos; for (const it of q) { d += entry(it, c); c = exit(it, c); } return d; };
  let bestCost = cost(seq);
  const t0 = Date.now();
  let improved = true;
  while (improved && Date.now() - t0 < budgetMs) {
    improved = false;
    for (let i = 0; i < seq.length - 1 && Date.now() - t0 < budgetMs; i++) {
      for (let j = i + 1; j < seq.length; j++) {
        const cand = seq.slice(0, i).concat(seq.slice(i, j + 1).reverse(), seq.slice(j + 1));
        const cc = cost(cand);
        if (cc < bestCost - 1e-6) { seq = cand; bestCost = cc; improved = true; }
      }
    }
    for (let i = 0; i < seq.length && Date.now() - t0 < budgetMs; i++) {
      for (let j = 0; j < seq.length; j++) {
        if (j === i) continue;
        const cand = seq.slice();
        const [it] = cand.splice(i, 1);
        cand.splice(j, 0, it);
        const cc = cost(cand);
        if (cc < bestCost - 1e-6) { seq = cand; bestCost = cc; improved = true; }
      }
    }
  }
  return seq;
}

// Where tabs go on a closed tool-centre loop, as [start, end] arc-length
// intervals: the flat top of each tab. Tabs sit centred on straight runs long
// enough to hold the tab and its ramps clear of corners; the count follows the
// spacing (at least opt.min), shared out by run length.
// The flat is the tab length + the tool diameter, so the top of the tab left in
// the material is the requested length; ramps (opt.ramp each side) widen its foot.
export function placeTabs(loop, opt, tool) {
  const lift = opt.length + tool.dia;
  const need = lift + 2 * (opt.ramp || 0) + tool.dia + 0.1;
  const edges = [];
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    edges.push({ s0: s, len, k: 0, cap: Math.floor(len / need) });
    s += len;
  }
  const usable = edges.filter((e) => e.cap > 0);
  if (!usable.length) return [];
  const want = Math.max(opt.min || 1, Math.round(s / (opt.spacing || 18)));
  const room = usable.reduce((a, e) => a + e.cap, 0);
  for (let n = Math.min(want, room); n > 0; n--) {
    let best = null;
    for (const e of usable) if (e.k < e.cap && (!best || e.len / (e.k + 1) > best.len / (best.k + 1))) best = e;
    best.k++;
  }
  const out = [];
  for (const e of usable) {
    for (let i = 0; i < e.k; i++) {
      const c = e.s0 + (e.len * (i + 0.5)) / e.k;
      out.push([c - lift / 2, c + lift / 2]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// tabs: null, or { length, thickness, spacing, min, z } (z = tab top, negative)
// Tabs for a whole sheet. A tab only holds if there is material on the far side
// of the cut. Along each straight edge of a tabbed part, the strip just past the
// cutter is one of:
//   free   - sheet skeleton: an ordinary tab
//   open   - off the sheet (or less than 1/4" left before the sheet edge), or a
//            neighbour without tabs cuts it away: no tab
//   shared - another tabbed part's cut overlaps ours: one tab, lifted over by
//            both parts at the same place, bridges the two and counts for both
// Each part still gets its tab count (spacing, at least min); shared tabs count
// toward it, and a part keeps at least one tab to the skeleton when it has room.
// Sets x.tabs.spans = [[a, b], ...] (flat tops, tool-centre XY) on each item.
const MIN_LIGAMENT = 0.25; // inch
export function planSheetTabs(items, tool, sheet, warnings = []) {
  const tabbed = items.filter((x) => x.tabs);
  if (!tabbed.length) return;
  const r = tool.dia / 2;
  const opt = tabbed[0].tabs;
  const lift = opt.length + tool.dia;
  const ramp = opt.ramp || 0;
  const need = lift + 2 * ramp + tool.dia + 0.1;   // edge length one tab takes, clear of corners
  const W = sheet.w ?? Infinity, H = sheet.h ?? Infinity;
  const info = items.map((x) => {
    const loop = x.loops[x.loops.length - 1];
    return { x, loop, bb: bbox(loop), ccw: signedArea(loop) > 0 };
  });
  const nearLoop = (q, loop, lim) => {
    for (let i = 0; i < loop.length; i++) if (distToSeg(q, loop[i], loop[(i + 1) % loop.length]) < lim) return true;
    return false;
  };
  const classify = (me, p, n) => {
    let off = false;
    // a tab needs MIN_LIGAMENT of material past the cut; the thin strip left
    // along the sheet edge by the trim margin doesn't count
    for (const d of [0.02, 0.1, MIN_LIGAMENT]) {
      const q = [p[0] + n[0] * (r + d), p[1] + n[1] * (r + d)];
      for (const o of info) {
        if (o === me || q[0] < o.bb.x0 - r || q[0] > o.bb.x1 + r || q[1] < o.bb.y0 - r || q[1] > o.bb.y1 + r) continue;
        if (inRegion(q, [o.x.g.outline]) || nearLoop(q, o.loop, r - 1e-4)) return o.x.tabs ? o.x.pi : 'open';
      }
      if (q[0] < 0 || q[1] < 0 || q[0] > W || q[1] > H) off = true;
    }
    return off ? 'open' : 'free';
  };
  // runs of one kind along each edge
  for (const me of info) {
    if (!me.x.tabs) continue;
    const L = me.loop, runs = [];
    for (let i = 0; i < L.length; i++) {
      const a = L[i], b = L[(i + 1) % L.length];
      const len = dist(a, b);
      if (len < need) continue;
      const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      const n = me.ccw ? [u[1], -u[0]] : [-u[1], u[0]];   // outward
      const step = 0.05, ns = Math.ceil(len / step);
      let cur = null;
      for (let k = 0; k <= ns; k++) {
        const t = Math.min(len, k * step);
        const cls = classify(me, [a[0] + u[0] * t, a[1] + u[1] * t], n);
        if (cur && cur.cls === cls) cur.t1 = t;
        else { if (cur) runs.push(cur); cur = { a, u, t0: t, t1: t, cls, edge: i, edgeLen: len }; }
      }
      if (cur) runs.push(cur);
    }
    me.runs = runs.filter((rn) => rn.t1 - rn.t0 >= need - 1e-9);
    me.spans = []; me.shared = 0; me.links = new Set(); me.used = new Map();
  }
  const at = (rn, t) => [rn.a[0] + rn.u[0] * t, rn.a[1] + rn.u[1] * t];
  const spanOn = (rn, c) => [at(rn, c - lift / 2), at(rn, c + lift / 2)];
  // tabs per straight edge: at most one per Spacing, rounded up (shared and
  // ordinary together), so a part with few free edges doesn't crowd one edge
  const sp = opt.spacing || 18;
  const budget = (len) => Math.max(1, Math.ceil(len / sp - 1e-6));
  const hasRoom = (o, rn) => (o.used.get(rn.edge) || 0) < budget(rn.edgeLen);
  const useOne = (o, rn) => o.used.set(rn.edge, (o.used.get(rn.edge) || 0) + 1);
  // shared edges: tabs placed once, on both parts
  for (const me of info) {
    if (!me.runs) continue;
    for (const rn of me.runs) {
      if (typeof rn.cls !== 'number' || rn.cls < me.x.pi) continue;   // each pair once, from the lower index
      const other = info.find((o) => o.x.pi === rn.cls);
      const theirs = (other.runs || []).filter((q) => q.cls === me.x.pi);
      const len = rn.t1 - rn.t0;
      const k = Math.min(Math.floor(len / need), Math.round(len / (opt.spacing || 18)));
      for (let i = 0; i < k; i++) {
        const c = rn.t0 + (len * (i + 0.5)) / k;
        const P = at(rn, c);
        // the same place on the neighbour's path
        let fit = null;
        for (const q of theirs) {
          const tb = (P[0] - q.a[0]) * q.u[0] + (P[1] - q.a[1]) * q.u[1];
          if (tb - lift / 2 - ramp >= q.t0 - 1e-6 && tb + lift / 2 + ramp <= q.t1 + 1e-6) { fit = { q, tb }; break; }
        }
        if (!fit || !hasRoom(me, rn) || !hasRoom(other, fit.q)) continue;
        useOne(me, rn); useOne(other, fit.q);
        me.spans.push(spanOn(rn, c)); other.spans.push(spanOn(fit.q, fit.tb));
        me.shared++; other.shared++;
        me.links.add(other.x.pi); other.links.add(me.x.pi);
      }
    }
  }
  // the rest of each part's tabs go on edges facing the skeleton
  for (const me of info) {
    if (!me.runs) continue;
    const perim = me.loop.reduce((a, p, i) => a + dist(p, me.loop[(i + 1) % me.loop.length]), 0);
    const want = Math.max(opt.min || 1, Math.round(perim / (opt.spacing || 18)));
    // (each edge's budget, shared tabs already counted, caps how many go there:
    // a part whose other edges can't take tabs doesn't pile them onto one edge)
    const free = me.runs.filter((rn) => rn.cls === 'free').map((rn) => {
      const len = rn.t1 - rn.t0;
      return { rn, len, cap: Math.min(Math.floor(len / need), budget(rn.edgeLen)), k: 0 };
    });
    const room = free.reduce((a, f) => a + f.cap, 0);
    let n = Math.min(room, Math.max(room > 0 ? 1 : 0, want - me.shared));
    for (; n > 0; n--) {
      let best = null;
      for (const f of free) if (f.k < f.cap && hasRoom(me, f.rn) && (!best || f.len / (f.k + 1) > best.len / (best.k + 1))) best = f;
      if (!best) {
        // every edge is at its budget: still give the part one tab to the sheet if it has none
        if (!free.some((f) => f.k) && free.length) best = free.reduce((b, f) => (f.cap > 0 && (!b || f.len > b.len) ? f : b), null);
        if (!best) break;
      }
      best.k++; useOne(me, best.rn);
    }
    for (const f of free) for (let i = 0; i < f.k; i++) me.spans.push(spanOn(f.rn, f.rn.t0 + (f.len * (i + 0.5)) / f.k));
    me.free = free.reduce((a, f) => a + f.k, 0);
    if (!me.spans.length) warnings.push(`${me.x.label}: no straight run with material past it long enough for a tab`);
  }
  // parts tabbed only to each other, with nothing tying the group to the skeleton
  const seen = new Set();
  for (const me of info) {
    if (!me.runs || seen.has(me.x.pi)) continue;
    const group = [], todo = [me];
    seen.add(me.x.pi);
    while (todo.length) {
      const g = todo.pop(); group.push(g);
      for (const pi of g.links) { if (!seen.has(pi)) { seen.add(pi); todo.push(info.find((o) => o.x.pi === pi)); } }
    }
    if (group.length > 1 && !group.some((g) => g.free > 0)) warnings.push(`${group.map((g) => g.x.label).join(', ')}: only tabbed to each other, nothing holds them to the sheet`);
  }
  for (const me of info) if (me.runs) me.x.tabs = { ...me.x.tabs, spans: me.spans };
}

// a sheet plan's tab spans as arc-length intervals on this (rotated) loop
function spansToIntervals(loop, spans) {
  const out = [];
  let s0 = 0;
  const edges = loop.map((a, i) => { const b = loop[(i + 1) % loop.length]; const e = { a, b, s0, len: dist(a, b) }; s0 += e.len; return e; });
  for (const [p, q] of spans) {
    const e = edges.find((e) => distToSeg(p, e.a, e.b) < 1e-6 && distToSeg(q, e.a, e.b) < 1e-6);
    if (!e) continue;
    const t0 = e.s0 + dist(e.a, p), t1 = e.s0 + dist(e.a, q);
    out.push([Math.min(t0, t1), Math.max(t0, t1)]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// Cut an open polyline at depth z, lifting over tabs (iv: [t0, t1] flat tops,
// arc length along pts), ramped when tabs.ramp > 0.
function walkRun(pb, pts, z, tool, tabs, iv) {
  if (!tabs || !iv.length || z >= tabs.z - 1e-9) {
    for (let i = 1; i < pts.length; i++) pb.feed(pts[i][0], pts[i][1], tool.feed);
    return;
  }
  const ramp = tabs.ramp || 0;
  const zAt = (t) => {
    for (const [t0, t1] of iv) {
      if (t >= t0 - 1e-9 && t <= t1 + 1e-9) return tabs.z;
      if (ramp > 0 && t > t0 - ramp && t < t0) return z + ((tabs.z - z) * (t - (t0 - ramp))) / ramp;
      if (ramp > 0 && t > t1 && t < t1 + ramp) return tabs.z + ((z - tabs.z) * (t - t1)) / ramp;
    }
    return z;
  };
  const marks = ramp > 0 ? iv.flatMap(([t0, t1]) => [t0 - ramp, t0, t1, t1 + ramp]) : iv.flatMap(([t0, t1]) => [t0, t1]);
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const stops = marks.filter((t) => t > s + 1e-9 && t < s + len - 1e-9).concat([s + len]);
    for (const t of stops) {
      const u = (t - s) / (len || 1);
      const x = a[0] + (b[0] - a[0]) * u, y = a[1] + (b[1] - a[1]) * u;
      const op = pb.op;
      if (ramp > 0) {
        const nz = zAt(t);
        const flat = Math.abs(nz - tabs.z) < 1e-9 && Math.abs(pb.z - tabs.z) < 1e-9;
        const sloped = Math.abs(nz - pb.z) > 1e-9;
        if (flat || sloped) pb.op = 'tab';
        pb.feed3(x, y, nz, tool.feed, sloped ? { ramp: true } : undefined);
      } else {
        // straight up at a tab's start, across at the tab top, straight down after
        const onTab = iv.some(([t0, t1]) => t > t0 + 1e-9 && t <= t1 + 1e-9);
        if (onTab) { pb.op = 'tab'; pb.feed(x, y, tool.feed); pb.op = op; if (iv.some(([, t1]) => Math.abs(t - t1) < 1e-9)) pb.plunge(z); }
        else { pb.feed(x, y, tool.feed); if (iv.some(([t0]) => Math.abs(t - t0) < 1e-9)) pb.lift(tabs.z, tool.feed); }
      }
      pb.op = op;
    }
    s += len;
  }
}

// Outline with some stretches already cut by a neighbour (shared cut lines):
// cut what's left as open runs. Each run goes back and forth a level at a time
// (no trip back to its start), the last level in the outline's own direction.
function contourRuns(pb, loop, zs, tool, tabs, low, skipSpans) {
  const iv0 = spansToIntervals(loop, skipSpans);
  if (!iv0.length) return contour(pb, loop, zs, tool, tabs, low);
  // start the loop where a skipped stretch ends, so no run wraps round
  const c0 = cumOf(loop), P0 = c0[c0.length - 1];
  const L = loopFrom(loop, atU(loop, c0, P0, iv0[0][1] / P0));
  const skip = spansToIntervals(L, skipSpans);
  const tabIv = !tabs ? [] : tabs.spans ? spansToIntervals(L, tabs.spans) : placeTabs(L, tabs, tool);
  const cum = cumOf(L), P = cum[cum.length - 1];
  const runs = [];
  let cur = 0;
  for (const [a, b] of skip.slice().sort((p, q) => p[0] - q[0])) { if (a - cur > 0.02) runs.push([cur, a]); cur = Math.max(cur, b); }
  if (P - cur > 0.02) runs.push([cur, P]);
  const ptsOf = ([a, b]) => {
    const out = [atU(L, cum, P, a / P)];
    for (let i = 1; i < L.length; i++) if (cum[i] > a + 1e-9 && cum[i] < b - 1e-9) out.push(L[i]);
    out.push(atU(L, cum, P, Math.min(b, P - 1e-9) / P));
    return out;
  };
  const left = runs.map((rn) => ({ rn, pts: ptsOf(rn), iv: tabIv.filter(([t0, t1]) => t0 >= rn[0] - 1e-6 && t1 <= rn[1] + 1e-6).map(([t0, t1]) => [t0 - rn[0], t1 - rn[0]]) }));
  const firstFwd = (zs.length - 1) % 2 === 0;   // last level goes forward
  while (left.length) {
    const here = pb.x == null ? [0, 0] : [pb.x, pb.y];
    let bi = 0, bd = Infinity;
    left.forEach((r, k) => { const st = firstFwd ? r.pts[0] : r.pts[r.pts.length - 1]; const d = dist(st, here); if (d < bd) { bd = d; bi = k; } });
    const { rn, pts, iv } = left.splice(bi, 1)[0];
    const len = rn[1] - rn[0];
    zs.forEach((z, k) => {
      const fwd = (zs.length - 1 - k) % 2 === 0;
      const path = fwd ? pts : pts.slice().reverse();
      const ivd = fwd ? iv : iv.map(([t0, t1]) => [len - t1, len - t0]).reverse();
      pb.startAt(path[0][0], path[0][1], z, low(path[0]));
      walkRun(pb, path, z, tool, tabs, ivd);
    });
  }
}

function contour(pb, loop, zs, tool, tabs, low = () => false) {
  // start on the nearest point of the edge (tabbed loops keep corner starts so
  // their straight runs stay whole for tab placement)
  loop = startNearest(loop, pb.x == null ? null : [pb.x, pb.y], !tabs);
  const start = loop[0];
  const iv = !tabs ? [] : tabs.spans ? spansToIntervals(loop, tabs.spans) : placeTabs(loop, tabs, tool);
  for (const z of zs) {
    pb.startAt(start[0], start[1], z, low(start));
    if (!iv.length || z >= tabs.z - 1e-9) {
      for (let i = 1; i < loop.length; i++) pb.feed(loop[i][0], loop[i][1], tool.feed);
      pb.feed(start[0], start[1], tool.feed);
      continue;
    }
    const ramp = tabs.ramp || 0;
    if (ramp > 0) {
      // ramp up onto each tab and back down off it while moving along the
      // edge, so the bit never stops against the part (no witness mark)
      const zAt = (t) => {
        for (const [t0, t1] of iv) {
          if (t >= t0 - 1e-9 && t <= t1 + 1e-9) return tabs.z;
          if (t > t0 - ramp && t < t0) return z + ((tabs.z - z) * (t - (t0 - ramp))) / ramp;
          if (t > t1 && t < t1 + ramp) return tabs.z + ((z - tabs.z) * (t - t1)) / ramp;
        }
        return z;
      };
      const marks = iv.flatMap(([t0, t1]) => [t0 - ramp, t0, t1, t1 + ramp]);
      let s = 0;
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const stops = marks.filter((t) => t > s + 1e-9 && t < s + len - 1e-9).concat([s + len]);
        for (const t of stops) {
          const u = (t - s) / (len || 1);
          const nz = zAt(t);
          const flat = Math.abs(nz - tabs.z) < 1e-9 && Math.abs(pb.z - tabs.z) < 1e-9;
          const sloped = Math.abs(nz - pb.z) > 1e-9;
          const op = pb.op;
          if (flat || sloped) pb.op = 'tab';
          pb.feed3(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, nz, tool.feed, sloped ? { ramp: true } : undefined);
          pb.op = op;
        }
        s += len;
      }
      continue;
    }
    // walk the loop, lifting straight up to the tab top over each tab
    let s = 0, k = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const at = (t) => [a[0] + ((b[0] - a[0]) * (t - s)) / len, a[1] + ((b[1] - a[1]) * (t - s)) / len];
      while (k < iv.length && iv[k][0] < s + len - 1e-9) {
        const [t0, t1] = iv[k];
        const p0 = at(Math.max(t0, s)), p1 = at(Math.min(t1, s + len));
        pb.feed(p0[0], p0[1], tool.feed);
        pb.lift(tabs.z, tool.feed);
        const op = pb.op;
        pb.op = 'tab';
        pb.feed(p1[0], p1[1], tool.feed);
        pb.op = op;
        pb.plunge(z);
        k++;
      }
      pb.feed(b[0], b[1], tool.feed);
      s += len;
    }
  }
}

/**
 * sheet: { placements } from nestParts
 * cfg: { thickness, safeZ, onionSkin, overcut, climb, tool, dadoTool }
 * returns { moves, warnings, stats }
 */
// Tool-centre lines that cut an offcut free: its outline offset by the tool
// radius, minus the sides that lie on the stock's edges. Returns
// [{ pts, closed }] (open lines end on the stock edge).
export function offcutCutLines(oc, W, H, r) {
  if (oc.rects?.length > 1) return shapeCutLines(oc.rects, W, H, r);
  const e = 1e-3;
  const x0 = oc.x - r, y0 = oc.y - r, x1 = oc.x + oc.w + r, y1 = oc.y + oc.h + r;
  const C = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  // edge k runs C[k] -> C[k+1]: bottom, right, top, left
  const onEdge = [oc.y < e, oc.x + oc.w > W - e, oc.y + oc.h > H - e, oc.x < e];
  if (!onEdge.some(Boolean)) return [{ pts: C, closed: true }];
  const lines = [];
  const k0 = onEdge.indexOf(true);
  let cur = null;
  for (let n = 1; n <= 4; n++) {
    const k = (k0 + n) % 4;
    if (onEdge[k]) { if (cur) { lines.push(cur); cur = null; } continue; }
    if (!cur) cur = [C[k]];
    cur.push(C[(k + 1) % 4]);
  }
  if (cur) lines.push(cur);
  // the ends stop on the stock edge: the cutter centred there already cuts
  // through it, and nothing goes off the stock (machine limits)
  const cl = ([x, y]) => [Math.min(W, Math.max(0, x)), Math.min(H, Math.max(0, y))];
  return lines.map((pts) => ({ pts: pts.map(cl), closed: false }));
}

// Outline of the union of rectangles (an L / T offcut or remnant).
export function rectsOutline(rects) {
  return union(rects.map((q) => [[q.x, q.y], [q.x + q.w, q.y], [q.x + q.w, q.y + q.h], [q.x, q.y + q.h]]), [])[0] || [];
}

// The same for an offcut of two rectangles (L / T): the outline of their
// union, square corners, offset by r; sides on the stock edge left out.
function shapeCutLines(rects, W, H, r) {
  const e = 1e-3;
  const rq = (q) => [[q.x, q.y], [q.x + q.w, q.y], [q.x + q.w, q.y + q.h], [q.x, q.y + q.h]];
  const outline = offset(union(rects.map(rq), []), r, 'miter')[0];
  if (!outline) return [];
  const n = outline.length;
  // a side on the stock edge: both ends out past it by r
  const off = ([x, y]) => [x < -r + e, x > W + r - e, y < -r + e, y > H + r - e];
  const onEdge = outline.map((p, k) => { const a = off(p), b = off(outline[(k + 1) % n]); return a.some((v, i) => v && b[i]); });
  if (!onEdge.some(Boolean)) return [{ pts: outline, closed: true }];
  const lines = [];
  const k0 = onEdge.indexOf(true);
  let cur = null;
  for (let m = 1; m <= n; m++) {
    const k = (k0 + m) % n;
    if (onEdge[k]) { if (cur) { lines.push(cur); cur = null; } continue; }
    if (!cur) cur = [outline[k]];
    cur.push(outline[(k + 1) % n]);
  }
  if (cur) lines.push(cur);
  const cl = ([x, y]) => [Math.min(W, Math.max(0, x)), Math.min(H, Math.max(0, y))];
  return lines.map((pts) => ({ pts: pts.map(cl), closed: false }));
}

// clearance radius kept around a screw centre: half the head plus the clearance
export const screwR = (S) => (S.head || 0.375) / 2 + (S.clear ?? 0.125);
function circlePoly(cx, cy, r, n) {
  const out = [];
  for (let k = 0; k < n; k++) { const a = (2 * Math.PI * k) / n; out.push([cx + (r / Math.cos(Math.PI / n)) * Math.cos(a), cy + (r / Math.cos(Math.PI / n)) * Math.sin(a)]); }
  return out;
}

export function sheetToolpaths(sheet, cfg) {
  const warnings = [];
  const pb = new PathBuilder(cfg.safeZ);
  pb.hopZ = cfg.hopZ ?? 0.1;
  const T = cfg.thickness;
  const geo = sheet.placements.map((pl) => ({ pl, g: placedGeometry(pl), label: pl.label || pl.part.name }));
  const dado = cfg.dadoSameTool || !cfg.dadoTool ? cfg.tool : cfg.dadoTool;
  // Short hops: the next op is on the part just cut (not yet cut free) and the
  // move stays over that part (its outline grown by the tool path) -> only lift
  // to hopZ. Anything else goes up to safe Z.
  const reachR = Math.max(cfg.tool.dia, dado.dia) / 2 + 0.05;
  const regionCache = new Map();
  const regionOf = (pi) => {
    if (!regionCache.has(pi)) regionCache.set(pi, offset([geo[pi].g.outline], reachR, 'miter'));
    return regionCache.get(pi);
  };
  let curPart = null;
  const lowTo = (pi) => (q) => {
    if (curPart !== pi || pb.x == null || cfg.hopZ === 0) return false;
    const a = [pb.x, pb.y], reg = regionOf(pi);
    const n = Math.max(2, Math.ceil(dist(a, q) / 0.25));
    for (let k = 0; k <= n; k++) if (!inOrOn([a[0] + ((q[0] - a[0]) * k) / n, a[1] + ((q[1] - a[1]) * k) / n], reg)) return false;
    return true;
  };
  const sameTool = dado === cfg.tool || (dado.dia === cfg.tool.dia && dado.name === cfg.tool.name);

  // ---- holes: round holes that match a drill (or a loaded bit) become drill ops ----
  const drills = (cfg.drills || []).filter((d) => d.dia > 0);
  const candidates = [dado, cfg.tool, ...drills].filter((t, i, arr) => arr.findIndex((u) => Math.abs(u.dia - t.dia) < 1e-6) === i);
  const matchTool = (d) => candidates.find((t) => Math.abs(t.dia - d) <= DRILL_TOL);
  const drillOps = [];
  const fullDepth = T + (cfg.overcut || 0);
  for (const x of geo) {
    const pockets = [], holes = [];
    for (const p of x.g.pockets) {
      const c = p.loops.length === 1 && asCircle(p.loops[0]);
      const t = c && matchTool(c.d);
      if (t) drillOps.push({ x: c.cx, y: c.cy, center: [c.cx, c.cy], depth: p.depth, tool: t, label: x.label, pi: geo.indexOf(x) });
      else if (c && c.d < dado.dia - 1e-3) warnings.push(`${x.label}: ${c.d.toFixed(3)}" hole has no matching drill — skipped`);
      else pockets.push(p); // bigger round holes (hinge cups) are milled as pockets
    }
    for (const h of x.g.holes) {
      const c = asCircle(h);
      const t = c && matchTool(c.d);
      if (t) drillOps.push({ x: c.cx, y: c.cy, center: [c.cx, c.cy], depth: fullDepth, tool: t, label: x.label, through: true, pi: geo.indexOf(x) });
      else if (c && c.d < cfg.tool.dia + 1e-3) warnings.push(`${x.label}: ${c.d.toFixed(3)}" through hole has no matching drill — skipped`);
      else holes.push(h); // too big for a drill: inside contour, slug drops out
    }
    x.g = { ...x.g, pockets, holes };
  }

  const home = [0, 0];
  const here = () => (pb.x == null ? home : [pb.x, pb.y]);
  let loaded = null;
  // Screw hold-downs: the first bit drills the screw holes before anything
  // else, goes to the park position and stops; the operator drives the screws
  // and continues. The nest left every spot clear of all cuts.
  const SCR = cfg.screws?.on && sheet.screws?.length ? cfg.screws : null;
  let screwsDone = !SCR;
  const drillScrews = (t) => {
    const depth = SCR.depth > 0 ? SCR.depth : T + (cfg.overcut || 0);
    if (depth >= T && t.dia >= (SCR.head || 0.375) - 1e-6) warnings.push(`Screw holes go right through with the ${t.name || t.dia + 'in'} bit, which is as wide as the screw heads (${SCR.head}"): the heads will pull through. Set Hole depth to a counterbore (e.g. 0.25) or use washers.`);
    const peck = t.peck || 0;
    const prevOp = pb.op;
    pb.op = 'screw';
    pb.comment(`Screw holes: ${sheet.screws.length} with ${t.name || t.dia + 'in'}, ${depth.toFixed(3)} deep`);
    for (const q of orderShortest(sheet.screws, home, (q, pos) => dist([q.x, q.y], pos), (q) => [q.x, q.y])) {
      pb.rapidTo(q.x, q.y);
      pb.rapidZ(0.05);
      let z = 0;
      while (z > -depth + 1e-6) {
        const nz = peck > 0 ? Math.max(-depth, z - peck) : -depth;
        if (z < 0) pb.rapidZ(z + 0.02);
        pb.plunge(nz);
        z = nz;
        if (z > -depth + 1e-6) pb.rapidZ(0.05);
      }
      pb.retract();
    }
    const park = cfg.park || { x: 0, y: 0 };
    pb.rapidTo(park.x, park.y);
    pb.pause(`Drive a screw in each of the ${sheet.screws.length} holes just drilled, keep clear of the machine, then continue`);
    pb.op = prevOp;
    curPart = null;
  };
  const load = (t, note) => {
    if (loaded === t) return;
    pb.toolchange(t, note || `${t.name || ''} ${t.dia}in`);
    loaded = t;
    curPart = null;
    if (!screwsDone) { screwsDone = true; drillScrews(t); }
  };
  const drillWith = (t) => {
    const ops = drillOps.filter((o) => o.tool === t);
    if (!ops.length) return;
    load(t);
    const prevOp = pb.op;
    pb.op = 'drill';
    pb.comment(`Drill ${ops.length} hole${ops.length === 1 ? '' : 's'} with ${t.name || t.dia + 'in'}`);
    // entry ipm for the first entryDepth, then drill ipm (handled by plunge); peck 0 = one plunge
    const peck = t.peck || 0;
    for (const o of orderShortest(ops, pb.x == null ? home : [pb.x, pb.y], (o, pos) => dist(o.center, pos), (o) => o.center)) {
      pb.rapidTo(o.x, o.y, lowTo(o.pi)(o.center));
      curPart = o.pi;
      if (pb.z > 0.05) pb.rapidZ(0.05);
      let z = 0;
      while (z > -o.depth + 1e-6) {
        const nz = peck > 0 ? Math.max(-o.depth, z - peck) : -o.depth;
        if (z < 0) pb.rapidZ(z + 0.02); // back down to just above the last peck
        pb.plunge(nz);
        z = nz;
        if (z > -o.depth + 1e-6) pb.rapidZ(0.05); // clear chips
      }
    }
    pb.op = prevOp;
  };

  // ---- pockets ----
  // how far open-ended dados run past the part edge: half the bit (+0.02),
  // but the cutter stays clear of the next part
  const overtravel = () => {
    const want = dado.dia / 2 + 0.02;
    const gap = cfg.sheet?.spacing;
    if (gap == null || cfg.commonLine) return want;   // neighbours are kept clear of exactly (avoidFor)
    const room = gap - dado.dia / 2 - 0.03;
    if (room < want && !overtravel.warned) { overtravel.warned = true; warnings.push(`Part spacing ${gap}" only lets open dados run ${Math.max(0, room).toFixed(3)}" past the edge (half the bit is ${(dado.dia / 2).toFixed(3)}")`); }
    return Math.max(0.02, Math.min(want, room));
  };
  const plans = [];
  // other parts on the sheet, grown by the bit radius + 0.03: no tool centre in there
  const clippedParts = new Set();
  // screw spots: no cutter edge within the screw clearance radius
  const screwDiscs = SCR ? sheet.screws.map((q) => circlePoly(q.x, q.y, screwR(SCR) + dado.dia / 2, 24)) : [];
  const avoidFor = (pi) => {
    const others = geo.filter((_, k) => k !== pi && geo[pi].g.pockets.length).map((o) => o.g.outline);
    const grown = others.length ? offset(others, dado.dia / 2 + 0.03, 'round') : [];   // round: square corners would stop run-outs early near a corner
    return screwDiscs.length ? union([...grown, ...screwDiscs], []) : grown;
  };
  geo.forEach(({ g, label }, pi) => {
    // pockets that touch (floors overlap or share an edge) are one operation
    const regs = g.pockets.map((p) => union(p.loops, []));
    const grow = regs.map((rg) => offset(rg, 0.005, 'miter'));
    const parent = g.pockets.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < regs.length; i++) for (let j = i + 1; j < regs.length; j++) {
      const bi = bbox(grow[i].flat()), bj = bbox(regs[j].flat());
      if (bi.x1 < bj.x0 || bj.x1 < bi.x0 || bi.y1 < bj.y0 || bj.y1 < bi.y0) continue;
      if (area(intersect(grow[i], regs[j])) > 1e-6) parent[find(i)] = find(j);
    }
    const groups = new Map();
    g.pockets.forEach((p, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); });
    for (const members of groups.values()) {
      // wall passes: 'climb' (default), 'conventional', or 'either' (whichever is shorter)
      const fd = cfg.finishDir || 'climb';
      const plan = planGroup(members, g, dado, warnings, label, { finishClimb: fd !== 'conventional', finishEither: fd === 'either', overtravel: overtravel(), avoid: avoidFor(pi), onClip: () => clippedParts.add(label) });
      if (plan) plans.push({ ...plan, pi, id: plans.length, center: [(g.box.x0 + g.box.x1) / 2, (g.box.y0 + g.box.y1) / 2] });
    }
  });
  if (clippedParts.size) warnings.push(`${clippedParts.size} part${clippedParts.size === 1 ? '' : 's'} (${[...clippedParts].slice(0, 4).join(', ')}${clippedParts.size > 4 ? '…' : ''}): a dado runs out toward a part closer than a bit width plus 0.05", so it stops 0.03" short of that part instead of running half the bit past the edge`);
  // Tool order: drilling first, and each bit loaded once with everything it
  // does: drill-only bits (their holes) -> dado bit (holes, then dados) ->
  // profile bit (holes, then cutouts and outlines). When the dado bit is the
  // profile bit that's one load: holes, then each part's dados with its profile.
  for (const t of candidates) if (t !== dado && t !== cfg.tool) drillWith(t);
  const usesDado = plans.length || drillOps.some((o) => o.tool === dado);
  if (usesDado) {
    load(dado, `${sameTool ? 'Tool' : 'Dado tool'}: ${dado.name || ''} ${dado.dia}in`);
    drillWith(dado);
  }
  // Keep the cutter down: a short safe move to the next row is fed at depth;
  // it lifts only when the next start is too far away or the straight move
  // would touch a wall or cut across uncut floor.
  const maxLink = dado.dia * 1.05;
  const maxCleared = cfg.stayDownMax ?? 3;   // inch of travel back over cleared floor before lifting instead
  const rD = dado.dia / 2;
  // where a group can start: its first level's starting rows (either end), or
  // its spiral starts, or its finishing passes
  const startsOfLevel = (L) => {
    if (L.spiral) return L.spiral.map((p) => p[0]);
    const firstRows = L.legPlans.flatMap((lp) => lp[0] || []).flatMap((sg) => [sg[0], sg[1]]);
    if (firstRows.length) return firstRows;
    return L.chains.flatMap((c) => (c.closed ? c.pts : c.either ? [c.pts[0], c.pts[c.pts.length - 1]] : [c.pts[0]]));
  };
  const startsOf = (pl) => [...new Set(pl.levels.map((L) => L.cls))].flatMap((ci) => startsOfLevel(pl.levels.find((L) => L.cls === ci)));
  // only: run just this depth class (a dry run to see where it ends);
  // starts: the start point chosen for each class
  const runGroup = (pl, P, real, only = null, starts = null, order = null) => {
    P.op = 'pocket';
    if (only == null) P.comment(`${pl.label} pocket ${pl.desc}${pl.fromRecords ? ' (cut records)' : ''}`);
    let first = true;
    let cutSegs = [], prevL = null, prevCut = [];
    let sel = null;   // where the first pick of a class is made from (its chosen start)
    const posNow = () => (P.x == null ? home : [P.x, P.y]);
    const pickPos = () => { const p = sel || posNow(); sel = null; return p; };
    let lastCls = -1;
    const seq = order ? order.flatMap((ci) => pl.levels.filter((L) => L.cls === ci)) : pl.levels;
    for (const L of seq) {
      if (only != null && L.cls !== only) continue;
      if (L.cls !== lastCls) {
        lastCls = L.cls; sel = starts ? starts[L.cls] : null;
        // a shallower depth after a deeper one: come straight up first
        if (!first && P.z < L.z - 1e-9) { P.rapidZ(L.z); prevL = null; }
      }
      const okAt = (p) => inOrOn(p, L.allowed) || L.plunges.some((q) =>
        dist(p, q.c) <= q.slack + 0.015 || (q.approach && distToSeg(p, q.approach[0], q.approach[1]) <= 0.015));
      const clearedIn = (segsList, p) => segsList.some(([a, b]) => distToSeg(p, a, b) <= rD * 0.9);
      const stayDown = (a, b) => {
        const Ln = dist(a, b);
        const short = Ln <= maxLink;
        if (!short && Ln > maxCleared) return false;
        const n = Math.max(4, Math.ceil(Ln / 0.02));
        for (let k = 0; k <= n; k++) {
          const p = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
          if (!okAt(p)) return false;
          if (!short && !L.anyLink && !clearedIn(cutSegs, p) && dist(p, a) > rD && dist(p, b) > rD) return false;
        }
        return true;
      };
      const feedTo = (x, y) => { cutSegs.push([[P.x, P.y], [x, y]]); P.feed(x, y, dado.feed); };
      // get to (x, y) at this level's depth
      // Ramp into the cut along the path about to be cut (ahead), at the ramp
      // angle, instead of plunging: start that far along it, come back down to
      // (x, y) while descending, then the path is cut at full depth from there.
      const rampAngle = Math.min(80, cfg.pocketRampAngle ?? 0);
      const rampTo = (x, y, ahead, mode) => {
        const zTop = mode === 'here' ? P.z : L.zTop;
        const dz = zTop - L.z;
        if (!(rampAngle > 0) || dz <= 1e-6 || !ahead.length) return false;
        const want = dz / Math.tan((rampAngle * Math.PI) / 180);
        const pts = [[x, y]];
        let got = 0;
        for (const q of ahead) {
          const a = pts[pts.length - 1], d = dist(a, q);
          if (got + d >= want) { const t = (want - got) / d; pts.push([a[0] + (q[0] - a[0]) * t, a[1] + (q[1] - a[1]) * t]); got = want; break; }
          pts.push([q[0], q[1]]); got += d;
        }
        if (got < 0.02 || dz / got > Math.tan((Math.min(80, rampAngle + 1) * Math.PI) / 180)) return false;   // no room for the ramp: plunge
        const R = pts[pts.length - 1];
        if (mode === 'start') { P.rapidTo(R[0], R[1], real ? lowTo(pl.pi)(R) : false); if (P.z > zTop + 0.05) P.rapidZ(zTop + 0.05); }
        else if (mode === 'hop') { if (P.z < 0.05) P.rapidZ(0.05); P.moves.push({ g: 0, x: R[0], y: R[1], z: P.z }); P.x = R[0]; P.y = R[1]; if (P.z > zTop + 0.05) P.rapidZ(zTop + 0.05); }
        else { for (let k = 1; k < pts.length; k++) P.feed(pts[k][0], pts[k][1], dado.feed); }   // 'here': along floor the last level cleared
        // down the ramp, never faster in Z than the bit's plunge rate
        const z0 = mode === 'here' ? P.z : zTop + 0.02;
        const f = Math.min(dado.feed, (dado.drillFeed || dado.feed) * got / Math.max(1e-6, z0 - L.z));
        let s = 0;
        for (let k = pts.length - 2; k >= 0; k--) {
          s += dist(pts[k], pts[k + 1]);
          P.feed3(pts[k][0], pts[k][1], z0 + ((L.z - z0) * s) / got, f, { ramp: true });
        }
        return true;
      };
      const goTo = (x, y, ahead = []) => {
        if (first) {
          if (!rampTo(x, y, ahead, 'start')) P.startAt(x, y, L.z, real ? lowTo(pl.pi)([x, y]) : false);
          first = false; if (real) curPart = pl.pi; return;
        }
        const here = posNow();
        if (dist(here, [x, y]) < 1e-6) { if (P.z > L.z + 1e-9 && !rampTo(x, y, ahead, 'here')) P.plunge(L.z); return; }
        if (P.z > L.z + 1e-9 && prevL) {
          // new, deeper level: back over the last level's cleared floor, then down
          const n = Math.max(4, Math.ceil(dist(here, [x, y]) / 0.02));
          let ok = dist(here, [x, y]) <= maxCleared;
          for (let k = 0; k <= n && ok; k++) { const p = [here[0] + ((x - here[0]) * k) / n, here[1] + ((y - here[1]) * k) / n]; ok = inOrOn(p, prevL.allowed) && (clearedIn(prevCut, p) || dist(p, here) <= rD || dist(p, [x, y]) <= rD); }
          if (ok) { P.feed(x, y, dado.feed); if (!rampTo(x, y, ahead, 'here')) P.plunge(L.z); return; }
          if (!rampTo(x, y, ahead, 'hop')) P.hopTo(x, y, L.z);
          return;
        }
        if (stayDown(here, [x, y])) feedTo(x, y);
        else if (!rampTo(x, y, ahead, 'hop')) P.hopTo(x, y, L.z);
      };
      const runPath = (path, base) => {
        P.op = base;
        const ahead = [];
        for (let k = 1; k < path.length && path[k][2] !== 'hop'; k++) ahead.push(path[k]);
        goTo(path[0][0], path[0][1], ahead);
        for (let k = 1; k < path.length; k++) {
          const [x, y, tag] = path[k];
          if (tag === 'hop') { P.hopTo(x, y, L.z); continue; }
          P.op = tag === 'relief' ? 'relief' : base;
          feedTo(x, y);
        }
      };
      if (L.spiral) {
        P.op = 'pocket';
        const here = pickPos();
        runPath(L.spiral.reduce((b, p) => (dist(p[0], here) < dist(b[0], here) ? p : b)), 'pocket');
      } else {
        // clearing: in each leg the rows go in its order (farthest from the
        // finished edges first); across legs, the next row is the nearest one
        // the bit can reach without lifting, else the nearest
        P.op = 'pocket';
        const items = [];
        L.legPlans.forEach((lp, li) => lp.forEach((group, rank) => group.forEach((sg) => items.push({ sg, li, rank }))));
        while (items.length) {
          const here = pickPos();
          const minRank = new Map();
          for (const it of items) minRank.set(it.li, Math.min(minRank.get(it.li) ?? Infinity, it.rank));
          const down = !first && P.z < 0 && P.z <= L.z + 1e-9 && dist(here, posNow()) < 1e-9;
          let best = null;
          items.forEach((it, k) => {
            if (it.rank !== minRank.get(it.li)) return;
            it.sg.forEach((e, ei) => {
              const d = dist(e, here);
              const score = (down && stayDown(here, e) ? 0 : 1e6) + d;
              if (!best || score < best.score) best = { score, k, ei };
            });
          });
          const { sg } = items.splice(best.k, 1)[0];
          const [a, b] = best.ei === 0 ? sg : [sg[1], sg[0]];
          P.op = 'pocket';
          goTo(a[0], a[1], [b]);
          P.op = 'pocket';
          feedTo(b[0], b[1]);
        }
        // finishing: every finished edge, nearest pass first
        const inside = (p) => inOrOn(p, L.allowed, 3e-3);
        // shortest tour through the finishing passes (each can run either way)
        const cEntry = (c, pos) => (c.closed ? nearestOnLoop(c.pts, pos).d : c.either ? Math.min(dist(c.pts[0], pos), dist(c.pts[c.pts.length - 1], pos)) : dist(c.pts[0], pos));
        const cExit = (c, pos) => (c.closed ? nearestOnLoop(c.pts, pos).p : c.either ? (dist(c.pts[0], pos) <= dist(c.pts[c.pts.length - 1], pos) ? c.pts[c.pts.length - 1] : c.pts[0]) : c.pts[c.pts.length - 1]);
        const from = pickPos();
        let first1 = true;
        for (const c of L.chains.length > 1 ? orderShortest(L.chains, from, cEntry, cExit, 20) : L.chains) {
          const here = first1 ? from : posNow();
          first1 = false;
          runPath(chainPath(c, here, inside), 'finish');
        }
        for (const q of L.loose) { P.op = 'relief'; goTo(q.c[0], q.c[1]); }
      }
      P.op = 'pocket';
      prevL = L; prevCut = cutSegs; cutSegs = [];
    }
  };
  // ordering: enter at the nearest start; where it ends is found by a dry run
  const pocketEntry = (pl, pos) => Math.min(...startsOf(pl).map((p) => dist(p, pos)));
  const exitMemo = new Map();
  const pocketExit = (pl, pos) => {
    const st = startsOf(pl);
    let k = 0;
    st.forEach((p, i) => { if (dist(p, pos) < dist(st[k], pos)) k = i; });
    const key = `${pl.id}|${k}`;
    if (!exitMemo.has(key)) {
      const dry = new PathBuilder(cfg.safeZ);
      dry.x = st[k][0]; dry.y = st[k][1];
      const keep = curPart;
      const po = planOrder(pl, st[k]);
      runGroup(pl, dry, false, null, po.starts, po.order);
      curPart = keep;
      exitMemo.set(key, [dry.x, dry.y]);
    }
    return exitMemo.get(key);
  };
  // class by class: start each where the trip in plus the trip on to the next
  // class is shortest (each candidate tried in a dry run)
  const jogIpm = cfg.machine?.maxXY ?? 240;
  // minutes, with the machine's real speeds and acceleration
  const movesTime = (moves, from) => machineTime(from ? [{ g: 0, ...from }, ...moves] : moves, cfg).total / 60;
  const classExit = new Map();
  const classTime = new Map();
  const exitOfClass = (pl, ci, start) => {
    const key = `${pl.id}|${ci}|${start[0].toFixed(3)},${start[1].toFixed(3)}`;
    if (!classExit.has(key)) {
      const dry = new PathBuilder(cfg.safeZ);
      dry.x = start[0]; dry.y = start[1];
      const keep = curPart;
      const st = []; st[ci] = start;
      runGroup(pl, dry, false, ci, st);
      curPart = keep;
      classExit.set(key, [dry.x, dry.y]);
      classTime.set(key, movesTime(dry.moves, { x: start[0], y: start[1], z: cfg.safeZ }));
    }
    return classExit.get(key);
  };
  const timeOfClass = (pl, ci, start) => { exitOfClass(pl, ci, start); return classTime.get(`${pl.id}|${ci}|${start[0].toFixed(3)},${start[1].toFixed(3)}`); };
  // Which depth goes first (any order cuts the same shape: a depth not cut yet
  // counts as open either way) and where each starts: every order tried, each
  // depth's start picked by time to get there + time inside + time on to the next.
  const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
  const planOrder = (pl, from) => {
    const present = [...new Set(pl.levels.map((L) => L.cls))];
    let best = null;
    for (const order of (present.length <= 4 ? perms(present) : [present])) {
      const r = chooseStarts(pl, from, order);
      if (!best || r.cost < best.cost) best = { ...r, order };
    }
    return best;
  };
  const chooseStarts = (pl, from, order) => {
    const firstLevel = (ci) => pl.levels.find((L) => L.cls === ci);
    const starts = [];
    let pos = from, total = 0;
    for (let k = 0; k < order.length; k++) {
      const ci = order[k];
      const L = firstLevel(ci);
      if (!L) continue;
      const cands = startsOfLevel(L);
      const nextL = k + 1 < order.length ? firstLevel(order[k + 1]) : null;
      const nextStarts = nextL ? startsOfLevel(nextL) : null;
      // time to get there + time inside (lifts, travel) + time on to the next class
      let best = null;
      const uniq = cands.filter((c, i) => cands.findIndex((q) => dist(q, c) < 1e-6) === i);
      for (const c of uniq) {
        let cost = dist(pos, c) / jogIpm;
        if (best && cost > best.cost) continue;
        cost += timeOfClass(pl, ci, c);
        if (nextStarts) { const ex = exitOfClass(pl, ci, c); cost += Math.min(...nextStarts.map((q) => dist(ex, q))) / jogIpm; }
        if (!best || cost < best.cost) best = { cost, c };
      }
      starts[ci] = best.c;
      total += best.cost;
      pos = exitOfClass(pl, ci, best.c);
    }
    return { starts, cost: total };
  };
  const emitPocket = (pl) => { const po = planOrder(pl, pb.x == null ? home : [pb.x, pb.y]); runGroup(pl, pb, true, null, po.starts, po.order); };
  // same bit for dados and profiles: each part's dados go right before its profile
  const interleave = sameTool && plans.length > 0;
  if (plans.length && !interleave) {
    for (const pl of orderShortest(plans, here(), pocketEntry, pocketExit)) emitPocket(pl);
  }

  // ---- profiles ----
  pb.op = 'profile';
  const tool = cfg.tool;
  const r = tool.dia / 2;
  if (!(sameTool && loaded === dado)) load(tool, `${sameTool ? 'Tool' : 'Profile tool'}: ${tool.name || ''} ${tool.dia}in`);
  loaded = tool;
  if (tool !== dado) drillWith(tool);
  pb.op = 'profile';
  const skin = usesSkin(cfg) ? Math.max(0, Math.min(cfg.onionSkin || 0, T - 0.01)) : 0;
  const full = T + (cfg.overcut || 0);
  const roughTarget = skin > 0 ? T - skin : full;

  const loopsFor = ({ g, label }) => {
    const out = [];
    for (const h of g.holes) {
      const hb = bbox(h);
      if (Math.min(hb.w, hb.h) < tool.dia + 1e-3) { warnings.push(`${label}: cutout smaller than the profile tool — skipped`); continue; }
      for (const inner of offset([h], -r, 'miter')) out.push(cfg.climb ? ensureCW(inner) : ensureCCW(inner));
    }
    const outers = offset([g.outline], r, 'miter').sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
    out.push(cfg.climb ? ensureCCW(outers[0]) : ensureCW(outers[0]));
    return out;
  };
  // tabs: on parts under maxArea sq in (0 = every part); tab top = material left at the bottom
  const tabsOn = usesTabs(cfg) && !!cfg.tabs;
  const tabCfg = tabsOn && cfg.tabs.length > 0 && cfg.tabs.thickness > 0 && cfg.tabs.thickness < T
    ? { ...cfg.tabs, z: -(T - cfg.tabs.thickness) } : null;
  if (tabsOn && !tabCfg) warnings.push('Tabs are on but need a length above zero and a thickness between 0 and the material thickness — no tabs cut');
  const items = geo.map((x, pi) => {
    const a = Math.abs(signedArea(x.g.outline));
    const tabs = tabCfg && (!(tabCfg.maxArea > 0) || a < tabCfg.maxArea) ? tabCfg : null;
    return { ...x, pi, loops: loopsFor(x), area: a, tabs, center: [(x.g.box.x0 + x.g.box.x1) / 2, (x.g.box.y0 + x.g.box.y1) / 2],
             pockets: interleave ? plans.filter((pl) => pl.pi === pi) : [] };
  });
  planSheetTabs(items, tool, sheet, warnings);
  // Shared cut lines: where two parts' outline paths run along the same line
  // (the parts sit exactly the bit apart), that stretch is one cut. Each is
  // recorded on both parts; in each pass whichever part is cut first cuts it.
  let sharedTotal = 0;
  if (cfg.commonLine) {
    for (const x of items) x.shared = [];
    const outer = (x) => x.loops[x.loops.length - 1];
    const boxes = items.map((x) => bbox(outer(x)));
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const A = boxes[i], B = boxes[j];
      if (A.x0 > B.x1 + 0.01 || B.x0 > A.x1 + 0.01 || A.y0 > B.y1 + 0.01 || B.y0 > A.y1 + 0.01) continue;
      const la = outer(items[i]), lb = outer(items[j]);
      for (let ea = 0; ea < la.length; ea++) {
        const a0 = la[ea], a1 = la[(ea + 1) % la.length], La = dist(a0, a1);
        if (La < 0.05) continue;
        const ua = [(a1[0] - a0[0]) / La, (a1[1] - a0[1]) / La];
        for (let eb = 0; eb < lb.length; eb++) {
          const b0 = lb[eb], b1 = lb[(eb + 1) % lb.length], Lb = dist(b0, b1);
          if (Lb < 0.05) continue;
          const ub = [(b1[0] - b0[0]) / Lb, (b1[1] - b0[1]) / Lb];
          if (ua[0] * ub[0] + ua[1] * ub[1] > -0.9999) continue;          // runs the other way along the same line
          const off = (p) => Math.abs((p[0] - a0[0]) * ua[1] - (p[1] - a0[1]) * ua[0]);
          if (off(b0) > 0.004 || off(b1) > 0.004) continue;
          const t0 = (b0[0] - a0[0]) * ua[0] + (b0[1] - a0[1]) * ua[1], t1 = (b1[0] - a0[0]) * ua[0] + (b1[1] - a0[1]) * ua[1];
          const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(La, Math.max(t0, t1));
          if (hi - lo < 0.05) continue;
          const pA0 = [a0[0] + ua[0] * lo, a0[1] + ua[1] * lo], pA1 = [a0[0] + ua[0] * hi, a0[1] + ua[1] * hi];
          const onB = (p) => { const t = Math.max(0, Math.min(Lb, (p[0] - b0[0]) * ub[0] + (p[1] - b0[1]) * ub[1])); return [b0[0] + ub[0] * t, b0[1] + ub[1] * t]; };
          const id = `${i}|${j}|${ea}|${eb}`;
          items[i].shared.push({ id, pts: [pA0, pA1], other: j });
          items[j].shared.push({ id, pts: [onB(pA1), onB(pA0)], other: i });
          sharedTotal += hi - lo;
        }
      }
    }
  }
  const runPart = (x, zs, note, withPockets = false, passDone = null) => {
    if (withPockets && x.pockets.length) {
      // same bit: this part's dados right before its profile, no trip back across the sheet
      for (const pl of orderShortest(x.pockets, here(), pocketEntry, pocketExit, 30)) emitPocket(pl);
      pb.op = 'profile';
    }
    pb.comment(note ? `${x.label} ${note}` : x.label);
    // cutouts first (nearest first), outline last
    const holes = x.loops.slice(0, -1);
    while (holes.length) {
      let bi = 0, bd = Infinity;
      holes.forEach((l, i) => { const d = nearestVertex([l], here()); if (d < bd) { bd = d; bi = i; } });
      contour(pb, holes.splice(bi, 1)[0], zs, tool, null, lowTo(x.pi));
      // a slug cut right through may be loose: don't skim over it
      curPart = zs[zs.length - 1] <= -T + 1e-6 ? null : x.pi;
    }
    // stretches a neighbour already cut in this pass are left out
    const skip = passDone && x.shared ? x.shared.filter((sp) => passDone.has(sp.other)).map((sp) => sp.pts) : [];
    if (skip.length) contourRuns(pb, x.loops[x.loops.length - 1], zs, tool, x.tabs, lowTo(x.pi), skip);
    else contour(pb, x.loops[x.loops.length - 1], zs, tool, x.tabs, lowTo(x.pi));
    if (passDone) passDone.add(x.pi);
    curPart = null; // the outline may have cut it free
  };
  // a part is entered at its nearest dado end (when interleaved) or contour
  // vertex, and left where its outline starts and ends
  const partEntry = (withPockets) => (x, pos) => Math.min(nearestVertex(x.loops, pos),
    ...(withPockets ? x.pockets.map((pl) => pocketEntry(pl, pos)) : [Infinity]));
  const partExit = (x, pos) => startNearest(x.loops[x.loops.length - 1], pos, !x.tabs)[0];
  const byTravel = (list, withPockets = false) => orderShortest(list, here(), partEntry(withPockets), partExit);
  // Shared cut lines: where a part's cut ends depends on which neighbours were
  // cut before it, so the next part is chosen from where the bit really is:
  // the nearest start of what's left to cut.
  const remainingStarts = (x, done, withPockets) => {
    const pts = [];
    if (withPockets && x.pockets.length) for (const pl of x.pockets) pts.push(...startsOf(pl));
    for (const l of x.loops.slice(0, -1)) pts.push(...l);
    const outer = x.loops[x.loops.length - 1];
    const skip = x.shared ? x.shared.filter((sp) => done.has(sp.other)) : [];
    if (!skip.length) pts.push(...outer);
    else for (const sp of skip) pts.push(sp.pts[0], sp.pts[1]);   // the leftover runs start and end at the shared stretches' ends
    return pts;
  };
  // Shared cut lines, one pass: every part's outline is pieces still to cut;
  // the nearest piece is cut next, whichever part it belongs to, so the cut
  // flows from part to part along the lines. A part's dados and cutouts are
  // done before its first piece. Cutting a piece that runs along a shared line
  // marks it cut for the neighbour too.
  const newPass = () => {
    const st = new Map();   // pi -> { L, cum, P, cut: [[a, b]], started }
    for (const x of items) {
      const L = x.loops[x.loops.length - 1];
      const cum = cumOf(L);
      st.set(x.pi, { L, cum, P: cum[cum.length - 1], cut: [], started: false });
    }
    return st;
  };
  const runPieces = (list, zs, note, withPockets, st) => {
    const mark = (pi, iv) => { const S = st.get(pi); S.cut.push(iv); };
    const leftOf = (x) => {
      const S = st.get(x.pi);
      if (!S.cut.length) return [{ closed: true }];
      // merge cut intervals; what's left between them (wrapping round the start)
      const c = S.cut.slice().sort((a, b) => a[0] - b[0]);
      const m = [];
      for (const iv of c) { if (m.length && iv[0] <= m[m.length - 1][1] + 0.02) m[m.length - 1][1] = Math.max(m[m.length - 1][1], iv[1]); else m.push([...iv]); }
      const out = [];
      for (let k = 0; k < m.length; k++) {
        const a = m[k][1], b = k + 1 < m.length ? m[k + 1][0] : m[0][0] + S.P;
        if (b - a > 0.02) out.push({ a, b });
      }
      return out;
    };
    const ptAt = (S, s) => { const u = (((s % S.P) + S.P) % S.P) / S.P; return atU(S.L, S.cum, S.P, u); };
    const piecePts = (S, a, b) => {
      const out = [ptAt(S, a)];
      for (let lap = 0; lap < 2; lap++) for (let i = 0; i < S.L.length; i++) { const t = S.cum[i] + lap * S.P; if (t > a + 1e-9 && t < b - 1e-9) out.push(S.L[i]); }
      out.push(ptAt(S, b));
      return out;
    };
    const firstFwd = (zs.length - 1) % 2 === 0;
    const left = new Set(list.map((x) => x.pi));
    const startPart = (x) => {
      const S = st.get(x.pi);
      if (S.started) return;
      S.started = true;
      if (withPockets && x.pockets.length) {
        for (const pl of orderShortest(x.pockets, here(), pocketEntry, pocketExit, 30)) emitPocket(pl);
        pb.op = 'profile';
      }
      pb.comment(note ? `${x.label} ${note}` : x.label);
      const holes = x.loops.slice(0, -1);
      while (holes.length) {
        let bi = 0, bd = Infinity;
        holes.forEach((l, i) => { const d = nearestVertex([l], here()); if (d < bd) { bd = d; bi = i; } });
        contour(pb, holes.splice(bi, 1)[0], zs, tool, null, lowTo(x.pi));
        curPart = zs[zs.length - 1] <= -T + 1e-6 ? null : x.pi;
      }
    };
    // after cutting [a, b] of x's outline: shared stretches inside it are cut for the neighbour too
    const markShared = (x, a, b) => {
      const S = st.get(x.pi);
      for (const sp of x.shared || []) {
        const iv = spansToIntervals(S.L, [sp.pts])[0];
        if (!iv) continue;
        const inside = (t) => (t >= a - 0.01 && t <= b + 0.01) || (t + S.P >= a - 0.01 && t + S.P <= b + 0.01);
        if (!inside(iv[0]) || !inside(iv[1])) continue;
        const o = items[sp.other], So = st.get(o.pi);
        const ivo = spansToIntervals(So.L, [[sp.pts[1], sp.pts[0]]])[0];
        if (ivo) mark(o.pi, ivo);
      }
    };
    while (left.size) {
      const h = here();
      let best = null;
      for (const pi of left) {
        const x = items[pi];
        for (const pc of leftOf(x)) {
          const S = st.get(pi);
          const cands = pc.closed ? [nearestOnLoop(S.L, h).p] : [ptAt(S, firstFwd ? pc.a : pc.b)];
          for (const c of cands) { const d = dist(c, h); if (!best || d < best.d) best = { d, x, pc }; }
        }
        if (!leftOf(x).length) { startPart(x); left.delete(pi); }
      }
      if (!best) break;
      const { x, pc } = best;
      startPart(x);
      const S = st.get(x.pi);
      // perimeter last for the neighbour too: its holes, dados and cutouts
      // before this piece cuts the line it shares with it
      {
        const a = pc.closed ? 0 : pc.a, b = pc.closed ? S.P : pc.b;
        for (const sp of x.shared || []) {
          const o = items[sp.other];
          if (st.get(o.pi).started) continue;
          const iv = spansToIntervals(S.L, [sp.pts])[0];
          if (!iv) continue;
          const inside = (t) => (t >= a - 0.01 && t <= b + 0.01) || (t + S.P >= a - 0.01 && t + S.P <= b + 0.01);
          if (inside(iv[0]) && inside(iv[1])) startPart(o);
        }
      }
      pb.op = 'profile';
      if (pc.closed) {
        contour(pb, S.L, zs, tool, x.tabs, lowTo(x.pi));
        S.cut.push([0, S.P]);
        markShared(x, 0, S.P);
      } else {
        const pts = piecePts(S, pc.a, pc.b);
        const len = pc.b - pc.a;
        const tabIv = !x.tabs ? [] : x.tabs.spans ? spansToIntervals(S.L, x.tabs.spans) : placeTabs(S.L, x.tabs, tool);
        const iv = tabIv.flatMap(([t0, t1]) => [[t0, t1], [t0 + S.P, t1 + S.P]]).filter(([t0, t1]) => t0 >= pc.a - 1e-6 && t1 <= pc.b + 1e-6).map(([t0, t1]) => [t0 - pc.a, t1 - pc.a]);
        zs.forEach((z, k) => {
          const fwd = (zs.length - 1 - k) % 2 === 0;
          const path = fwd ? pts : pts.slice().reverse();
          const ivd = fwd ? iv : iv.map(([t0, t1]) => [len - t1, len - t0]).reverse();
          pb.startAt(path[0][0], path[0][1], z, lowTo(x.pi)(path[0]));
          walkRun(pb, path, z, tool, x.tabs, ivd);
        });
        S.cut.push([pc.a, pc.b]);
        markShared(x, pc.a, pc.b);
      }
      curPart = leftOf(x).length ? x.pi : null;   // cut free once its whole outline is cut
      if (!leftOf(x).length) left.delete(x.pi);
    }
  };
  const runList = (list, zs, note, withPockets, done, st) => {
    if (st) { runPieces(list, zs, note, withPockets, st); return; }
    for (const x of byTravel(list, withPockets)) runPart(x, zs, note, withPockets, done);
  };
  // pass that frees the parts: small parts first (they lose hold-down soonest),
  // shortest travel within each group. Each group is its own trip across the
  // sheet, so keep the threshold to genuinely small parts (0 = one trip).
  const SMALL = cfg.smallPartArea ?? 50; // sq in
  const freeing = (zs, note, withPockets = false) => {
    // tabbed parts stay put, so only untabbed small parts need a trip of their own
    const early = (x) => x.area < SMALL && !x.tabs;
    const done = new Set();
    const st = cfg.commonLine && items.some((x) => x.shared?.length) ? newPass() : null;   // one record per pass, across both groups
    for (const bucket of [items.filter(early), items.filter((x) => !early(x))]) {
      runList(bucket, zs, note, withPockets, done, st);
    }
  };

  const roughZs = levels(roughTarget, tool.stepdown);
  if (skin > 0) {
    pb.comment(`Profiles to ${roughTarget.toFixed(3)} (onion skin ${skin.toFixed(3)})${interleave ? ', each part\'s dados first' : ''}`);
    runList(items, roughZs, null, interleave, new Set(), cfg.commonLine && items.some((x) => x.shared?.length) ? newPass() : null);
    pb.comment('Onion skin passes');
    freeing([-full], 'skin');
  } else {
    pb.comment(`Profiles full depth${interleave ? ', each part\'s dados first' : ''}`);
    freeing(roughZs, null, interleave);
  }
  // Offcuts kept as remnants: cut free along their inside edges (the edges on
  // the stock's own edges are left as they are), last, full depth.
  if (cfg.remnants?.cutFree && sheet.offcuts?.length && sheet.w && sheet.h) {
    const fullZs = levels(full, tool.stepdown);
    for (const oc of sheet.offcuts) {
      for (const line of offcutCutLines(oc, sheet.w, sheet.h, r)) {
        pb.comment(`Cut offcut free ${oc.w.toFixed(2)} x ${oc.h.toFixed(2)} (keep as a remnant)`);
        let pts = line.pts;
        if (dist(pts[pts.length - 1], here()) < dist(pts[0], here())) pts = pts.slice().reverse();
        fullZs.forEach((z, i) => {
          if (i === 0) pb.startAt(pts[0][0], pts[0][1], z);
          else if (line.closed) pb.plunge(z);
          else { pts = pts.slice().reverse(); pb.plunge(z); }   // open line: back and forth, staying down
          for (let k = 1; k < pts.length; k++) pb.feed(pts[k][0], pts[k][1], tool.feed);
          if (line.closed) pb.feed(pts[0][0], pts[0][1], tool.feed);
        });
        pb.retract();
      }
    }
  }
  if (pb.z < pb.safeZ) pb.retract();

  // stats
  let rapidLen = 0, cutLen = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = 0;
  let prev = null;
  for (const m of pb.moves) {
    if (m.x == null) continue;
    if (prev && m.g === 1) cutLen += Math.hypot(m.x - prev.x, m.y - prev.y, m.z - prev.z);
    if (prev && m.g === 0) rapidLen += Math.hypot(m.x - prev.x, m.y - prev.y);
    minX = Math.min(minX, m.x); minY = Math.min(minY, m.y); maxX = Math.max(maxX, m.x); maxY = Math.max(maxY, m.y);
    minZ = Math.min(minZ, m.z);
    prev = m;
  }
  const mt = machineTime(pb.moves, cfg);
  return { moves: pb.moves, warnings, stats: { sharedLength: sharedTotal, cutLength: cutLen, rapidLength: rapidLen, estMinutes: mt.total / 60, time: mt, minX, minY, maxX, maxY, minZ } };
}
