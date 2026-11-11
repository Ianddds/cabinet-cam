// Small 2D geometry helpers shared by the server and the browser.
// Polygons are arrays of [x, y] with no repeated closing point.

export function signedArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function ensureCCW(poly) {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

export function ensureCW(poly) {
  return signedArea(poly) > 0 ? poly.slice().reverse() : poly;
}

export function bbox(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

const near = (a, b, tol) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;

// Join edge polylines (in any order/direction) into closed loops.
export function chainLoops(polylines, tol = 1e-6) {
  const unused = polylines.filter((p) => p.length >= 2).map((p) => p.slice());
  const loops = [];
  while (unused.length) {
    let loop = unused.shift();
    let guard = 0;
    while (!near(loop[0], loop[loop.length - 1], tol) && guard++ < 100000) {
      const end = loop[loop.length - 1];
      const i = unused.findIndex((p) => near(p[0], end, tol) || near(p[p.length - 1], end, tol));
      if (i < 0) break; // open chain; keep what we have
      let next = unused.splice(i, 1)[0];
      if (!near(next[0], end, tol)) next = next.reverse();
      loop = loop.concat(next.slice(1));
    }
    if (near(loop[0], loop[loop.length - 1], tol)) loop.pop();
    loops.push(simplify(loop, tol));
  }
  return loops.filter((l) => l.length >= 3);
}

// Drop duplicate and collinear points.
export function simplify(poly, tol = 1e-9) {
  const out = [];
  for (const p of poly) {
    if (!out.length || !near(out[out.length - 1], p, tol)) out.push(p);
  }
  if (out.length > 1 && near(out[0], out[out.length - 1], tol)) out.pop();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      if (Math.abs(cross) / len < tol) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

// Offset a polygon by d (positive = outward for a CCW polygon) using mitered
// corners. Fine for straight-edged parts and finely sampled arcs.
export function offsetPolygon(poly, d) {
  const p = ensureCCW(poly);
  const n = p.length;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = dy / len, ny = -dx / len; // outward normal for CCW
    lines.push({ a: [a[0] + nx * d, a[1] + ny * d], dir: [dx / len, dy / len] });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i - 1 + n) % n], L2 = lines[i];
    const cross = L1.dir[0] * L2.dir[1] - L1.dir[1] * L2.dir[0];
    if (Math.abs(cross) < 1e-9) {
      out.push(L2.a);
      continue;
    }
    const wx = L2.a[0] - L1.a[0], wy = L2.a[1] - L1.a[1];
    const t = (wx * L2.dir[1] - wy * L2.dir[0]) / cross;
    out.push([L1.a[0] + L1.dir[0] * t, L1.a[1] + L1.dir[1] * t]);
  }
  return out;
}

// Ray-cast point in polygon.
export function pointInPolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Rotate 90 deg (x,y) -> (y, w - x) inside a w x h box; result box is h x w.
export function rotate90(points, w) {
  return points.map(([x, y]) => [y, w - x]);
}

export function translate(points, dx, dy) {
  return points.map(([x, y]) => [x + dx, y + dy]);
}
