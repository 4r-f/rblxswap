'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const wrapped = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('launcher', {
  // app / config
  getAppInfo: () => invoke('app:info'),
  getHealth: () => invoke('app:health'),
  relaunchAdmin: () => invoke('app:relaunch-admin'),
  createShortcut: () => invoke('app:create-shortcut'),
  getConfig: () => invoke('config:get'),
  setConfig: (config) => invoke('config:set', config),
  resetConfig: () => invoke('config:reset'),

  // window / dialogs
  hideWindow: () => invoke('window:hide'),
  selectDirectory: () => invoke('dialog:select-directory'),
  scanWeblauncher: () => invoke('scan:weblauncher'),
  showToast: (payload) => invoke('toast:show', payload),

  // cleaner
  planCleanup: (payload) => invoke('cleaner:plan', payload),
  runCleanup: (payload) => invoke('cleaner:run', payload),
  onCleanerLog: (callback) => subscribe('cleaner:log', callback),
  onCleanerProgress: (callback) => subscribe('cleaner:progress', callback),
  onCleanerStatus: (callback) => subscribe('cleaner:status', callback),

  // spoof
  runSpoof: (options) => invoke('spoof:run', options),
  detectAnticheat: () => invoke('spoof:detect-anticheat'),
  createRestorePoint: (description) => invoke('spoof:restore-point', { description }),
  onSpoofLog: (callback) => subscribe('spoof:log', callback),
  onSpoofProgress: (callback) => subscribe('spoof:progress', callback),

  // hwid
  hwidBackupExists: () => invoke('hwid:backup-exists'),
  hwidBackupInfo: () => invoke('hwid:backup-info'),
  backupHwid: () => invoke('hwid:backup'),
  restoreHwid: (options) => invoke('hwid:restore', options),
  purgeRoblox: () => invoke('hwid:purge-roblox'),

  // adapters
  listAdapters: () => invoke('adapters:list'),
  spoofAdapter: (guid, mac) => invoke('adapters:spoof', { guid, mac }),
  resetAdapter: (guid) => invoke('adapters:reset', { guid }),
  restartAdapter: (guid) => invoke('adapters:restart', { guid }),
  dhcpRefresh: () => invoke('network:dhcp'),

  // updates
  checkUpdates: () => invoke('updates:check'),
  installLatest: () => invoke('updates:install-latest'),
  onUpdateProgress: (callback) => subscribe('updates:progress', callback),

  // externals / diagnostics
  openExternal: (url) => invoke('shell:open-external', { url }),
  openLogs: () => invoke('shell:open-logs'),
  getLogs: () => invoke('logs:tail'),
  getDiagnostics: () => invoke('diag:get'),

  // profiles
  listProfiles: () => invoke('profiles:list'),
  saveProfile: (name) => invoke('profiles:save', { name }),
  applyProfile: (name) => invoke('profiles:apply', { name }),
  deleteProfile: (name) => invoke('profiles:delete', { name }),

  // theme
  exportTheme: () => invoke('theme:export'),
  importTheme: () => invoke('theme:import'),

  // main-process commands (tray/toast)
  onCommand: (callback) => subscribe('app:command', callback)
});
