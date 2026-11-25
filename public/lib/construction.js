// Construction sheets for the shop assembling the cabinets: one printable page
// per cabinet (or custom item: see splitCustom) with a front view (case, no fronts), a section through the middle,
// the fronts, overall sizes, the heights of the fixed parts, drawer box sizes
// and a parts list numbered to match the drawings. Drawn from where each part
// sits in the Onshape model (lib/parts.js placeOf), so it is only as right as
// the model.
import { fraction } from './cutlist.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const neg = (a) => a.map((v) => -v);
const fr = (v) => fraction(Math.abs(v) < 1e-6 ? 0 : v);

// fronts: hung on the case, drawn in their own view
const FRONTS = new Set(['DOOR', 'DRAWER_FACE', 'DOOR_STILE', 'DOOR_RAIL', 'DOOR_PANEL']);
// parts whose face looks out the front of the cabinet
const FACING_FRONT = new Set([...FRONTS, 'FF_STILE', 'FF_RAIL', 'FF_INNER_STILE', 'FF_INNER_RAIL', 'FF_BEAD']);
const SIDES = new Set(['SIDE', 'END_PANEL', 'PARTITION', 'FILLER']);
const DRAWER_BOX = new Set(['DRAWER_SIDE', 'DRAWER_FRONT', 'DRAWER_BACK', 'DRAWER_BOTTOM']);
// fixed horizontal parts whose height the shop sets at assembly
const LEVELS = new Set(['BOTTOM', 'TOP', 'FIXED_SHELF', 'STRETCHER', 'NAILER']);
const ORDER = ['SIDE', 'END_PANEL', 'BOTTOM', 'TOP', 'STRETCHER', 'NAILER', 'BACK', 'PARTITION', 'FIXED_SHELF', 'ADJ_SHELF',
  'TOE_KICK', 'TOE_SKIN', 'FILLER', 'FF_STILE', 'FF_RAIL', 'FF_INNER_STILE', 'FF_INNER_RAIL', 'FF_BEAD', 'SLIDE_SPACER', 'DRAWER_SIDE', 'DRAWER_FRONT', 'DRAWER_BACK',
  'DRAWER_BOTTOM', 'DOOR', 'DRAWER_FACE', 'DOOR_STILE', 'DOOR_RAIL', 'DOOR_PANEL', 'SHELF_NOSE', 'PANEL'];
const WORDS = {
  SIDE: 'Side', END_PANEL: 'End panel', BOTTOM: 'Bottom', TOP: 'Top', STRETCHER: 'Stretcher', NAILER: 'Nailer', BACK: 'Back',
  PARTITION: 'Partition', FIXED_SHELF: 'Fixed shelf', ADJ_SHELF: 'Adjustable shelf', TOE_KICK: 'Toe kick', TOE_SKIN: 'Toe skin',
  FILLER: 'Filler', FF_STILE: 'Frame stile', FF_RAIL: 'Frame rail', FF_INNER_STILE: 'Inner frame stile', FF_INNER_RAIL: 'Inner frame rail', FF_BEAD: 'Frame bead', SLIDE_SPACER: 'Slide spacer', DRAWER_SIDE: 'Drawer side',
  DRAWER_FRONT: 'Drawer box front', DRAWER_BACK: 'Drawer box back', DRAWER_BOTTOM: 'Drawer bottom', DOOR: 'Door',
  DRAWER_FACE: 'Drawer face', DOOR_STILE: 'Door stile', DOOR_RAIL: 'Door rail', DOOR_PANEL: 'Door panel', SHELF_NOSE: 'Shelf nosing', PANEL: 'Panel',
};
const roleRank = (r) => { const i = ORDER.indexOf(r); return i < 0 ? ORDER.length : i; };

function horizontal(v) {
  const L = Math.hypot(v[0], v[1]);
  return L > 0.5 ? [v[0] / L, v[1] / L, 0] : null;
}
function centerOf(p) {
  const c = [0, 0, 0];
  for (const q of p.corners) for (let d = 0; d < 3; d++) c[d] += q[d] / p.corners.length;
  return c;
}

