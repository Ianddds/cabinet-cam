// Cabinet CAM as a desktop app: runs the same local server inside the app and
// shows it in its own window. This PC's data (tools, settings, remnants, jobs,
// Onshape keys) lives in the user's app-data folder, so installing an update
// never touches it.
import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let baseUrl = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

const dataDir = () => path.join(app.getPath('userData'), 'data');

async function startBackend() {
  process.env.CABINET_CAM_DATA = dataDir();
  fs.mkdirSync(dataDir(), { recursive: true });
  const { startServer } = await import('../server.js');
  try { return await startServer({ port: 3100, host: '127.0.0.1' }); }
  catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    return startServer({ port: 0, host: '127.0.0.1' });   // 3100 is busy (an older copy running in a terminal?): any free port
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 1000, minHeight: 650,
    title: 'Cabinet CAM',
    icon: path.join(here, '..', 'build', 'icon.png'),
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(baseUrl);
  // links to other sites (Onshape, the dev portal) open in the normal browser;
  // the app's own pop-ups (print layouts) stay in the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(baseUrl)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    // Onshape sign-in (OAuth) has to come back to this window; anything else external goes to the browser
    if (/^https?:/i.test(url) && !url.startsWith(baseUrl) && !/onshape\.com/i.test(new URL(url).hostname)) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on('closed', () => { win = null; });
}

// Bring over the data (and keys) from a copy that was run from a folder.
async function importOldInstall() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Pick the old cabinet-cam folder (the one with server.js and the data folder in it)',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return;
  const from = r.filePaths[0];
  const oldData = fs.existsSync(path.join(from, 'data')) ? path.join(from, 'data') : (path.basename(from) === 'data' ? from : null);
  const envFile = path.join(oldData ? path.dirname(oldData) : from, '.env');
  if (!oldData && !fs.existsSync(envFile)) {
    dialog.showMessageBox(win, { type: 'warning', message: 'No data folder or .env file in that folder.', detail: from });
    return;
  }
  const ok = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Import', 'Cancel'], defaultId: 0, cancelId: 1,
    message: 'Import tools, settings, remnants, jobs and Onshape keys from the old copy?',
    detail: `From: ${from}\n\nAnything already in this app with the same name (tool library, remnant rack, a job with the same id) is replaced.`,
  });
  if (ok.response !== 0) return;
  const done = [];
  if (oldData) { fs.cpSync(oldData, dataDir(), { recursive: true, force: true }); done.push('data'); }
  if (fs.existsSync(envFile)) {
    const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/).map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
    if (env.ONSHAPE_ACCESS_KEY && env.ONSHAPE_SECRET_KEY) {
      fs.writeFileSync(path.join(dataDir(), 'onshape-keys.json'), JSON.stringify({ accessKey: env.ONSHAPE_ACCESS_KEY, secretKey: env.ONSHAPE_SECRET_KEY, savedAt: new Date().toISOString() }, null, 2));
      done.push('Onshape keys');
    }
  }
  await dialog.showMessageBox(win, { message: `Imported: ${done.join(', ') || 'nothing'}.`, detail: 'Cabinet CAM will restart to load it.' });
  app.relaunch();
  app.exit(0);
}

// Updates come from the GitHub releases this copy was built from. If there is
// no release feed (a private repository, no internet), it just says so when asked.
async function checkForUpdates(manual) {
  if (!app.isPackaged) { if (manual) dialog.showMessageBox(win, { message: 'Updates only work in the installed app.' }); return; }
  try {
    const { default: updater } = await import('electron-updater');
    const au = updater.autoUpdater;
    au.autoDownload = true;
    au.removeAllListeners();
    au.on('update-downloaded', async (info) => {
      const r = await dialog.showMessageBox(win, {
        type: 'info', buttons: ['Restart and update', 'Later'], defaultId: 0, cancelId: 1,
        message: `Cabinet CAM ${info.version} is ready to install.`,
        detail: 'Your tools, settings, remnants and jobs are kept. Finish any job you are in the middle of first.',
      });
      if (r.response === 0) au.quitAndInstall();
    });
    au.on('update-not-available', () => { if (manual) dialog.showMessageBox(win, { message: `Cabinet CAM ${app.getVersion()} is the latest version.` }); });
    au.on('error', (e) => { if (manual) dialog.showMessageBox(win, { type: 'warning', message: 'Could not check for updates.', detail: String(e?.message || e).slice(0, 400) }); });
    await au.checkForUpdates();
  } catch (e) {
    if (manual) dialog.showMessageBox(win, { type: 'warning', message: 'Could not check for updates.', detail: String(e?.message || e).slice(0, 400) });
  }
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Open data folder', click: () => shell.openPath(dataDir()) },
      { label: 'Import from an old copy…', click: importOldInstall },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    { label: 'Help', submenu: [
      { label: 'Check for updates…', click: () => checkForUpdates(true) },
      { label: 'About Cabinet CAM', click: () => dialog.showMessageBox(win, { message: `Cabinet CAM ${app.getVersion()}`, detail: `Data: ${dataDir()}\nAddress: ${baseUrl}` }) },
    ] },
  ]));
}

app.whenReady().then(async () => {
  try {
    const { port } = await startBackend();
    baseUrl = `http://127.0.0.1:${port}`;
  } catch (e) {
    dialog.showErrorBox('Cabinet CAM could not start', String(e?.stack || e));
    app.quit();
    return;
  }
  buildMenu();
  createWindow();
  setTimeout(() => checkForUpdates(false), 8000);
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
