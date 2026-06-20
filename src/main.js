const {
  app, BrowserWindow, globalShortcut,
  clipboard, ipcMain, Tray, Menu, screen, dialog
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');

let GetForegroundWindow, ShowWindow, SetForegroundWindow, keybd_event, IsIconic;

try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');

  GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()');
  ShowWindow = user32.func('bool __stdcall ShowWindow(uintptr_t hWnd, int nCmdShow)');
  SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(uintptr_t hWnd)');
  keybd_event = user32.func('void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)');
  IsIconic = user32.func('bool __stdcall IsIconic(uintptr_t hWnd)');
} catch (_) {}

const VK_CONTROL = 0x11;
const VK_V = 0x56;
const KEYEVENTF_KEYUP = 0x0002;
const SW_RESTORE = 9;

function registerAutoLaunch() {
  if (!app.isPackaged) return;

  const exePath = process.execPath;

  const invalidPaths = [
    process.env.TEMP,
    process.env.TMP,
    path.join(process.env.LOCALAPPDATA || '', 'Temp'),
    'WindowsApps',
  ].filter(Boolean);

  const isInvalidPath = invalidPaths.some(p =>
    exePath.toLowerCase().includes(p.toLowerCase())
  );

  if (isInvalidPath) {
    return;
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
      path: exePath,
    });
  } catch (_) {
    try {
      spawnSync('reg', [
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v', 'PetaDock',
        '/t', 'REG_SZ',
        '/d', `"${exePath}"`,
        '/f'
      ], { windowsHide: true });
    } catch (__) {}
  }
}

function unregisterAutoLaunch() {
  try {
    app.setLoginItemSettings({ openAtLogin: false });
  } catch (_) {}

  try {
    spawnSync('reg', [
      'delete',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v', 'PetaDock',
      '/f'
    ], { windowsHide: true });
  } catch (_) {}
}

const store = new Store({
  defaults: {
    tabs: [
      { id: 't1', name: '仕事', items: [], pinned: false },
      { id: 't2', name: '開発', items: [], pinned: false },
      { id: 't3', name: '個人', items: [], pinned: false },
    ],
    history: [],
    shortcutKey: 'Ctrl+Shift+V',
    maxHistory: 30,
  }
});

let win = null;
let settingsWin = null;
let tray = null;
let lastClipboard = clipboard.readText();
let clipboardTimer = null;
let isPasting = false;
let isQuitting = false;
let isUninstalling = false;
let targetHwnd = null;
let updateListenersRegistered = false;
let isUpdateChecking = false;
let isManualCheck = false;

function safeHideWindow(w) {
  if (!w || w.isDestroyed()) return;
  w.hide();
}

function safeSendToMain(channel, data) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, data);
}
function safeSendToSettings(channel, data) {
  if (!settingsWin || settingsWin.isDestroyed()) return;
  settingsWin.webContents.send(channel, data);
}

function rememberTargetWindow() {
  try {
    const hwnd = GetForegroundWindow();
    targetHwnd = (hwnd && hwnd !== 0) ? hwnd : null;
  } catch (_) {
    targetHwnd = null;
  }
}

function focusTargetWindow() {
  if (!targetHwnd) return;

  try {
    if (IsIconic && IsIconic(targetHwnd)) {
      ShowWindow(targetHwnd, SW_RESTORE);
    }

    SetForegroundWindow(targetHwnd);
  } catch (_) {}
}