/**
 * The cabinet's own frame: x = right, y = into the cabinet, z = up (world up;
 * Cabinet layout keeps cabinets upright). The front is away from the back
 * panel, else toward the doors / face frame, else toward the model's front.
 */
export function cabinetFrame(parts) {
  const up = [0, 0, 1];
  const all = parts.map(centerOf);
  const mid = all.reduce((a, c) => a.map((v, d) => v + c[d] / all.length), [0, 0, 0]);
  const away = (p, out, toward) => {
    const s = dot(centerOf(p).map((v, d) => v - mid[d]), out);
    return (toward ? s < 0 : s > 0) ? neg(out) : out;
  };
  let out = null;
  const back = parts.filter((p) => p.role === 'BACK' && horizontal(p.n)).sort((a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1])[0];
  if (back) out = away(back, horizontal(back.n), false);
  if (!out) {
    const f = parts.filter((p) => FACING_FRONT.has(p.role) && horizontal(p.n)).sort((a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1])[0];
    if (f) out = away(f, horizontal(f.n), true);
  }
  if (!out) {
    const s = parts.find((p) => SIDES.has(p.role) && horizontal(p.n));
    if (s) {
      out = cross(horizontal(s.n), up);
      if (dot(out, [0, -1, 0]) < -1e-6 || (Math.abs(out[1]) < 1e-6 && out[0] < 0)) out = neg(out);
    }
  }
  if (!out) out = [0, -1, 0];
  return { right: cross(up, out), into: neg(out), up };
}

/** Each cabinet's parts as boxes in its own frame, case front-bottom-left at 0. */
export function cabinetModel(parts) {
  const f = cabinetFrame(parts);
  const boxes = parts.map((p) => {
    const xs = [], ys = [], zs = [];
    for (const q of p.corners) { xs.push(dot(q, f.right)); ys.push(dot(q, f.into)); zs.push(dot(q, f.up)); }
    return { ...p, b: [Math.min(...xs), Math.min(...ys), Math.min(...zs), Math.max(...xs), Math.max(...ys), Math.max(...zs)] };
  });
  const caseParts = boxes.filter((p) => !FRONTS.has(p.role));
  const ref = caseParts.length ? caseParts : boxes;
  const o = [0, 1, 2].map((d) => Math.min(...ref.map((p) => p.b[d])));
  for (const p of boxes) p.b = p.b.map((v, i) => +(v - o[i % 3]).toFixed(4));
  const ext = (list) => (list.length ? [0, 1, 2].map((d) => Math.max(...list.map((p) => p.b[d + 3]))) : [0, 0, 0]);
  const [W, D, H] = ext(boxes.filter((p) => !FRONTS.has(p.role)));
  return { parts: boxes, W, D, H };
}

// Drawer boxes: drawer parts that touch, grouped. Outer sizes, lowest last.
export function drawerBoxes(model) {
  const list = model.parts.filter((p) => DRAWER_BOX.has(p.role));
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const touch = (a, b, t = 0.06) => [0, 1, 2].every((d) => a.b[d] <= b.b[d + 3] + t && b.b[d] <= a.b[d + 3] + t);
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (touch(list[i], list[j])) parent[find(i)] = find(j);
  const groups = new Map();
  list.forEach((p, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p); });
  return [...groups.values()].map((ps) => {
    const b = [0, 1, 2].map((d) => Math.min(...ps.map((p) => p.b[d]))).concat([0, 1, 2].map((d) => Math.max(...ps.map((p) => p.b[d + 3]))));
    return { parts: ps, b, w: b[3] - b[0], h: b[5] - b[2], d: b[4] - b[1] };
  }).sort((a, b) => b.b[2] - a.b[2]);
}

