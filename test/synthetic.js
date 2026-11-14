import './clipper-node.js';
import { union } from '../public/lib/clip.js';
// Builds raw extraction data shaped like lib/extract.fs output (meters, local
// face coords, shuffled/reversed edges) so the pipeline can be tested offline.
const M = 1 / 39.37007874;

function rectPoly(x0, y0, x1, y1) { return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
function circlePoly(cx, cy, d, n = 32) {
  const out = [];
  for (let k = 0; k < n; k++) out.push([cx + (d / 2) * Math.cos((2 * Math.PI * k) / n), cy + (d / 2) * Math.sin((2 * Math.PI * k) / n)]);
  return out;
}

function edgesOf(poly, seed) {
  const segs = poly.map((p, i) => [p, poly[(i + 1) % poly.length]]);
  // deterministic shuffle + reverse some
  let s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  segs.sort(() => rnd() - 0.5);
  return segs.map((sg) => (rnd() > 0.5 ? sg.slice().reverse() : sg)).map((sg) => sg.map(([x, y]) => [x * M, y * M]));
}

function area(poly) {
  let a = 0;
  poly.forEach(([x1, y1], i) => { const [x2, y2] = poly[(i + 1) % poly.length]; a += x1 * y2 - x2 * y1; });
  return Math.abs(a / 2) * M * M;
}

// outline in inches (local coords), pockets [{rect:[x0,y0,x1,y1], depth}], cut from 'top' or 'bottom'
export function rawPart(name, outline, t, pockets = [], opts = {}) {
  const fromBottom = opts.side === 'bottom';
  const faces = [];
  faces.push({ z: 0, dir: 1, area: area(outline), edges: edgesOf(outline, name.length) });
  faces.push({ z: -t * M, dir: -1, area: area(outline), edges: edgesOf(outline, name.length + 7) });
  for (const p of pockets) {
    const poly = p.poly || rectPoly(...p.rect);
    faces.push({
      z: (fromBottom ? -t + p.depth : -p.depth) * M,
      dir: fromBottom ? -1 : 1,
      area: area(poly),
      edges: edgesOf(poly, Math.round(poly[0][0] * 13) + 3),
    });
  }
  const xs = outline.map((p) => p[0]), ys = outline.map((p) => p[1]);
  // Cabinet build's tagged dado walls: { cut, kind, seg (inches), depth }
  const cuts = (opts.cuts || []).map((c) => ({
    cut: c.cut, kind: c.kind || 'dado', seg: c.seg.map(([x, y]) => [x * M, y * M]),
    z0: (fromBottom ? -t : -c.depth) * M, z1: (fromBottom ? -t + c.depth : 0) * M,
  }));
  return {
    id: `JH${name.length}${pockets.length}`,
    name,
    material: '',
    attributes: opts.attributes || [{ cabinetPart: true, material: '3/4 Baltic Birch', cabinetCode: opts.cabinet || 'B36', role: opts.role || (/Side/.test(name) ? 'SIDE' : /Bottom/.test(name) ? 'BOTTOM' : /Stretcher/.test(name) ? 'STRETCHER' : ''), cnc: true }],
    box: [Math.min(...xs) * M, Math.min(...ys) * M, -t * M, Math.max(...xs) * M, Math.max(...ys) * M, 0],
    faces,
    cuts,
    ...(opts.place ? { place: { o: opts.place.o.map((n) => n * M), x: opts.place.x, z: opts.place.z } } : {}),
  };
}

// Model placement (inches): local frame origin o, local x axis, face normal z.
// World: x = right, y = into the cabinets (front at y = 0), z = up.
const at = (o, x, z) => ({ o, x, z });

export function sampleKitchen() {
  const t = 0.75;
  // Base side: 23.25 deep x 34.5 tall, toe kick notch 3 deep x 4 high at front bottom,
  // stood vertically in local coords (x = depth, y = height) to exercise rotation.
  const side = [[0, 0], [20.25, 0], [20.25, 4], [23.25, 4], [23.25, 34.5], [0, 34.5]];
  const sidePockets = [
    { rect: [0.375, 4, 23.25, 4.75], depth: 0.25 },       // bottom dado, open at the front edge
    { rect: [0, 0, 0.5, 34.5], depth: 0.375 },            // back rabbet along x=0 edge (through)
  ];
  const parts = [];
  // cabinets side by side from x = 0; side local x runs from the back (y = 23.25) forward
  const X0 = { B36: 0, B24: 36, B18: 60 }, WD = { B36: 36, B24: 24, B18: 18 };
  for (const cab of ['B36', 'B24', 'B18']) {
    const x0 = X0[cab], x1 = X0[cab] + WD[cab];
    parts.push(rawPart(`${cab} Left Side`, side, t, sidePockets, { cabinet: cab, place: at([x0, 23.25, 0], [0, -1, 0], [-1, 0, 0]) }));
    parts.push(rawPart(`${cab} Right Side`, side, t, sidePockets, { cabinet: cab, side: 'bottom', place: at([x1 - t, 23.25, 0], [0, -1, 0], [-1, 0, 0]) }));
  }
  for (const [cab, w] of [['B36', 34.75], ['B24', 22.75], ['B18', 16.75]]) {
    parts.push(rawPart(`${cab} Bottom`, rectPoly(0, 0, w, 22.75), t, [], { cabinet: cab, place: at([X0[cab] + 0.625, 0, 4.75], [1, 0, 0], [0, 0, 1]) }));
  }
  for (const [cab, w] of [['B36', 34.75], ['B24', 22.75], ['B18', 16.75]]) {
    parts.push(rawPart(`${cab} Front Stretcher`, rectPoly(0, 0, w, 4), t, [], { cabinet: cab, place: at([X0[cab] + 0.625, 0, 34.5], [1, 0, 0], [0, 0, 1]) }));
    parts.push(rawPart(`${cab} Rear Stretcher`, rectPoly(0, 0, w, 4), t, [], { cabinet: cab, place: at([X0[cab] + 0.625, 18.75, 34.5], [1, 0, 0], [0, 0, 1]) }));
  }
  // Frameless base side as Cabinet build makes it (no toe notch, separate base):
  // bottom rabbet, back groove and back stretcher rabbet are all 1/4 deep and
  // touch, so Onshape gives them ONE floor face (the case that broke the bbox pockets).
  {
    const tt = 0.705, H = 30.5, D = 24, dc = 0.008;
    const yBack0 = D - 0.5 - 0.472;
    const merged = union([
      rectPoly(0.5, 0, D, tt + dc),                     // bottom rabbet, blind 1/2 at the front
      rectPoly(yBack0 - dc, tt - 0.25, D - 0.5, H),     // back groove, open at the top
      rectPoly(yBack0 - 4, H - tt - dc, yBack0, H),     // back stretcher rabbet
    ], [], 'nonzero');
    const ffSide = rawPart('B36-2-SIDE-R', rectPoly(0, 0, D, H), tt, [
      { poly: merged[0], depth: 0.25 },
      { rect: [0.5, H - tt - dc, 4, H], depth: 0.25 },  // front stretcher rabbet
      // 5 mm shelf pins, 3/8 deep, two columns
      ...[8, 12].flatMap((yy) => [2.5, 20.5].map((xx) => ({ poly: circlePoly(xx, yy, 5 / 25.4), depth: 0.375 }))),
    ], { side: 'bottom', cuts: [
      { cut: 'bot', kind: 'rabbet', seg: [[0.5, tt + dc], [yBack0 - dc, tt + dc]], depth: 0.25 },
      { cut: 'grv', kind: 'groove', seg: [[yBack0 - dc, tt + dc], [yBack0 - dc, H - tt - dc]], depth: 0.25 },
      { cut: 'grv', kind: 'groove', seg: [[D - 0.5, tt + dc], [D - 0.5, H]], depth: 0.25 },
      { cut: 'bstr', kind: 'rabbet', seg: [[yBack0 - 4, H - tt - dc], [yBack0 - dc, H - tt - dc]], depth: 0.25 },
      { cut: 'fstr', kind: 'rabbet', seg: [[0.5, H - tt - dc], [4, H - tt - dc]], depth: 0.25 },
    ], attributes: [{ cabinetPart: true, label: 'B36-2-SIDE-R', cabinetCode: 'B36-2', role: 'SIDE', material: 'BB 3/4', grain: 'length', cnc: true }] });
    parts.push(ffSide);
  }
  // Stretcher-style dado with T-bone corner reliefs at its stopped end
  {
    const rr = 0.125, x1 = 4, y0 = 6, y1 = 6.875;    // relief drawn for a 1/4 bit; the test cuts with 3/8
    const arc = (cx, cy, from, to) => { const pts = []; for (let k = 0; k <= 16; k++) { const a = from + ((to - from) * k) / 16; pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); } return pts; };
    // outline: open at x=0 (runs out of the panel edge), stopped at x=4 with reliefs at both corners
    const poly = [[0, y0], [x1, y0], ...arc(x1, y0 + rr, -Math.PI / 2, Math.PI / 2).slice(1, -1), [x1, y0 + 2 * rr],
                  [x1, y1 - 2 * rr], ...arc(x1, y1 - rr, -Math.PI / 2, Math.PI / 2).slice(1, -1), [x1, y1], [0, y1]];
    parts.push(rawPart('Relief Test Side', rectPoly(0, 0, 23.25, 30), 0.75, [{ poly, depth: 0.25 }],
      { cuts: [{ cut: 'd1', seg: [[0, y0], [x1, y0]], depth: 0.25 }, { cut: 'd1', seg: [[0, y1], [x1, y1]], depth: 0.25 }],
        attributes: [{ cabinetPart: true, label: 'RELIEF-SIDE', cabinetCode: 'T1', role: 'SIDE', material: '3/4 Baltic Birch', grain: 'length', cnc: true }] }));
  }
  // MDF part with a cutout and no grain
  const panel = rawPart('Grommet Panel', rectPoly(0, 0, 20, 12), t, [], { attributes: [{ cabinetPart: true, material: '3/4 MDF', grain: 'none', cnc: true }] });
  const hole = rectPoly(8, 4, 12, 8);
  panel.faces[1].edges.push(...edgesOf(hole, 99));
  panel.faces[1].edges.push(...edgesOf(circlePoly(2, 2, 0.25), 7));      // 1/4 through -> drill
  panel.faces[1].edges.push(...edgesOf(circlePoly(16, 9, 1.0), 8));      // 1" through -> inside contour
  panel.faces[1].edges.push(...edgesOf(circlePoly(18, 2, 0.118), 9));    // 3 mm through -> no drill, flagged
  panel.faces.push({ z: -0.5 * M, dir: 1, area: Math.PI * 0.69 ** 2 * M * M, edges: edgesOf(circlePoly(4, 9, 35 / 25.4), 10) }); // 35 mm hinge cup
  parts.push(panel);
  // Tandem drawer back as Cabinet drawers makes it (dado joinery)
  {
    const W = 20.0, Hh = 4.5, mm = 1 / 25.4, nW = 35 * mm, nH = 13 * mm;
    const ol = [[0.5, 0], [0.5 + nW, 0], [0.5 + nW, nH], [W - 0.5 - nW, nH], [W - 0.5 - nW, 0], [W - 0.5, 0], [W - 0.5, Hh], [0.5, Hh]];
    const back = rawPart('B36 drawer 1 back', ol, 0.5, [
      { rect: [0.25, 13 * mm, W - 0.25, 13 * mm + 0.5], depth: 0.25 },   // bottom groove (cut from the inside face)
    ], { attributes: [{ cabinetPart: true, label: 'B36-DRAWER_BACK-1', cabinetCode: 'B36', material: 'BB 1/2', grain: 'length', cnc: true }] });
    // hook holes on the OTHER face: floors facing the opposite way, 10 mm deep
    for (const cx of [0.5 + 7 * mm, W - 0.5 - 7 * mm]) {
      const r = 3 * mm, cy = nH + 11 * mm, circ = [];
      for (let k = 0; k < 24; k++) circ.push([cx + r * Math.cos((k * Math.PI) / 12), cy + r * Math.sin((k * Math.PI) / 12)]);
      back.faces.push({ z: (-0.5 + 10 * mm) * M, dir: -1, area: Math.PI * r * r * M * M, edges: edgesOf(circ, 5) });
    }
    parts.push(back);
  }
  // face frame members (cnc: false) -> cut list, not nested
  const ff = (label, cab, role, L, W) => rawPart(label, rectPoly(0, 0, L, W), 0.75, [], {
    attributes: [{ cabinetPart: true, label, cabinetCode: cab, role, material: 'Hard Maple 3/4', grain: 'length', cnc: false }] });
  for (const cab of ['W3030', 'W3030-2']) {
    parts.push(ff(`${cab}-FF_STILE-L`, cab, 'FF_STILE', 30, 1.5), ff(`${cab}-FF_STILE-R`, cab, 'FF_STILE', 30, 1.5));
    parts.push(ff(`${cab}-FF_RAIL-T`, cab, 'FF_RAIL', 27, 1.5), ff(`${cab}-FF_RAIL-B`, cab, 'FF_RAIL', 27, 1.5));
    parts.push(ff(`${cab}-FF_STILE-M1`, cab, 'FF_STILE', 27, 2));
  }
  // things that must not be cut: a slide (excluded), an envelope (layout), and an untagged block
  parts.push(rawPart('Tandem 563H slide L', rectPoly(0, 0, 21, 1.5), 0.5, [], { attributes: [{ cabinetExcluded: true, reason: 'hardware' }] }));
  parts.push(rawPart('B36 envelope', rectPoly(0, 0, 36, 34.5), 24, [], { attributes: [{ cabinetLayout: 'envelope' }] }));
  parts.push(rawPart('Part 7', rectPoly(0, 0, 10, 3), 0.75, [], { attributes: [] }));
  return parts;
}

