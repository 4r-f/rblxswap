'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeTheme,
  screen,
  session,
  shell
} = require('electron');

const { createConfigStore } = require('../shared/config');
const { createLogger } = require('../shared/logger');
const { createToastManager } = require('./toasts');
const { createIpc } = require('./ipc');
const { isCliRequest, runCli } = require('./cli');
const cleaner = require('./cleaner');
const hwid = require('../../hwid');
const { APP_ID, LOG_MAX_BYTES, LOG_MAX_FILES } = require('../shared/constants');
const { isSafeExternalUrl } = require('../shared/security');

const state = {
  window: null,
  tray: null,
  quitting: false,
  poller: null,
  pollBusy: false,
  wasRobloxRunning: false,
  grace: 0,
  configStore: null,
  logger: null,
  toasts: null,
  ipc: null,
  trayCleaning: false
};

function isDev() {
  return !app.isPackaged;
}

function showWindow() {
  if (!state.window || state.window.isDestroyed()) return;
  if (state.window.isMinimized()) state.window.restore();
  state.window.show();
  state.window.focus();
}

function emitCommand(command, payload = {}) {
  if (state.ipc) state.ipc.emitCommand(command, payload);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 480,
    height: 400,
    frame: false,
    transparent: true,
    resizable: false,
    fullscreenable: false,
    show: false,
    titleBarStyle: 'hidden',
    alwaysOnTop: false,
    icon: path.join(__dirname, '..', '..', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
      devTools: isDev()
    }
  });

  state.window = window;

  window.once('ready-to-show', () => window.show());
  window.setMenuBarVisibility(false);
  window.loadFile(path.join(__dirname, '..', 'index.html'));

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());

  window.on('close', (event) => {
    if (state.quitting) return;

    event.preventDefault();
    const config = state.configStore.get();

    if (config.minimizeClose) {
      window.hide();
      state.toasts.showToast({
        title: 'rblxswap',
        message: 'Minimized to the system tray.',
        timespan: 4000
      });
      return;
    }

    state.quitting = true;
    app.quit();
  });

  window.on('closed', () => {
    state.window = null;
  });

  if (process.platform === 'win32') nativeTheme.themeSource = 'dark';

  return window;
}

function requestQuit() {
  state.quitting = true;
  setTimeout(() => app.quit(), 800);
}

function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'icon.ico');

  try {
    state.tray = new Tray(iconPath);
  } catch (error) {
    state.logger.append('warn', `Tray icon unavailable: ${error.message}`);
    return;
  }

  const buildMenu = () => {
    const config = state.configStore.get();

    return Menu.buildFromTemplate([
      { label: 'Open rblxswap', click: showWindow },
      { type: 'separator' },
      {
        label: 'Clean now',
        click: () => cleanFromTray()
      },
      {
        label: 'Spoof…',
        click: () => {
          showWindow();
          emitCommand('open-spoof');
        }
      },
      {
        label: 'Restore identifiers…',
        click: () => {
          showWindow();
          emitCommand('open-restore');
        }
      },
      { type: 'separator' },
      {
        label: 'Pause Roblox watcher',
        type: 'checkbox',
        checked: config.watcherEnabled === false,
        click: (item) => {
          state.configStore.set({ watcherEnabled: !item.checked });
          state.tray.setContextMenu(buildMenu());
        }
      },
      {
        label: 'Test toast',
        click: () => state.toasts.showToast({
          title: 'Test toast',
          message: 'This is a test toast message.',
          buttons: true
        })
      },
      { type: 'separator' },
      {
        label: 'Exit',
        click: () => {
          state.quitting = true;
          app.quit();
        }
      }
    ]);
  };

  state.tray.setToolTip('rblxswap');
  state.tray.setContextMenu(buildMenu());
  state.tray.on('double-click', showWindow);
  state.tray.on('click', showWindow);
}

async function cleanFromTray() {
  if (state.trayCleaning) {
    state.toasts.showToast({ title: 'Cleanup', message: 'A cleanup is already running.' });
    return;
  }

  state.trayCleaning = true;
  const config = state.configStore.get();
  state.toasts.showToast({ title: 'Cleanup', message: 'Cleaning Roblox traces…', timespan: 3000 });

  try {
    const result = await cleaner.runCleanup({
      config,
      weblauncherDir: config.weblauncherDir,
      log: (level, message) => state.logger.append(level, message)
    });

    state.toasts.showToast({
      title: 'Cleanup complete',
      message: `${result.result.removedPaths} path(s) removed, ${result.result.failed.length} failure(s).`,
      buttons: [{ label: 'OK', type: 'primary' }],
      timespan: 8000
    });
  } catch (error) {
    state.logger.append('error', error.stack || error.message);
    state.toasts.showToast({
      title: 'Cleanup failed',
      message: error.message,
      buttons: [{ label: 'OK', type: 'danger' }],
      timespan: 9000
    });
  } finally {
    state.trayCleaning = false;
  }
}

