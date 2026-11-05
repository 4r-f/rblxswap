'use strict';

/**
 * Electron smoke test: loads the real renderer over file:// with the real
 * preload and stubbed IPC, then asserts that scripts run under CSP, views
 * switch and translation works. Run with: npx electron scripts/smoke-electron.js
 */

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { DEFAULT_CONFIG } = require('../src/shared/config');

const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
const stub = { ok: true };

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`FAIL: ${message}`);
};

function handle(channel, value) {
  ipcMain.handle(channel, () => value);
}

handle('app:info', {
  ok: true,
  version: '0.4.0-smoke',
  platform: process.platform,
  arch: process.arch,
  isPackaged: false,
  elevated: null,
  config,
  paths: { config: '', logs: '', backup: '', userData: '' }
});
handle('app:health', {
  ok: true,
  version: '0.5.0-smoke',
  platform: process.platform,
  elevated: true,
  robloxRunning: false,
  backupExists: false
});
handle('app:relaunch-admin', { ok: true });
handle('config:get', { ok: true, config });
handle('config:set', { ok: true, config });
handle('config:reset', { ok: true, config });
handle('hwid:backup-info', { ok: true, info: { exists: false } });
handle('hwid:backup-exists', { ok: true, exists: false });
handle('hwid:backup', { ok: true, created: true });
handle('hwid:restore', { ok: true, identifiers: [], adapters: [], errors: [] });
handle('hwid:purge-roblox', { ok: true, files: 0, registry: [], errors: [] });
handle('adapters:list', { ok: true, adapters: [] });
handle('profiles:list', { ok: true, profiles: [] });
handle('updates:check', { ok: true, updateAvailable: false });
handle('cleaner:plan', {
  ok: true,
  plan: {
    steps: [{
      id: 'temp', label: 'Roblox temp caches', kind: 'dirs',
      paths: ['C:\\Temp\\Roblox'], keys: [], requiresAdmin: false,
      danger: false, bytes: 1024, count: 2, truncated: false
    }],
    totals: { count: 2, bytes: 1024, human: '1 KB' },
    warnings: []
  }
});
handle('cleaner:run', { ok: true, dryRun: false, plan: { steps: [], totals: { count: 0, bytes: 0 }, warnings: [] }, result: { removedPaths: 0, failed: [] } });
handle('toast:show', { ok: true, id: 'smoke' });
handle('spoof:detect-anticheat', { ok: true, detections: [] });
handle('spoof:run', { ok: true, mac: [], hwid: [], needsReboot: false, errors: [] });
handle('diag:get', { ok: true, diagnostics: { platform: process.platform } });
handle('logs:tail', { ok: true, lines: [] });
handle('theme:export', { ok: false, error: 'cancelled' });
handle('theme:import', { ok: false, error: 'cancelled' });
handle('dialog:select-directory', { ok: true, directory: null });
handle('scan:weblauncher', { ok: true, directory: null });

app.commandLine.appendSwitch('disable-gpu');

