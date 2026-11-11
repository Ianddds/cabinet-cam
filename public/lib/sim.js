// Cut simulation: carve the toolpath into a height grid of the sheet (flat-end
// bits), then compare what's left with the model.
//
// carve(): Z per cell, 0 = sheet top, negative = cut down to there.
// check(): every bit of each pocket floor the bit can reach is cut to depth,
// nothing in a part is cut deeper than the model (corner reliefs aside), and
// (with tabs or no hold-down) every outline is cut right through except at
// its tabs.
import { placedGeometry } from './nest.js';
import { offset, difference, union } from './clip.js';

export function carve(sheet, moves, opts = {}) {
  const res = opts.res ?? 0.04;
  const W = sheet.w ?? 96, H = sheet.h ?? 48;
  const nx = Math.ceil(W / res), ny = Math.ceil(H / res);
  const z = new Float32Array(nx * ny);          // 0 = untouched
  const relief = new Uint8Array(nx * ny);       // cut by a corner relief
  const tab = new Uint8Array(nx * ny);          // under a tab move
  let r = (opts.dia ?? 0.375) / 2;
  let prev = null;
  const sweep = (a, b, mask) => {
    const z0 = a.z, z1 = b.z;
    if (z0 >= 0 && z1 >= 0) return;
    const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - r) / res)), x1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + r) / res));
    const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - r) / res)), y1 = Math.min(ny - 1, Math.ceil((Math.max(a.y, b.y) + r) / res));
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    for (let j = y0; j <= y1; j++) {
      const cy = (j + 0.5) * res;
      for (let i = x0; i <= x1; i++) {
        const cx = (i + 0.5) * res;
        const t = L2 > 1e-12 ? Math.max(0, Math.min(1, ((cx - a.x) * dx + (cy - a.y) * dy) / L2)) : 0;
        const ex = a.x + dx * t - cx, ey = a.y + dy * t - cy;
        if (ex * ex + ey * ey > r * r) continue;
        const zz = z0 + (z1 - z0) * t;
        const k = j * nx + i;
        if (zz < z[k]) z[k] = zz;
        if (mask) mask[k] = 1;
      }
    }
  };
  for (const m of moves) {
    if (m.toolchange) { r = (m.tool?.dia ?? r * 2) / 2; continue; }
    if (m.x == null) continue;
    if (prev) sweep(prev, m, m.op === 'relief' ? relief : m.op === 'tab' ? tab : null);
    prev = m;
  }
  return { res, nx, ny, W, H, z, relief, tab };
}

/**
 * Compare a carve with the parts on the sheet.
 * opts: { dia (pocket bit), thickness, holdDown ('skin'|'tabs'|'both'|'none'), skin }
 * returns { uncut, deep, notThrough, cells: [{ i, j, kind }] (first few), ok }
 */
// Fill loops (even-odd, holes included) into a grid mask: cell (i, j) is set
// when its centre is inside. One scanline pass per row.
function raster(loops, sim, x0 = 0, y0 = 0, x1 = sim.W, y1 = sim.H) {
  const { res, nx, ny } = sim;
  const m = new Uint8Array(nx * ny);
  const j0 = Math.max(0, Math.floor(y0 / res)), j1 = Math.min(ny - 1, Math.ceil(y1 / res));
  const edges = [];
  for (const l of loops) for (let k = 0; k < l.length; k++) { const a = l[k], b = l[(k + 1) % l.length]; if (a[1] !== b[1]) edges.push(a, b); }
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const cy = (j + 0.5) * res;
    xs.length = 0;
    for (let e = 0; e < edges.length; e += 2) {
      const a = edges[e], b = edges[e + 1];
      if ((a[1] > cy) !== (b[1] > cy)) xs.push(a[0] + ((cy - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] / res - 0.5)), i1 = Math.min(nx - 1, Math.floor(xs[k + 1] / res - 0.5));
      for (let i = i0; i <= i1; i++) m[j * nx + i] = 1;
    }
  }
  return m;
}

/**
 * Compare a carve with the parts on the sheet.
 * opts: { dia (pocket bit), profileDia, thickness, holdDown ('skin'|'tabs'|'both'|'none') }
 * returns { uncut, deep, notThrough, cells: [{ i, j, kind }] (first few), ok }
 */
