'use strict';

const path = require('path');
const fs = require('fs');
const { readJsonSync } = require('./fs-utils');
const { DEFAULT_UPDATE_REPO } = require('./constants');

const DEFAULT_THEME = Object.freeze({
  'bg-base': '#101010',
  'bg-accent': '#191919',
  'text-main': '#f0f0f0',
  'good': '#4ade80',
  'bad': '#f87171',
  'bg-img': '',
  'hide-grid': false
});

const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 2,
  launcherType: 'default',
  weblauncherDir: null,
  minimizeClose: true,
  preserveSettings: true,
  preserveFastflags: false,
  deleteStudio: false,
  purgeAuth: true,
  useTrash: true,
  restorePoint: false,
  spoofTargets: { mac: true, hwid: true, volume: false },
  spoofMode: 'simple',
  autoCleanOnExit: false,
  watcherEnabled: true,
  quickSpoof: true,
  onboardingDone: false,
  language: 'en',
  updates: { channel: 'stable', repo: DEFAULT_UPDATE_REPO, allowUnsigned: false },
  theme: { ...DEFAULT_THEME },
  ignoredUpdate: null,
  lastSpoofAt: null,
  profiles: {}
});

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PROFILE_NAME_RE = /^[\w .-]{1,40}$/;

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function asString(value, fallback, maxLength = 1024) {
  return typeof value === 'string' ? value.slice(0, maxLength) : fallback;
}

function sanitizeTheme(input) {
  const theme = { ...DEFAULT_THEME };
  if (!isPlainObject(input)) return theme;

  for (const key of ['bg-base', 'bg-accent', 'text-main', 'good', 'bad']) {
    if (typeof input[key] === 'string' && COLOR_RE.test(input[key])) theme[key] = input[key];
  }

  if (typeof input['bg-img'] === 'string') {
    const image = input['bg-img'].trim().slice(0, 2048);
    theme['bg-img'] = image === '' || /^(file:\/\/\/|https:\/\/)/i.test(image) ? image : '';
  }

  theme['hide-grid'] = asBoolean(input['hide-grid'], false);
  return theme;
}

function sanitizeProfile(input) {
  if (!isPlainObject(input)) return null;
  return {
    launcherType: input.launcherType === 'weao' ? 'weao' : 'default',
    weblauncherDir: typeof input.weblauncherDir === 'string' ? input.weblauncherDir.slice(0, 1024) : null,
    spoofMode: input.spoofMode === 'advanced' ? 'advanced' : 'simple',
    spoofTargets: {
      mac: asBoolean(input.spoofTargets?.mac, true),
      hwid: asBoolean(input.spoofTargets?.hwid, true),
      volume: asBoolean(input.spoofTargets?.volume, false)
    }
  };
}

function sanitizeProfiles(input) {
  const profiles = {};
  if (!isPlainObject(input)) return profiles;

  for (const [name, value] of Object.entries(input)) {
    if (!PROFILE_NAME_RE.test(name)) continue;
    const profile = sanitizeProfile(value);
    if (profile) profiles[name] = profile;
  }
  return profiles;
}

/** Coerces arbitrary input into the known config shape. Unknown keys are dropped. */
function sanitizeConfig(input) {
  const source = isPlainObject(input) ? input : {};
  const config = {
    schemaVersion: 2,
    launcherType: source.launcherType === 'weao' ? 'weao' : 'default',
    weblauncherDir: typeof source.weblauncherDir === 'string' && source.weblauncherDir.trim()
      ? source.weblauncherDir.slice(0, 1024)
      : null,
    minimizeClose: asBoolean(source.minimizeClose, true),
    preserveSettings: asBoolean(source.preserveSettings, true),
    preserveFastflags: asBoolean(source.preserveFastflags, false),
    deleteStudio: asBoolean(source.deleteStudio, false),
    purgeAuth: asBoolean(source.purgeAuth, true),
    useTrash: asBoolean(source.useTrash, true),
    restorePoint: asBoolean(source.restorePoint, false),
    spoofTargets: {
      mac: asBoolean(source.spoofTargets?.mac, true),
      hwid: asBoolean(source.spoofTargets?.hwid, true),
      volume: asBoolean(source.spoofTargets?.volume, false)
    },
    spoofMode: source.spoofMode === 'advanced' ? 'advanced' : 'simple',
    autoCleanOnExit: asBoolean(source.autoCleanOnExit, false),
    watcherEnabled: asBoolean(source.watcherEnabled, true),
    quickSpoof: asBoolean(source.quickSpoof, true),
    onboardingDone: asBoolean(source.onboardingDone, false),
    language: source.language === 'tr' ? 'tr' : 'en',
    updates: {
      channel: source.updates?.channel === 'beta' ? 'beta' : 'stable',
      repo: typeof source.updates?.repo === 'string' && REPO_RE.test(source.updates.repo)
        ? source.updates.repo
        : DEFAULT_UPDATE_REPO,
      allowUnsigned: asBoolean(source.updates?.allowUnsigned, false)
    },
    theme: sanitizeTheme(source.theme),
    ignoredUpdate: typeof source.ignoredUpdate === 'string' ? source.ignoredUpdate.slice(0, 32) : null,
    lastSpoofAt: Number.isFinite(source.lastSpoofAt) ? source.lastSpoofAt : null,
    profiles: sanitizeProfiles(source.profiles)
  };

  return config;
}

function mergeConfig(base, patch) {
  const next = { ...base, ...(isPlainObject(patch) ? patch : {}) };

  // Nested objects merge per-key, except profiles which must support deletion.
  next.theme = { ...base.theme, ...(isPlainObject(patch?.theme) ? patch.theme : {}) };
  next.spoofTargets = { ...base.spoofTargets, ...(isPlainObject(patch?.spoofTargets) ? patch.spoofTargets : {}) };
  next.updates = { ...base.updates, ...(isPlainObject(patch?.updates) ? patch.updates : {}) };
  if (isPlainObject(patch?.profiles)) next.profiles = { ...patch.profiles };

  return sanitizeConfig(next);
}

/**
 * Config store with atomic writes. `dir` is injected so tests can use a temp
 * directory instead of Electron's userData path.
 */
function createConfigStore({ dir, filename = 'config.json' } = {}) {
  if (!dir) throw new Error('createConfigStore requires a directory');

  const file = path.join(dir, filename);
  let cache = null;

  function get() {
    if (cache) return cache;

    const raw = readJsonSync(file, null);
    cache = raw ? sanitizeConfig(raw) : sanitizeConfig(DEFAULT_CONFIG);

    if (!raw) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
      } catch (error) {
        // Read-only install location: keep working with in-memory defaults.
      }
    }

    return cache;
  }

  function set(patch) {
    const next = mergeConfig(get(), patch);
    cache = next;

    try {
      fs.mkdirSync(dir, { recursive: true });
      // Small file: write synchronously through a temp file + rename so a
      // crash can never leave a truncated config behind.
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      // Ignore: read-only install locations are expected.
    }

    return next;
  }

  function reset() {
    cache = sanitizeConfig(DEFAULT_CONFIG);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      // Ignore.
    }
    return cache;
  }

  return { get, set, reset, file, defaults: DEFAULT_CONFIG };
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_THEME,
  sanitizeConfig,
  sanitizeTheme,
  mergeConfig,
  createConfigStore
};
