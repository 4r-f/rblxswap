'use strict';

/**
 * Shared, Electron-free constants. Everything that used to be scattered through
 * main.js lives here so tests and the CLI can use the exact same values.
 */

const APP_NAME = 'rblxswap';
const APP_ID = 'com.rblxswap.utility';
const APP_VERSION_FALLBACK = '0.4.0';

// The updater used to point at focat69/rblxswap, which is now a 404.
// Priority: RBLXSWAP_UPDATE_REPO env > package.json repository > fallback.
function repoFromPackage() {
  try {
    const pkg = require('../../package.json');
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const match = String(url || '').match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
    if (match) return `${match[1]}/${match[2]}`;
  } catch (error) {
    // Packaged without a repository field.
  }
  return 'hackyue/rblxswap';
}

const DEFAULT_UPDATE_REPO = process.env.RBLXSWAP_UPDATE_REPO || repoFromPackage();

const ROBLOX_PROCESS_NAMES = [
  'RobloxPlayerBeta.exe',
  'RobloxPlayerLauncher.exe',
  'RobloxStudioBeta.exe',
  'RobloxCrashHandler.exe',
  'RobloxPlayerBeta'
];

const LAUNCHER_NAMES = ['Fishstrap', 'Bloxstrap', 'Voidstrap'];
const LAUNCHER_SUBFOLDERS = ['Logs', 'Downloads'];

const PREFETCH_PREFIXES = ['ROBLOXCRASHHANDLER.EXE-', 'ROBLOXPLAYERBETA.EXE-'];

// Only these temp directories are ever considered "Roblox" and removable.
// The old code deleted *every* directory starting with "Roblox".
const TEMP_DIR_NAMES = ['Roblox', 'RobloxLogs'];
const TEMP_DIR_PATTERN = /^Roblox(?:Logs|Studio[^\\/]*)?$/i;

const WEBLAUNCHER_DIRS = [
  'content',
  'ExtraContent',
  'PlatformContent',
  'RobloxPlayerBeta.exe.WebView2',
  'shaders',
  'ssl',
  'WebView2RuntimeInstaller'
];

const WEBLAUNCHER_FILES = [
  'RobloxCrashHandler.exe',
  'RobloxPlayerBeta.dll',
  'RobloxPlayerBeta.exe',
  'WebView2Loader.dll',
  'COPYRIGHT.txt'
];

const WEBLAUNCHER_MARKERS = ['weblauncher.exe', 'WebLauncher.exe'];

const REGISTRY_ROBLOX_KEY = 'HKCU\\Software\\ROBLOX Corporation';
const REGISTRY_PURGE_KEYS = ['Software\\Roblox', 'Software\\Roblox Corporation'];

const MAX_UPDATE_BYTES = 300 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const HTTP_TIMEOUT_MS = 10_000;
const MAX_TOASTS = 5;

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_MAX_FILES = 3;

const ALLOWED_EXTERNAL_HOSTS = ['github.com', 'discord.gg', 'discord.com'];

module.exports = {
  APP_NAME,
  APP_ID,
  APP_VERSION_FALLBACK,
  DEFAULT_UPDATE_REPO,
  ROBLOX_PROCESS_NAMES,
  LAUNCHER_NAMES,
  LAUNCHER_SUBFOLDERS,
  PREFETCH_PREFIXES,
  TEMP_DIR_NAMES,
  TEMP_DIR_PATTERN,
  WEBLAUNCHER_DIRS,
  WEBLAUNCHER_FILES,
  WEBLAUNCHER_MARKERS,
  REGISTRY_ROBLOX_KEY,
  REGISTRY_PURGE_KEYS,
  MAX_UPDATE_BYTES,
  MAX_REDIRECTS,
  HTTP_TIMEOUT_MS,
  MAX_TOASTS,
  LOG_MAX_BYTES,
  LOG_MAX_FILES,
  ALLOWED_EXTERNAL_HOSTS
};
