// Fits custom shapes (shapes.js) off the page's main thread, so a job with
// complicated outlines doesn't freeze the window. Returns only where each shape
// goes; the page lays them out from that (placeShapes with spots).
import './vendor/clipper.js';   // sets self.ClipperLib
import { placeShapes } from './shapes.js';

self.onmessage = (e) => {
  const { id, nest, parts, opts } = e.data;
  try {
    let last = 0;
    const r = placeShapes(nest, parts, { ...opts, onProgress: (p) => { if (Date.now() - last > 400) { last = Date.now(); self.postMessage({ id, progress: p }); } } });
    self.postMessage({ id, spots: r.spots || null });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