function sendCtrlV() {
  try {
    keybd_event(VK_CONTROL, 0, 0, 0);
    keybd_event(VK_V, 0, 0, 0);
    keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0);
    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
  } catch (_) {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 640,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  win.on('blur', () => {
    if (isQuitting) return;
    if (isUninstalling) return;
    if (!win || win.isDestroyed()) return;
    if (settingsWin && !settingsWin.isDestroyed()) return;
    if (isPasting) return;

    safeHideWindow(win);
  });
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }

  const sw = 480;
  const sh = 640;
  let sx = 100;
  let sy = 100;

  if (win && !win.isDestroyed()) {
    const [mx, my] = win.getPosition();
    const [mw] = win.getSize();
    const disp = screen.getDisplayNearestPoint({ x: mx, y: my });
    const wa = disp.workArea;

    if (mx + mw + sw + 10 <= wa.x + wa.width) {
      sx = mx + mw + 10;
      sy = Math.max(Math.min(my, wa.y + wa.height - sh - 8), wa.y);
    } else {
      sx = Math.max(mx - sw - 10, wa.x);
      sy = Math.max(Math.min(my, wa.y + wa.height - sh - 8), wa.y);
    }
  }

  settingsWin = new BrowserWindow({
    width: sw,
    height: sh,
    x: sx,
    y: sy,
    title: 'PetaDock 設定',
    resizable: false,
    minimizable: false,
    alwaysOnTop: false,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.setMenu(null);

  settingsWin.on('closed', () => {
    settingsWin = null;
    safeSendToMain('settings-closed');
  });
}

function showAtCursor() {
  if (!win || win.isDestroyed()) return;

  const { x, y } = screen.getCursorScreenPoint();
  const { workArea: wa } = screen.getDisplayNearestPoint({ x, y });
  const [ww, wh] = win.getSize();

  let wx = Math.min(x, wa.x + wa.width - ww - 8);
  let wy = Math.min(y, wa.y + wa.height - wh - 8);

  wx = Math.max(wx, wa.x + 8);
  wy = Math.max(wy, wa.y + 8);

  win.setPosition(Math.round(wx), Math.round(wy));
  win.show();
  win.focus();
}

function registerShortcut(key) {
  globalShortcut.unregisterAll();

  try {
    const ok = globalShortcut.register(key, () => {
      if (!win || win.isDestroyed()) return;

      if (win.isVisible()) {
        safeHideWindow(win);
      } else {
        rememberTargetWindow();
        showAtCursor();
      }
    });

    if (ok) {
      store.set('shortcutKey', key);
    }

    return ok;
  } catch (_) {
    return false;
  }
}

function startMonitor() {
  clipboardTimer = setInterval(() => {
    if (isQuitting || isUninstalling) return;

    const text = clipboard.readText();

    if (!text || text === lastClipboard || !text.trim()) return;

    lastClipboard = text;

    const cur = Array.isArray(store.get('history')) ? store.get('history') : [];
    const history = [text, ...cur.filter(h => h !== text)].slice(0, store.get('maxHistory') || 30);

    store.set('history', history);
    safeSendToMain('history-updated', history);
  }, 500);
}

function createTray() {
  const { nativeImage } = require('electron');
  const iconPath = path.join(__dirname, 'icon.ico');

  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('PetaDock');

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'PetaDockを開く', click: showAtCursor },
    { label: '設定', click: openSettingsWindow },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() },
  ]));

  tray.on('click', showAtCursor);
}

function registerUpdateListeners() {
  if (updateListenersRegistered) return;

  updateListenersRegistered = true;
  autoUpdater.autoDownload = false;

  autoUpdater.on('update-available', async (info) => {
    safeSendToSettings('update-check-finished');
    const parent = win && !win.isDestroyed() ? win : null;

    const { response } = await dialog.showMessageBox(parent, {
      type: 'info',
      title: 'PetaDock 更新通知',
      message: `新しいバージョン (${info.version}) が利用可能です。`,
      detail: '更新しますか？\n\n保存されているデータ（タブ・アイテム・履歴）は更新後もそのまま残ります。',
      buttons: ['更新する', '後で'],
      defaultId: 0,
      cancelId: 1,
    });

    if (response === 0) {
      try {
        await autoUpdater.downloadUpdate();
      } catch (error) {
        isUpdateChecking = false;

        dialog.showMessageBox(parent, {
          type: 'error',
          title: 'PetaDock 更新ダウンロードエラー',
          message: '更新ファイルのダウンロードに失敗しました。',
          detail: error && error.message ? error.message : String(error),
        });
      }
    } else {
      isUpdateChecking = false;
    }
  });

  autoUpdater.on('update-not-available', async () => {
    isUpdateChecking = false;
    safeSendToSettings('update-check-finished');

    if (isManualCheck) {
      const parent = win && !win.isDestroyed() ? win : null;
      await dialog.showMessageBox(parent, {
        type: 'info',
        title: 'PetaDock 更新確認',
        message: '現在お使いのバージョンが最新です。',
      });
    }
    isManualCheck = false;
  });

  autoUpdater.on('download-progress', (p) => {
    safeSendToMain('update-progress', Math.round(p.percent));
  });

  autoUpdater.on('update-downloaded', async () => {
    isUpdateChecking = false;

    const parent = win && !win.isDestroyed() ? win : null;

    const { response } = await dialog.showMessageBox(parent, {
      type: 'info',
      title: 'PetaDock 更新準備完了',
      message: '更新の準備ができました。',
      detail: '今すぐ再起動して更新を適用しますか？\n保存データは引き続き保持されます。',
      buttons: ['今すぐ再起動', '後で（次回起動時に適用）'],
      defaultId: 0,
      cancelId: 1,
    });

    if (response === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
    }
  });

  autoUpdater.on('error', (error) => {
    isUpdateChecking = false;
    isManualCheck = false;
    safeSendToSettings('update-check-finished');

    const parent = win && !win.isDestroyed() ? win : null;

    dialog.showMessageBox(parent, {
      type: 'error',
      title: 'PetaDock 更新エラー',
      message: '更新処理中にエラーが発生しました。',
      detail: error && error.message ? error.message : String(error),
    });
  });
}

