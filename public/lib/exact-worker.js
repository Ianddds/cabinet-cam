// Builds the exact cut (exactcut.js) off the page's main thread: the simulator
// sends the moves cut so far, gets back the mesh (transferred, not copied).
import './vendor/clipper.js';   // sets self.ClipperLib
import { ShapeUtils, Vector2 } from './vendor/three/three.module.min.js';
import { cutMesh } from './exactcut.js';

const tri = (outer, holes) => ShapeUtils.triangulateShape(outer.map(([x, y]) => new Vector2(x, y)), holes.map((h) => h.map(([x, y]) => new Vector2(x, y))));

self.onmessage = (e) => {
  const { id, moves, opts } = e.data;
  try {
    const m = cutMesh(moves, { ...opts, triangulate: tri });
    self.postMessage({ id, position: m.position, normal: m.normal, kind: m.kind, levels: m.levels }, [m.position.buffer, m.normal.buffer, m.kind.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