// A base cabinet with a partition, doors, drawers, shelves, back and toe kick,
// as construction-drawing records (what lib/parts.js placeOf returns), built
// from world boxes. turn: quarter turns about the vertical, to check the
// cabinet's front is found wherever it stands.
export function sampleCabinetPlaces(turn = 0, code = 'B30D') {
  const list = [];
  const add = (name, role, bx, material = '3/4 Baltic Birch', cnc = true) => list.push({ name: `${code}-${name}`, role, bx, material, cnc });
  add('SIDE-L', 'SIDE', [0, 0, 4, 0.75, 24, 34.5]);
  add('SIDE-R', 'SIDE', [29.25, 0, 4, 30, 24, 34.5]);
  add('BOTTOM', 'BOTTOM', [0.75, 0, 4, 29.25, 23.25, 4.75]);
  add('BACK', 'BACK', [0.75, 23.25, 4, 29.25, 23.5, 34.5], '1/4 Ply');
  add('STRETCHER-F', 'STRETCHER', [0.75, 0, 33.75, 29.25, 4, 34.5]);
  add('STRETCHER-B', 'STRETCHER', [0.75, 19.25, 33.75, 29.25, 23.25, 34.5]);
  add('TOE_KICK', 'TOE_KICK', [0.75, 3, 0, 29.25, 3.75, 4]);
  add('PARTITION', 'PARTITION', [14.625, 0, 4.75, 15.375, 23.25, 33.75]);
  add('FIXED_SHELF', 'FIXED_SHELF', [0.75, 0, 18, 14.625, 23.25, 18.75]);
  add('ADJ_SHELF', 'ADJ_SHELF', [0.75, 0.25, 25, 14.625, 22.5, 25.75]);
  for (const [k, z0, h] of [[1, 6, 6], [2, 20, 10]]) {
    add(`DRAWER_SIDE-${k}-L`, 'DRAWER_SIDE', [16, 1, z0, 16.5, 22, z0 + h], 'BB 1/2');
    add(`DRAWER_SIDE-${k}-R`, 'DRAWER_SIDE', [28.125, 1, z0, 28.625, 22, z0 + h], 'BB 1/2');
    add(`DRAWER_FRONT-${k}`, 'DRAWER_FRONT', [16.5, 1, z0, 28.125, 1.5, z0 + h], 'BB 1/2');
    add(`DRAWER_BACK-${k}`, 'DRAWER_BACK', [16.5, 21.5, z0 + 0.5, 28.125, 22, z0 + h], 'BB 1/2');
    add(`DRAWER_BOTTOM-${k}`, 'DRAWER_BOTTOM', [16.25, 1.25, z0 + 0.5, 28.375, 21.75, z0 + 0.75], '1/4 Ply');
  }
  add('DOOR', 'DOOR', [0.0625, -0.75, 4.0625, 14.9375, 0, 34.4375], 'Maple 3/4');
  add('DRAWER_FACE-1', 'DRAWER_FACE', [15.0625, -0.75, 4.0625, 29.9375, 0, 16.9375], 'Maple 3/4');
  add('DRAWER_FACE-2', 'DRAWER_FACE', [15.0625, -0.75, 17.0625, 29.9375, 0, 34.4375], 'Maple 3/4');
  const c = [1, 0, -1, 0][turn & 3], s = [0, 1, 0, -1][turn & 3];
  const rot = ([x, y, z]) => [+(c * x - s * y + 100).toFixed(4), +(s * x + c * y + 50).toFixed(4), z];
  return list.map(({ name, role, bx, material, cnc }) => {
    const e = [bx[3] - bx[0], bx[4] - bx[1], bx[5] - bx[2]];
    const thin = e.indexOf(Math.min(...e));
    const n = [0, 0, 0]; n[thin] = 1;
    const corners = [];
    for (const x of [bx[0], bx[3]]) for (const y of [bx[1], bx[4]]) for (const z of [bx[2], bx[5]]) corners.push(rot([x, y, z]));
    const r = rot(n), r0 = rot([0, 0, 0]);
    const others = e.filter((_, i) => i !== thin).sort((a, b) => b - a);
    return { name, cabinet: code, role, material, cnc, size: [...others, e[thin]], n: [r[0] - r0[0], r[1] - r0[1], r[2] - r0[2]], corners };
  });
}