export function check(sheet, sim, opts = {}) {
  const { res, nx, ny, z } = sim;
  const r = (opts.dia ?? 0.375) / 2;
  const rp = (opts.profileDia ?? opts.dia ?? 0.375) / 2;
  const T = opts.thickness ?? 0.75;
  const tol = 0.004;
  const out = { uncut: 0, deep: 0, notThrough: 0, cells: [] };
  const note = (i, j, kind) => { out[kind]++; if (out.cells.length < 2000) out.cells.push({ i, j, kind }); };
  const bb = (loops, pad = 0) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const l of loops) for (const [x, y] of l) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  };
  const each = ([x0, y0, x1, y1], fn) => {
    const i0 = Math.max(0, Math.floor(x0 / res)), i1 = Math.min(nx - 1, Math.ceil(x1 / res));
    const j0 = Math.max(0, Math.floor(y0 / res)), j1 = Math.min(ny - 1, Math.ceil(y1 / res));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(i, j, j * nx + i);
  };
  const parts = sheet.placements.map((pl) => placedGeometry(pl));
  const allParts = raster(parts.map((g) => g.outline), sim);
  for (const g of parts) {
    const material = difference([g.outline], g.holes);
    const box = bb([g.outline], 2 * rp + 4 * res);
    // cells within most of a cell of a wall don't count (grid noise)
    const inner = raster(offset(material, -res * 0.75, 'miter'), sim, ...box);
    const floors = g.pockets.map((q) => {
      const fl = union(q.loops, []);
      const reach = offset(offset(fl, -(r + res), 'round'), r, 'round');
      return { depth: q.depth, near: raster(offset(fl, res * 0.75, 'miter'), sim, ...box), reach: raster(reach, sim, ...box), box: bb(fl, res) };
    });
    // too deep: only cells that were cut can be
    each(bb([g.outline]), (i, j, k) => {
      if (z[k] >= -tol || sim.relief[k] || !inner[k]) return;
      let expected = 0;
      for (const f of floors) if (f.depth > -expected && f.near[k]) expected = -f.depth;
      if (z[k] < expected - tol) note(i, j, 'deep');
    });
    // left uncut: each floor, where the bit can reach
    for (const f of floors) each(f.box, (i, j, k) => { if (f.reach[k] && inner[k] && z[k] > -f.depth + tol) note(i, j, 'uncut'); });
    // outlines cut right through (tabs and onion skin aside), where a round
    // bit outside the part can reach (it always leaves a sliver in an inside corner)
    if (opts.holdDown === 'tabs' || opts.holdDown === 'none') {
      const zone = difference([bboxRect(g.outline, 2 * rp + 4 * res)], [g.outline]);
      const reachOut = raster(offset(offset(zone, -(rp + res), 'round'), rp, 'round'), sim, ...box);
      const band = raster(difference(offset([g.outline], res * 2, 'miter'), offset([g.outline], res * 0.75, 'miter')), sim, ...box);
      each(box, (i, j, k) => {
        if (!band[k] || !reachOut[k] || allParts[k]) return;
        if (z[k] > -T + tol && !sim.tab[k] && !nearTab(sim, i, j, rp)) note(i, j, 'notThrough');
      });
    }
  }
  // screw spots: nothing cut within the clearance radius except the screw hole itself
  out.screw = 0;
  const sr = opts.screwR || 0, hr = (opts.screwHoleR || 0) + res * 1.5;
  for (const q of opts.screws || []) {
    each([q.x - sr, q.y - sr, q.x + sr, q.y + sr], (i, j, k) => {
      const d = Math.hypot((i + 0.5) * res - q.x, (j + 0.5) * res - q.y);
      if (d <= sr - res && d > hr && z[k] < -tol) note(i, j, 'screw');
    });
  }
  out.ok = out.uncut === 0 && out.deep === 0 && out.notThrough === 0 && out.screw === 0;
  return out;
}

function bboxRect(loop, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of loop) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [[x0 - pad, y0 - pad], [x1 + pad, y0 - pad], [x1 + pad, y1 + pad], [x0 - pad, y1 + pad]];
}

// within a bit radius of a tab move (the tab's ramps and its edges)
function nearTab(sim, i, j, r) {
  const n = Math.ceil(r / sim.res) + 1;
  for (let dj = -n; dj <= n; dj++) for (let di = -n; di <= n; di++) {
    const ii = i + di, jj = j + dj;
    if (ii < 0 || jj < 0 || ii >= sim.nx || jj >= sim.ny) continue;
    if (sim.tab[jj * sim.nx + ii]) return true;
  }
  return false;
}

// RGBA image of the carve (row 0 = top of the sheet = largest Y): untouched
// sheet light, deeper darker, cut right through dark; problem cells marked.
export function shade(sim, opts = {}) {
  const { nx, ny, z } = sim;
  const T = opts.thickness ?? 0.75;
  const img = new Uint8ClampedArray(nx * ny * 4);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, p = ((ny - 1 - j) * nx + i) * 4;
    const d = Math.min(1, -z[k] / T);
    let rgb;
    if (z[k] >= 0) rgb = [236, 224, 200];
    else if (d >= 0.999) rgb = [52, 58, 70];
    else { const s = 1 - 0.6 * d; rgb = [205 * s, 170 * s, 120 * s]; }
    img[p] = rgb[0]; img[p + 1] = rgb[1]; img[p + 2] = rgb[2]; img[p + 3] = 255;
  }
  for (const c of opts.cells || []) {
    const p = ((ny - 1 - c.j) * nx + c.i) * 4;
    const col = c.kind === 'deep' ? [220, 30, 30] : c.kind === 'uncut' ? [250, 200, 0] : c.kind === 'screw' ? [0, 120, 255] : [255, 0, 200];
    img[p] = col[0]; img[p + 1] = col[1]; img[p + 2] = col[2]; img[p + 3] = 255;
  }
  return { width: nx, height: ny, data: img };
}