function startRobloxWatcher() {
  if (process.platform !== 'win32') return;

  state.poller = setInterval(() => {
    if (state.pollBusy) return;

    const config = state.configStore.get();
    if (config.watcherEnabled === false) return;

    state.pollBusy = true;
    execFile('tasklist', ['/FI', 'IMAGENAME eq RobloxPlayerBeta.exe', '/NH'], { windowsHide: true }, (error, stdout) => {
      state.pollBusy = false;
      if (error) return;

      const running = String(stdout || '').includes('RobloxPlayerBeta.exe');

      if (!state.wasRobloxRunning && running) {
        state.wasRobloxRunning = true;
        state.grace = 0;
        return;
      }

      if (state.wasRobloxRunning && !running) {
        state.grace += 1;
        if (state.grace < 1) return;

        state.wasRobloxRunning = false;
        state.grace = 0;
        onRobloxClosed();
        return;
      }

      if (state.wasRobloxRunning) state.grace = 0;
    });
  }, 5000);
}

async function onRobloxClosed() {
  const config = state.configStore.get();

  if (config.autoCleanOnExit) {
    if (state.trayCleaning) return;
    state.trayCleaning = true;

    try {
      await cleaner.runCleanup({
        config,
        weblauncherDir: config.weblauncherDir,
        log: (level, message) => state.logger.append(level, message)
      });
      state.toasts.showToast({
        title: 'Roblox closed',
        message: 'Traces cleaned automatically. Ready for the next session.',
        timespan: 5000
      });
    } catch (error) {
      state.logger.append('error', `auto-clean failed: ${error.message}`);
    } finally {
      state.trayCleaning = false;
    }
    return;
  }

  state.toasts.showToast({
    title: 'Roblox closed',
    message: 'Clean traces and spoof before your next session?',
    buttons: [
      { label: 'Yes', type: 'yes', actionKey: 'roblox:start-clean' },
      { label: 'No', type: 'default' }
    ],
    timespan: 15_000
  });
}

function registerToastActions() {
  state.toasts.registerAction('open:weao-discord', () => {
    const url = 'https://discord.gg/weaoxyz';
    if (isSafeExternalUrl(url)) shell.openExternal(url);
  });

  state.toasts.registerAction('open:main-window', showWindow);

  state.toasts.registerAction('roblox:start-clean', () => {
    showWindow();
    emitCommand('start-clean');
  });

  state.toasts.registerAction('fun:bao_confetti', () => {
    emitCommand('confetti');
  });
}

function installSecurityHandlers() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    // Only clipboard writes are needed by the UI (copy buttons).
    callback(permission === 'clipboard-sanitized-write');
  });

  app.on('web-contents-created', (event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (navigationEvent) => navigationEvent.preventDefault());
  });
}

function createApplication() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    const configFile = path.join(userData, 'config.json');
    const firstRun = !fs.existsSync(configFile);

    state.configStore = createConfigStore({ dir: userData });
    state.configStore.get();

    // First launch: follow the OS language instead of forcing English.
    if (firstRun) {
      const locale = String(app.getLocale() || 'en').toLowerCase();
      if (locale.startsWith('tr')) state.configStore.set({ language: 'tr' });
    }

    state.logger = createLogger({
      dir: path.join(userData, 'logs'),
      maxBytes: LOG_MAX_BYTES,
      maxFiles: LOG_MAX_FILES,
      mirrorToConsole: isDev()
    });

    process.on('uncaughtException', (error) => {
      state.logger.append('error', error.stack || error.message);
    });
    process.on('unhandledRejection', (reason) => {
      state.logger.append('error', `unhandled rejection: ${reason}`);
    });

    app.setAppUserModelId(APP_ID);

    if (isCliRequest(process.argv)) {
      const exitCode = await runCli({
        argv: process.argv,
        configStore: state.configStore,
        logger: state.logger,
        version: app.getVersion()
      });
      app.exit(exitCode);
      return;
    }

    installSecurityHandlers();

    state.toasts = createToastManager({
      BrowserWindow,
      screen,
      preloadPath: path.join(__dirname, '..', '..', 'preload-toast.js'),
      iconPath: path.join(__dirname, '..', '..', 'icon.ico'),
      logger: state.logger
    });

    registerToastActions();

    // Register IPC before the renderer starts loading, otherwise the first
    // app:info call can race the handler registration.
    state.ipc = createIpc({
      ipcMain,
      app,
      BrowserWindow,
      shell,
      dialog,
      configStore: state.configStore,
      logger: state.logger,
      toasts: state.toasts,
      requestQuit,
      getWindow: () => state.window
    });

    createWindow();
    createTray();
    startRobloxWatcher();

    // Warn once if the user is not elevated: spoofing needs admin rights.
    if (process.platform === 'win32') {
      hwid.isElevated().then((elevated) => {
        if (!elevated) {
          state.toasts.showToast({
            title: 'Not running as administrator',
            message: 'Hardware ID and MAC spoofing need admin rights. Relaunch rblxswap as administrator.',
            timespan: 9000
          });
        }
      }).catch(() => {});
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  app.on('before-quit', () => {
    state.quitting = true;
    if (state.poller) clearInterval(state.poller);
    if (state.toasts) state.toasts.destroyAll();
  });

  // Keep running in the tray when the window is hidden.
  app.on('window-all-closed', () => {});
}

module.exports = { createApplication };
