const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { openDb, importJsonlDir, getCounts, getFailed, listAll, migrateDoneFilenames, deleteVideos } = require('./db');
const { Queue } = require('./queue');
const { TRANSCRIPTS_DIR } = require('./transcriber');

const DATA_SOURCES_DIR = path.join(__dirname, '..', '..', 'data', 'sources');

let mainWindow;
let db;
let queue;

function filesAreIdentical(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch (e) {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  db = await openDb();
  const imported = importJsonlDir(db, DATA_SOURCES_DIR);
  console.log(`Imported ${imported.inserted} new videos from ${imported.files} jsonl file(s) in data/sources`);
  const migrated = migrateDoneFilenames(db, TRANSCRIPTS_DIR);
  if (migrated > 0) console.log(`Renamed ${migrated} existing transcript(s) to title-based filenames`);

  queue = new Queue(db, (type, payload) => {
    if (mainWindow) mainWindow.webContents.send(`queue:${type}`, payload);
  });

  createWindow();

  ipcMain.handle('queue:start', () => queue.start());
  ipcMain.handle('queue:stop', () => queue.stop());
  ipcMain.handle('queue:counts', () => getCounts(db));
  ipcMain.handle('queue:reimport', () => importJsonlDir(db, DATA_SOURCES_DIR));
  ipcMain.handle('queue:failed', () => getFailed(db));
  ipcMain.handle('queue:retryFailed', () => queue.startRetryFailed());
  ipcMain.handle('queue:list', () => listAll(db));
  ipcMain.handle('queue:retryOne', (_e, videoId) => queue.startRetry([videoId]));
  ipcMain.handle('shell:openFile', (_e, filePath) => shell.openPath(filePath));
  ipcMain.handle('shell:openUrl', (_e, url) => shell.openExternal(url));
  ipcMain.handle('queue:delete', (_e, videoIds) => {
    const deleted = deleteVideos(db, videoIds);
    return { deleted };
  });
  ipcMain.handle('queue:addFiles', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add video list (.jsonl)',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'JSONL', extensions: ['jsonl'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { added: 0, imported: 0 };

    fs.mkdirSync(DATA_SOURCES_DIR, { recursive: true });
    let copied = 0;
    for (const srcPath of result.filePaths) {
      let destName = path.basename(srcPath);
      let destPath = path.join(DATA_SOURCES_DIR, destName);
      let n = 2;
      while (fs.existsSync(destPath) && !filesAreIdentical(srcPath, destPath)) {
        destName = `${path.basename(srcPath, '.jsonl')} (${n}).jsonl`;
        destPath = path.join(DATA_SOURCES_DIR, destName);
        n += 1;
      }
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
        copied += 1;
      }
    }
    const imported = importJsonlDir(db, DATA_SOURCES_DIR);
    return { added: copied, imported: imported.inserted };
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
