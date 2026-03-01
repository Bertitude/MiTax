/**
 * Auto-updater module — electron-updater + GitHub Releases
 *
 * Usage in main.js:
 *   const { initUpdater } = require('./src/updater');
 *   initUpdater(mainWindow);
 */

const { autoUpdater } = require('electron-updater');
const { ipcMain, app }  = require('electron');
const path = require('path');
const fs   = require('fs');

// ─── Configure ───────────────────────────────────────────────────────────────

autoUpdater.autoDownload        = false; // ask user first
autoUpdater.autoInstallOnAppQuit = true;  // install silently when app is closed

// Write update logs to userData so the user can inspect them
const logPath = path.join(app.getPath('userData'), 'update.log');
autoUpdater.logger = {
  info:  msg => appendLog('INFO', msg),
  warn:  msg => appendLog('WARN', msg),
  error: msg => appendLog('ERROR', msg),
  debug: () => {},
};

function appendLog(level, msg) {
  try {
    const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
    fs.appendFileSync(logPath, line);
  } catch {}
}

// ─── Init ────────────────────────────────────────────────────────────────────

function initUpdater(mainWindow) {
  // Forward all autoUpdater events to the renderer
  const send = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  };

  autoUpdater.on('checking-for-update', () => {
    send('updater:checking');
  });

  autoUpdater.on('update-available', info => {
    send('updater:available', {
      version:     info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes || '',
    });
  });

  autoUpdater.on('update-not-available', info => {
    send('updater:not-available', { version: info.version });
  });

  autoUpdater.on('download-progress', progress => {
    send('updater:progress', {
      percent:         Math.round(progress.percent),
      transferred:     formatBytes(progress.transferred),
      total:           formatBytes(progress.total),
      bytesPerSecond:  formatBytes(progress.bytesPerSecond) + '/s',
    });
  });

  autoUpdater.on('update-downloaded', info => {
    send('updater:downloaded', {
      version:     info.version,
      releaseNotes: info.releaseNotes || '',
    });
  });

  autoUpdater.on('error', err => {
    send('updater:error', { message: err.message });
  });

  // ─── IPC handlers from renderer ──────────────────────────────────────────

  ipcMain.handle('updater:check', async () => {
    try {
      await autoUpdater.checkForUpdates();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
  });

  ipcMain.handle('updater:get-version', () => {
    return app.getVersion();
  });

  // ─── Check automatically on startup (after 5 s delay) ────────────────────

  // Only check in packaged builds — not during development (npm start)
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 5000);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024)          return bytes + ' B';
  if (bytes < 1024 * 1024)   return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

module.exports = { initUpdater };
