// Rectangle nesting (MaxRects) with grain locking, plus a search over part
// orders and placement rules. Sheet grain runs along the sheet's X (long) direction.
//
// A nest is fully determined by a "solution": the order parts are placed in,
// the placement rule and the sheet mode. Searching tries many solutions and
// keeps the best; the winning solution is small and can be stored with the job
// so the same nest comes back every time (applySolution).
//
// Best = fewest sheets, then the largest single rectangular offcut on the last
// sheet (a usable remnant beats scattered slivers). While searching, ties on
// sheet count go to the emptiest last sheet, which is what leads to a sheet fewer.
import { rotate90, translate } from './geometry.js';

export const RULES = ['bssf', 'blsf', 'baf', 'bl', 'cp'];
const SHARE_RULES = [...RULES, 'sh'];
const MODES = ['first', 'best'];   // first sheet it fits on / best fit over all open sheets

class MaxRectsBin {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.free = [{ x: 0, y: 0, w, h }];
    this.used = [];
  }

  // Score of the best spot for w x h (lower is better), or null.
  find(w, h, allowRotate, rule) {
    let best = null;
    const tryFit = (rw, rh, rotated) => {
      for (const f of this.free) {
        if (rw > f.w + 1e-9 || rh > f.h + 1e-9) continue;
        const dw = f.w - rw, dh = f.h - rh;
        const shortSide = Math.min(dw, dh), longSide = Math.max(dw, dh);
        let score;
        switch (rule) {
          case 'blsf': score = [longSide, shortSide]; break;
          case 'baf': score = [f.w * f.h - rw * rh, shortSide]; break;
          case 'bl': score = [f.y + rh, f.x]; break;
          case 'cp': score = [-this.contact(f.x, f.y, rw, rh), shortSide]; break;
          // shared cut lines: most edge against parts already placed (sheet walls don't count)
          case 'sh': score = [-this.contact(f.x, f.y, rw, rh, true), f.y + rh, f.x]; break;
          default: score = [shortSide, longSide];
        }
        score.push(f.y + f.x * 1e-3);   // tiebreak: pack toward the origin
        if (!best || cmp(score, best.score) < 0) best = { x: f.x, y: f.y, w: rw, h: rh, rotated, score };
      }
    };
    tryFit(w, h, false);
    if (allowRotate) tryFit(h, w, true);
    return best;
  }

  // length of the rectangle's edges touching the bin walls or placed parts
  contact(x, y, w, h, partsOnly = false) {
    let c = 0;
    if (!partsOnly && (x <= 1e-9 || Math.abs(x + w - this.w) < 1e-9)) c += h;
    if (!partsOnly && (y <= 1e-9 || Math.abs(y + h - this.h) < 1e-9)) c += w;
    const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
    for (const u of this.used) {
      if (Math.abs(u.x - (x + w)) < 1e-9 || Math.abs(u.x + u.w - x) < 1e-9) c += ov(y, y + h, u.y, u.y + u.h);
      if (Math.abs(u.y - (y + h)) < 1e-9 || Math.abs(u.y + u.h - y) < 1e-9) c += ov(x, x + w, u.x, u.x + u.w);
    }
    return c;
  }

  place(r) {
    this.used.push({ x: r.x, y: r.y, w: r.w, h: r.h });
    const next = [];
    for (const f of this.free) {
      if (r.x >= f.x + f.w || r.x + r.w <= f.x || r.y >= f.y + f.h || r.y + r.h <= f.y) {
        next.push(f);
        continue;
      }
      if (r.x > f.x) next.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
      if (r.x + r.w < f.x + f.w) next.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - r.x - r.w, h: f.h });
      if (r.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
      if (r.y + r.h < f.y + f.h) next.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - r.y - r.h });
    }
    // prune contained rects
    this.free = next.filter((a, i) =>
      a.w > 1e-6 && a.h > 1e-6 &&
      !next.some((b, j) => j !== i && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h &&
        (j < i || a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h)));
  }

  largestFree() { return this.free.reduce((a, f) => Math.max(a, f.w * f.h), 0); }
  usedArea() { return this.used.reduce((a, u) => a + u.w * u.h, 0); }
}

const cmp = (a, b) => {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return a[i] - b[i];
  return 0;
};

// Which orientations a part may take on a sheet with grain along X.
function orientations(part, respectGrain) {
  if (!respectGrain || part.grain === 'none') return { normal: true, rotated: true };
  if (part.grain === 'width') return { normal: false, rotated: true };
  return { normal: true, rotated: false }; // grain along length (part X)
}

function findOriented(bin, w, h, o, rule) {
  if (o.normal && o.rotated) return bin.find(w, h, true, rule);
  if (o.normal) return bin.find(w, h, false, rule);
  const r = bin.find(h, w, false, rule);
  return r ? { ...r, rotated: true } : null;
}

const itemKey = (it) => `${it.part.id ?? ''}|${it.part.name}#${it.copy}`;

