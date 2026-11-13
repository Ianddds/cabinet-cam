// Custom-shape nesting: custom (non-cabinet) parts whose outline isn't a
// rectangle are fitted by their true outline, at any angle their grain allows,
// into the space the rectangle nest left on its sheets (new sheets only when
// nothing fits). Cabinet parts and rectangular custom parts are untouched: the
// rectangle nester places them first, exactly as before.
//
// How a part is fitted: for one angle, the places its corner can go without
// touching anything are the sheet's usable area less, for every part already
// there, that part grown by the spacing and swept around the new part's outline
// (a Minkowski sum, the "no-fit polygon"). The best corner of what's left wins:
// against the parts already on the sheet, away from the stock's zero corner, so
// the offcut keeps that corner as in the rectangle nest.
//
// Rotation: grain along the part (or across it) allows a half turn only (the
// grain still runs the same way); grainless / "Any" parts (or Respect grain
// off) turn in steps of opts.shapeStep degrees.

const SCALE = 1e4;          // Clipper works in integers: 0.0001"
const SIMPLIFY = 0.004;     // outlines are thinned to this (inch) for fitting...
const SHUFFLES = 5;        // extra fixed shuffles of the order tried, besides the sorted ones
const SLACK = 0.01;         // ...so obstacles grow this much more than the spacing (both outlines thinned)

const L = () => {
  const c = globalThis.ClipperLib;
  if (!c) throw new Error('ClipperLib not loaded');
  return c;
};
const toPath = (pts) => pts.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
const fromPath = (p) => p.map((q) => [q.X / SCALE, q.Y / SCALE]);

const areaOf = (pts) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a) / 2;
};

// A part whose outline isn't its bounding rectangle (notches, angles, curves).
export function isShapeOutline(p) {
  if (!p.outline || p.outline.length < 3) return false;
  return areaOf(p.outline) < p.width * p.height * 0.999;
}

// Where to put a label on a placed part: its box centre, or for a custom shape
// the centre of its area (a triangle's or an L's box centre can be off the part).
export function labelPoint(pl, g) {
  if (!pl.xf) return [(g.box.x0 + g.box.x1) / 2, (g.box.y0 + g.box.y1) / 2];
  const o = g.outline;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
    const k = o[j][0] * o[i][1] - o[i][0] * o[j][1];
    a += k; cx += (o[j][0] + o[i][0]) * k; cy += (o[j][1] + o[i][1]) * k;
  }
  return Math.abs(a) < 1e-9 ? [(g.box.x0 + g.box.x1) / 2, (g.box.y0 + g.box.y1) / 2] : [cx / (3 * a), cy / (3 * a)];
}

// Custom part fitted by its outline (only when a rotation step is set).
export function isShapePart(p, opts) {
  if (!(opts?.shapeStep > 0)) return false;
  if (p.shape !== undefined) return !!p.shape;
  return !!p.custom && isShapeOutline(p);
}

// Douglas-Peucker on a closed loop (fewer points to sweep; arcs come in dense)
function thin(pts, tol) {
  if (pts.length <= 8) return pts;
  // split the loop at the point farthest from the first, thin each half
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
  const ring = [...pts, pts[0]];
  const keep = new Uint8Array(ring.length);
  keep[0] = 1; keep[far] = 1;
  const run = (a, b) => {
    let worst = -1, wi = -1;
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((ring[i][0] - ax) * dx + (ring[i][1] - ay) * dy) / L2));
      const d = Math.hypot(ring[i][0] - ax - t * dx, ring[i][1] - ay - t * dy);
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > tol) { keep[wi] = 1; run(a, wi); run(wi, b); }
  };
  run(0, far); run(far, ring.length - 1);
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out.length >= 3 ? out : pts;
}