// Rows of the parts list: identical parts (role, size, material) together.
function partRows(model, where) {
  const rows = new Map();
  const r3 = (v) => v.toFixed(3);
  for (const p of model.parts) {
    const key = [p.role, ...p.size.map(r3), p.material].join('|');
    if (!rows.has(key)) rows.set(key, { role: p.role, size: p.size, material: p.material, cnc: p.cnc, parts: [] });
    rows.get(key).parts.push(p);
  }
  const list = [...rows.values()].sort((a, b) => roleRank(a.role) - roleRank(b.role) ||
    Math.min(...b.parts.map((p) => p.b[2])) - Math.min(...a.parts.map((p) => p.b[2])) || a.parts[0].name.localeCompare(b.parts[0].name));
  list.forEach((r, i) => {
    r.no = i + 1;
    for (const p of r.parts) p.no = r.no;
    r.where = r.parts.map((p) => where?.get(p.name) || '');
  });
  return list;
}

// ---------- drawing ----------
function svgView(model, fs) {
  const { W, D, H } = model;
  const sw = fs * 0.07;
  const gap = fs * 9;
  const fronts = model.parts.filter((p) => FRONTS.has(p.role));
  const caseParts = model.parts.filter((p) => !FRONTS.has(p.role));
  const F = fronts.length ? [0, 2].map((d) => Math.min(...fronts.map((p) => p.b[d]))).concat([3, 5].map((d) => Math.max(...fronts.map((p) => p.b[d])))) : null;
  const fW = F ? Math.max(F[2], W) - Math.min(F[0], 0) : 0;
  const top = Math.max(H, F ? F[3] : 0);
  const left = fs * 7;                      // room for the height dimension
  const xFront = left;
  const xSec = xFront + W + gap;
  const xFr = xSec + D + (fronts.length ? 1.5 : 0) + gap;
  const totalW = (F ? xFr + fW : xSec + D) + fs * 8;
  const totalH = top + fs * 12;
  const Y = (z) => fs * 4 + (top - z);      // svg y of a height
  let s = '';
  const labels = [];
  const balloon = (x, y, no) => {
    if (labels.some(([a, b]) => Math.hypot(a - x, b - y) < fs * 1.7)) return false;
    labels.push([x, y]);
    s += `<circle cx="${x}" cy="${y}" r="${fs * 0.75}" fill="#fff" stroke="#000" stroke-width="${sw}"/>`;
    s += `<text x="${x}" y="${y + fs * 0.36}" font-size="${fs}" text-anchor="middle" font-weight="700">${no}</text>`;
    return true;
  };
  const text = (x, y, t, o = {}) => {
    s += `<text x="${x}" y="${y}" font-size="${o.size || fs}" text-anchor="${o.anchor || 'middle'}"${o.bold ? ' font-weight="700"' : ''}${o.rotate ? ` transform="rotate(-90 ${x} ${y})"` : ''}>${esc(t)}</text>`;
  };
  const line = (x1, y1, x2, y2, w = sw, dash = '') => {
    s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  };
  // dimension: horizontal (between x1, x2 at height y) or vertical
  const dimH = (x1, x2, y, from, t) => {
    if (Math.abs(x2 - x1) < 1e-3) return;
    line(x1, from, x1, y + fs * 0.4, sw * 0.6); line(x2, from, x2, y + fs * 0.4, sw * 0.6);
    line(x1, y, x2, y, sw * 0.8);
    for (const x of [x1, x2]) line(x - fs * 0.3, y + fs * 0.3, x + fs * 0.3, y - fs * 0.3, sw * 1.3);
    text((x1 + x2) / 2, y - fs * 0.3, t);
  };
  const dimV = (y1, y2, x, from, t) => {
    if (Math.abs(y2 - y1) < 1e-3) return;
    line(from, y1, x - fs * 0.4, y1, sw * 0.6); line(from, y2, x - fs * 0.4, y2, sw * 0.6);
    line(x, y1, x, y2, sw * 0.8);
    for (const y of [y1, y2]) line(x - fs * 0.3, y + fs * 0.3, x + fs * 0.3, y - fs * 0.3, sw * 1.3);
    text(x - fs * 0.35, (y1 + y2) / 2, t, { rotate: true });
  };

  // --- front view: case only, back to front so nearer parts cover farther ones
  const fx = (x) => xFront + x;
  const byDepth = caseParts.slice().sort((a, b) => b.b[1] - a.b[1]);
  for (const p of byDepth) {
    s += `<rect x="${fx(p.b[0])}" y="${Y(p.b[5])}" width="${p.b[3] - p.b[0]}" height="${p.b[5] - p.b[2]}" fill="${DRAWER_BOX.has(p.role) ? '#f2f2f2' : '#fff'}" stroke="#000" stroke-width="${sw}"/>`;
  }
  // a balloon on each part whose middle isn't hidden by a part in front of it
  const shown = new Set();
  for (const p of byDepth.slice().reverse()) {
    const cx = (p.b[0] + p.b[3]) / 2, cz = (p.b[2] + p.b[5]) / 2;
    const hidden = caseParts.some((q) => q !== p && q.b[1] < p.b[1] - 1e-3 && q.b[0] <= cx && cx <= q.b[3] && q.b[2] <= cz && cz <= q.b[5]);
    if (!hidden && balloon(fx(cx), Y(cz), p.no)) shown.add(p.no);
  }
  text(fx(W / 2), Y(-fs * 0.2) + fs * 6.2, 'FRONT (fronts off)', { bold: true });
  dimH(fx(0), fx(W), Y(0) + fs * 2.4, Y(0) + fs * 0.4, fr(W));
  dimV(Y(0), Y(H), fx(0) - fs * 2.6, fx(0) - fs * 0.4, fr(H));
  // heights to the top of each fixed horizontal part, from the floor
  const levels = [...new Set(caseParts.filter((p) => LEVELS.has(p.role)).map((p) => +p.b[5].toFixed(3)))]
    .filter((z) => z > 1e-3 && z < H - 1e-3).sort((a, b) => a - b);
  let lastY = Infinity;
  for (const z of levels) {
    const y = Y(z);
    if (lastY - y < fs * 1.1) continue;
    lastY = y;
    line(fx(W) + fs * 0.4, y, fx(W) + fs * 1.6, y, sw * 0.6);
    text(fx(W) + fs * 1.8, y + fs * 0.35, fr(z), { anchor: 'start', size: fs * 0.9 });
  }
  if (levels.length) text(fx(W) + fs * 1.8, Y(H) - fs * 0.6, 'to top of', { anchor: 'start', size: fs * 0.8 });
  // partitions: from the left side
  for (const p of caseParts.filter((q) => q.role === 'PARTITION')) {
    dimH(fx(0), fx(p.b[0]), Y(H) - fs * 1.6, Y(H) - fs * 0.3, fr(p.b[0]));
  }

  // --- section through the middle of a bay, seen from the right (front at left)
  const thinX = (p) => p.b[3] - p.b[0] < 2 && p.b[5] - p.b[2] > 2;
  const cut = [0.5, 0.25, 0.75, 0.4, 0.6].map((t) => W * t).find((x) => !caseParts.some((p) => thinX(p) && p.b[0] - 0.01 <= x && x <= p.b[3] + 0.01)) ?? W / 2;
  const sx = (y) => xSec + (fronts.length ? 1.5 : 0) + y;
  const crosses = (p) => p.b[0] < cut && cut < p.b[3];
  const beyond = model.parts.filter((p) => !crosses(p) && p.b[3] <= cut && !FRONTS.has(p.role)).sort((a, b) => a.b[3] - b.b[3]);
  for (const p of beyond) {
    s += `<rect x="${sx(p.b[1])}" y="${Y(p.b[5])}" width="${p.b[4] - p.b[1]}" height="${p.b[5] - p.b[2]}" fill="#fff" stroke="#999" stroke-width="${sw * 0.7}"/>`;
  }
  const cutParts = model.parts.filter(crosses);
  for (const p of cutParts) {
    const isFront = FRONTS.has(p.role);
    s += `<rect x="${sx(p.b[1])}" y="${Y(p.b[5])}" width="${p.b[4] - p.b[1]}" height="${p.b[5] - p.b[2]}" fill="${isFront ? '#fff' : '#d0d0d0'}" stroke="#000" stroke-width="${sw}"${isFront ? ` stroke-dasharray="${fs * 0.5} ${fs * 0.3}"` : ''}/>`;
  }
  for (const p of cutParts.filter((q) => !FRONTS.has(q.role) && !shown.has(q.no)).sort((a, b) => (b.b[4] - b.b[1]) * (b.b[5] - b.b[2]) - (a.b[4] - a.b[1]) * (a.b[5] - a.b[2]))) {
    if (balloon(sx((p.b[1] + p.b[4]) / 2), Y((p.b[2] + p.b[5]) / 2), p.no)) shown.add(p.no);
  }
  for (const p of beyond.filter((q) => !shown.has(q.no))) {
    if (balloon(sx((p.b[1] + p.b[4]) / 2), Y((p.b[2] + p.b[5]) / 2), p.no)) shown.add(p.no);
  }
  text(sx(D / 2), Y(-fs * 0.2) + fs * 6.2, `SECTION ${fr(cut)} FROM LEFT (front at left)`, { bold: true });
  dimH(sx(0), sx(D), Y(0) + fs * 2.4, Y(0) + fs * 0.4, fr(D));
  const back = caseParts.filter((p) => p.role === 'BACK').sort((a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1])[0];
  if (back && D - back.b[4] > 0.05) dimH(sx(back.b[4]), sx(D), Y(H) - fs * 1.6, Y(H) - fs * 0.3, fr(D - back.b[4]));

  // --- fronts, as seen from the front, with their sizes
  if (F) {
    const ox = xFr - Math.min(F[0], 0);
    s += `<rect x="${ox}" y="${Y(H)}" width="${W}" height="${H}" fill="none" stroke="#bbb" stroke-width="${sw * 0.7}" stroke-dasharray="${fs * 0.5} ${fs * 0.3}"/>`;
    for (const p of fronts.slice().sort((a, b) => b.b[1] - a.b[1])) {
      const w = p.b[3] - p.b[0], h = p.b[5] - p.b[2];
      s += `<rect x="${ox + p.b[0]}" y="${Y(p.b[5])}" width="${w}" height="${h}" fill="#fff" stroke="#000" stroke-width="${sw}"/>`;
      const cx = ox + (p.b[0] + p.b[3]) / 2, cy = Y((p.b[2] + p.b[5]) / 2);
      if (balloon(cx, cy - fs * 0.9, p.no)) shown.add(p.no);
      if (w > fs * 5.5 && h > fs * 2.5) text(cx, cy + fs * 1.2, `${fr(w)} × ${fr(h)}`, { size: fs * 0.9 });
    }
    // gaps: from the case bottom / floor to the lowest front, and its overlay at the sides
    const lo = Math.min(...fronts.map((p) => p.b[2]));
    dimV(Y(0), Y(lo), ox - fs * 2.2, ox - fs * 0.4, fr(lo));
    text(ox + W / 2, Y(-fs * 0.2) + fs * 6.2, 'FRONTS', { bold: true });
    dimH(ox + F[0], ox + F[2], Y(0) + fs * 2.4, Y(Math.min(lo, 0)) + fs * 0.4, fr(F[2] - F[0]));
  }
  return { svg: `<svg viewBox="0 0 ${totalW} ${totalH}" xmlns="http://www.w3.org/2000/svg">${s}</svg>`, totalW, totalH, shown };
}