// Which sides of a part's box an open-ended pocket (dado, rabbet, groove) runs
// out of: { x: left or right, y: bottom or top } in part coordinates.
export function partExits(p) {
  if (p.exits) return p.exits;
  const e = 1e-3, out = { x: false, y: false };
  for (const q of p.pockets || []) {
    for (const l of q.loops) {
      for (let i = 0; i < l.length; i++) {
        const a = l[i], b = l[(i + 1) % l.length];
        if (Math.abs(a[0] - b[0]) < e && (Math.abs(a[0]) < e || Math.abs(a[0] - p.width) < e) && Math.abs(a[1] - b[1]) > e) out.x = true;
        if (Math.abs(a[1] - b[1]) < e && (Math.abs(a[1]) < e || Math.abs(a[1] - p.height) < e) && Math.abs(a[0] - b[0]) > e) out.y = true;
      }
    }
  }
  return out;
}

// opts.commonLine: shared cut lines - parts sit exactly the bit apart (spacing
// = the bit) so a facing edge is one cut. opts.exitPad (default 0): extra room
// on both sides of an axis a dado runs out along, so its run-out past the edge
// can't reach the next part. Off by default: even 0.05 can stop 23 1/4 sides
// fitting two-high on a 48 sheet; the toolpath shortens a run-out instead.
function makeItems(parts, opts) {
  const items = [];
  const pad = opts.commonLine ? opts.exitPad || 0 : 0;
  for (const p of parts) {
    if (!p.include) continue;
    const ex = pad ? partExits(p) : { x: false, y: false };
    const px = ex.x ? pad : 0, py = ex.y ? pad : 0;
    for (let i = 0; i < (p.qty || 1); i++) {
      items.push({ part: p, copy: i + 1, px, py, w: p.width + 2 * px + opts.spacing, h: p.height + 2 * py + opts.spacing, o: orientations(p, opts.respectGrain) });
    }
  }
  items.forEach((it) => { it.key = itemKey(it); });
  // screw hold-downs: screw-sized squares packed in among the parts, so the
  // search can open a gap for the centre screw wherever it suits the layout
  // (one per sheet the parts could need, plus one). They never open a sheet,
  // and are dropped again before the screws are placed.
  if (opts.screws?.R > 0) {
    const sw = 2 * opts.screws.R + opts.spacing;
    const area = items.reduce((a, it) => a + it.w * it.h, 0);
    const n = Math.ceil(area / ((opts.sheetW - 2 * opts.trim) * (opts.sheetH - 2 * opts.trim))) + 1;
    for (let i = 0; i < n; i++) items.push({ screw: true, part: null, copy: i + 1, px: 0, py: 0, w: sw, h: sw, o: { normal: true, rotated: false }, key: `screw#${i + 1}` });
  }
  return items;
}

// Length of facing edges between parts sitting exactly the spacing apart (no
// exit pad on either side): what shared cut lines save.
function sharedLength(bins, sp) {
  let total = 0;
  const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  for (const s of bins) {
    const u = s.items.map(({ it, r }) => {
      const padX = r.rotated ? it.py : it.px, padY = r.rotated ? it.px : it.py;
      return { x0: r.x + padX, x1: r.x + r.w - sp - padX, y0: r.y + padY, y1: r.y + r.h - sp - padY, padX, padY };
    });
    for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) {
      const a = u[i], b = u[j];
      if (!a.padX && !b.padX && (Math.abs(b.x0 - a.x1 - sp) < 1e-6 || Math.abs(a.x0 - b.x1 - sp) < 1e-6)) total += ov(a.y0, a.y1, b.y0, b.y1);
      if (!a.padY && !b.padY && (Math.abs(b.y0 - a.y1 - sp) < 1e-6 || Math.abs(a.y0 - b.y1 - sp) < 1e-6)) total += ov(a.x0, a.x1, b.x0, b.x1);
    }
  }
  return total;
}

