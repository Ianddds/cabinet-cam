// The desktop-only things the page can ask for (see electron/desktop.js).
// Nothing else from Node or Electron is reachable from the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  makePdf: (html, opts) => ipcRenderer.invoke('pdf:make', html, opts),
  printPdf: (id, opts) => ipcRenderer.invoke('pdf:print', id, opts),
  closePdf: (id) => ipcRenderer.invoke('pdf:close', id),
  savePdf: (bytes, name) => ipcRenderer.invoke('pdf:save', bytes, name),
  printers: () => ipcRenderer.invoke('printers'),
  chooseFolder: (current) => ipcRenderer.invoke('folder:choose', current),
  writeFiles: (folder, files) => ipcRenderer.invoke('files:write', folder, files),
  openFolder: (folder) => ipcRenderer.invoke('folder:open', folder),
  cores: () => ipcRenderer.invoke('cores'),
});
