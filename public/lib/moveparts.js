// Moving a part on a sheet by hand: where it can go. A part dropped where it would
// come too close to another part (closer than the part spacing, or the bit with
// shared cut lines), a hold-down screw's clearance, or off the usable stock goes
// to the nearest spot where it fits instead.
import { placedGeometry } from './nest.js';
import { sweepAround, clipPaths, growPaths, trimOffcuts, toPath, SCALE } from './shapes.js';

const C = () => globalThis.ClipperLib;
const circle = (x, y, r, n = 24) => {
  const R = r / Math.cos(Math.PI / n);   // the polygon goes round the circle
  return Array.from({ length: n }, (_, k) => [x + R * Math.cos((2 * Math.PI * k) / n), y + R * Math.sin((2 * Math.PI * k) / n)]);
};

/** The placement moved by (dx, dy): a new object, the rest of it unchanged. */
export function moveBy(pl, dx, dy) {
  const out = { ...pl, x: pl.x + dx, y: pl.y + dy, moved: true };
  if (pl.xf) {
    out.xf = { ...pl.xf, tx: pl.xf.tx + dx, ty: pl.xf.ty + dy };
    if (pl.box) out.box = { x0: pl.box.x0 + dx, y0: pl.box.y0 + dy, x1: pl.box.x1 + dx, y1: pl.box.y1 + dy };
  }
  return out;
}

/** Usable stock rectangles of a sheet (inch, x0..x1, y0..y1). */
export function usableRects(sheet) {
  const tx = sheet.trimX ?? sheet.trim, t = sheet.trim;
  if (sheet.remnant?.rects?.length > 1) {
    return sheet.remnant.rects.map((r) => ({ x0: r.x + t, y0: r.y + t, x1: r.x + r.w - t, y1: r.y + r.h - t })).filter((r) => r.x1 > r.x0 && r.y1 > r.y0);
  }
  return [{ x0: tx, y0: t, x1: sheet.w - tx, y1: sheet.h - t }];
}

/**
 * Where part `index` on `sheet` may be moved to. o: { gap (part to part; a
 * number, or a function of the other placement),
 * screwClear (screw centre to a part's edge), screws (list) }.
 * Returns fit(dx, dy) -> { dx, dy, snapped, ok } for a wanted move.
 * Worked out once per drag; each fit() call is quick.
 */
export function moveRoom(sheet, index, o) {
  const L = C();
  const pl = sheet.placements[index];
  const M = placedGeometry(pl).outline;
  const moving = toPath(M);
  const bx = { x0: Math.min(...M.map((q) => q[0])), x1: Math.max(...M.map((q) => q[0])), y0: Math.min(...M.map((q) => q[1])), y1: Math.max(...M.map((q) => q[1])) };
  // where its corner can be: the usable rectangles shrunk by the part, as moves
  const areas = usableRects(sheet).map((r) => ({ x0: r.x0 - bx.x0, x1: r.x1 - bx.x1, y0: r.y0 - bx.y0, y1: r.y1 - bx.y1 })).filter((r) => r.x1 >= r.x0 - 1e-9 && r.y1 >= r.y0 - 1e-9);
  const e = 1 / SCALE;
  const areaPaths = areas.map((r) => toPath([[r.x0, r.y0], [r.x1 + e, r.y0], [r.x1 + e, r.y1 + e], [r.x0, r.y1 + e]]));
  // the moves that would bring it too close to something
  const blocked = [];
  sheet.placements.forEach((q, j) => {
    if (j === index) return;
    const gap = typeof o.gap === 'function' ? o.gap(q) : o.gap;
    for (const ob of growPaths([toPath(placedGeometry(q).outline)], gap - 0.0005)) blocked.push(...sweepAround(ob, moving));
  });
  for (const s of o.screws || []) blocked.push(...sweepAround(toPath(circle(s.x, s.y, o.screwClear)), moving));
  const free = blocked.length ? clipPaths(L.ClipType.ctDifference, areaPaths, blocked) : areaPaths;
  const signs = blocked.map((b) => (L.Clipper.Orientation(b) ? 1 : -1));
  const isBlocked = (q) => {
    let w = 0;
    for (let i = 0; i < blocked.length; i++) if (L.Clipper.PointInPolygon(q, blocked[i]) === 1) w += signs[i];
    return w > 0;
  };
  const inArea = (x, y) => areas.some((r) => x >= r.x0 - 1e-6 && x <= r.x1 + 1e-6 && y >= r.y0 - 1e-6 && y <= r.y1 + 1e-6);
  const fits = (x, y) => inArea(x, y) && !isBlocked({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) });
  // edges of the free area, to find the nearest point on them
  const edges = [];
  for (const poly of free) for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    edges.push([a.X / SCALE, a.Y / SCALE, b.X / SCALE, b.Y / SCALE]);
  }
  const fit = (dx, dy) => {
    if (fits(dx, dy)) return { dx, dy, snapped: false, ok: true };
    const cand = [];
    for (const [ax, ay, bx2, by2] of edges) {
      const vx = bx2 - ax, vy = by2 - ay, L2 = vx * vx + vy * vy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((dx - ax) * vx + (dy - ay) * vy) / L2)) : 0;
      const x = ax + t * vx, y = ay + t * vy;
      cand.push([Math.hypot(x - dx, y - dy), x, y]);
    }
    cand.sort((p, q) => p[0] - q[0]);
    for (const [, x, y] of cand.slice(0, 60)) {
      // on the edge is touching (fine); a rounding step either way if it lands a hair inside
      for (const [ex, ey] of [[0, 0], [e, 0], [-e, 0], [0, e], [0, -e], [e, e], [-e, -e], [e, -e], [-e, e]]) {
        if (fits(x + ex, y + ey)) return { dx: x + ex, dy: y + ey, snapped: true, ok: true };
      }
    }
    return { dx: 0, dy: 0, snapped: true, ok: false };   // nowhere: stays put
  };
  return { fit, free };
}