// The part (turned over first if mirror: y -> -y, which keeps the grain along
// X) turned `deg` degrees and moved so its bounding box starts at 0,0.
// { pts, w, h, minx, miny } (pts are the thinned outline, for fitting)
function turned(part, deg, mirror = false) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const src = mirror ? part.outline.map(([x, y]) => [x, -y]).reverse() : part.outline;   // reversed: same winding
  const r = src.map(([x, y]) => [c * x - s * y, s * x + c * y]);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of r) { minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); }
  const pts = thin(r.map(([x, y]) => [x - minx, y - miny]), SIMPLIFY);
  return { pts, w: maxx - minx, h: maxy - miny, minx, miny };
}

const uidOf = (cache, part) => {
  if (!cache.uids.has(part)) cache.uids.set(part, cache.uids.size + 1);
  return cache.uids.get(part);
};

// An obstacle: path grown by d, kept at its own origin with its offset.
function obstacle(pts, ox, oy, key, d, cache) {
  let local = cache.grown.get(key);
  if (!local) { local = grow([toPath(pts)], d)[0]; cache.grown.set(key, local); }
  return { local, key, ox: Math.round(ox * SCALE), oy: Math.round(oy * SCALE) };
}

// Turned outlines, per part object (ids aren't always unique), angle and side.
function turnedCached(cache, part, deg, mirror = false) {
  let m = cache.get(part);
  if (!m) { m = new Map(); cache.set(part, m); }
  const k = `${deg}${mirror ? 'm' : ''}`;
  let t = m.get(k);
  if (!t) { t = turned(part, deg, mirror); t.path = toPath(t.pts); t.key = `S${uidOf(cache, part)}@${k}`; m.set(k, t); }
  return t;
}

// A part can be turned over (machined from its other face) when it has nothing
// cut into one face only: no dados or pockets. Turning over doesn't change the
// way the grain runs.
export const canTurnOver = (part, opts) => opts.shapeFlip !== false && !(part.pockets?.length);

// Ways a part may lie: [{ deg, mirror }].
function posesFor(part, opts) {
  const grain = opts.respectGrain ? part.grain : 'none';
  let degs;
  if (grain === 'length') degs = [0, 180];
  else if (grain === 'width') degs = [90, 270];
  else {
    const step = Math.max(1, Math.min(180, opts.shapeStep || 90));
    degs = [];
    for (let d = 0; d < 360 - 1e-9; d += step) degs.push(+d.toFixed(6));
  }
  const out = degs.map((deg) => ({ deg, mirror: false }));
  if (canTurnOver(part, opts)) for (const deg of degs) out.push({ deg, mirror: true });
  return out;
}

function clip(type, subj, clp, fill = 'nonzero') {
  const C = L();
  const c = new C.Clipper();
  c.AddPaths(subj, C.PolyType.ptSubject, true);
  if (clp.length) c.AddPaths(clp, C.PolyType.ptClip, true);
  const out = new C.Paths();
  const ft = fill === 'nonzero' ? C.PolyFillType.pftNonZero : C.PolyFillType.pftEvenOdd;
  c.Execute(type, out, ft, ft);
  return out;
}

// Grown by d. Mitred corners (squared off at sharp ones) always reach at least
// as far as the bit's round path, so the clearance is never short.
function grow(paths, d) {
  const C = L();
  const co = new C.ClipperOffset(2, 0.001 * SCALE);
  co.AddPaths(paths, C.JoinType.jtMiter, C.EndType.etClosedPolygon);
  const out = new C.Paths();
  co.Execute(out, d * SCALE);
  return out;
}

// Where the moving part's corner (0,0 of its turned box) can't go next to one
// obstacle: the obstacle swept around the part. It doesn't depend on where the
// obstacle is, so it's worked out once per pair of shapes (in the obstacle's own
// coordinates) and moved into place. Obstacles are already grown by the spacing.
//   obstacle: { local (path at its own origin), key, ox, oy (scaled offset) }
function noFitOne(ob, moving, movingKey, nfpCache) {
  const C = L();
  const k = `${ob.key}|${movingKey}`;
  let nf = nfpCache.get(k);
  if (!nf) {
    const neg = moving.map((q) => ({ X: -q.X, Y: -q.Y }));
    // (Clipper adds the obstacle's inside to its sweep; the part at a corner of
    // the obstacle goes in too, or a part bigger than it could swallow it)
    const swept = C.Clipper.MinkowskiSum(neg, [ob.local], true);
    const around = neg.map((q) => ({ X: q.X + ob.local[0].X, Y: q.Y + ob.local[0].Y }));
    nf = clip(C.ClipType.ctUnion, [...swept, around], []);
    nfpCache.set(k, nf);
  }
  return nf.map((poly) => poly.map((q) => ({ X: q.X + ob.ox, Y: q.Y + ob.oy })));
}