// Screw hold-downs (opts.screws = { R }): five screws per sheet, one as close
// as it can get to each of the four corners of the area the parts take up and
// one to its centre. Screw-sized squares are packed in among the parts (see
// makeItems), so the search can open a gap at the centre; they're taken out
// again before this runs, so an unused one doesn't cut up the offcut.
// Screws go where the parts leave room - scrap first; an offcut being kept
// only when there's no scrap within 30" of the target - and never on the lines
// that cut a keeper free. A thin strip where the screw only just fits costs
// 1". A spot is a square of 2R plus the spacing, so no cut comes within R of
// the screw centre (the spacing covers the next part's kerf). Spots go into a
// copy of the free space, so they never move the parts. Returns centres in
// bin coordinates and counts: no room, thin strip, in a keeper, and the total
// distance from the targets.
const THIN = 0.2;   // room to spare around a spot below this: a thin strip
// a spot in an offcut being kept counts this much farther: a screw goes in the
// keeper only when there's no scrap within this distance of where it wants to be
const KEEPER_COST = 30;
const screwSide = (ctx) => 2 * ctx.screws.R + ctx.spacing;
function placeScrews(bin, rects, ctx) {
  const S = ctx.screws;
  const none = { spots: [], missing: 0, thin: 0, inKeeper: 0, dist: 0, centre: 0 };
  if (!S || !rects.length) return none;
  const R = S.R, sw = screwSide(ctx), sp = ctx.spacing, e = 1e-6;
  const work = new MaxRectsBin(bin.w, bin.h);
  work.free = bin.free.map((f) => ({ ...f }));
  const keepers = freeKeepers(bin, { remnantMin: ctx.remnantMin, spacing: sp });
  for (const kp of keepers) for (const k of kp.rects) {
    // the lines that cut a keeper free: a band the spacing wide outside each
    // inside edge (not between the keeper's own two rectangles)
    const x0 = Math.max(0, k.x - sp), y0 = Math.max(0, k.y - sp);
    const x1 = Math.min(bin.w, k.x + k.w + sp), y1 = Math.min(bin.h, k.y + k.h + sp);
    const bands = [];
    if (k.x > e) bands.push({ x: x0, y: y0, w: k.x - x0, h: y1 - y0 });
    if (k.x + k.w + sp < bin.w - e) bands.push({ x: k.x + k.w, y: y0, w: x1 - k.x - k.w, h: y1 - y0 });
    if (k.y > e) bands.push({ x: x0, y: y0, w: x1 - x0, h: k.y - y0 });
    if (k.y + k.h + sp < bin.h - e) bands.push({ x: x0, y: k.y + k.h, w: x1 - x0, h: y1 - k.y - k.h });
    let left = bands;
    for (const o of kp.rects) if (o !== k) left = rectsMinus(left, o);
    for (const b of left) if (b.w > e && b.h > e) work.place(b);
  }
  // the area the parts take up (rects carry the spacing on their far side)
  let ux0 = Infinity, uy0 = Infinity, ux1 = -Infinity, uy1 = -Infinity;
  for (const r of rects) { ux0 = Math.min(ux0, r.x); uy0 = Math.min(uy0, r.y); ux1 = Math.max(ux1, r.x + r.w - sp); uy1 = Math.max(uy1, r.y + r.h - sp); }
  const targets = [[(ux0 + ux1) / 2, (uy0 + uy1) / 2], [ux0, uy0], [ux1, uy0], [ux1, uy1], [ux0, uy1]];
  const inKeeper = (x, y) => keepers.some((kp) => kp.rects.some((k) => x < k.x + k.w && x + sw > k.x && y < k.y + k.h && y + sw > k.y));
  const out = { ...none, spots: [] };
  for (const [tx, ty] of targets) {
    // the centre screw is only worth anything near the centre: there a keeper
    // spot loses to scrap within 12", at the corners within 30"
    const keeperCost = tx === targets[0][0] && ty === targets[0][1] ? 12 : KEEPER_COST;
    let best = null;
    for (const f of work.free) {
      if (f.w < sw - 1e-9 || f.h < sw - 1e-9) continue;
      const x = Math.min(f.x + f.w - sw, Math.max(f.x, tx - R)), y = Math.min(f.y + f.h - sw, Math.max(f.y, ty - R));
      const d = Math.hypot(x + R - tx, y + R - ty);
      // room to spare toward neighbouring parts (the stock edge isn't a part)
      const side = (gap, atEdge) => (atEdge ? Infinity : gap);
      const slack = Math.min(side(x - f.x, f.x <= e), side(f.x + f.w - sw - x, f.x + f.w >= bin.w - e),
        side(y - f.y, f.y <= e), side(f.y + f.h - sw - y, f.y + f.h >= bin.h - e));
      const k = inKeeper(x, y);
      const cost = d + (k ? keeperCost : 0) + (slack < THIN ? 1 : 0);
      if (!best || cost < best.cost) best = { x, y, d, k, slack, cost };
    }
    if (!best) { out.missing++; continue; }
    if (tx === targets[0][0] && ty === targets[0][1]) out.centre = best.d + (best.k ? keeperCost : 0);
    if (best.k) out.inKeeper++;
    else if (best.slack < THIN) out.thin++;
    out.dist += best.d;
    work.place({ x: best.x, y: best.y, w: sw, h: sw });
    out.spots.push({ x: best.x + R, y: best.y + R });
  }
  return out;
}

