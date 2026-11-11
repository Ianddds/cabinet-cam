// Part labels for Zebra printers (ZPL). One strip per sheet: a sheet label,
// then one label per part (numbered to match the sheet preview), then a label
// for each offcut to keep. Sized for 2 x 1 labels; other sizes scale. Face frame / cut list parts are never nested, so
// they never get labels here.
//
// Layout is built once as simple primitives (text, box, filled box) in printer
// dots, then written as ZPL or drawn as an SVG preview, so the two match.
import { fraction } from './cutlist.js';

export const LABEL_DEFAULTS = { w: 2, h: 1, dpi: 203, header: true, offcuts: true, mode: 'download', host: '', share: '' };

// Part numbers on a sheet: left to right, then front to back.
export function numberPlacements(sheet) {
  const list = sheet.placements.map((pl, i) => ({ pl, i }));
  list.sort((a, b) => Math.round(a.pl.x * 2) - Math.round(b.pl.x * 2) || a.pl.y - b.pl.y);
  const no = new Map();
  list.forEach(({ pl }, k) => no.set(pl, k + 1));
  return no;
}

const dimsOf = (pl) => (pl.rotated ? [pl.part.height, pl.part.width] : [pl.part.width, pl.part.height]);

// Grain in words, against the part's own sizes ("along 34 1/2").
function grainText(part) {
  const g = part.grainEffective ?? part.grain;
  if (g === 'none') return 'No grain';
  if (g === 'any') return 'Grain: either way';
  return `Grain along ${fraction(g === 'width' ? part.height : part.width)}`;
}

/**
 * Labels for one sheet. item: { sheet, group, title } from the app's results.
 * info: { job, sheetLabel ("Sheet 1 of 3" / "Remnant R2"), date, remnantNos: [no|null per offcut] }
 */
export function sheetLabels(item, info, opts = LABEL_DEFAULTS) {
  const sh = item.sheet;
  const nos = numberPlacements(sh);
  const mat = `${item.group.material} ${fraction(item.group.thickness)}`;
  const out = [];
  if (opts.header !== false) {
    out.push({ kind: 'sheet', title: info.sheetLabel, lines: [mat, info.job, `${sh.placements.length} parts  #1-#${sh.placements.length}`, info.date] });
  }
  const ordered = [...sh.placements].sort((a, b) => nos.get(a) - nos.get(b));
  for (const pl of ordered) {
    const p = pl.part;
    out.push({
      kind: 'part', no: nos.get(pl), name: pl.label || p.name,
      dims: `${fraction(p.width)} x ${fraction(p.height)} x ${fraction(p.thickness)}`,
      lines: [[pl.cabinet, item.group.material].filter(Boolean).join('  |  '), grainText(p)],
      foot: `${info.sheetLabel}  |  ${info.job}`
    });
  }
  if (opts.offcuts !== false) {
    (sh.offcuts || []).forEach((oc, k) => {
      const no = info.remnantNos?.[k];
      out.push({
        kind: 'offcut', title: no ? `KEEP  R${no}` : 'KEEP OFFCUT',
        dims: `${fraction(oc.w)} x ${fraction(oc.h)}${oc.rects?.length > 1 ? ' L' : ''}`,
        lines: [mat, `Grain along ${fraction(oc.w)}`, no ? `From ${info.job}` : 'Mark job as cut to number it'],
        foot: `${info.sheetLabel}  |  ${info.date}`,
      });
    });
  }
  return out;
}

// A label for a remnant on the rack.
export function remnantLabel(r, date) {
  return {
    kind: 'offcut', title: `REMNANT  R${r.no}`, dims: `${fraction(r.w)} x ${fraction(r.h)}${r.rects?.length > 1 ? ' L' : ''}`,
    lines: [`${r.material} ${fraction(r.thickness)}`, `Grain along ${fraction(r.w)}`, r.fromJobName ? `From ${r.fromJobName}` : (r.note || '')],
    foot: date,
  };
}

// ---- layout ------------------------------------------------------------------
// Text never wraps: it is cut to fit (font 0 runs about 0.55 x its height per character).
const fit = (s, maxW, h) => {
  const n = Math.max(1, Math.floor(maxW / (h * 0.56)));
  s = String(s ?? '');
  return s.length > n ? s.slice(0, Math.max(1, n - 2)) + '..' : s;
};