/**
 * places: from /api/extract (lib/parts.js placeOf), one per body.
 * opts: { job, where: Map(part name -> "Sheet 2 #7"), cabinets: Set of codes to print (all if absent) }
 */
// Custom parts tagged without an item name (code CUSTOM): one item per group of
// parts that touch in the model (CUSTOM-1, CUSTOM-2, ... left to right, front to
// back), so each built-up piece gets its own page. A custom item with its own
// code (Tag cabinet part / Cabinet extrude) is its own page already.
const TOUCH = 0.06;   // inch: boxes this close count as touching
export function splitCustom(places, code = 'CUSTOM') {
  const mine = places.filter((p) => p.cabinet === code);
  if (mine.length < 2) return places;
  const bounds = mine.map((p) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const c of p.corners) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], c[d]); hi[d] = Math.max(hi[d], c[d]); }
    return { lo, hi };
  });
  const up = mine.map((_, i) => i);
  const find = (i) => (up[i] === i ? i : (up[i] = find(up[i])));
  for (let i = 0; i < mine.length; i++) {
    for (let j = i + 1; j < mine.length; j++) {
      const a = bounds[i], b = bounds[j];
      if ([0, 1, 2].every((d) => a.lo[d] <= b.hi[d] + TOUCH && b.lo[d] <= a.hi[d] + TOUCH)) up[find(i)] = find(j);
    }
  }
  const groups = new Map();
  mine.forEach((p, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  if (groups.size < 2) return places;
  const lowest = (g) => g.reduce((m, i) => [Math.min(m[0], bounds[i].lo[0]), Math.min(m[1], bounds[i].lo[1])], [Infinity, Infinity]);
  const order = [...groups.values()].sort((g, h) => { const a = lowest(g), b = lowest(h); return Math.abs(a[0] - b[0]) > 1 ? a[0] - b[0] : a[1] - b[1]; });
  const name = new Map();
  order.forEach((g, k) => g.forEach((i) => name.set(mine[i], `${code}-${k + 1}`)));
  return places.map((p) => (name.has(p) ? { ...p, cabinet: name.get(p) } : p));
}

export function constructionHTML(places, opts = {}) {
  const byCab = new Map();
  const picked = (places || []).filter((p) => p.cabinet && !(opts.cabinets && !opts.cabinets.has(p.cabinet)));
  for (const p of splitCustom(picked)) {
    if (!byCab.has(p.cabinet)) byCab.set(p.cabinet, []);
    byCab.get(p.cabinet).push(p);
  }
  const cabs = [...byCab.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const pages = cabs.map((code) => {
    const model = cabinetModel(byCab.get(code));
    const rows = partRows(model, opts.where);
    // text size in drawing inches so it prints near 8 pt whatever the cabinet's size
    // drawing height: what the tables leave on a landscape letter page (they
    // run onto a second page past that)
    const drawers = drawerBoxes(model);
    const tableIn = 0.17 * (rows.length + 1) + (drawers.length ? 0.17 * (drawers.length + 1) + 0.08 : 0);
    const svgIn = Math.max(2.6, Math.min(4.8, 7.7 - 1.0 - tableIn));
    let fs = 1.4;
    for (let k = 0; k < 3; k++) {
      const v = svgView(model, fs);
      const inPerUnit = Math.min(9.9 / v.totalW, svgIn / v.totalH);
      fs = 0.11 / inPerUnit;
    }
    const view = svgView(model, fs);
    const fronts = model.parts.filter((p) => FRONTS.has(p.role));
    const tk = model.parts.filter((p) => p.role === 'TOE_KICK').reduce((m, p) => Math.max(m, p.b[5]), 0);
    // a custom item (all hand-made parts) has no case to speak of
    const custom = byCab.get(code).every((p) => p.custom);
    const sub = [`${fr(model.W)} W × ${fr(model.H)} H × ${fr(model.D)} D${custom ? (fronts.length ? ' (fronts off)' : '') : ` (case${fronts.length ? ', fronts off' : ''})`}`, tk ? `toe kick ${fr(tk)}` : '', `${model.parts.length} parts`].filter(Boolean).join('  ·  ');
    const table = rows.map((r) => `<tr${view.shown.has(r.no) ? '' : ' class="unseen"'}>
      <td class="n"><b>${r.no}</b></td><td>${esc(WORDS[r.role] || r.role || 'Part')}</td><td class="c">${r.parts.length}</td>
      <td class="n">${fr(r.size[0])} × ${fr(r.size[1])} × ${fr(r.size[2])}</td><td>${esc(r.material)}</td>
      <td class="names">${r.parts.map((p) => esc(p.name)).join('<br>')}</td>
      <td class="n sheets">${r.cnc ? r.where.map((w) => esc(w || '–')).join('<br>') : 'cut list'}</td></tr>`).join('');
    const dTable = drawers.length ? `<table class="drawers"><thead><tr><th>Drawer box</th><th>Outside W × H × D</th><th>Bottom at</th><th>Parts</th></tr></thead><tbody>${
      drawers.map((d, i) => `<tr><td>${i + 1}${i === 0 && drawers.length > 1 ? ' (top)' : ''}</td><td class="n">${fr(d.w)} × ${fr(d.h)} × ${fr(d.d)}</td><td class="n">${fr(d.b[2])}</td><td>${[...new Set(d.parts.map((p) => p.no))].sort((a, b) => a - b).join(', ')}</td></tr>`).join('')}</tbody></table>` : '';
    return `<section class="page">
      <header><div><h1>${esc(code)}</h1><div class="sub">${esc(sub)}</div></div><div class="job">${esc(opts.job || '')}<br>${new Date().toLocaleDateString()}</div></header>
      ${view.svg.replace('<svg ', `<svg style="max-height:${svgIn.toFixed(2)}in" `)}
      <table><thead><tr><th>#</th><th>Part</th><th>Qty</th><th>L × W × T</th><th>Material</th><th>Labels</th><th>Sheet</th></tr></thead><tbody>${table}</tbody></table>
      ${dTable}
      <p class="foot">Heights are from the floor (bottom of the case) to the top of each part. Sizes are drawn from the Onshape model. Hardware isn't shown.${opts.where?.size ? ' Sheet is the sheet each part is cut from, numbered as on the printed layouts (per material).' : ' Nest the job first to fill in the Sheet column.'}${rows.some((r) => !view.shown.has(r.no)) ? ' Grey rows are hidden in these views.' : ''}</p>
    </section>`;
  });
  if (!pages.length) return null;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(opts.job || 'Job')} construction sheets</title><style>
    @page { size: landscape; margin: 0.4in; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; }
    .page { page-break-after: always; break-after: page; }
    .page:last-child { page-break-after: auto; break-after: auto; }
    header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #000; padding-bottom: 4px; margin-bottom: 6px; }
    h1 { font-size: 22px; margin: 0; }
    .sub { font-size: 13px; }
    .job { text-align: right; font-size: 12px; }
    svg { width: 100%; height: auto; display: block; font-family: Arial, Helvetica, sans-serif; }
    table { border-collapse: collapse; width: 100%; font-size: 10px; margin-top: 6px; break-inside: auto; }
    tr { break-inside: avoid; }
    th, td { border-bottom: 1px solid #999; padding: 1px 6px; text-align: left; vertical-align: top; }
    td.n { white-space: nowrap; font-variant-numeric: tabular-nums; }
    td.c { text-align: center; }
    td.names, td.sheets { font-size: 9px; line-height: 12px; }
    td.names { color: #333; }
    tr.unseen td { color: #777; }
    table.drawers { width: auto; min-width: 50%; }
    .foot { font-size: 10px; color: #444; margin: 6px 0 0; }
  </style></head><body>${pages.join('')}</body></html>`;
}
