// Turn raw FeatureScript extraction (meters, local face coords) into flat CNC
// parts in inches: outline, holes, and dado/rabbet pocket floors (true shape), all
// measured from the machined (up) face with x along the part's length.
import { chainLoops, signedArea, ensureCCW, bbox, rotate90, translate} from '../public/lib/geometry.js';

const IN = 39.37007874;
const TOL_M = 2e-5; // 0.02 mm

function mergeAttributes(attrs) {
  const out = {};
  for (const a of attrs || []) if (a && typeof a === 'object' && !Array.isArray(a)) Object.assign(out, a);
  return out;
}

function distSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function loopsOf(face) {
  return chainLoops(face.edges.map((e) => e.map(([x, y]) => [x * IN, y * IN])), 1e-4);
}

export function normalizePart(raw) {
  const warnings = [];
  const [, , zmin, , , zmax] = raw.box;
  const tM = zmax - zmin;
  const thickness = +(tM * IN).toFixed(4);

  const top = [], bottom = [], floors = [];
  for (const f of raw.faces) {
    if (Math.abs(f.z - zmax) < TOL_M) top.push(f);
    else if (Math.abs(f.z - zmin) < TOL_M) bottom.push(f);
    else floors.push(f);
  }

  // Floors facing +z are cut from the top; facing -z from the bottom.
  const fromTop = floors.filter((f) => f.dir > 0);
  const fromBottom = floors.filter((f) => f.dir < 0);
  // Up = the face with the most pocket AREA (a groove beats a couple of hook holes).
  const sumArea = (fs) => fs.reduce((a, f) => a + (f.area || 0), 0);
  const side = sumArea(fromBottom) > sumArea(fromTop) ? 'bottom' : 'top';
  if (fromTop.length && fromBottom.length) {
    const other = side === 'top' ? fromBottom : fromTop;
    const inch2 = sumArea(other) * IN * IN;
    warnings.push(`Machining on both faces; the ${other.length} feature(s) on the other face (${inch2.toFixed(2)} sq in) are not cut — they need a flip or a drill`);
  }
  const cutFloors = side === 'top' ? fromTop : fromBottom;

  // Profile from the face opposite the machining (uninterrupted by dados).
  const profileFaces = side === 'top' ? bottom : top;
  if (!profileFaces.length) throw new Error(`${raw.name}: no face found for the profile`);
  if (profileFaces.length > 1) warnings.push(`Profile face is split in ${profileFaces.length}; using the largest`);
  const pf = profileFaces.reduce((a, b) => (b.area > a.area ? b : a));
  let loops = loopsOf(pf).sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
  if (!loops.length) throw new Error(`${raw.name}: could not build an outline`);

  // Flip so the machined face is up: mirror y; depths stay measured from that face.
  const mirror = (pts) => (side === 'bottom' ? pts.map(([x, y]) => [x, -y]) : pts);
  loops = loops.map(mirror);

  // Each floor face keeps all its loops (outer + islands) so its real shape is cut.
  let floorsXY = cutFloors.map((f) => {
    const depth = side === 'top' ? (zmax - f.z) * IN : (f.z - zmin) * IN;
    return { loops: loopsOf(f).map(mirror), depth: +depth.toFixed(4) };
  }).filter((p) => p.loops.length);

  // Dado / rabbet / groove side walls tagged by Cabinet build: segments on the
  // machined face, with the floor depth they run down to.
  const zTol = 1e-4; // m
  let walls = [];
  for (const c of raw.cuts || []) {
    const fromSurface = side === 'top' ? Math.abs(c.z1 - zmax) < zTol : Math.abs(c.z0 - zmin) < zTol;
    if (!fromSurface) continue;
    const depth = side === 'top' ? (zmax - c.z0) * IN : (c.z1 - zmin) * IN;
    if (depth >= thickness - 1e-4) continue;   // through: not a pocket wall
    walls.push({ cut: String(c.cut), kind: c.kind, depth: +depth.toFixed(4), seg: mirror(c.seg.map(([x, y]) => [x * IN, y * IN])) });
  }

  // Normalize: outline bbox at origin, x along the longer side.
  let outer = loops[0], holes = loops.slice(1);
  let bb = bbox(outer);
  const shift = (pts) => translate(pts, -bb.x0, -bb.y0);
  outer = shift(outer); holes = holes.map(shift);
  floorsXY = floorsXY.map((p) => ({ ...p, loops: p.loops.map(shift) }));
  walls = walls.map((wl) => ({ ...wl, seg: shift(wl.seg) }));
  let w = bb.w, h = bb.h;
  if (h > w + 1e-6) {
    outer = rotate90(outer, w); holes = holes.map((p) => rotate90(p, w));
    floorsXY = floorsXY.map((p) => ({ ...p, loops: p.loops.map((l) => rotate90(l, w)) }));
    walls = walls.map((wl) => ({ ...wl, seg: rotate90(wl.seg, w) }));
    [w, h] = [h, w];
  }

  const partArea = Math.abs(signedArea(outer)) - holes.reduce((a, l) => a + Math.abs(signedArea(l)), 0);
  const pockets = [];
  for (const f of floorsXY) {
    const sorted = f.loops.slice().sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
    const area = sorted.reduce((a, l, i) => a + (i === 0 ? 1 : -1) * Math.abs(signedArea(l)), 0);
    const b = bbox(sorted[0]);
    const desc = `${b.w.toFixed(3)} x ${b.h.toFixed(3)} at ${f.depth.toFixed(3)} deep`;
    if (f.depth >= thickness - 1e-4) { warnings.push(`Pocket ${desc} goes through the part — skipped`); continue; }
    if (area > partArea * 0.6) { warnings.push(`Pocket ${desc} covers ${Math.round((area / partArea) * 100)}% of the part — looks like a stepped body, not a dado. Not cut.`); continue; }
    // walls at this depth that lie on this floor's boundary
    const onEdge = (pt) => sorted.some((l) => l.some((q, i) => distSeg(pt, q, l[(i + 1) % l.length]) < 0.01));
    const pw = walls.filter((wl) => Math.abs(wl.depth - f.depth) < 0.002 &&
      onEdge([(wl.seg[0][0] + wl.seg[1][0]) / 2, (wl.seg[0][1] + wl.seg[1][1]) / 2]));
    const pocket = { loops: sorted, depth: f.depth, area: +area.toFixed(4), x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
    if (pw.length) pocket.walls = pw.map(({ cut, kind, seg }) => ({ cut, kind, seg }));
    pockets.push(pocket);
  }

  const attrs = mergeAttributes(raw.attributes);
  const grain = ['length', 'width', 'none'].includes(attrs.grain) ? attrs.grain : 'length';
  const materialName = attrs.material || attrs.materialPackage || raw.material || 'Unassigned';

  return {
    id: raw.id,
    name: attrs.label || raw.name || raw.id,
    cabinet: attrs.cabinetCode || attrs.cabinet || '',
    role: attrs.role || '',
    cnc: attrs.cabinetPart ? attrs.cnc !== false : true,
    material: materialName,
    thickness,
    width: +w.toFixed(4),
    height: +h.toFixed(4),
    outline: ensureCCW(outer),
    holes,
    pockets,
    grain,
    modelGrain: grain,
    side,
    qty: 1,
    include: attrs.cnc !== false,
    warnings,
  };
}

// Identical parts (same material, size, shape and machining) are combined into a qty.
function signature(p) {
  const r = (n) => n.toFixed(3);
  return [p.untagged ? 'U' : 'T', p.custom ? 'K' : '', p.cnc ? 'C' : 'N', p.role, p.material, r(p.thickness), r(p.width), r(p.height), shapeKey(p), p.grain].join('|');
}

// The part's outline, holes and pockets to the nearest 0.01". The same part
// turned half a turn in the model matches (it's the same part); a mirror image
// (the other half of a part split in two, a left vs a right) does not.
function shapeKey(p) {
  const r2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
  const turns = p.width === p.height ? [0, 1, 2, 3] : [0, 2];   // quarter turns that keep the bbox
  const keys = turns.map((q) => {
    const t = ([x, y]) => (q === 0 ? [x, y] : q === 2 ? [p.width - x, p.height - y] : q === 1 ? [p.height - y, x] : [y, p.width - x]);
    const loop = (l) => l.map(t).map(([x, y]) => `${r2(x)},${r2(y)}`).sort().join(' ');
    // pockets by their actual shape (a dado and a rabbet that meet make one L-shaped
    // pocket; its mirror image has the same bounding box and area)
    const pk = p.pockets.map((k) => `${r2(k.depth)}:${(k.loops || []).map(loop).sort().join('/')}`).sort().join(';');
    return `${loop(p.outline)}#${p.holes.map(loop).sort().join('|')}#${pk}`;
  });
  return keys.sort()[0];
}

export function normalizeAll(rawParts) {
  const errors = [];
  const groups = new Map();
  for (const raw of rawParts) {
    const a = mergeAttributes(raw.attributes);
    if (a.cabinetExcluded || a.cabinetLayout) continue; // markers, hardware, layout bodies
    try {
      const p = normalizePart(raw);
      // custom part (Tag cabinet part / Cabinet extrude, or not tagged at all):
      // a non-rectangular one is nested by its outline at any allowed angle
      p.custom = !!a.custom || !a.cabinetPart;
      if (!a.cabinetPart) {
        // opt-in: only tagged cabinet parts are cut unless ticked by hand
        p.include = false;
        p.untagged = true;
        p.warnings.unshift('Not tagged as a cabinet part (use Tag cabinet part in Onshape) — not cut unless ticked');
      }
      const sig = signature(p);
      if (groups.has(sig)) {
        const g = groups.get(sig);
        g.qty += 1;
        g.sourceNames.push(p.name);
        g.sourceCabinets.push(p.cabinet);
        if (p.cabinet && !g.cabinet.split(', ').includes(p.cabinet)) g.cabinet = `${g.cabinet}, ${p.cabinet}`;
      } else {
        groups.set(sig, { ...p, sourceNames: [p.name], sourceCabinets: [p.cabinet] });
      }
    } catch (e) {
      errors.push(e.message);
    }
  }
  const all = [...groups.values()];
  const untagged = all.filter((p) => p.untagged).reduce((n, p) => n + p.qty, 0);
  return { parts: all, errors, untagged };
}