// Open the corners of the parts' area for corner screws: where parts cover a
// corner, slide them (and whatever they'd run into, in a chain) straight in
// from that corner by just enough to clear a screw square, if there's room on
// the far side - e.g. a row of stretchers moved over into the gap at the
// other end of the row. Tries along the length and across, takes the one
// that moves the fewest parts. rects: the parts' rects (bin coordinates, the
// spacing on their far side); returns the new rects (same order).
function openCorners(rects, binW, binH, sw, sp, fixed = []) {
  if (!rects.length) return rects;
  let out = rects.map((r) => ({ ...r }));
  const ov = (a, b) => a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
  let ux0 = Infinity, uy0 = Infinity, ux1 = -Infinity, uy1 = -Infinity;
  for (const r of out) { ux0 = Math.min(ux0, r.x); uy0 = Math.min(uy0, r.y); ux1 = Math.max(ux1, r.x + r.w); uy1 = Math.max(uy1, r.y + r.h); }
  // corner squares, and the two ways in from each (dx, dy = direction parts move)
  const corners = [
    { sq: { x: ux0, y: uy0, w: sw, h: sw }, dirs: [[1, 0], [0, 1]] },
    { sq: { x: ux1 - sw, y: uy0, w: sw, h: sw }, dirs: [[-1, 0], [0, 1]] },
    { sq: { x: ux1 - sw, y: uy1 - sw, w: sw, h: sw }, dirs: [[-1, 0], [0, -1]] },
    { sq: { x: ux0, y: uy1 - sw, w: sw, h: sw }, dirs: [[1, 0], [0, -1]] },
  ];
  for (const { sq, dirs } of corners) {
    const hit = out.map((r, i) => (ov(r, sq) ? i : -1)).filter((i) => i >= 0);
    if (!hit.length) continue;
    let best = null;
    for (const [dx, dy] of dirs) {
      // how far: clear the square in that direction
      let d = 0;
      for (const i of hit) {
        const r = out[i];
        d = Math.max(d, dx > 0 ? sq.x + sq.w - r.x : dx < 0 ? r.x + r.w - sq.x : dy > 0 ? sq.y + sq.h - r.y : r.y + r.h - sq.y);
      }
      // chain: anything a moved part would run into moves too
      const moving = new Set(hit);
      let ok = true, grew = true;
      while (ok && grew) {
        grew = false;
        for (const i of [...moving]) {
          const m = { ...out[i], x: out[i].x + dx * d, y: out[i].y + dy * d };
          if (m.x < -1e-9 || m.y < -1e-9 || m.x + m.w > binW + 1e-9 || m.y + m.h > binH + 1e-9 || ov(m, sq) || fixed.some((f) => ov(m, f))) { ok = false; break; }
          for (let k = 0; k < out.length; k++) if (!moving.has(k) && ov(m, out[k])) { moving.add(k); grew = true; }
        }
        if (moving.size > 12) ok = false;
      }
      if (ok && (!best || moving.size < best.moving.size)) best = { moving, dx, dy, d };
    }
    if (best) out = out.map((r, i) => (best.moving.has(i) ? { ...r, x: r.x + best.dx * best.d, y: r.y + best.dy * best.d } : r));
  }
  return out;
}

// The same parts on a fresh bin (drops the screw squares); blocks = a
// remnant's missing corner(s), kept blocked.
function rebuildBin(bin, items, blocks = []) {
  const b = new MaxRectsBin(bin.w, bin.h);
  for (const r of blocks) b.place(r);
  for (const { r } of items) b.place(r);
  return b;
}
// A remnant's bin: the parts of its bounding box that aren't remnant are blocked.
function remBin(rem) {
  const b = new MaxRectsBin(rem.binW, rem.binH);
  for (const r of rem.blocks || []) b.place(r);
  return b;
}

