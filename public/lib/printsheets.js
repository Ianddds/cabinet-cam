// Printable sheet layouts for an ordinary printer: one page per sheet with the
// layout drawn in black and white (part numbers matching the labels), and a
// parts list. Paper size comes from the print dialog (landscape).
import { placedGeometry } from './nest.js';
import { numberPlacements } from './labels.js';
import { fraction } from './cutlist.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pts = (poly) => poly.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(' ');

function grainWord(part) {
  const g = part.grainEffective ?? part.grain;
  if (g === 'none') return 'none';
  if (g === 'any') return 'either';
  return `along ${fraction(g === 'width' ? part.height : part.width)}`;
}

/**
 * pages: [{ item, heading, sub, note, remnantNos }]
 * item: { sheet, group, title } from the app's results
 */
export function layoutsHTML(pages, job) {
  const body = pages.map(({ item, heading, sub, note, remnantNos }) => {
    const sh = item.sheet;
    const W = sh.w, H = sh.h, pad = 1.2;
    const fy = (y) => H - y;
    const flip = (poly) => poly.map(([x, y]) => [x, fy(y)]);
    const nos = numberPlacements(sh);
    let svg = `<svg viewBox="${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff" stroke="#000" stroke-width="0.12"/>`;
    for (const pl of sh.placements) {
      const g = placedGeometry(pl);
      svg += `<polygon points="${pts(flip(g.outline))}" fill="#f2f2f2" stroke="#000" stroke-width="0.1"/>`;
      for (const h of g.holes) svg += `<polygon points="${pts(flip(h))}" fill="#fff" stroke="#000" stroke-width="0.06"/>`;
      for (const q of g.pockets) {
        const d = q.loops.map((l) => 'M' + flip(l).map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L') + 'Z').join('');
        svg += `<path d="${d}" fill="#bbb" fill-rule="evenodd"/>`;
      }
      const bw = g.box.x1 - g.box.x0, bh = g.box.y1 - g.box.y0;
      const cx = (g.box.x0 + g.box.x1) / 2, cy = fy((g.box.y0 + g.box.y1) / 2);
      const big = Math.min(4, Math.max(1.2, Math.min(bw, bh) * 0.35));
      svg += `<text x="${cx}" y="${cy + big * 0.1}" font-size="${big}" font-weight="700" text-anchor="middle">#${nos.get(pl)}</text>`;
      if (bh > 5 && bw > 10) {
        svg += `<text x="${cx}" y="${cy + big * 0.1 + 1.6}" font-size="1.1" text-anchor="middle">${esc(pl.label || pl.part.name)}</text>`;
        svg += `<text x="${cx}" y="${cy + big * 0.1 + 2.9}" font-size="0.95" text-anchor="middle" fill="#444">${fraction(pl.part.width)} × ${fraction(pl.part.height)}</text>`;
      }
    }
    (sh.offcuts || []).forEach((oc, k) => {
      const no = remnantNos?.[k];
      for (const q of (oc.rects?.length > 1 ? oc.rects : [oc])) svg += `<rect x="${q.x}" y="${fy(q.y + q.h)}" width="${q.w}" height="${q.h}" fill="none" stroke="#000" stroke-width="0.15" stroke-dasharray="1 0.6"/>`;
      svg += `<text x="${oc.x + oc.w / 2}" y="${fy(oc.y + oc.h / 2)}" font-size="1.6" font-weight="700" text-anchor="middle">KEEP${no ? ' R' + no : ''}</text>`;
      svg += `<text x="${oc.x + oc.w / 2}" y="${fy(oc.y + oc.h / 2) + 1.8}" font-size="1.1" text-anchor="middle">${fraction(oc.w)} × ${fraction(oc.h)}</text>`;
    });
    svg += `<circle cx="0" cy="${H}" r="0.6" fill="#000"/><text x="1" y="${H + 1}" font-size="0.9">0,0</text>`;
    svg += `<text x="${W}" y="${H + 1}" font-size="0.9" text-anchor="end">grain →  ${fraction(W)} × ${fraction(H)}</text>`;
    svg += '</svg>';

    const rows = [...sh.placements].sort((a, b) => nos.get(a) - nos.get(b)).map((pl) => `<tr>
      <td class="n">#${nos.get(pl)}</td><td>${esc(pl.label || pl.part.name)}</td><td>${esc(pl.cabinet || '')}</td>
      <td class="n">${fraction(pl.part.width)} × ${fraction(pl.part.height)}</td><td>${esc(grainWord(pl.part))}</td>
      <td>${pl.part.pockets?.length ? 'dados' : ''}${pl.part.holes?.length ? (pl.part.pockets?.length ? ', ' : '') + 'cutouts' : ''}</td></tr>`).join('');
    const keep = (sh.offcuts || []).map((oc, k) => `<tr><td class="n">${remnantNos?.[k] ? 'R' + remnantNos[k] : 'KEEP'}</td><td>Offcut to keep</td><td></td><td class="n">${fraction(oc.w)} × ${fraction(oc.h)}${oc.rects?.length > 1 ? ' L' : ''}</td><td>along ${fraction(oc.w)}</td><td></td></tr>`).join('');
    return `<section class="page">
      <header><div><h1>${esc(heading)}</h1><div class="sub">${esc(sub)}</div></div><div class="job">${esc(job)}<br>${new Date().toLocaleDateString()}</div></header>
      ${note ? `<p class="note">${esc(note)}</p>` : ''}
      ${svg}
      <table><thead><tr><th>#</th><th>Part</th><th>Cabinet</th><th>Size</th><th>Grain</th><th></th></tr></thead><tbody>${rows}${keep}</tbody></table>
    </section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(job)} sheet layouts</title><style>
    @page { size: landscape; margin: 0.4in; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; }
    .page { page-break-after: always; break-after: page; }
    .page:last-child { page-break-after: auto; break-after: auto; }
    header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #000; padding-bottom: 4px; margin-bottom: 6px; }
    h1 { font-size: 20px; margin: 0; }
    .sub { font-size: 13px; }
    .job { text-align: right; font-size: 12px; }
    .note { font-size: 12px; margin: 0 0 4px; font-weight: 700; }
    svg { width: 100%; height: auto; max-height: 4.6in; display: block; font-family: Arial, Helvetica, sans-serif; }
    table { border-collapse: collapse; width: 100%; font-size: 11px; margin-top: 6px; }
    th, td { border-bottom: 1px solid #999; padding: 2px 6px; text-align: left; }
    td.n { white-space: nowrap; font-variant-numeric: tabular-nums; }
  </style></head><body>${body}</body></html>`;
}
