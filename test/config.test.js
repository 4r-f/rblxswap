'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createConfigStore, sanitizeConfig, DEFAULT_CONFIG } = require('../src/shared/config');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rblxswap-config-'));
}

test('config store starts from sanitized defaults and writes the file', () => {
  const dir = tempDir();
  const store = createConfigStore({ dir });
  const config = store.get();

  assert.equal(config.schemaVersion, 2);
  assert.equal(config.launcherType, 'default');
  assert.equal(config.spoofTargets.mac, true);
  assert.equal(config.spoofTargets.volume, false);
  assert.equal(fs.existsSync(store.file), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('set() merges nested theme/spoofTargets and persists atomically', () => {
  const dir = tempDir();
  const store = createConfigStore({ dir });

  const updated = store.set({
    theme: { 'bg-base': '#123456' },
    spoofTargets: { volume: true },
    language: 'tr'
  });

  assert.equal(updated.theme['bg-base'], '#123456');
  assert.equal(updated.theme['text-main'], DEFAULT_CONFIG.theme['text-main']);
  assert.equal(updated.spoofTargets.mac, true);
  assert.equal(updated.spoofTargets.volume, true);
  assert.equal(updated.language, 'tr');

  const reloaded = createConfigStore({ dir }).get();
  assert.equal(reloaded.theme['bg-base'], '#123456');
  assert.equal(reloaded.language, 'tr');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('profiles are replaced, not merged, so deletion works', () => {
  const dir = tempDir();
  const store = createConfigStore({ dir });

  store.set({ profiles: { work: { spoofMode: 'advanced' }, home: {} } });
  const next = store.set({ profiles: { home: {} } });

  assert.deepEqual(Object.keys(next.profiles), ['home']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('invalid or hostile config values are sanitized', () => {
  const config = sanitizeConfig({
    launcherType: 'evil',
    language: 'de',
    theme: { 'bg-base': 'javascript:alert(1)', 'bg-img': 'javascript:alert(1)' },
    updates: { repo: 'not a repo', channel: 'nightly', allowUnsigned: 'yes' },
    spoofTargets: { mac: 'yes' },
    profiles: { '../bad': {}, ok: { spoofMode: 'advanced' } }
  });

  assert.equal(config.launcherType, 'default');
  assert.equal(config.language, 'en');
  assert.equal(config.theme['bg-base'], '#101010');
  assert.equal(config.theme['bg-img'], '');
  assert.equal(config.updates.channel, 'stable');
  assert.equal(config.updates.allowUnsigned, false);
  assert.equal(config.spoofTargets.mac, true); // invalid value falls back to the default
  assert.deepEqual(Object.keys(config.profiles), ['ok']);
});

test('weblauncherDir must be a string to survive sanitization', () => {
  assert.equal(sanitizeConfig({ weblauncherDir: 42 }).weblauncherDir, null);
  assert.equal(sanitizeConfig({ weblauncherDir: 'C:\\launcher' }).weblauncherDir, 'C:\\launcher');
});