// Usable area for the corner of a w x h box: the stock's usable rectangles shrunk
// by the box (an L remnant is its two rectangles).
function fitArea(stock, w, h) {
  const out = [];
  for (const r of stock) {
    const x0 = r.x0, y0 = r.y0, x1 = r.x1 - w, y1 = r.y1 - h;
    if (x1 < x0 - 1e-9 || y1 < y0 - 1e-9) continue;
    // a hair of area so an exact fit isn't lost
    const e = 1 / SCALE;
    out.push(toPath([[x0, y0], [x1 + e, y0], [x1 + e, y1 + e], [x0, y1 + e]]));
  }
  return out;
}

// Best spot for one part on one sheet in its allowed poses: { deg, mirror, x, y, t, score } or null.
function bestSpot(sh, part, poses, cache, opts) {
  const C = L();
  let best = null;
  for (const { deg, mirror } of poses) {
    const t = turnedCached(cache, part, deg, mirror);
    const area = fitArea(sh.stock, t.w, t.h);
    if (!area.length) continue;
    const blocked = sh.obstacles.flatMap((ob) => noFitOne(ob, t.path, t.key, cache.nfp));
    const free = blocked.length ? clip(C.ClipType.ctDifference, area, blocked) : area;
    for (const poly of free) {
      for (const q of poly) {
        const x = q.X / SCALE, y = q.Y / SCALE;
        // keep the shapes on this sheet in as short a run from their end as it
        // can (a tight group, a long clear offcut), then as low (or high) as it
        // goes, then hard against the end; square angles win a tie
        const ext = sh.gx > 0 ? sh.extEnd - Math.min(sh.ext, x) : Math.max(sh.ext, x + t.w) - sh.extEnd;
        const side = sh.gy < 0 ? y : sh.sheet.h - (y + t.h);
        const toEnd = sh.gx > 0 ? sh.extEnd - (x + t.w) : x - sh.extEnd;
        const score = Math.round(ext * 100) * 1e6 + Math.round(side * 100) * 10 + toEnd * 1e-3 + (deg % 90 ? 1 : 0) + (mirror ? 0.5 : 0);
        if (!best || score < best.score - 1e-9) best = { deg, mirror, x, y, t, score };
      }
    }
  }
  return best;
}

// Rectangles (inch) of an offcut list less the boxes in `boxes`, keeping pieces
// worth keeping.
function trimOffcuts(offcuts, boxes, min) {
  const minus = (a, b) => {
    if (b.x >= a.x + a.w || b.x + b.w <= a.x || b.y >= a.y + a.h || b.y + b.h <= a.y) return [a];
    const out = [];
    if (b.x > a.x) out.push({ x: a.x, y: a.y, w: b.x - a.x, h: a.h });
    if (b.x + b.w < a.x + a.w) out.push({ x: b.x + b.w, y: a.y, w: a.x + a.w - b.x - b.w, h: a.h });
    if (b.y > a.y) out.push({ x: a.x, y: a.y, w: a.w, h: b.y - a.y });
    if (b.y + b.h < a.y + a.h) out.push({ x: a.x, y: b.y + b.h, w: a.w, h: a.y + a.h - b.y - b.h });
    return out;
  };
  const ok = (r) => Math.min(r.w, r.h) >= min.side - 1e-6 && r.w * r.h >= min.area - 1e-6;
  let pieces = [];
  for (const oc of offcuts) {
    let rs = [oc.rects?.length > 1 ? oc.rects : [oc]].flat().map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
    const hit = boxes.some((b) => rs.some((r) => !(b.x >= r.x + r.w || b.x + b.w <= r.x || b.y >= r.y + r.h || b.y + b.h <= r.y)));
    if (!hit) { pieces.push(oc); continue; }
    for (const b of boxes) rs = rs.flatMap((r) => minus(r, b));
    pieces.push(...rs.filter(ok));
  }
  // overlapping candidates (the minus makes maximal strips): keep the biggest, drop overlaps
  pieces.sort((a, b) => b.w * b.h - a.w * a.h);
  const out = [];
  for (const p of pieces) {
    const rr = p.rects?.length > 1 ? p.rects : [p];
    if (out.some((q) => (q.rects?.length > 1 ? q.rects : [q]).some((a) => rr.some((b) => a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9)))) continue;
    out.push(p);
  }
  return out;
}