// Place items in the given order. Stock is tried in a fixed order: remnants
// (opened or not) first, then full sheets. Returns the used stock + scores.
function pack(order, rule, mode, ctx) {
  const slots = ctx.remnants.map((rem) => ({ rem, bin: null, probe: null, items: [] }));
  const unplaced = [];
  for (const it of order) {
    let best = null;
    for (let b = 0; b < slots.length; b++) {
      const s = slots[b];
      const bin = s.bin || (s.probe ||= remBin(s.rem));
      const r = findOriented(bin, it.w, it.h, it.o, rule);
      if (!r) continue;
      if (mode.startsWith('first')) { best = { b, r }; break; }
      if (!best || cmp(r.score, best.r.score) < 0) best = { b, r };
    }
    if (!best && it.screw) continue;   // a screw square never opens a sheet
    if (!best) {
      const bin = new MaxRectsBin(ctx.binW, ctx.binH);
      const r = findOriented(bin, it.w, it.h, it.o, rule);
      if (!r) { unplaced.push(it); continue; }
      slots.push({ rem: null, bin, items: [] });
      best = { b: slots.length - 1, r };
    }
    const s = slots[best.b];
    if (!s.bin) s.bin = s.probe;
    s.bin.place(best.r);
    s.items.push({ it, r: best.r });
  }
  // screw squares out again: they only held space open for the screws
  if (ctx.screws) for (const s of slots) {
    if (s.items.some(({ it }) => it.screw)) {
      s.items = s.items.filter(({ it }) => !it.screw);
      s.bin = rebuildBin(s.bin, s.items, s.rem?.blocks);
    }
  }
  const bins = slots.filter((s) => s.items.length);
  const full = bins.filter((s) => !s.rem);
  // screws: none missing and the centre one at the centre come before how
  // tightly the parts pack (parts may spread a little to open the centre);
  // the corner screws' distance, keepers and thin strips only break near-ties
  let screwsMissing = 0, screwsThin = 0;
  if (ctx.screws) for (const s of bins) {
    // slide parts off the corners where there's room, so corner screws can sit there
    const moved = openCorners(s.items.map(({ r }) => r), s.bin.w, s.bin.h, screwSide(ctx), ctx.spacing, s.rem?.blocks || []);
    if (moved.some((r, i) => r.x !== s.items[i].r.x || r.y !== s.items[i].r.y)) {
      s.items = s.items.map((x, i) => ({ it: x.it, r: { ...moved[i] } }));
      s.bin = rebuildBin(s.bin, s.items, s.rem?.blocks);
    }
    s.screws = placeScrews(s.bin, s.items.map(({ r }) => r), ctx);
    screwsMissing += s.screws.missing * 1000 + Math.round(s.screws.centre);
    screwsThin += Math.round((s.screws.dist - s.screws.centre) / 2) * 1e6 + s.screws.inKeeper * 1000 + s.screws.thin;
  }
  const remUsed = bins.length - full.length;
  const last = full.at(-1)?.bin;
  const binArea = ctx.binW * ctx.binH;
  const used = last ? last.usedArea() / binArea : 0, free = last ? last.largestFree() / binArea : 0;
  // search: fewest full sheets, then the emptiest last sheet (pushes toward one sheet fewer)
  // final pick: fewest full sheets, then the biggest rectangular offcut on the last
  // sheet, then the fewest remnants used up.
  // Shared cut lines: after the sheet count, the most shared edge (in 2 ft steps,
  // so a near tie still goes to the bigger offcut)
  if (ctx.screws) {
    // with screws, sheet use and the offcut count in 2% steps, so near-equal
    // nests are decided by where the screws can go (close to the corners and
    // centre) instead of spreading the parts out to make room
    const q = (v) => Math.round(v * 50);
    const sh = ctx.commonLine ? sharedLength(bins, ctx.spacing) : 0;
    const share = ctx.commonLine ? -Math.round(sh / 24) : 0;
    return {
      bins, unplaced, screwsMissing, ...(ctx.commonLine ? { shared: sh } : {}),
      score: [unplaced.length, full.length, screwsMissing, q(used), screwsThin, remUsed, -free],
      share: [unplaced.length, full.length, screwsMissing, -sh, screwsThin, -free],
      keep: [unplaced.length, full.length, screwsMissing, share, -q(free), screwsThin, remUsed, used],
    };
  }
  if (ctx.commonLine) {
    const shared = sharedLength(bins, ctx.spacing);
    return {
      bins, unplaced, shared,
      score: [unplaced.length, full.length, used, remUsed, -free],
      share: [unplaced.length, full.length, -shared, -free],
      keep: [unplaced.length, full.length, -Math.round(shared / 24), -free, remUsed, used],
    };
  }
  return {
    bins, unplaced,
    score: [unplaced.length, full.length, used, remUsed, -free],
    keep: [unplaced.length, full.length, -free, remUsed, used],
  };
}

