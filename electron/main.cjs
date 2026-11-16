const { app, BrowserWindow, Menu, dialog, ipcMain, powerMonitor, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mainWindow = null;
let serverHandle = null;
let isQuitting = false;
let autoBackupTimer = null;

const isDev = !app.isPackaged && !!process.env.ELECTRON_START_URL;

function getDataDir() {
  return path.join(app.getPath('userData'), 'data');
}

function getDefaultAutoBackupDir() {
  return path.join(app.getPath('documents'), 'GestDepot-Sauvegardes');
}

function getConfigFilePath() {
  return path.join(app.getPath('userData'), 'desktop-config.json');
}

function readDesktopConfig() {
  const defaults = {
    autoBackupDir: getDefaultAutoBackupDir(),
    autoBackupIntervalMinutes: 30,
    lastMirrorSyncAt: null,
    lastMirrorFile: null,
  };
  try {
    const cfgPath = getConfigFilePath();
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      return {
        autoBackupDir:
          typeof parsed.autoBackupDir === 'string' && parsed.autoBackupDir.trim()
            ? parsed.autoBackupDir.trim()
            : defaults.autoBackupDir,
        autoBackupIntervalMinutes:
          typeof parsed.autoBackupIntervalMinutes === 'number' && parsed.autoBackupIntervalMinutes >= 5
            ? parsed.autoBackupIntervalMinutes
            : defaults.autoBackupIntervalMinutes,
        lastMirrorSyncAt: typeof parsed.lastMirrorSyncAt === 'string' ? parsed.lastMirrorSyncAt : null,
        lastMirrorFile: typeof parsed.lastMirrorFile === 'string' ? parsed.lastMirrorFile : null,
      };
    }
  } catch (err) {
    console.error('Desktop config read warning:', err);
  }
  return defaults;
}

function writeDesktopConfig(patch) {
  const current = readDesktopConfig();
  const next = { ...current, ...patch };
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(getConfigFilePath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('Desktop config write warning:', err);
  }
  return next;
}

function syncBackupEnv() {
  const cfg = readDesktopConfig();
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    fs.mkdirSync(cfg.autoBackupDir, { recursive: true });
  } catch (err) {
    console.error('Auto backup folder mkdir warning:', err);
  }
  process.env.GESTDEPOT_DATA_DIR = dataDir;
  process.env.GESTDEPOT_AUTO_BACKUP_DIR = cfg.autoBackupDir;
  return cfg;
}