function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    dialog.showMessageBox(null, {
      type: 'info',
      title: 'PetaDock 更新確認',
      message: '開発モードでは更新チェックできません。',
    });
    return;
  }

  if (isUpdateChecking) return;

  isUpdateChecking = true;
  isManualCheck = manual;
  registerUpdateListeners();

  autoUpdater.checkForUpdates().catch((error) => {
    isUpdateChecking = false;
    isManualCheck = false;
    safeSendToSettings('update-check-finished');

    const parent = win && !win.isDestroyed() ? win : null;

    dialog.showMessageBox(parent, {
      type: 'error',
      title: 'PetaDock 更新確認エラー',
      message: '更新確認に失敗しました。',
      detail: error && error.message ? error.message : String(error),
    });
  });
}

app.whenReady().then(() => {
  createWindow();
  registerAutoLaunch();
  registerShortcut(store.get('shortcutKey'));
  startMonitor();

  try {
    createTray();
  } catch (_) {}

  if (app.isPackaged) {
    setTimeout(() => checkForUpdates(), 3000);
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  clearInterval(clipboardTimer);
});

app.on('window-all-closed', e => e.preventDefault());

ipcMain.handle('get-data', () => {
  const history = Array.isArray(store.get('history')) ? store.get('history') : [];

  return {
    tabs: store.get('tabs'),
    history,
    shortcutKey: store.get('shortcutKey'),
    maxHistory: store.get('maxHistory'),
  };
});

ipcMain.handle('save-tabs', (_, tabs) => {
  store.set('tabs', tabs);
  safeSendToMain('tabs-updated', tabs);
});

ipcMain.handle('save-history', (_, history) => {
  store.set('history', Array.isArray(history) ? history : []);
});

ipcMain.handle('save-max-history', (_, n) => {
  store.set('maxHistory', n);
});

ipcMain.handle('set-shortcut', (_, key) => {
  return registerShortcut(key);
});

ipcMain.handle('write-clipboard', (_, text) => {
  clipboard.writeText(text);
  lastClipboard = text;
});

ipcMain.handle('hide-window', () => {
  safeHideWindow(win);
});

ipcMain.handle('open-settings', () => {
  openSettingsWindow();
});

ipcMain.handle('open-external', (_, url) => {
  require('electron').shell.openExternal(url);
});

ipcMain.handle('check-update', () => {
  checkForUpdates(true);
  return true;
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('paste-text', async (_, text) => {
  clipboard.writeText(text);
  lastClipboard = text;

  isPasting = true;
  safeHideWindow(win);

  await new Promise(r => setTimeout(r, 20));
  focusTargetWindow();

  await new Promise(r => setTimeout(r, 20));
  sendCtrlV();

  setTimeout(() => {
    isPasting = false;
  }, 80);
});

ipcMain.handle('export-data', async (_, fmt) => {
  const parent = settingsWin && !settingsWin.isDestroyed() ? settingsWin : win;
  const tabs = store.get('tabs') || [];
  const history = Array.isArray(store.get('history')) ? store.get('history') : [];

  const ext = fmt === 'csv' ? 'csv' : 'json';
  const name = `petadock-backup-${new Date().toISOString().slice(0, 10)}`;

  const { filePath, canceled } = await dialog.showSaveDialog(parent, {
    title: 'エクスポート',
    defaultPath: `${name}.${ext}`,
    filters: fmt === 'csv'
      ? [{ name: 'CSV', extensions: ['csv'] }]
      : [{ name: 'JSON', extensions: ['json'] }],
  });

  if (canceled || !filePath) return { ok: false };

  if (fmt === 'csv') {
    const rows = ['グループ,タイトル,アイテム'];

    for (const tab of tabs) {
      for (const item of (tab.items || [])) {
        const title = typeof item === 'object' ? item.title || '' : '';
        const text = typeof item === 'object' ? item.text || '' : item;

        rows.push(`"${tab.name.replace(/"/g, '""')}","${title.replace(/"/g, '""')}","${text.replace(/"/g, '""')}"`);
      }
    }

    fs.writeFileSync(filePath, '\uFEFF' + rows.join('\r\n'), 'utf8');
  } else {
    fs.writeFileSync(filePath, JSON.stringify({ tabs, history }, null, 2), 'utf8');
  }

  return { ok: true };
});

ipcMain.handle('import-data', async (_, fmt, overwrite) => {
  const dataOverwrite = !!overwrite;
  const parent = settingsWin && !settingsWin.isDestroyed() ? settingsWin : win;

  const { filePaths, canceled } = await dialog.showOpenDialog(parent, {
    title: 'インポート',
    filters: fmt === 'csv'
      ? [{ name: 'CSV', extensions: ['csv'] }]
      : [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });

  if (canceled || !filePaths.length) return { ok: false };

  const raw = fs.readFileSync(filePaths[0], 'utf8').replace(/^\uFEFF/, '');

  try {
    if (fmt === 'csv') {
      const lines = raw.split(/\r?\n/).slice(1).filter(l => l.trim());
      const groups = {};

      for (const line of lines) {
        const cols = [];
        let cur = '';
        let inQ = false;

        for (let i = 0; i < line.length; i++) {
          const c = line[i];

          if (c === '"' && !inQ) {
            inQ = true;
          } else if (c === '"' && inQ) {
            if (line[i + 1] === '"') {
              cur += '"';
              i++;
            } else {
              inQ = false;
            }
          } else if (c === ',' && !inQ) {
            cols.push(cur);
            cur = '';
          } else {
            cur += c;
          }
        }

        cols.push(cur);

        let grp;
        let title;
        let item;

        if (cols.length >= 3) {
          [grp, title, item] = cols;
        } else {
          [grp, item] = cols;
          title = '';
        }

        if (!grp || !item) continue;

        if (!groups[grp]) {
          groups[grp] = [];
        }

        if (!groups[grp].find(i => i.text === item)) {
          groups[grp].push({ title: title || '', text: item });
        }
      }

      const tabs = dataOverwrite ? [] : (store.get('tabs') || []);

      for (const [name, items] of Object.entries(groups)) {
        const ex = tabs.find(t => t.name === name);

        if (ex) {
          for (const i of items) {
            if (!ex.items.find(e => (e.text || e) === i.text)) {
              ex.items.push(i);
            }
          }
        } else {
          tabs.push({
            id: 'g' + Date.now() + Math.random().toString(36).slice(2, 5),
            name,
            items,
            pinned: false
          });
        }
      }

      store.set('tabs', tabs);
      safeSendToMain('tabs-updated', tabs);

      return { ok: true, count: Object.values(groups).flat().length };
    }

    const data = JSON.parse(raw);

    if (data.tabs) {
      if (dataOverwrite) {
        store.set('tabs', data.tabs);
      } else {
        const existing = store.get('tabs') || [];

        for (const tab of data.tabs) {
          const ex = existing.find(t => t.name === tab.name);

          if (ex) {
            for (const i of tab.items || []) {
              if (!ex.items.find(e => (e.text || e) === (i.text || i))) {
                ex.items.push(i);
              }
            }
          } else {
            existing.push(tab);
          }
        }

        store.set('tabs', existing);
      }

      safeSendToMain('tabs-updated', store.get('tabs'));
    }

    if (data.history) {
      store.set('history', Array.isArray(data.history) ? data.history : []);
    }

    return {
      ok: true,
      count: (store.get('tabs') || []).reduce((s, t) => s + (t.items || []).length, 0)
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('uninstall', async () => {
  const parent = settingsWin && !settingsWin.isDestroyed() ? settingsWin : win;

  const { response } = await dialog.showMessageBox(parent, {
    type: 'warning',
    title: 'アンインストール',
    message: 'PetaDockをアンインストールしますか？',
    detail: '保存データ・自動起動の設定をすべて削除します。',
    buttons: ['キャンセル', 'アンインストール'],
    defaultId: 0,
    cancelId: 0,
  });

  if (response !== 1) return { ok: false };

  isUninstalling = true;
  unregisterAutoLaunch();

  try {
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
  } catch (_) {}

  const exePath = process.execPath;
  const batPath = path.join(app.getPath('temp'), '_petadock_uninstall.bat');

  fs.writeFileSync(
    batPath,
    `@echo off\r\ntimeout /t 2 /nobreak >nul\r\ndel /f /q "${exePath}"\r\ndel /f /q "%~f0"\r\n`
  );

  spawn('cmd.exe', ['/c', batPath], {
    detached: true,
    stdio: 'ignore'
  }).unref();

  app.quit();

  return { ok: true };
});