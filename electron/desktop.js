// What the desktop app adds to the page (exposed by preload.cjs as window.desktop):
// real PDFs for print preview / Save PDF / printing to a chosen printer, and
// writing G-code files straight into a folder. The browser version of the page
// works without any of it.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CSS @page names for the paper sizes offered
const PAPER = { Letter: 'letter', Legal: 'legal', Tabloid: 'ledger', A4: 'A4', A3: 'A3' };
const jobs = new Map();   // print job id -> { win, file }
let nextId = 1;
let lastPdfDir = null;

function pageRule({ paper = 'Letter', orient = 'landscape', margin = 0.4 }) {
  const size = PAPER[paper] || 'letter';
  // Tabloid as CSS "ledger" is 11 x 17 portrait; turning it gives 17 x 11
  return `<style>@page { size: ${size} ${orient === 'portrait' ? 'portrait' : 'landscape'}; margin: ${+margin || 0}in; }</style>`;
}

async function openJob(html, opts) {
  const file = path.join(os.tmpdir(), `cabinet-cam-print-${process.pid}-${nextId}.html`);
  const withRule = html.includes('</head>') ? html.replace('</head>', `${pageRule(opts)}</head>`) : pageRule(opts) + html;
  fs.writeFileSync(file, withRule, 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, javascript: false } });
  await win.loadFile(file);
  const id = nextId++;
  jobs.set(id, { win, file });
  return id;
}

function closeJob(id) {
  const j = jobs.get(id);
  if (!j) return;
  jobs.delete(id);
  try { j.win.destroy(); } catch { /* already gone */ }
  try { fs.unlinkSync(j.file); } catch { /* already gone */ }
}

// Windows' default printer (remembered for a minute), or null
let defCache = { at: 0, name: null };
function defaultPrinter() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (Date.now() - defCache.at < 60000) return Promise.resolve(defCache.name);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(Get-CimInstance -ClassName Win32_Printer -Filter 'Default=TRUE').Name"],
      { timeout: 5000, windowsHide: true }, (err, out) => {
        const name = err ? null : String(out || '').trim() || null;
        defCache = { at: Date.now(), name };
        resolve(name);
      });
  });
}

// only plain file names: never a path out of the chosen folder
const safeName = (n) => path.basename(String(n || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'file.txt';

export function registerDesktop(getWin) {
  // HTML -> PDF bytes. The page stays open so Print sends exactly what was previewed.
  ipcMain.handle('pdf:make', async (_e, html, opts = {}) => {
    const id = await openJob(String(html), opts);
    const pdf = await jobs.get(id).win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;
    return { id, pdf: new Uint8Array(pdf), pages };
  });

  ipcMain.handle('pdf:print', (_e, id, { deviceName = '', copies = 1 } = {}) => new Promise((resolve) => {
    const j = jobs.get(id);
    if (!j) { resolve({ ok: false, error: 'This preview has been closed.' }); return; }
    // a printer chosen in the app prints straight away; "ask" shows the Windows print dialog
    j.win.webContents.print({ silent: !!deviceName, deviceName: deviceName || undefined, printBackground: true, copies: Math.max(1, Math.min(+copies || 1, 50)) },
      (ok, error) => resolve({ ok, error: ok ? '' : String(error || '') }));
  }));

  ipcMain.handle('pdf:close', (_e, id) => { closeJob(id); return true; });

  ipcMain.handle('pdf:save', async (_e, bytes, defaultName) => {
    const r = await dialog.showSaveDialog(getWin(), {
      title: 'Save PDF',
      defaultPath: path.join(lastPdfDir || app.getPath('documents'), safeName(defaultName || 'Cabinet CAM.pdf')),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return { saved: false };
    fs.writeFileSync(r.filePath, Buffer.from(bytes));
    lastPdfDir = path.dirname(r.filePath);
    return { saved: true, path: r.filePath };
  });

  ipcMain.handle('printers', async () => {
    const list = await getWin().webContents.getPrintersAsync();
    // Electron 36+ no longer says which printer is the default: ask Windows
    const def = list.some((p) => p.isDefault !== undefined) ? null : await defaultPrinter();
    return list.map((p) => ({ name: p.name, label: p.displayName || p.name, isDefault: p.isDefault !== undefined ? !!p.isDefault : p.name === def }));
  });

  ipcMain.handle('folder:choose', async (_e, current) => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: 'Folder to save G-code into',
      defaultPath: current && fs.existsSync(current) ? current : undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('files:write', (_e, folder, files) => {
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      return { ok: false, error: `The folder ${folder || '(none)'} can't be found. Is the drive or network share connected?` };
    }
    const written = [];
    const replaced = [];
    try {
      for (const f of files || []) {
        const name = safeName(f.name);
        const target = path.join(folder, name);
        if (fs.existsSync(target)) replaced.push(name);
        fs.writeFileSync(target, String(f.text ?? ''), 'utf8');
        written.push(name);
      }
    } catch (e) {
      return { ok: false, error: String(e?.message || e), written, replaced };
    }
    return { ok: true, written, replaced };
  });

  ipcMain.handle('folder:open', (_e, folder) => (folder ? shell.openPath(folder) : ''));

  ipcMain.handle('cores', () => os.cpus().length);
}