// --- ordering -----------------------------------------------------------------
const SORTS = {
  maxSide: (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h,
  area: (a, b) => b.w * b.h - a.w * a.h,
  perimeter: (a, b) => b.w + b.h - (a.w + a.h),
  width: (a, b) => b.w - a.w || b.h - a.h,
  height: (a, b) => b.h - a.h || b.w - a.w,
  minSide: (a, b) => Math.min(b.w, b.h) - Math.min(a.w, a.h) || b.w * b.h - a.w * a.h,
};

// small seeded RNG so a search is repeatable
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

function mutate(order, rand) {
  const o = order.slice();
  const n = o.length;
  if (n < 2) return o;
  const i = Math.floor(rand() * n);
  let j = Math.floor(rand() * n);
  if (j === i) j = (i + 1) % n;
  const k = rand();
  if (k < 0.5) {
    [o[i], o[j]] = [o[j], o[i]];                       // swap two parts
  } else if (k < 0.8) {
    const [it] = o.splice(i, 1); o.splice(j, 0, it);   // move one part
  } else {
    const a = Math.min(i, j), b = Math.max(i, j);       // reverse a run
    const seg = o.slice(a, b + 1).reverse();
    o.splice(a, seg.length, ...seg);
  }
  return o;
}

/**
 * parts: normalized parts (all same material/thickness)
 * opts: { sheetW, sheetH, trim, spacing, respectGrain,
 *         remnants [{ id, w, h }], remnantTrim, remnantMin { side, area },
 *         searchMs (0 = quick: every sort x rule x mode once),
 *         seed, onProgress({ ms, tries, sheets }) }
 * returns { sheets, unplaced, solution, stats }
 */
export function nestParts(parts, opts) {
  const ctx = binSize(opts);
  const items = makeItems(parts, opts);
  const t0 = Date.now();
  let tries = 0;
  let best = null;   // by search score
  let keep = null;   // by final score (offcut)
  const note = (order, rule, mode, res) => {
    tries++;
    let gain = false;
    if (!best || cmp(res.score, best.res.score) < 0) { best = { order, rule, mode, res }; gain = true; }
    if (!keep || cmp(res.keep, keep.res.keep) < 0) keep = { order, rule, mode, res };
    return gain;
  };
  const consider = (order, rule, mode) => note(order, rule, mode, pack(order, rule, mode, ctx));
  const modes = MODES;

  // 1. every sort order x placement rule x sheet mode
  const rules = ctx.commonLine ? SHARE_RULES : RULES;
  for (const s of Object.values(SORTS)) {
    const order = items.slice().sort(s);
    for (const rule of rules) for (const mode of modes) consider(order, rule, mode);
  }

  // 2. random search from the best: small changes to the order, sometimes a
  // different rule; keep a change if it's no worse (lets it walk along plateaus)
  const budget = opts.searchMs || 0;
  // shared cut lines: the last 40% of the time searches for more shared edge
  // (same sheet count) instead of fewer sheets
  const mainBudget = ctx.commonLine ? budget * 0.6 : budget;
  if (budget > 0 && items.length > 1) {
    const rand = rng(opts.seed ?? 12345);
    let cur = { order: best.order, rule: best.rule, mode: best.mode, score: best.res.score };
    let lastReport = Date.now(), lastGain = Date.now();
    while (Date.now() - t0 < mainBudget) {
      const order = mutate(cur.order, rand);
      const rule = rand() < 0.15 ? rules[Math.floor(rand() * rules.length)] : cur.rule;
      const mode = rand() < 0.1 ? modes[Math.floor(rand() * modes.length)] : cur.mode;
      const res = pack(order, rule, mode, ctx);
      if (cmp(res.score, cur.score) <= 0) cur = { order, rule, mode, score: res.score };
      if (note(order, rule, mode, res)) lastGain = Date.now();
      // restart from the best now and then so it doesn't wander off
      if (rand() < 0.01) cur = { order: best.order, rule: best.rule, mode: best.mode, score: best.res.score };
      if (opts.onProgress && Date.now() - lastReport > 250) {
        lastReport = Date.now();
        opts.onProgress({ ms: lastReport - t0, tries, sheets: keep.res.bins.filter((b) => !b.rem).length });
      }
      // nothing better for a long while: stop early
      if (Date.now() - lastGain > Math.max(1500, mainBudget * 0.5)) break;
    }
    if (ctx.commonLine) {
      // walk from the kept nest, accepting changes with no less shared edge
      let cur2 = { order: keep.order, rule: keep.rule, mode: keep.mode, share: keep.res.share };
      const t1 = Date.now(), budget2 = Math.max(0, budget - (t1 - t0));
      while (Date.now() - t1 < budget2) {
        const order = mutate(cur2.order, rand);
        const rule = rand() < 0.25 ? rules[Math.floor(rand() * rules.length)] : cur2.rule;
        const mode = rand() < 0.1 ? modes[Math.floor(rand() * modes.length)] : cur2.mode;
        const res = pack(order, rule, mode, ctx);
        tries++;
        if (cmp(res.share, cur2.share) <= 0) cur2 = { order, rule, mode, share: res.share };
        if (cmp(res.keep, keep.res.keep) < 0) keep = { order, rule, mode, res };
        if (rand() < 0.01) cur2 = { order: keep.order, rule: keep.rule, mode: keep.mode, share: keep.res.share };
        if (opts.onProgress && Date.now() - lastReport > 250) {
          lastReport = Date.now();
          opts.onProgress({ ms: lastReport - t0, tries, sheets: keep.res.bins.filter((b) => !b.rem).length });
        }
      }
    }
  }

  const solution = { order: keep.order.map((it) => it.key), rule: keep.rule, mode: keep.mode };
  return { ...finish(keep.res, opts), solution, stats: { ms: Date.now() - t0, tries, lowerBound: lowerBound(items, ctx), shared: keep.res.shared, screwsMissing: keep.res.screwsMissing || 0 } };
}

// Rebuild a stored nest exactly. Returns null if the parts no longer match it.
export function applySolution(parts, opts, solution) {
  if (!solution?.order) return null;
  const ctx = binSize(opts);
  const items = makeItems(parts, opts);
  if (items.length !== solution.order.length) return null;
  const byKey = new Map(items.map((it) => [it.key, it]));
  const order = solution.order.map((k) => byKey.get(k));
  if (order.some((it) => !it) || new Set(solution.order).size !== order.length) return null;
  const res = pack(order, solution.rule, solution.mode, ctx);
  return { ...finish(res, opts), solution, stats: { ms: 0, tries: 1, lowerBound: lowerBound(items, ctx), stored: true, shared: res.shared } };
}

// Identifies what a nest depends on (parts, sizes, grain, sheet), so a stored
// solution is only reused for the same inputs.
export function nestKey(parts, opts) {
  const items = makeItems(parts, opts).map((it) => `${it.key}:${it.w.toFixed(4)}x${it.h.toFixed(4)}:${it.o.normal ? 1 : 0}${it.o.rotated ? 1 : 0}`);
  const s = [opts.sheetW, opts.sheetH, opts.trim, opts.spacing, opts.commonLine ? 'cl' : '', opts.screws?.R > 0 ? `sc5-${opts.screws.R}` : '', items.sort().join(',')].join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36) + '-' + items.length;
}