// The nest with the custom shapes added. parts: the group's parts (all of them;
// only shapes are taken). Returns a new nest object (sheets copied).
// spots: where each shape went last time (from a result's .spots) - placed there
// again without fitting, for redraws of the same layout.
export function placeShapes(nest, parts, opts, spots = null) {
  const shapes = parts.filter((p) => p.include !== false && (p.qty || 1) > 0 && isShapePart(p, opts));
  if (!shapes.length) return nest;
  // shapes never share cut lines, so they keep the normal part spacing even when
  // the cabinet parts sit one bit apart (else a dado running off a shape's edge
  // would reach its neighbour)
  const sp = Math.max(opts.shapeSpacing ?? opts.spacing ?? 0, opts.spacing || 0);
  const pad = opts.commonLine ? opts.exitPad || 0 : 0;
  const min = opts.remnantMin || { side: 8, area: 288 };
  const cache = new Map();   // part -> angle -> turned outline
  cache.uids = new Map();    // part -> number (for keys)
  cache.grown = new Map();   // obstacle key -> grown outline at its origin
  cache.nfp = new Map();     // obstacle key | moving key -> no-fit area at the obstacle's origin

  // items, biggest first (copies together)
  const items = [];
  for (const p of shapes) for (let i = 0; i < (p.qty || 1); i++) items.push({ part: p, copy: i + 1, area: areaOf(p.outline) });
  items.sort((a, b) => b.area - a.area || String(a.part.name).localeCompare(String(b.part.name)) || a.copy - b.copy);

  const fullStock = () => {
    const tx = Number.isFinite(opts.endTrim) && opts.endTrim >= 0 ? opts.endTrim : opts.trim;
    return [{ x0: tx, y0: opts.trim, x1: opts.sheetW - tx, y1: opts.sheetH - opts.trim }];
  };
  const stateOf = (sheet) => {
    const t = sheet.trim ?? opts.trim, tx = sheet.trimX ?? t;
    const stock = sheet.remnant?.rects?.length > 1
      ? sheet.remnant.rects.map((r) => ({ x0: r.x + t, y0: r.y + t, x1: r.x + r.w - t, y1: r.y + r.h - t }))
      : [{ x0: tx, y0: t, x1: sheet.w - tx, y1: sheet.h - t }];
    // what's there: rectangle parts by their box (with any exit pad), screws by their square
    // (each obstacle grown on its own and never merged: merged ones enclose the
    // gaps between parts as holes, and Clipper's Minkowski sum gets holes wrong)
    const d = sp + SLACK;
    const obstacles = [];
    for (const pl of sheet.placements) {
      const b = pl.box || boxOf(pl);
      const w = b.x1 - b.x0 + 2 * pad, h = b.y1 - b.y0 + 2 * pad;
      obstacles.push(obstacle([[0, 0], [w, 0], [w, h], [0, h]], b.x0 - pad, b.y0 - pad, `R${w.toFixed(4)}x${h.toFixed(4)}`, d, cache));
    }
    const R = opts.screws?.R || 0;
    for (const q of sheet.screws || []) if (R) obstacles.push(obstacle([[0, 0], [2 * R, 0], [2 * R, 2 * R], [0, 2 * R]], q.x - R, q.y - R, `Q${R}`, d, cache));
    // parts gather on the side away from the kept offcut (it holds the zero corner)
    let cx = 0, cy = 0, n = 0;
    for (const pl of sheet.placements) { const b = pl.box || boxOf(pl); cx += (b.x0 + b.x1) / 2; cy += (b.y0 + b.y1) / 2; n++; }
    const gx = n ? (cx / n >= sheet.w / 2 ? 1 : -1) : 1;
    const gy = n ? (cy / n >= sheet.h / 2 ? 1 : -1) : -1;
    const usable = stock.reduce((a, r) => a + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
    const taken = sheet.placements.reduce((a, pl) => { const b = pl.box || boxOf(pl); return a + (b.x1 - b.x0 + sp) * (b.y1 - b.y0 + sp); }, 0);
    // the end the shapes pack from, and how far along they reach so far
    const extEnd = gx > 0 ? Math.max(...stock.map((r) => r.x1)) : Math.min(...stock.map((r) => r.x0));
    return { sheet, stock, obstacles, gx, gy, added: [], freeArea: usable - taken, extEnd, ext: extEnd };
  };

  // One pass: the shapes in this order, each to the first sheet it fits on.
  // replay: [item index] -> [sheet, deg, x, y] from an earlier pass (no fitting)
  const pass = (order, replay = null) => {
    const sheets = nest.sheets.map((s) => ({ ...s, placements: s.placements.map((pl) => ({ ...pl, box: pl.box || boxOf(pl) })) }));
    const states = sheets.map(stateOf);
    const unplaced = [...(nest.unplaced || [])];

    const used = [];   // where each item (by index) went: [sheet index, deg, x, y] or null
    for (const [n, it] of order.map((k) => [k, items[k]])) {
      const angles = posesFor(it.part, opts);
      let spot = null, st = null;
      const again = replay?.[n];
      if (replay) {
        // replay: same sheet, angle and spot as last time
        if (!again) { unplaced.push({ name: it.part.name, reason: 'Does not fit on the sheet at any angle its grain allows' }); used[n] = null; continue; }
        while (states.length <= again[0]) {
          const blank = { w: opts.sheetW, h: opts.sheetH, trim: opts.trim, trimX: fullStock()[0].x0, screws: [], screwsMissing: opts.screws?.R ? 5 : 0, screwsThin: 0, screwsInKeeper: 0, remnant: null, placements: [], offcuts: [], offcut: null, shapesOnly: true };
          sheets.push(blank); const s = stateOf(blank); s.stock = fullStock(); states.push(s);
        }
        const t = turnedCached(cache, it.part, again[1], !!again[4]);
        st = states[again[0]];
        spot = { deg: again[1], mirror: !!again[4], x: again[2], y: again[3], t };
      }
      for (const s of replay ? [] : states) {
        if (s.sheet.remnant && !opts.shapesOnRemnants) continue;
        if (s.freeArea < it.area) continue;   // not enough room left anywhere on it
        spot = bestSpot(s, it.part, angles, cache, opts);
        if (spot) { st = s; break; }
      }
      if (!spot && !replay) {
        // a new full sheet
        const blank = { w: opts.sheetW, h: opts.sheetH, trim: opts.trim, trimX: fullStock()[0].x0, screws: [], screwsMissing: opts.screws?.R ? 5 : 0, screwsThin: 0, screwsInKeeper: 0, remnant: null, placements: [], offcuts: [], offcut: null, shapesOnly: true };
        const s = stateOf(blank);
        s.stock = fullStock();
        spot = bestSpot(s, it.part, angles, cache, opts);
        if (!spot) { unplaced.push({ name: it.part.name, reason: 'Does not fit on the sheet at any angle its grain allows' }); used[n] = null; continue; }
        sheets.push(blank); states.push(s); st = s;
      }
      used[n] = [states.indexOf(st), spot.deg, spot.x, spot.y, spot.mirror ? 1 : 0];
      const { deg, x, y, t } = spot;
      const pl = {
        part: it.part, copy: it.copy,
        label: it.part.sourceNames?.[it.copy - 1] || it.part.name,
        cabinet: it.part.sourceCabinets?.[it.copy - 1] ?? it.part.cabinet,
        x, y, rotated: false, angle: deg, mirror: !!spot.mirror,
        // sheet point = turn(part point) + (tx, ty)
        xf: { a: deg, m: !!spot.mirror, tx: x - t.minx, ty: y - t.miny },
        box: { x0: x, y0: y, x1: x + t.w, y1: y + t.h },
        shape: true,
      };
      st.sheet.placements.push(pl);
      st.added.push(pl);
      st.freeArea -= it.area;
      st.ext = st.gx > 0 ? Math.min(st.ext, x) : Math.max(st.ext, x + t.w);
      if (!replay) st.obstacles.push(obstacle(t.pts, x, y, t.key, sp + SLACK, cache));
    }
    // how good: fewest left over, fewest sheets, then the shortest runs of shapes
    const run = states.reduce((a, s2) => a + (s2.added.length ? Math.abs(s2.ext - s2.extEnd) : 0), 0);
    return { sheets, states, unplaced, used, order, cost: [unplaced.length, sheets.length, run] };
  };

  // several orders (fixed, so the same job always gives the same layout); keep the best
  let best;
  if (spots?.order) best = pass(spots.order, spots.at);
  else {
    const idx = items.map((_, k) => k);
    const dims = (k) => { const p = items[k].part; return [Math.max(p.width, p.height), Math.min(p.width, p.height)]; };
    const orders = [
      idx,                                                                   // biggest area first
      idx.slice().sort((a, b) => dims(b)[0] - dims(a)[0] || a - b),           // longest first
      idx.slice().sort((a, b) => dims(b)[1] - dims(a)[1] || a - b),           // widest first
    ];
    const rand = seeded(items.length * 7919 + 17);
    for (let k = 0; k < SHUFFLES; k++) {
      const o = idx.slice();
      for (let m = 0; m < Math.max(2, o.length / 3); m++) { const i = Math.floor(rand() * o.length), j = Math.floor(rand() * o.length); [o[i], o[j]] = [o[j], o[i]]; }
      orders.push(o);
    }
    const better = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i] - 1e-6) return true; if (a[i] > b[i] + 1e-6) return false; } return false; };
    for (const o of orders) { const r = pass(o); if (!best || better(r.cost, best.cost)) best = r; }
  }
  const { sheets, states, unplaced, used } = best;

  // offcuts: what the shapes took out of the kept ones; a shapes-only sheet
  // keeps the clear strip on the zero-corner side
  for (const s of states) {
    if (!s.added.length) continue;
    const sh = s.sheet;
    const boxes = s.added.map((pl) => ({ x: pl.box.x0 - sp, y: pl.box.y0 - sp, w: pl.box.x1 - pl.box.x0 + 2 * sp, h: pl.box.y1 - pl.box.y0 + 2 * sp }));
    if (sh.shapesOnly) {
      const minX = Math.min(...sh.placements.map((pl) => pl.box.x0));
      const strip = { x: 0, y: 0, w: Math.max(0, minX - sp), h: sh.h };
      sh.offcuts = trimOffcuts([strip], [], min).filter((r) => r.w > 0);
      delete sh.shapesOnly;
    } else {
      sh.offcuts = trimOffcuts(sh.offcuts || [], boxes, min);
    }
    sh.offcut = sh.offcuts[0] || null;
    sh.yield = sh.placements.reduce((a, pl) => a + (pl.shape ? areaOf(pl.part.outline) : pl.part.width * pl.part.height), 0) / (sh.w * sh.h);
  }
  return { ...nest, sheets, fullSheets: sheets.filter((x) => !x.remnant).length, unplaced, shapes: items.length, spots: { order: best.order, at: used } };
}

// small fixed-seed generator (same layout every time for the same job)
function seeded(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

function boxOf(pl) {
  const w = pl.rotated ? pl.part.height : pl.part.width, h = pl.rotated ? pl.part.width : pl.part.height;
  return { x0: pl.x, y0: pl.y, x1: pl.x + w, y1: pl.y + h };
}
