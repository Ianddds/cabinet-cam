// Re-plans one sheet's toolpaths off the page's main thread, after a hand edit
// (tabs, screws, moved / pasted / deleted parts), so dragging and clicking stay
// smooth on big sheets. The page shows the new layout at once and the toolpaths
// when this answers.
import './vendor/clipper.js';   // sets self.ClipperLib
import { sheetToolpaths, screwCheck } from './toolpath.js';

self.onmessage = (e) => {
  const { id, sheet, cfg, checkScrews } = e.data;
  try {
    const tp = sheetToolpaths(sheet, cfg);
    const chk = checkScrews ? screwCheck(sheet, tp.moves, cfg) : [];
    self.postMessage({ id, tp, chk });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
