// Cut list for parts that aren't cut on the CNC (face frame stiles/rails, or
// anything tagged cnc: false). Rows are merged identical parts.

const ROLE_NAMES = {
  FF_STILE: 'Stile', FF_RAIL: 'Rail', DOOR: 'Door', DRAWER_FACE: 'Drawer face', DOOR_STILE: 'Door stile', DOOR_RAIL: 'Door rail', DOOR_PANEL: 'Door panel', FILLER: 'Filler',
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
  }));
  return rows.sort((a, b) => a.material.localeCompare(b.material) || a.part.localeCompare(b.part) || b.length - a.length || b.width - a.width);
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export function cutListCSV(rows) {
  const head = ['Material', 'Qty', 'Part', 'Length', 'Width', 'Thickness', 'Length (in)', 'Width (in)', 'Thickness (in)', 'Cabinets', 'Part names'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([r.material, r.qty, r.part, fraction(r.length), fraction(r.width), fraction(r.thickness),
      r.length.toFixed(3), r.width.toFixed(3), r.thickness.toFixed(3), r.cabinets, r.names].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}
