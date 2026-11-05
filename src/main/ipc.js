'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const hwid = require('../../hwid');
const adapters = require('./adapters');
const cleaner = require('./cleaner');
const updater = require('./updater');
const spoof = require('./spoof');
const { createDiagnostics } = require('./diagnostics');
const { runCommand, runPowerShell } = require('../shared/powershell');
const { isSafeExternalUrl } = require('../shared/security');
const { sanitizeTheme } = require('../shared/config');
const { WEBLAUNCHER_MARKERS } = require('../shared/constants');

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function findExeShallow(dir, exeName, currentDepth = 0, maxDepth = 3) {
  if (currentDepth > maxDepth) return null;

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    return null;
  }

  const wanted = exeName.toLowerCase();
  const directories = [];

  for (const entry of entries) {
    if (entry.name.toLowerCase() === wanted) return dir;
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
      directories.push(path.join(dir, entry.name));
    }
  }

  for (const directory of directories) {
    const found = await findExeShallow(directory, exeName, currentDepth + 1, maxDepth);
    if (found) return found;
  }

  return null;
}

function createIpc({
  ipcMain,
  app,
  BrowserWindow,
  shell,
  dialog,
  configStore,
  logger,
  toasts,
  requestQuit,
  getWindow
}) {
  const diagnostics = createDiagnostics({ app, configStore, logger, hwid, adapters });
  let cleanupRunning = false;
  let spoofRunning = false;
  let updateRunning = false;

  function send(channel, payload) {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  }

  function logToRenderer(level, message) {
    logger.append(level, message);
    send('cleaner:log', { level, message });
  }

  function spoofLog(level, message) {
    logger.append(level, message);
    send('spoof:log', { level, message });
  }

  function guarded(handler) {
    return async (event, payload) => {
      try {
        return await handler(event, payload);
      } catch (error) {
        logger.append('error', `${error.message}`);
        return { ok: false, error: error.message };
      }
    };
  }

  // --- app / config -------------------------------------------------------
  ipcMain.handle('app:health', guarded(async () => {
    let robloxRunning = false;

    if (process.platform === 'win32') {
      try {
        const { stdout } = await runCommand(
          'tasklist',
          ['/FI', 'IMAGENAME eq RobloxPlayerBeta.exe', '/NH'],
          { timeout: 8000 }
        );
        robloxRunning = /RobloxPlayerBeta\.exe/i.test(stdout);
      } catch (error) {
        robloxRunning = false;
      }
    }

    return {
      ok: true,
      version: app.getVersion(),
      platform: process.platform,
      elevated: process.platform === 'win32' ? await hwid.isElevated() : null,
      robloxRunning,
      backupExists: hwid.backupExists()
    };
  }));

  ipcMain.handle('app:create-shortcut', guarded(async () => {
    if (process.platform !== 'win32') {
      return { ok: false, error: 'unsupported-platform' };
    }

    const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const target = app.isPackaged ? executable : process.execPath;
    const args = app.isPackaged ? '--auto' : `"${app.getAppPath()}" --auto`;
    const shortcutPath = path.join(app.getPath('desktop'), 'rblxswap (Auto).lnk');

    const created = shell.writeShortcutLink(shortcutPath, {
      target,
      args,
      description: 'rblxswap automatic cleanup and spoof',
      icon: executable,
      iconIndex: 0
    });

    return created ? { ok: true, path: shortcutPath } : { ok: false, error: 'write-failed' };
  }));

  ipcMain.handle('app:relaunch-admin', guarded(async () => {
    if (process.platform !== 'win32') {
      return { ok: false, error: 'unsupported-platform' };
    }

    const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const args = app.isPackaged ? '' : app.getAppPath();

    await runPowerShell(`
$args = $env:APP_ARGS
if ([string]::IsNullOrWhiteSpace($args)) {
  Start-Process -FilePath $env:APP_EXE -Verb RunAs
} else {
  Start-Process -FilePath $env:APP_EXE -ArgumentList $args -Verb RunAs
}
Write-Output 'OK'
`, { env: { APP_EXE: executable, APP_ARGS: args }, timeout: 20_000 });

    requestQuit();
    return { ok: true };
  }));

  ipcMain.handle('app:info', guarded(async () => {
    const window = getWindow();
    return {
      ok: true,
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      auto: process.argv.includes('--auto'),
      elevated: process.platform === 'win32' ? await hwid.isElevated() : null,
      config: configStore.get(),
      paths: {
        config: configStore.file,
        logs: logger.file,
        backup: hwid.getBackupPath(),
        userData: app.getPath('userData')
      },
      windowVisible: Boolean(window && window.isVisible())
    };
  }));

  ipcMain.handle('config:get', guarded(async () => ({ ok: true, config: configStore.get() })));
  ipcMain.handle('config:set', guarded(async (event, payload) => {
    const config = configStore.set(asObject(payload));
    return { ok: true, config };
  }));
  ipcMain.handle('config:reset', guarded(async () => ({ ok: true, config: configStore.reset() })));

  // --- window -------------------------------------------------------------
  ipcMain.handle('window:hide', guarded(async () => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.hide();
    return { ok: true };
  }));

  ipcMain.handle('dialog:select-directory', guarded(async () => {
    const window = getWindow();
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: 'Select the WebLauncher folder (it contains weblauncher.exe)',
      defaultPath: app.getPath('downloads')
    });
    return { ok: true, directory: result.canceled ? null : result.filePaths[0] };
  }));

  ipcMain.handle('scan:weblauncher', guarded(async () => {
    const roots = [
      process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Desktop'),
      process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Downloads'),
      process.env.LOCALAPPDATA,
      process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Documents')
    ].filter(Boolean);

    for (const root of roots) {
      for (const marker of WEBLAUNCHER_MARKERS) {
        const found = await findExeShallow(root, marker);
        if (found) return { ok: true, directory: found };
      }
    }

    return { ok: true, directory: null };
  }));

  // --- toasts -------------------------------------------------------------
  ipcMain.handle('toast:show', guarded(async (event, payload) => {
    const data = asObject(payload);
    const id = toasts.showToast({
      title: data.title,
      message: data.message,
      buttons: data.buttons,
      timespan: data.timespan
    });
    return { ok: true, id };
  }));

  // --- cleanup ------------------------------------------------------------
  ipcMain.handle('cleaner:plan', guarded(async (event, payload) => {
    const data = asObject(payload);
    const config = configStore.get();
    const target = typeof data.weblauncherDir === 'string' && data.weblauncherDir
      ? data.weblauncherDir
      : config.weblauncherDir;

    const plan = await cleaner.planCleanup({ config, weblauncherDir: target });
    return { ok: true, plan };
  }));

  ipcMain.handle('cleaner:run', guarded(async (event, payload) => {
    if (cleanupRunning) return { ok: false, error: 'busy' };
    cleanupRunning = true;

    try {
      const data = asObject(payload);
      const config = configStore.get();
      const target = typeof data.weblauncherDir === 'string' && data.weblauncherDir
        ? data.weblauncherDir
        : config.weblauncherDir;

      send('cleaner:status', { status: 'starting', progress: 0 });

      const outcome = await cleaner.runCleanup({
        config,
        weblauncherDir: target,
        dryRun: data.dryRun === true,
        log: logToRenderer,
        onProgress: (progress) => send('cleaner:progress', progress)
      });

      send('cleaner:status', { status: 'complete', progress: 100 });
      return { ok: true, ...outcome };
    } finally {
      cleanupRunning = false;
    }
  }));

  // --- spoof --------------------------------------------------------------
  ipcMain.handle('spoof:run', guarded(async (event, payload) => {
    if (spoofRunning) return { ok: false, error: 'busy' };
    spoofRunning = true;

    try {
      const data = asObject(payload);
      const config = configStore.get();

      const outcome = await spoof.runSpoof({
        config,
        options: {
          targets: data.targets,
          allAdapters: data.allAdapters !== false,
          adapterGuid: data.adapterGuid,
          mac: data.mac,
          mirror: data.mirror !== false,
          dhcp: data.dhcp === true
        },
        log: spoofLog,
        onProgress: (progress) => send('spoof:progress', progress),
        markSpoofed: () => configStore.set({ lastSpoofAt: Date.now() })
      });

      return { ok: true, ...outcome };
    } finally {
      spoofRunning = false;
    }
  }));

  ipcMain.handle('spoof:detect-anticheat', guarded(async () => ({
    ok: true,
    detections: await hwid.detectAnticheats()
  })));

  ipcMain.handle('spoof:restore-point', guarded(async (event, payload) => {
    const description = asObject(payload).description;
    const result = await hwid.createSystemRestorePoint(
      typeof description === 'string' && description ? description.slice(0, 200) : 'rblxswap pre-spoof'
    );
    return { ok: result.ok, message: result.message };
  }));

  // --- hardware ids -------------------------------------------------------
  ipcMain.handle('hwid:backup-exists', guarded(async () => ({ ok: true, exists: hwid.backupExists() })));
  ipcMain.handle('hwid:backup-info', guarded(async () => ({ ok: true, info: hwid.backupInfo() })));
  ipcMain.handle('hwid:backup', guarded(async () => {
    const result = await hwid.createBackup();
    return { ok: true, created: result.created };
  }));
  ipcMain.handle('hwid:restore', guarded(async (event, payload) => {
    const data = asObject(payload);
    const result = await hwid.restoreIdentifiers({
      guids: data.guids !== false,
      mac: data.mac !== false,
      volume: data.volume !== false
    });
    return { ok: result.ok !== false, ...result };
  }));
  ipcMain.handle('hwid:purge-roblox', guarded(async () => ({
    ok: true,
    ...(await hwid.purgeRobloxTraces())
  })));

  // --- adapters -----------------------------------------------------------
  ipcMain.handle('adapters:list', guarded(async () => ({ ok: true, adapters: await adapters.listAdapters() })));
  ipcMain.handle('adapters:spoof', guarded(async (event, payload) => {
    const data = asObject(payload);
    const result = await adapters.spoofAdapter(String(data.guid || ''), String(data.mac || ''));
    return result;
  }));
  ipcMain.handle('adapters:reset', guarded(async (event, payload) => {
    const data = asObject(payload);
    return adapters.resetAdapter(String(data.guid || ''));
  }));
  ipcMain.handle('adapters:restart', guarded(async (event, payload) => {
    const data = asObject(payload);
    return adapters.restartAdapter(String(data.guid || ''));
  }));
  ipcMain.handle('network:dhcp', guarded(async () => ({ ok: await adapters.dhcpRefresh() })));

  // --- updates ------------------------------------------------------------
  ipcMain.handle('updates:check', guarded(async () => {
    const config = configStore.get();
    const result = await updater.checkForUpdates({
      repo: config.updates.repo,
      channel: config.updates.channel,
      currentVersion: app.getVersion()
    });

    if (result.error) return result;

    return {
      ok: true,
      updateAvailable: result.updateAvailable,
      version: result.version,
      url: result.url
    };
  }));

  ipcMain.handle('updates:install-latest', guarded(async () => {
    if (updateRunning) return { ok: false, error: 'busy' };
    updateRunning = true;

    try {
      const config = configStore.get();
      const check = await updater.checkForUpdates({
        repo: config.updates.repo,
        channel: config.updates.channel,
        currentVersion: app.getVersion()
      });

      if (check.error) return { ok: false, error: check.message, code: check.code };
      if (!check.updateAvailable) return { ok: false, error: 'up-to-date' };

      const prepared = await updater.prepareUpdate({
        release: check.release,
        allowUnsigned: config.updates.allowUnsigned === true,
        onProgress: (progress) => send('updates:progress', progress)
      });

      if (!prepared.ok) {
        return {
          ok: false,
          error: prepared.error,
          reason: prepared.reason || null,
          version: check.version
        };
      }

      if (!app.isPackaged) {
        return {
          ok: true,
          packaged: false,
          file: prepared.file,
          version: check.version,
          verifiedBy: prepared.verifiedBy
        };
      }

      const applied = await updater.applyUpdate(prepared.file, {
        log: (level, message) => logger.append(level, message)
      });

      if (!applied.ok) {
        return { ok: false, error: applied.error || 'update-apply-failed' };
      }

      requestQuit();
      return { ok: true, packaged: true, version: check.version, verifiedBy: prepared.verifiedBy };
    } finally {
      updateRunning = false;
    }
  }));

  // --- external links / logs ---------------------------------------------
  ipcMain.handle('shell:open-external', guarded(async (event, payload) => {
    const url = asObject(payload).url;
    if (!isSafeExternalUrl(url)) {
      logger.append('warn', `Blocked external URL: ${String(url).slice(0, 120)}`);
      return { ok: false, error: 'blocked-url' };
    }
    await shell.openExternal(url);
    return { ok: true };
  }));

  ipcMain.handle('shell:open-logs', guarded(async () => {
    const target = path.dirname(logger.file);
    await fsp.mkdir(target, { recursive: true }).catch(() => {});
    shell.showItemInFolder(logger.file);
    return { ok: true };
  }));

  ipcMain.handle('logs:tail', guarded(async () => ({ ok: true, lines: logger.tail(200) })));

  // --- diagnostics --------------------------------------------------------
  ipcMain.handle('diag:get', guarded(async () => ({ ok: true, diagnostics: await diagnostics.collect() })));

  // --- profiles -----------------------------------------------------------
  ipcMain.handle('profiles:list', guarded(async () => {
    const config = configStore.get();
    return {
      ok: true,
      profiles: Object.entries(config.profiles || {}).map(([name, profile]) => ({ name, ...profile }))
    };
  }));

  ipcMain.handle('profiles:save', guarded(async (event, payload) => {
    const data = asObject(payload);
    const name = String(data.name || '').trim();
    if (!/^[\w .-]{1,40}$/.test(name)) return { ok: false, error: 'invalid-name' };

    const config = configStore.get();
    const next = configStore.set({
      profiles: {
        ...config.profiles,
        [name]: {
          launcherType: config.launcherType,
          weblauncherDir: config.weblauncherDir,
          spoofMode: config.spoofMode,
          spoofTargets: config.spoofTargets
        }
      }
    });

    return { ok: true, profiles: Object.entries(next.profiles).map(([key, profile]) => ({ name: key, ...profile })) };
  }));

  ipcMain.handle('profiles:apply', guarded(async (event, payload) => {
    const name = String(asObject(payload).name || '');
    const config = configStore.get();
    const profile = config.profiles?.[name];
    if (!profile) return { ok: false, error: 'not-found' };

    const next = configStore.set({
      launcherType: profile.launcherType,
      weblauncherDir: profile.weblauncherDir,
      spoofMode: profile.spoofMode,
      spoofTargets: profile.spoofTargets
    });
    return { ok: true, config: next };
  }));

  ipcMain.handle('profiles:delete', guarded(async (event, payload) => {
    const name = String(asObject(payload).name || '');
    const config = configStore.get();
    const profiles = { ...config.profiles };
    delete profiles[name];
    const next = configStore.set({ profiles });
    return { ok: true, profiles: Object.entries(next.profiles).map(([key, profile]) => ({ name: key, ...profile })) };
  }));

  // --- theme export / import ---------------------------------------------
  ipcMain.handle('theme:export', guarded(async () => {
    const window = getWindow();
    const result = await dialog.showSaveDialog(window, {
      title: 'Export theme',
      defaultPath: path.join(app.getPath('documents'), 'rblxswap-theme.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };

    const theme = configStore.get().theme;
    await fsp.writeFile(result.filePath, `${JSON.stringify({ version: 1, theme }, null, 2)}\n`, 'utf8');
    return { ok: true, path: result.filePath };
  }));

  ipcMain.handle('theme:import', guarded(async () => {
    const window = getWindow();
    const result = await dialog.showOpenDialog(window, {
      title: 'Import theme',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, error: 'cancelled' };

    try {
      const parsed = JSON.parse(await fsp.readFile(result.filePaths[0], 'utf8'));
      const theme = sanitizeTheme(parsed.theme || parsed);
      const config = configStore.set({ theme });
      return { ok: true, theme: config.theme };
    } catch (error) {
      return { ok: false, error: 'invalid-theme' };
    }
  }));

  // --- toast button actions ----------------------------------------------
  ipcMain.on('toast-action', (event, payload) => {
    const data = asObject(payload);
    if (typeof data.toastId !== 'string') return;
    toasts.handleAction(data.action, data.toastId, Number.isInteger(data.index) ? data.index : null);
  });

  return {
    diagnostics,
    emitCommand: (command, payload = {}) => send('app:command', { command, ...payload })
  };
}

module.exports = { createIpc, findExeShallow };