async function performAutoBackup(backupType, reason) {
  const cfg = syncBackupEnv();
  if (serverHandle && typeof serverHandle.runAutoBackup === 'function') {
    const res = await serverHandle.runAutoBackup(backupType, reason);
    if (res && res.integrity_ok === 1) {
      writeDesktopConfig({
        lastMirrorSyncAt: res.created_at,
        lastMirrorFile: res.mirror_path || res.file_path,
      });
    }
    return res;
  }

  // Fallback in electron:dev mode where external server runs separately
  const liveDbPath = path.join(getDataDir(), 'gestdepot.sqlite');
  if (fs.existsSync(liveDbPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `gestdepot_${String(backupType).toLowerCase()}_${stamp}.sqlite`;
    fs.mkdirSync(cfg.autoBackupDir, { recursive: true });
    const dest = path.join(cfg.autoBackupDir, filename);
    fs.copyFileSync(liveDbPath, dest);
    const createdAt = new Date().toISOString();
    writeDesktopConfig({ lastMirrorSyncAt: createdAt, lastMirrorFile: dest });
    return { filename, mirror_path: dest, integrity_ok: 1, created_at: createdAt };
  }
  return null;
}

function restartAutoBackupScheduler() {
  if (autoBackupTimer) {
    clearInterval(autoBackupTimer);
    autoBackupTimer = null;
  }
  const cfg = readDesktopConfig();
  const intervalMs = Math.max(5, cfg.autoBackupIntervalMinutes) * 60 * 1000;
  autoBackupTimer = setInterval(() => {
    void performAutoBackup('AUTO_PERIODIQUE', `Sauvegarde automatique toutes les ${cfg.autoBackupIntervalMinutes} min`).catch(
      (err) => console.error('Periodic Electron auto-backup error:', err),
    );
  }, intervalMs);
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: 'GestDepot',
            submenu: [
              { role: 'about', label: 'À propos de GestDepot' },
              { type: 'separator' },
              { role: 'hide', label: 'Masquer GestDepot' },
              { role: 'hideOthers', label: 'Masquer les autres' },
              { role: 'unhide', label: 'Tout afficher' },
              { type: 'separator' },
              { role: 'quit', label: 'Quitter GestDepot' },
            ],
          },
        ]
      : []),
    {
      label: 'Fichier',
      submenu: [
        {
          label: 'Sauvegarder maintenant vers le dossier local',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            void performAutoBackup('MANUELLE', 'Sauvegarde manuelle depuis le menu Fichier');
          },
        },
        {
          label: 'Imprimer la vue courante',
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.print();
            }
          },
        },
        { type: 'separator' },
        isMac
          ? { role: 'close', label: 'Fermer la fenêtre' }
          : { role: 'quit', label: 'Quitter GestDepot' },
      ],
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' },
      ],
    },
    {
      label: 'Affichage',
      submenu: [
        { role: 'reload', label: 'Actualiser' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom normal' },
        { role: 'zoomIn', label: 'Zoom avant' },
        { role: 'zoomOut', label: 'Zoom arrière' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function startEmbeddedBackend() {
  if (serverHandle) {
    return `http://127.0.0.1:${serverHandle.port}`;
  }

  syncBackupEnv();
  process.env.GESTDEPOT_EMBEDDED = '1';
  process.env.NODE_ENV = 'production';

  const appRoot = app.getAppPath();
  const serverEntry = path.join(appRoot, 'dist-server', 'server.mjs');
  const distPath = path.join(appRoot, 'dist');

  const mod = await import(pathToFileURL(serverEntry).href);
  serverHandle = await mod.startServer({
    port: 0,
    host: '127.0.0.1',
    staticDistPath: distPath,
  });

  // Immediately mirror startup snapshot to configured local backup folder
  try {
    await performAutoBackup('AUTO_DEMARRAGE', 'Synchronisation locale automatique au démarrage');
  } catch (err) {
    console.error('Initial mirror sync warning:', err);
  }

  return `http://127.0.0.1:${serverHandle.port}`;
}

function registerIpcHandlers() {
  ipcMain.handle('gestdepot:get-desktop-config', () => {
    const cfg = syncBackupEnv();
    return {
      isDesktop: true,
      platform: process.platform,
      dataDir: getDataDir(),
      autoBackupDir: cfg.autoBackupDir,
      autoBackupIntervalMinutes: cfg.autoBackupIntervalMinutes,
      lastMirrorSyncAt: cfg.lastMirrorSyncAt,
      lastMirrorFile: cfg.lastMirrorFile,
    };
  });

  ipcMain.handle('gestdepot:select-backup-dir', async () => {
    const current = readDesktopConfig();
    const res = await dialog.showOpenDialog(mainWindow || undefined, {
      title: 'Choisir le dossier de sauvegarde automatique SQLite',
      defaultPath: current.autoBackupDir,
      buttonLabel: 'Sélectionner ce dossier',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) {
      return { canceled: true, autoBackupDir: current.autoBackupDir };
    }
    const nextDir = path.resolve(res.filePaths[0]);
    writeDesktopConfig({ autoBackupDir: nextDir });
    syncBackupEnv();
    try {
      await performAutoBackup('MANUELLE', 'Sauvegarde automatique vers le nouveau dossier local');
    } catch (err) {
      console.error('Mirror on folder change warning:', err);
    }
    const updated = readDesktopConfig();
    return {
      canceled: false,
      autoBackupDir: updated.autoBackupDir,
      lastMirrorSyncAt: updated.lastMirrorSyncAt,
      lastMirrorFile: updated.lastMirrorFile,
    };
  });

  ipcMain.handle('gestdepot:set-backup-interval', (_event, minutes) => {
    const valid = [15, 30, 60].includes(Number(minutes)) ? Number(minutes) : 30;
    const updated = writeDesktopConfig({ autoBackupIntervalMinutes: valid });
    restartAutoBackupScheduler();
    return { autoBackupIntervalMinutes: updated.autoBackupIntervalMinutes };
  });

  ipcMain.handle('gestdepot:run-backup-now', async () => {
    try {
      const res = await performAutoBackup('MANUELLE', 'Sauvegarde manuelle vers dossier local dédié');
      return {
        ok: !!res && res.integrity_ok === 1,
        filename: res?.filename,
        mirrorPath: res?.mirror_path || null,
        createdAt: res?.created_at || new Date().toISOString(),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('gestdepot:open-folder', async (_event, targetPath) => {
    const cfg = readDesktopConfig();
    const allowed = [path.resolve(getDataDir()), path.resolve(cfg.autoBackupDir)];
    const resolved = path.resolve(String(targetPath || cfg.autoBackupDir));
    if (!allowed.includes(resolved)) return;
    fs.mkdirSync(resolved, { recursive: true });
    await shell.openPath(resolved);
  });
}

async function createMainWindow() {
  const distIcon = path.join(app.getAppPath(), 'dist', 'pwa-512x512.png');
  const publicIcon = path.join(app.getAppPath(), 'public', 'pwa-512x512.png');
  const iconPath = fs.existsSync(distIcon) ? distIcon : publicIcon;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: 'GestDepot — Gestion commerciale de dépôt de boissons',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#f8fafc',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  let closeBackupCompleted = false;
  mainWindow.on('close', async (event) => {
    // Even if user only closes the window (common on macOS with red X) without Cmd+Q,
    // snapshot SQLite immediately into the configured local backup folder before closing.
    if (isQuitting || closeBackupCompleted) return;
    event.preventDefault();
    closeBackupCompleted = true;
    try {
      await Promise.race([
        performAutoBackup('AUTO_FENETRE', 'Sauvegarde automatique à la fermeture de la fenêtre'),
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]);
    } catch (err) {
      console.error('Window-close backup warning:', err);
    } finally {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close();
      }
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    syncBackupEnv();
    await mainWindow.loadURL(process.env.ELECTRON_START_URL);
  } else {
    const serverUrl = await startEmbeddedBackend();
    await mainWindow.loadURL(serverUrl);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    registerIpcHandlers();
    buildAppMenu();
    await createMainWindow();
    restartAutoBackupScheduler();

    powerMonitor.on('shutdown', () => {
      if (serverHandle && !isQuitting) {
        isQuitting = true;
        void serverHandle.shutdown('Sauvegarde automatique lors de l’arrêt du système');
      }
    });

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createMainWindow();
      }
    });
  });

  app.on('before-quit', async (event) => {
    if (autoBackupTimer) {
      clearInterval(autoBackupTimer);
      autoBackupTimer = null;
    }
    if (isQuitting || !serverHandle) return;
    event.preventDefault();
    isQuitting = true;
    try {
      await serverHandle.shutdown('Sauvegarde automatique à la fermeture du logiciel bureau');
    } catch (err) {
      console.error('Desktop shutdown backup error:', err);
    } finally {
      app.exit(0);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
