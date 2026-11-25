// Cut list for parts that aren't cut on the CNC (face frame stiles/rails, or
// anything tagged cnc: false). Rows are merged identical parts.

const ROLE_NAMES = {
  FF_STILE: 'Stile', FF_RAIL: 'Rail', FF_INNER_STILE: 'Inner stile', FF_INNER_RAIL: 'Inner rail', FF_BEAD: 'Bead', DOOR: 'Door', DRAWER_FACE: 'Drawer face', DOOR_STILE: 'Door stile', DOOR_RAIL: 'Door rail', DOOR_PANEL: 'Door panel', FILLER: 'Filler',
  PANEL: 'Panel', END_PANEL: 'End panel', TOE_SKIN: 'Toe kick skin', NAILER: 'Nailer',
};
export const roleName = (r) => ROLE_NAMES[r] || (r ? String(r).toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '');

// 23.25 -> 23 1/4, nearest 1/32
export function fraction(v, den = 32) {
  const neg = v < 0;
  let n = Math.round(Math.abs(v) * den);
  const whole = Math.floor(n / den);
  n -= whole * den;
  let d = den;
  while (n && n % 2 === 0) { n /= 2; d /= 2; }
  const s = n ? (whole ? `${whole} ${n}/${d}` : `${n}/${d}`) : `${whole}`;
  return (neg ? '-' : '') + s;
}

export function cutListRows(parts) {
  const rows = parts.filter((p) => p.cnc === false).map((p) => ({
    material: p.material,
    qty: p.qty,
    part: roleName(p.role) || p.name,
    names: (p.sourceNames || [p.name]).join(', '),
    cabinets: [...new Set((p.sourceCabinets || [p.cabinet]).filter(Boolean))].join(', '),
    length: p.width, // normalized parts: width = long side
    width: p.height,
    thickness: p.thickness,
    grain: p.grain,
    grainSet: p.grainOverride || '',   // picked in the parts list ('' = Auto: the model's grain)
  }));
  return rows.sort((a, b) => a.material.localeCompare(b.material) || a.part.localeCompare(b.part) || b.length - a.length || b.width - a.width);
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export function cutListCSV(rows) {
  // same column order as the cut list on screen (Cabinets, Part, Qty, sizes, decimals)
  const head = ['Material', 'Cabinets', 'Part', 'Qty', 'Length', 'Width', 'Thickness', 'Length (in)', 'Width (in)', 'Thickness (in)', 'Part names'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([r.material, r.cabinets, r.part, r.qty, fraction(r.length), fraction(r.width), fraction(r.thickness),
      r.length.toFixed(3), r.width.toFixed(3), r.thickness.toFixed(3), r.names].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Stock needed for the cut list, per material.
//   sheet goods: the parts nested on full sheets (saw kerf apart, grain kept
//     along the sheet's length) -> sheet count and a map of each sheet
//   lumber: lineal feet per size (width x thickness), plus a waste factor
// Which a material is: its own choice (kinds[material]), else a guess from the
// name (ply, Baltic, MDF, melamine...) or any part wider than 12".

const SHEET_NAME = /\b(ply|plywood|bb|baltic|birch ply|mdf|hdf|melamine|particle ?board|osb|hardboard|masonite|veneer core|sheet)\b/i;
export function guessKind(material, rows) {
  if (SHEET_NAME.test(material || '')) return 'sheet';
  return rows.some((r) => r.width > 12) ? 'sheet' : 'lumber';
}

// lineal feet per size; waste in percent
export function linealStock(rows, waste = 15) {
  const sizes = new Map();
  for (const r of rows) {
    const k = `${r.width.toFixed(4)}x${r.thickness.toFixed(4)}`;
    const s = sizes.get(k) || { width: r.width, thickness: r.thickness, pieces: 0, inches: 0, longest: 0 };
    s.pieces += r.qty;
    s.inches += r.length * r.qty;
    s.longest = Math.max(s.longest, r.length);
    sizes.set(k, s);
  }
  return [...sizes.values()]
    .map((s) => ({ ...s, feet: s.inches / 12, withWaste: (s.inches / 12) * (1 + (waste || 0) / 100) }))
    .sort((a, b) => b.thickness - a.thickness || b.width - a.width);
}

// rectangles for the nester: length along the sheet's grain unless the part says otherwise
export function sheetStockParts(rows) {
  return rows.map((r, i) => {
    const w = r.length, h = r.width;
    return {
      id: `cl${i}`, name: r.part, label: r.part, include: true, qty: r.qty, width: w, height: h, thickness: r.thickness,
      material: r.material, grain: r.grain === 'none' ? 'none' : (r.grain || 'length'), custom: false,
      outline: [[0, 0], [w, 0], [w, h], [0, h]], holes: [], pockets: [],
    };
  });
}

// a placement's size on the sheet (the nest keeps the part and whether it's turned)
export const placedSize = (pl) => (pl.rotated ? { w: pl.part.height, h: pl.part.width } : { w: pl.part.width, h: pl.part.height });

// one sheet of the nest as an SVG map: parts outlined and labelled with their size
export function sheetMapSvg(sheet, { width = 700, label = 12 } = {}) {
  const W = sheet.w, H = sheet.h, sc = width / W, h = H * sc;
  const y = (v) => h - v * sc;   // sheet origin bottom-left
  let g = `<rect x="0.5" y="0.5" width="${width - 1}" height="${h - 1}" fill="#fff" stroke="#000" stroke-width="1"/>`;
  for (const pl of sheet.placements) {
    const { w: pw, h: ph } = placedSize(pl);
    const x0 = pl.x * sc, x1 = (pl.x + pw) * sc, y0 = y(pl.y + ph), y1 = y(pl.y);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const name = pl.part.name || '';
    const size = `${fraction(Math.max(pw, ph))} × ${fraction(Math.min(pw, ph))}`;
    const fs = Math.max(8, Math.min(label, (y1 - y0) / 3, (x1 - x0) / Math.max(6, name.length * 0.62)));
    g += `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${(y1 - y0).toFixed(1)}" fill="#e6e6e6" stroke="#000" stroke-width="0.8"/>`;
    g += `<text x="${cx.toFixed(1)}" y="${(cy - (y1 - y0 > 2.6 * fs ? fs * 0.15 : -fs * 0.35)).toFixed(1)}" font-size="${fs.toFixed(1)}" text-anchor="middle" font-family="system-ui,sans-serif">${name.replace(/[&<>]/g, '')}</text>`;
    if (y1 - y0 > 2.6 * fs) g += `<text x="${cx.toFixed(1)}" y="${(cy + fs * 1.05).toFixed(1)}" font-size="${(fs * 0.85).toFixed(1)}" text-anchor="middle" fill="#444" font-family="system-ui,sans-serif">${size}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h.toFixed(0)}" viewBox="0 0 ${width} ${h.toFixed(1)}">${g}</svg>`;
}