// opts.remnants: [{ id, w, h, rects? }] in this material, w along the grain
// (sheet X); rects: an L / T remnant's two rectangles, relative to its
// bounding box w x h (none = the whole box); opts.remnantTrim: clean-up
// margin around a remnant, inside corners included
function remnantBlocks(r, rt, sp, binW, binH) {
  if (!(r.rects?.length > 1)) return [];
  const missing = r.rects.reduce((acc, q) => rectsMinus(acc, q), [{ x: 0, y: 0, w: r.w, h: r.h }]);
  // a part (its rect carries the spacing on its far side) stays the trim clear of a missing region
  return missing.map((m) => {
    const x0 = Math.max(0, m.x - 2 * rt + sp), y0 = Math.max(0, m.y - 2 * rt + sp);
    const x1 = Math.min(binW, m.x + m.w), y1 = Math.min(binH, m.y + m.h);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }).filter((b) => b.w > 1e-6 && b.h > 1e-6);
}
function binSize(opts) {
  const rt = opts.remnantTrim ?? 0.25;
  const remnants = (opts.remnants || [])
    .map((r) => {
      const binW = r.w - 2 * rt + opts.spacing, binH = r.h - 2 * rt + opts.spacing;
      return { ...r, trim: rt, binW, binH, blocks: remnantBlocks(r, rt, opts.spacing, binW, binH) };
    })
    .filter((r) => r.binW > opts.spacing && r.binH > opts.spacing)
    .sort((a, b) => remArea(b) - remArea(a) || String(a.id).localeCompare(String(b.id)));
  const screws = opts.screws?.R > 0 ? { R: opts.screws.R } : null;
  return { binW: opts.sheetW - 2 * opts.trim + opts.spacing, binH: opts.sheetH - 2 * opts.trim + opts.spacing, remnants, commonLine: !!opts.commonLine, spacing: opts.spacing, trim: opts.trim, sheetW: opts.sheetW, screws, remnantMin: opts.remnantMin };
}

const remArea = (r) => (r.rects?.length > 1 ? r.rects.reduce((a, q) => a + q.w * q.h, 0) : r.w * r.h);
// fewest full sheets the part area could possibly need (after the remnants)
function lowerBound(items, ctx) {
  const a = items.reduce((s, it) => s + (it.screw ? 0 : it.w * it.h), 0) - ctx.remnants.reduce((s, r) => s + r.binW * r.binH, 0);
  return Math.max(0, Math.ceil(a / (ctx.binW * ctx.binH) - 1e-9));
}

// Up to two separate clear rectangles worth keeping, in bin coordinates (the
// part of each free rectangle that isn't spacing).
// a minus b, as up to four rectangles
export function rectMinus(a, b) {
  const e = 1e-9;
  if (!(a.x < b.x + b.w - e && b.x < a.x + a.w - e && a.y < b.y + b.h - e && b.y < a.y + a.h - e)) return [a];
  const out = [];
  if (b.x > a.x + e) out.push({ x: a.x, y: a.y, w: b.x - a.x, h: a.h });
  if (b.x + b.w < a.x + a.w - e) out.push({ x: b.x + b.w, y: a.y, w: a.x + a.w - b.x - b.w, h: a.h });
  const x0 = Math.max(a.x, b.x), x1 = Math.min(a.x + a.w, b.x + b.w);
  if (b.y > a.y + e) out.push({ x: x0, y: a.y, w: x1 - x0, h: b.y - a.y });
  if (b.y + b.h < a.y + a.h - e) out.push({ x: x0, y: b.y + b.h, w: x1 - x0, h: a.y + a.h - b.y - b.h });
  return out;
}
const rectsMinus = (list, b) => list.flatMap((a) => rectMinus(a, b));
const bboxOf = (rects) => {
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
};
const overlaps = (a, b) => a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;