setTimeout(() => {
  console.error('FAIL: smoke test timed out');
  app.exit(2);
}, 20_000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 480,
    height: 400,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  const consoleErrors = [];
  window.webContents.on('console-message', (event, level, message) => {
    if (level >= 2) consoleErrors.push(message);
    console.log(`[console:${level}] ${message}`);
  });
  window.webContents.on('did-fail-load', (event, code, description) => {
    fail(`did-fail-load ${code} ${description}`);
  });

  await window.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  const result = await window.webContents.executeJavaScript(`(() => {
    const visible = document.querySelector('.view.active');
    return {
      views: document.querySelectorAll('.view').length,
      active: visible ? visible.id : null,
      actions: document.querySelectorAll('[data-action]').length,
      bridge: typeof window.launcher,
      theme: getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim(),
      title: document.querySelector('[data-i18n="home.title"]')?.textContent || null
    };
  })()`);

  console.log('RESULT', JSON.stringify(result));

  if (result.views !== 5) fail(`expected 5 views, got ${result.views}`);
  if (result.active !== 'view_home') fail(`expected view_home, got ${result.active}`);
  if (result.bridge !== 'object') fail(`preload bridge missing (${result.bridge})`);
  if (result.actions < 20) fail(`expected action buttons, got ${result.actions}`);
  if (result.title !== 'Ready to swap?') fail(`i18n title wrong: ${result.title}`);

  const switched = await window.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-action="show-view"][data-arg="settings"]').click();
    const active = document.querySelector('.view.active');
    return {
      active: active ? active.id : null,
      language: typeof window.setLanguage,
      tab: document.getElementById('tab_general')?.style.display
    };
  })()`);

  console.log('SWITCH', JSON.stringify(switched));
  if (switched.active !== 'view_settings') fail(`settings view did not open: ${switched.active}`);

  await new Promise((resolve) => setTimeout(resolve, 700));
  const onboarding = await window.webContents.executeJavaScript(`(() => ({
    helpOpen: document.getElementById('helpModal').style.display,
    health: document.getElementById('healthAdmin').textContent,
    banner: document.getElementById('adminBanner').style.display
  }))()`);

  console.log('ONBOARDING', JSON.stringify(onboarding));
  if (onboarding.helpOpen !== 'flex') fail(`first-run help did not open (${onboarding.helpOpen})`);
  if (!/Admin/i.test(onboarding.health)) fail(`health chip missing admin state (${onboarding.health})`);
  if (onboarding.banner !== 'none') fail(`admin banner should be hidden when elevated (${onboarding.banner})`);

  const flow = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-action="close-help"]').click();
    document.querySelector('[data-action="show-view"][data-arg="home"]').click();
    document.querySelector('[data-action="quick-start"]').click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const planOpen = document.getElementById('planModal').style.display;
    const rows = document.querySelectorAll('.plan-row').length;
    document.querySelector('[data-action="close-modal"][data-arg="planModal"]').click();
    document.querySelector('[data-action="open-spoof"]').click();
    return {
      planOpen,
      rows,
      macActive: document.querySelector('.view.active')?.id,
      targets: document.getElementById('chkSpoofMac')?.checked,
      helpClosed: document.getElementById('helpModal').style.display
    };
  })()`);

  console.log('FLOW', JSON.stringify(flow));
  if (flow.planOpen !== 'flex') fail(`plan modal did not open (${flow.planOpen})`);
  if (flow.rows !== 1) fail(`plan rows wrong (${flow.rows})`);
  if (flow.macActive !== 'view_mac') fail(`spoof view did not open (${flow.macActive})`);
  if (flow.targets !== true) fail('MAC target should default to checked');
  if (flow.helpClosed !== 'none') fail(`help modal did not close (${flow.helpClosed})`);

  const quick = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-action="close-help"]').click();
    document.querySelector('[data-action="show-view"][data-arg="home"]').click();
    document.querySelector('[data-action="quick-start"]').click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    document.querySelector('[data-action="confirm-clean"]').click();
    await new Promise((resolve) => setTimeout(resolve, 1400));
    return {
      view: document.querySelector('.view.active')?.id,
      title: document.getElementById('postTitle')?.textContent,
      spoofLog: document.getElementById('loaderLog')?.textContent || ''
    };
  })()`);

  console.log('QUICK', JSON.stringify(quick));
  if (quick.view !== 'view_post') fail(`one-click flow did not reach the final screen (${quick.view})`);
  if (!/ready/i.test(quick.title || '')) fail(`final screen title wrong (${quick.title})`);

  const translated = await window.webContents.executeJavaScript(`(() => {
    window.setLanguage ? window.setLanguage('tr') : null;
    return document.querySelector('[data-i18n="home.title"]')?.textContent || null;
  })()`);

  console.log('TRANSLATED', translated);
  if (translated !== 'Hazır mısın?') fail(`translation did not apply: ${translated}`);

  const fatal = consoleErrors.filter((line) => /Content Security Policy|Refused to|Uncaught|not defined/i.test(line));
  if (fatal.length) fail(`console errors: ${fatal.join(' | ')}`);

  window.destroy();
  console.log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`);
  app.exit(failures === 0 ? 0 : 1);
});