// Rows of text spread down the label. Sizes are set for a 2 x 1 label and
// scale with the label (1 x 2 tall labels are laid out the same way, narrower).
function layout(lb, opts) {
  const W = Math.round(opts.w * opts.dpi), H = Math.round(opts.h * opts.dpi);
  const u = opts.dpi;
  const s = Math.max(0.5, Math.min(opts.w / 2, opts.h / 1));
  const m = Math.round(0.05 * u);
  const full = W - 2 * m;
  const rows = [];
  if (lb.kind === 'part') {
    rows.push({ h: 0.19, left: lb.name, right: `#${lb.no}`, bold: true, rightH: 0.22 });
    rows.push({ h: 0.15, left: lb.dims, bold: true });
    for (const line of lb.lines) rows.push({ h: 0.105, left: line });
    rows.push({ h: 0.085, left: lb.foot });
  } else if (lb.kind === 'sheet') {
    rows.push({ h: 0.2, left: lb.title, bold: true });
    for (const line of lb.lines) rows.push({ h: 0.1, left: line });
  } else {
    rows.push({ h: 0.19, left: lb.title, bold: true });
    rows.push({ h: 0.15, left: lb.dims, bold: true });
    for (const line of lb.lines) rows.push({ h: 0.1, left: line });
    if (lb.foot) rows.push({ h: 0.085, left: lb.foot });
  }
  // fit the rows to the height: shrink if needed, spread out if there's room
  const dots = (r) => Math.max(r.h, r.rightH || 0) * u * s;
  const need = rows.reduce((a, r) => a + dots(r), 0);
  const k = Math.min(1, (H - 2 * m - (rows.length - 1) * 2) / need);
  const gap = rows.length > 1 ? Math.max(2, (H - 2 * m - need * k) / (rows.length - 1)) : 0;
  const P = [];
  let y = m;
  for (const r of rows) {
    const rh = dots(r) * k;
    const th = Math.round(r.h * u * s * k);
    let leftW = full;
    if (r.right) {
      const nh = Math.round(r.rightH * u * s * k);
      const nw = Math.round(nh * 0.62 * r.right.length + 4);
      P.push({ t: 'text', x: W - m - nw, y: Math.round(y), h: nh, text: r.right, w: nw, align: 'R', bold: true });
      leftW = full - nw - Math.round(0.04 * u);
    }
    P.push({ t: 'text', x: m, y: Math.round(y + rh - th), h: th, text: fit(r.left, leftW, th), w: leftW, align: 'L', bold: !!r.bold });
    y += rh + gap;
  }
  return { W, H, P };
}

// ---- ZPL ---------------------------------------------------------------------
const zplText = (s) => String(s).replace(/_/g, '_5F').replace(/\^/g, '_5E').replace(/~/g, '_7E');

export function toZPL(labels, opts = LABEL_DEFAULTS) {
  return labels.map((lb) => {
    const { W, H, P } = layout(lb, opts);
    const z = [`^XA`, `^CI28`, `^PW${W}`, `^LL${H}`, `^LH0,0`];
    for (const p of P) {
      if (p.t === 'text') {
        const wd = Math.round(p.h * (p.bold ? 1.08 : 0.95));
        z.push(`^FO${p.x},${p.y}^A0N,${p.h},${wd}^FB${Math.round(p.w)},1,0,${p.align}^FH_^FD${zplText(p.text)}^FS`);
      } else if (p.t === 'box') {
        z.push(`^FO${p.x},${p.y}^GB${p.w},${p.h},${p.th},B^FS`);
      } else {
        z.push(`^FO${p.x},${p.y}^GB${p.w},${p.h},${Math.min(p.w, p.h)},B^FS`);
      }
    }
    z.push('^XZ');
    return z.join('\n');
  }).join('\n');
}

// ---- preview -----------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function labelSVG(lb, opts = LABEL_DEFAULTS) {
  const { W, H, P } = layout(lb, opts);
  let svg = `<svg class="label-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" rx="${Math.round(opts.dpi * 0.06)}" fill="#fff" stroke="#bbb"/>`;
  for (const p of P) {
    if (p.t === 'text') {
      const x = p.align === 'R' ? p.x + p.w : p.align === 'C' ? p.x + p.w / 2 : p.x;
      const anchor = p.align === 'R' ? 'end' : p.align === 'C' ? 'middle' : 'start';
      svg += `<text x="${x}" y="${p.y + p.h * 0.8}" font-size="${p.h}" font-family="Arial Narrow, Arial, sans-serif" font-weight="${p.bold ? 700 : 400}" text-anchor="${anchor}" fill="#000">${esc(p.text)}</text>`;
    } else if (p.t === 'box') {
      svg += `<rect x="${p.x + p.th / 2}" y="${p.y + p.th / 2}" width="${p.w - p.th}" height="${p.h - p.th}" fill="none" stroke="#000" stroke-width="${p.th}"/>`;
    } else {
      svg += `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="#000"/>`;
    }
  }
  return svg + '</svg>';
}
