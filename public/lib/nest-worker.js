// Runs one nest search off the page's main thread (one worker per material
// group, so groups search side by side). Returns only the winning solution; the
// page rebuilds the nest from it with its own part objects (applySolution).
import { nestParts } from './nest.js';

self.onmessage = (e) => {
  const { parts, opts } = e.data;
  try {
    const r = nestParts(parts, { ...opts, onProgress: (p) => self.postMessage({ progress: p }) });
    self.postMessage({ done: true, solution: r.solution, stats: r.stats, sheets: r.sheets.length });
  } catch (err) {
    self.postMessage({ error: String(err?.message || err) });
  }
};