/**
 * Hand changes applied to a sheet: moves = { [part id # copy]: { x, y } } (where
 * the placement's x, y go); edits = { removed: [part id # copy], added: [placement
 * records] } (parts deleted from / pasted onto this sheet by hand; an added
 * record is { partId, copy, label, cabinet, x, y, rotated, xf, box }, resolved
 * to a part with partOf(id)). Offcuts that moved or added parts now sit on are
 * trimmed.
 */
/** A part row's key (Onshape ids repeat across split rows; with the name it's unique). */
export const partKey = (p) => `${p.id}|${p.name}`;
export const moveKey = (pl) => `${partKey(pl.part)}#${pl.copy}`;
export function applyMoves(sheet, moves, { gap = 0, remnantMin, edits = null, partOf = null } = {}) {
  if (!sheet.autoPlacements) sheet.autoPlacements = { placements: sheet.placements, offcuts: sheet.offcuts };
  const base = sheet.autoPlacements;
  const removed = new Set(edits?.removed || []);
  const added = (edits?.added || []).map((a) => {
    const part = partOf?.(a.partId);
    return part ? { part, copy: a.copy, label: a.label, cabinet: a.cabinet, x: a.x, y: a.y, rotated: !!a.rotated, ...(a.xf ? { xf: { ...a.xf }, box: { ...a.box }, angle: a.angle, mirror: a.mirror, shape: true } : {}), added: true } : null;
  }).filter(Boolean);
  const start = removed.size || added.length ? base.placements.filter((pl) => !removed.has(moveKey(pl))).concat(added) : base.placements;
  let n = 0;
  sheet.placements = !moves || !Object.keys(moves).length ? start : start.map((pl) => {
    const m = moves?.[moveKey(pl)];
    if (!m) return pl;
    n++;
    return moveBy(pl, m.x - pl.x, m.y - pl.y);
  });
  sheet.partsMoved = n;
  sheet.partsAdded = added.length;
  sheet.partsRemoved = base.placements.length - (start.length - added.length);
  const boxes = sheet.placements.filter((pl) => pl.moved || pl.added).map((pl) => {
    const g = placedGeometry(pl).box;
    return { x: g.x0 - gap, y: g.y0 - gap, w: g.x1 - g.x0 + 2 * gap, h: g.y1 - g.y0 + 2 * gap };
  });
  // at most two kept per sheet, as the nest keeps
  sheet.offcuts = boxes.length ? trimOffcuts(base.offcuts || [], boxes, remnantMin || { side: 8, area: 288 }).slice(0, 2) : base.offcuts;
  sheet.offcut = sheet.offcuts?.[0] || null;
}

/** A copy of placement pl, its middle at (x, y): for pasting. */
export function copyAt(pl, x, y, extra = {}) {
  const b = placedGeometry(pl).box;
  const out = moveBy(pl, x - (b.x0 + b.x1) / 2, y - (b.y0 + b.y1) / 2);
  delete out.moved;
  return { ...out, ...extra, added: true };
}