// Offcuts worth keeping, biggest first (at most two): each { x, y, w, h (its
// bounding box), rects }. A keeper can be two adjacent rectangles - the
// biggest clear rectangle plus the strip of clear space running on past one
// of its sides (an L or T) - since it comes off the sheet as one piece. The
// second rectangle needs the minimum side and half the minimum area.
function freeKeepers(bin, opts) {
  const min = opts.remnantMin || { side: 8, area: 288 };
  const sp = opts.spacing;
  const clear = bin.free.map((f) => ({ x: f.x, y: f.y, w: f.w - sp, h: f.h - sp })).sort((a, b) => b.w * b.h - a.w * a.h);
  const big = (r, area) => Math.min(r.w, r.h) >= min.side && r.w * r.h >= area;
  const out = [];
  for (const r of clear) {
    if (!big(r, min.area)) continue;
    if (out.some((o) => o.rects.some((q) => overlaps(r, q)))) continue;
    const rects = [r];
    if (!out.length) {
      // the clear space running on past one side of it, as one more rectangle
      let ext = null;
      for (const f of clear) {
        if (f === r || !overlaps(f, r)) continue;
        const rest = rectMinus(f, r);
        if (rest.length !== 1 || !big(rest[0], min.area / 2)) continue;
        if (!ext || rest[0].w * rest[0].h > ext.w * ext.h) ext = rest[0];
      }
      if (ext) rects.push(ext);
    }
    out.push({ ...bboxOf(rects), rects });
    if (out.length === 2) break;
  }
  return out;
}

function finish(res, opts) {
  const sheets = res.bins.map((b) => {
    const trim = b.rem ? b.rem.trim : opts.trim;
    const w = b.rem ? b.rem.w : opts.sheetW, h = b.rem ? b.rem.h : opts.sheetH;
    // Mirror the layout so the biggest offcut sits on the stock's zero corner:
    // the remnant keeps that corner (and its two edges), so next time it goes
    // back against the same corner, and only its inside edges need cutting.
    const bw = b.bin.w, bh = b.bin.h, sp = opts.spacing, e = 1e-6;
    const keep = freeKeepers(b.bin, opts);
    const k0 = keep[0]?.rects[0];
    const mx = !!k0 && k0.x > e && k0.x + k0.w + sp >= bw - e;
    const my = !!k0 && k0.y > e && k0.y + k0.h + sp >= bh - e;
    const fx = (x, w) => (mx ? bw - x - w : x), fy = (y, h) => (my ? bh - y - h : y);
    const placements = b.items.map(({ it, r }) => ({
      part: it.part, copy: it.copy,
      label: it.part.sourceNames?.[it.copy - 1] || it.part.name,
      cabinet: it.part.sourceCabinets?.[it.copy - 1] ?? it.part.cabinet,
      x: fx(r.x, r.w) + trim + (r.rotated ? it.py : it.px), y: fy(r.y, r.h) + trim + (r.rotated ? it.px : it.py), rotated: r.rotated,
    }));
    // offcuts in stock coordinates; where one reaches the edge of the usable
    // area it runs on out to the stock's edge (nothing to cut there)
    const toStock = (k) => {
      let x = fx(k.x, k.w + sp) + trim, y = fy(k.y, k.h + sp) + trim;
      let x1 = x + k.w, y1 = y + k.h;
      if (x - trim < e) x = 0;
      if (y - trim < e) y = 0;
      if (x1 > w - trim - e) x1 = w;
      if (y1 > h - trim - e) y1 = h;
      return { x, y, w: x1 - x, h: y1 - y };
    };
    // an L / T keeper: its two rectangles (rects), w x h = their bounding box
    const offcuts = keep.map((kp) => {
      const rects = kp.rects.map(toStock);
      return rects.length > 1 ? { ...bboxOf(rects), rects } : rects[0];
    });
    // screw spots (centres) in stock coordinates, mirrored with the parts
    const screws = (b.screws?.spots || []).map((q) => ({ x: (mx ? bw - sp - q.x : q.x) + trim, y: (my ? bh - sp - q.y : q.y) + trim }));
    return {
      w, h, trim,
      screws,
      screwsMissing: b.screws?.missing || 0,
      screwsThin: b.screws?.thin || 0,
      screwsInKeeper: b.screws?.inKeeper || 0,
      remnant: b.rem ? { id: b.rem.id, w: b.rem.w, h: b.rem.h, ...(b.rem.rects?.length > 1 ? { rects: b.rem.rects } : {}) } : null,
      placements,
      yield: placements.reduce((a, pl) => a + pl.part.width * pl.part.height, 0) / (w * h),
      offcuts,                       // clear rectangles worth keeping (biggest first)
      offcut: offcuts[0] || null,
    };
  });
  return {
    sheets,
    fullSheets: sheets.filter((x) => !x.remnant).length,
    unplaced: res.unplaced.map((it) => ({ name: it.part.name, reason: 'Does not fit on the sheet in an allowed grain direction' })),
  };
}

// Part geometry in sheet coordinates for a placement.
export function placedGeometry(pl) {
  const p = pl.part;
  const xf = (pts) => translate(pl.rotated ? rotate90(pts, p.width) : pts, pl.x, pl.y);
  const pockets = p.pockets.map((q) => ({ loops: q.loops.map(xf), depth: q.depth, ...(q.walls ? { walls: q.walls.map((wl) => ({ ...wl, seg: xf(wl.seg) })) } : {}) }));
  const w = pl.rotated ? p.height : p.width, h = pl.rotated ? p.width : p.height;
  return { outline: xf(p.outline), holes: p.holes.map(xf), pockets, box: { x0: pl.x, y0: pl.y, x1: pl.x + w, y1: pl.y + h } };
}
