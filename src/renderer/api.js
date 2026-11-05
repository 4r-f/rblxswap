/** Thin wrapper around the preload bridge with a safe "not in Electron" fallback. */
const bridge = typeof window !== 'undefined' ? window.launcher : null;

const noop = () => () => {};
const unavailable = async () => ({ ok: false, error: 'bridge-unavailable' });

const api = bridge || {
  getAppInfo: unavailable,
  getConfig: unavailable,
  setConfig: unavailable,
  resetConfig: unavailable,
  hideWindow: async () => {},
  selectDirectory: unavailable,
  scanWeblauncher: unavailable,
  showToast: async () => {},
  planCleanup: unavailable,
  runCleanup: unavailable,
  runSpoof: unavailable,
  detectAnticheat: async () => ({ ok: true, detections: [] }),
  createRestorePoint: unavailable,
  hwidBackupExists: unavailable,
  hwidBackupInfo: unavailable,
  backupHwid: unavailable,
  restoreHwid: unavailable,
  purgeRoblox: unavailable,
  listAdapters: async () => ({ ok: true, adapters: [] }),
  spoofAdapter: unavailable,
  resetAdapter: unavailable,
  restartAdapter: unavailable,
  dhcpRefresh: unavailable,
  checkUpdates: unavailable,
  installLatest: unavailable,
  openExternal: unavailable,
  openLogs: unavailable,
  getLogs: unavailable,
  getDiagnostics: unavailable,
  listProfiles: async () => ({ ok: true, profiles: [] }),
  saveProfile: unavailable,
  applyProfile: unavailable,
  deleteProfile: unavailable,
  exportTheme: unavailable,
  importTheme: unavailable,
  onCleanerLog: noop,
  onCleanerProgress: noop,
  onCleanerStatus: noop,
  onSpoofLog: noop,
  onSpoofProgress: noop,
  onUpdateProgress: noop,
  onCommand: noop
};

const hasBridge = Boolean(bridge);
