const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gestdepotDesktop', {
  isDesktop: true,
  platform: process.platform,
  getDesktopConfig: () => ipcRenderer.invoke('gestdepot:get-desktop-config'),
  selectAutoBackupDir: () => ipcRenderer.invoke('gestdepot:select-backup-dir'),
  setAutoBackupInterval: (minutes) => ipcRenderer.invoke('gestdepot:set-backup-interval', minutes),
  runAutoBackupNow: () => ipcRenderer.invoke('gestdepot:run-backup-now'),
  openFolder: (targetPath) => ipcRenderer.invoke('gestdepot:open-folder', targetPath),
});
