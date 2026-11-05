'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  planCleanup,
  executePlan,
  hasWeblauncherMarker,
  isRootOrDrive
} = require('../src/main/cleaner');

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rblxswap-clean-'));
  const env = {
    LOCALAPPDATA: path.join(root, 'local'),
    APPDATA: path.join(root, 'roaming'),
    PROGRAMDATA: path.join(root, 'programdata'),
    ProgramFiles: path.join(root, 'programfiles'),
    'ProgramFiles(x86)': path.join(root, 'programfilesx86'),
    TEMP: path.join(root, 'temp'),
    SystemRoot: path.join(root, 'windows'),
    USERPROFILE: path.join(root, 'user'),
    SystemDrive: 'C:'
  };

  const mk = (target) => fs.mkdirSync(target, { recursive: true });
  const write = (target, data = 'x') => {
    mk(path.dirname(target));
    fs.writeFileSync(target, data);
  };

  mk(path.join(env.LOCALAPPDATA, 'Roblox', 'Versions', 'player-1'));
  mk(path.join(env.LOCALAPPDATA, 'Roblox', 'Versions', 'player-2'));
  write(path.join(env.LOCALAPPDATA, 'Roblox', 'Versions', 'player-2', 'RobloxStudioBeta.exe'));
  write(path.join(env.LOCALAPPDATA, 'Roblox', 'Downloads', 'installer.exe'));
  write(path.join(env.LOCALAPPDATA, 'Roblox', 'Logs', 'client.log'));

  mk(path.join(env.APPDATA, 'Roblox', 'logs'));
  mk(path.join(env.APPDATA, 'Roblox', 'http'));

  mk(path.join(env.TEMP, 'Roblox'));
  mk(path.join(env.TEMP, 'RobloxLogs'));
  mk(path.join(env.TEMP, 'RobloxStudioCache'));
  mk(path.join(env.TEMP, 'RobloxBackup'));

  write(path.join(env.SystemRoot, 'Prefetch', 'ROBLOXPLAYERBETA.EXE-1234.pf'));
  write(path.join(env.SystemRoot, 'Prefetch', 'OTHER.EXE-1234.pf'));

  write(path.join(env.USERPROFILE, 'AppData', 'Local', 'Roblox', 'LocalStorage', 'cookies.dat'));
  write(path.join(env.USERPROFILE, 'AppData', 'Local', 'Roblox', 'logs', 'client.log'));

  mk(path.join(env.PROGRAMDATA, 'Roblox'));

  return { root, env };
}

test('planCleanup keeps Studio versions and includes player versions', async () => {
  const { root, env } = makeTree();
  const plan = await planCleanup({ config: { purgeAuth: true }, env });
  const ids = plan.steps.map((step) => step.id);

  assert.ok(ids.includes('local-versions'));
  assert.ok(ids.includes('registry'));
  assert.ok(ids.includes('programdata'));
  assert.ok(ids.includes('auth'));

  const versions = plan.steps.find((step) => step.id === 'local-versions');
  const joined = versions.paths.join('|');
  assert.ok(joined.includes('player-1'));
  assert.ok(!joined.includes('player-2'), 'Studio folder must be kept');

  fs.rmSync(root, { recursive: true, force: true });
});

test('planCleanup only removes allow-listed Roblox temp folders', async () => {
  const { root, env } = makeTree();
  const plan = await planCleanup({ config: {}, env });
  const temp = plan.steps.find((step) => step.id === 'temp');
  const joined = temp.paths.join('|');

  assert.ok(joined.includes(`${path.sep}Roblox`));
  assert.ok(joined.includes('RobloxLogs'));
  assert.ok(joined.includes('RobloxStudioCache'));
  assert.ok(!joined.includes('RobloxBackup'), 'unrelated Roblox* folder must survive');

  fs.rmSync(root, { recursive: true, force: true });
});

test('planCleanup finds prefetch entries case-insensitively and counts files', async () => {
  const { root, env } = makeTree();
  const plan = await planCleanup({ config: {}, env });
  const prefetch = plan.steps.find((step) => step.id === 'prefetch');

  assert.equal(prefetch.paths.length, 1);
  assert.match(prefetch.paths[0], /ROBLOXPLAYERBETA/);
  assert.ok(plan.totals.count > 0);

  fs.rmSync(root, { recursive: true, force: true });
});

test('planCleanup refuses a drive root as WebLauncher directory', async () => {
  const { root, env } = makeTree();
  const plan = await planCleanup({ config: {}, env, weblauncherDir: path.parse(root).root });

  assert.ok(plan.warnings.some((warning) => /drive root/i.test(warning)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('executePlan removes directories when trash is disabled', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rblxswap-exec-'));
  const victim = path.join(root, 'victim');
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'file.txt'), 'x');

  const result = await executePlan({
    steps: [{ id: 'x', label: 'x', kind: 'dirs', paths: [victim], keys: [], requiresAdmin: false, danger: false }]
  }, { config: { useTrash: false }, env: { USERPROFILE: root } });

  assert.equal(result.removedPaths, 1);
  assert.equal(fs.existsSync(victim), false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('helper checks for WebLauncher markers and drive roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rblxswap-marker-'));
  assert.equal(hasWeblauncherMarker(root), false);
  fs.writeFileSync(path.join(root, 'WebLauncher.exe'), '');
  assert.equal(hasWeblauncherMarker(root), true);

  assert.equal(isRootOrDrive(path.parse(root).root), true);
  assert.equal(isRootOrDrive(root), false);

  fs.rmSync(root, { recursive: true, force: true });
});
