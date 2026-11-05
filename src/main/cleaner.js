'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const {
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
  REGISTRY_PURGE_KEYS
} = require('../shared/constants');
const { pathExists, measurePath, formatBytes } = require('../shared/fs-utils');
const { isSubPath } = require('../shared/paths');

/**
 * Cleanup is split into a read-only plan phase (used by the dry-run UI and
 * CLI --dry-run) and an execute phase. Nothing is deleted before the user has
 * seen the plan.
 */

function windowsEnv(env) {
  return {
    localAppData: env.LOCALAPPDATA || '',
    appData: env.APPDATA || '',
    programData: env.PROGRAMDATA || '',
    programFiles: env.ProgramFiles || env.PROGRAMFILES || '',
    programFilesX86: env['ProgramFiles(x86)'] || '',
    temp: env.TEMP || env.TMP || os.tmpdir(),
    systemRoot: env.SystemRoot || 'C:\\Windows',
    userProfile: env.USERPROFILE || ''
  };
}

async function readDirSafe(target) {
  try {
    return await fsp.readdir(target, { withFileTypes: true });
  } catch (error) {
    return [];
  }
}

async function collectFiles(root, matcher, maxDepth = 6, currentDepth = 0) {
  if (currentDepth > maxDepth) return [];
  if (!(await pathExists(root))) return [];

  const collected = [];
  for (const entry of await readDirSafe(root)) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && matcher.test(entry.name)) {
      collected.push(full);
      continue;
    }
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const nested = await collectFiles(full, matcher, maxDepth, currentDepth + 1);
      if (nested.length) collected.push(...nested);
    }
  }
  return collected;
}

async function collectAllFiles(root, maxDepth = 8, currentDepth = 0) {
  if (currentDepth > maxDepth) return [];
  const files = [];
  for (const entry of await readDirSafe(root)) {
    const full = path.join(root, entry.name);
    if (entry.isFile()) files.push(full);
    else if (entry.isDirectory()) files.push(...await collectAllFiles(full, maxDepth, currentDepth + 1));
  }
  return files;
}

function addPaths(step, paths) {
  const seen = new Set(step.paths.map((item) => item.toLowerCase()));

  for (const target of paths) {
    if (!target) continue;
    const key = target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    step.paths.push(target);
  }
}

function hasWeblauncherMarker(dir) {
  return WEBLAUNCHER_MARKERS.some((marker) => {
    try {
      return fs.existsSync(path.join(dir, marker));
    } catch (error) {
      return false;
    }
  });
}

function isRootOrDrive(target) {
  const parsed = path.parse(target);
  return parsed.root === target || parsed.dir === target;
}

async function versionDirs(root, { deleteStudio }) {
  const versionsPath = path.join(root, 'Versions');
  if (!(await pathExists(versionsPath))) return { toDelete: [], kept: [] };

  const toDelete = [];
  const kept = [];

  for (const entry of await readDirSafe(versionsPath)) {
    if (!entry.isDirectory()) continue;
    const versionPath = path.join(versionsPath, entry.name);

    if (deleteStudio) {
      toDelete.push(versionPath);
      continue;
    }

    const hasStudio = await pathExists(path.join(versionPath, 'RobloxStudioBeta.exe'));
    if (hasStudio) kept.push(versionPath);
    else toDelete.push(versionPath);
  }

  return { toDelete, kept };
}

/**
 * Builds a complete, human-readable cleanup plan without deleting anything.
 */
async function planCleanup({ config = {}, weblauncherDir = null, env = process.env } = {}) {
  const paths = windowsEnv(env);
  const steps = [];
  const warnings = [];

  const pushStep = (step) => {
    if (!step) return null;
    const normalized = {
      id: step.id,
      label: step.label,
      kind: step.kind,
      paths: [],
      keys: step.keys || [],
      requiresAdmin: Boolean(step.requiresAdmin),
      danger: Boolean(step.danger),
      bytes: 0,
      count: 0,
      truncated: false
    };
    addPaths(normalized, step.paths || []);
    if (normalized.paths.length || normalized.keys.length) steps.push(normalized);
    return normalized;
  };

  // 1. Processes ------------------------------------------------------------
  pushStep({
    id: 'processes',
    label: 'Terminate Roblox processes',
    kind: 'process',
    paths: ROBLOX_PROCESS_NAMES
  });

  // 2. Launcher caches ------------------------------------------------------
  const launcherPaths = [];
  if (paths.localAppData) {
    for (const launcher of LAUNCHER_NAMES) {
      for (const folder of LAUNCHER_SUBFOLDERS) {
        launcherPaths.push(path.join(paths.localAppData, launcher, folder));
      }
    }
  }
  pushStep({
    id: 'launcher-caches',
    label: 'Fishstrap / Bloxstrap / Voidstrap caches',
    kind: 'dirs',
    paths: launcherPaths
  });

  // 3. Custom WebLauncher ---------------------------------------------------
  if (weblauncherDir) {
    if (isRootOrDrive(weblauncherDir)) {
      warnings.push('Refusing to clean a drive root as WebLauncher directory');
    } else {
      const hasMarker = hasWeblauncherMarker(weblauncherDir);
      if (!hasMarker) {
        warnings.push('WebLauncher marker not found; review the file list before cleaning');
      }

      pushStep({
        id: 'weblauncher',
        label: 'WebLauncher files',
        kind: 'dirs',
        paths: WEBLAUNCHER_DIRS.map((dir) => path.join(weblauncherDir, dir)),
        danger: !hasMarker
      });

      pushStep({
        id: 'weblauncher-files',
        label: 'WebLauncher executables',
        kind: 'files',
        paths: WEBLAUNCHER_FILES.map((file) => path.join(weblauncherDir, file)),
        danger: !hasMarker
      });
    }
  }

  // 4. Roblox installation --------------------------------------------------
  if (paths.localAppData) {
    const localRoblox = path.join(paths.localAppData, 'Roblox');
    if (config.deleteStudio) {
      pushStep({
        id: 'local-roblox',
        label: 'Local Roblox installation (including Studio)',
        kind: 'dirs',
        paths: [localRoblox],
        requiresAdmin: false,
        danger: true
      });
    } else {
      const localVersions = await versionDirs(localRoblox, { deleteStudio: false });
      pushStep({
        id: 'local-versions',
        label: 'Roblox player versions',
        kind: 'dirs',
        paths: localVersions.toDelete
      });
      pushStep({
        id: 'local-logs-downloads',
        label: 'Roblox Downloads / Logs',
        kind: 'dirs',
        paths: [path.join(localRoblox, 'Downloads'), path.join(localRoblox, 'Logs')]
      });
    }
  }

  // 5. Launcher versions ----------------------------------------------------
  for (const launcher of LAUNCHER_NAMES) {
    if (!paths.localAppData) break;
    const launcherRoot = path.join(paths.localAppData, launcher);
    if (!(await pathExists(launcherRoot))) continue;

    if (config.deleteStudio) {
      pushStep({
        id: `versions-${launcher.toLowerCase()}`,
        label: `${launcher} versions (including Studio)`,
        kind: 'dirs',
        paths: [path.join(launcherRoot, 'Versions')],
        danger: true
      });
    } else {
      const result = await versionDirs(launcherRoot, { deleteStudio: false });
      pushStep({
        id: `versions-${launcher.toLowerCase()}`,
        label: `${launcher} player versions`,
        kind: 'dirs',
        paths: result.toDelete
      });
    }
  }

  // 6. Program Files --------------------------------------------------------
  for (const [root, label] of [
    [paths.programFiles, 'Program Files'],
    [paths.programFilesX86, 'Program Files (x86)']
  ]) {
    if (!root) continue;
    const robloxRoot = path.join(root, 'Roblox');
    if (!(await pathExists(robloxRoot))) continue;

    if (config.deleteStudio) {
      pushStep({
        id: `pf-${label}`,
        label: `${label} Roblox (including Studio)`,
        kind: 'dirs',
        paths: [robloxRoot],
        requiresAdmin: true,
        danger: true
      });
    } else {
      const result = await versionDirs(robloxRoot, { deleteStudio: false });
      pushStep({
        id: `pf-${label}`,
        label: `${label} Roblox player versions`,
        kind: 'dirs',
        paths: result.toDelete,
        requiresAdmin: true
      });
    }
  }

  // 7. Roaming --------------------------------------------------------------
  if (paths.appData) {
    pushStep({
      id: 'roaming',
      label: 'Roaming Roblox logs and HTTP cache',
      kind: 'dirs',
      paths: [path.join(paths.appData, 'Roblox', 'logs'), path.join(paths.appData, 'Roblox', 'http')]
    });
  }

  // 8. Prefetch -------------------------------------------------------------
  const prefetchDir = path.join(paths.systemRoot, 'Prefetch');
  const prefetchFiles = (await readDirSafe(prefetchDir))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      const upper = name.toUpperCase();
      return PREFETCH_PREFIXES.some((prefix) => upper.startsWith(prefix)) && upper.endsWith('.PF');
    })
    .map((name) => path.join(prefetchDir, name));

  pushStep({
    id: 'prefetch',
    label: 'Roblox Prefetch entries',
    kind: 'prefetch',
    paths: prefetchFiles,
    requiresAdmin: true
  });

  // 9. Registry -------------------------------------------------------------
  pushStep({
    id: 'registry',
    label: 'Roblox registry keys',
    kind: 'registry',
    keys: [REGISTRY_ROBLOX_KEY]
  });

  // 10. Temp ---------------------------------------------------------------
  const tempPaths = TEMP_DIR_NAMES.map((name) => path.join(paths.temp, name));
  for (const entry of await readDirSafe(paths.temp)) {
    if (entry.isDirectory() && TEMP_DIR_PATTERN.test(entry.name)) {
      tempPaths.push(path.join(paths.temp, entry.name));
    }
  }
  pushStep({
    id: 'temp',
    label: 'Roblox temp caches',
    kind: 'dirs',
    paths: tempPaths
  });

  // 11. ProgramData ---------------------------------------------------------
  if (paths.programData) {
    pushStep({
      id: 'programdata',
      label: 'ProgramData Roblox',
      kind: 'dirs',
      paths: [path.join(paths.programData, 'Roblox')],
      requiresAdmin: true
    });
  }

  // 12. Auth tokens + telemetry --------------------------------------------
  if (config.purgeAuth !== false && paths.userProfile) {
    const localRoblox = path.join(paths.userProfile, 'AppData', 'Local', 'Roblox');
    const authFiles = [
      ...await collectAllFiles(path.join(localRoblox, 'LocalStorage')),
      ...await collectAllFiles(path.join(localRoblox, 'logs'))
    ];

    pushStep({
      id: 'auth',
      label: 'Roblox auth tokens and local logs',
      kind: 'files',
      paths: authFiles
    });

    pushStep({
      id: 'registry-purge',
      label: 'Roblox trace registry keys',
      kind: 'registry',
      keys: REGISTRY_PURGE_KEYS.map((key) => `HKCU\\${key}`)
    });
  }

  // Measure everything (bounded) -------------------------------------------
  for (const step of steps) {
    if (step.kind === 'process' || step.kind === 'registry') continue;

    for (const target of step.paths) {
      const measured = await measurePath(target);
      step.bytes += measured.bytes;
      step.count += measured.count;
      step.truncated = step.truncated || measured.truncated;
    }
  }

  const totals = steps.reduce((accumulator, step) => ({
    count: accumulator.count + step.count,
    bytes: accumulator.bytes + step.bytes
  }), { count: 0, bytes: 0 });

  return {
    steps,
    warnings,
    totals: { ...totals, human: formatBytes(totals.bytes) },
    createdAt: Date.now(),
    target: weblauncherDir || null
  };
}

async function removeDirectory(target, { trash = false, userProfile = '' } = {}) {
  try {
    if (!(await pathExists(target))) return { removed: false, reason: 'absent', target };
  } catch (error) {
    return { removed: false, reason: error.message, target };
  }

  const canTrash = trash && userProfile && isSubPath(userProfile, target);
  if (canTrash) {
    try {
      // Lazy require: Electron is unavailable in unit tests.
      const { shell } = require('electron');
      await shell.trashItem(target);
      return { removed: true, reason: 'trash', target };
    } catch (error) {
      // Fall through to permanent removal.
    }
  }

  try {
    await fsp.rm(target, { recursive: true, force: true });
    return { removed: true, reason: 'deleted', target };
  } catch (error) {
    return { removed: false, reason: error.message, target };
  }
}

async function killProcesses(names = ROBLOX_PROCESS_NAMES) {
  if (process.platform !== 'win32') {
    return { killed: 0, skipped: true, errors: [] };
  }

  let killed = 0;
  const errors = [];

  for (const name of names) {
    try {
      await execFileAsync('taskkill', ['/IM', name, '/F'], { windowsHide: true });
      killed += 1;
    } catch (error) {
      const stderr = String(error.stderr || '');
      if (error.code === 'ENOENT') {
        errors.push('taskkill unavailable');
        break;
      }
      if (!/not found|No tasks are running/i.test(stderr)) {
        errors.push(`${name}: ${error.message}`);
      }
    }
  }

  return { killed, skipped: false, errors };
}

async function collectPreservedFiles({ config, env = process.env }) {
  const paths = windowsEnv(env);
  const backups = [];

  if (config.preserveSettings && paths.localAppData) {
    const roots = [path.join(paths.localAppData, 'Roblox')];
    if (paths.appData) roots.push(path.join(paths.appData, 'Roblox'));

    const settings = [];
    for (const root of roots) {
      settings.push(...await collectFiles(root, /^GlobalBasicSettings_\d+\.xml$/i, 6));
    }

    for (const filePath of Array.from(new Set(settings))) {
      try {
        backups.push({ filePath, data: await fsp.readFile(filePath) });
      } catch (error) {
        // File disappeared between scan and read.
      }
    }
  }

  if (config.preserveFastflags && paths.localAppData) {
    const roots = LAUNCHER_NAMES.map((name) => path.join(paths.localAppData, name));
    if (config.weblauncherDir) roots.push(config.weblauncherDir);

    const fastflags = [];
    for (const root of roots) {
      fastflags.push(...await collectFiles(root, /^Client(Settings|AppSettings)\.json$/i, 6));
    }

    for (const filePath of Array.from(new Set(fastflags))) {
      try {
        backups.push({ filePath, data: await fsp.readFile(filePath) });
      } catch (error) {
        // Ignore.
      }
    }
  }

  return backups;
}

async function restorePreservedFiles(backups, log = () => {}) {
  for (const backup of backups) {
    try {
      await fsp.mkdir(path.dirname(backup.filePath), { recursive: true });
      await fsp.writeFile(backup.filePath, backup.data);
      log('success', `Restored ${path.basename(backup.filePath)}`);
    } catch (error) {
      log('warn', `Could not restore ${path.basename(backup.filePath)}: ${error.message}`);
    }
  }
}

async function deleteRegistryKey(key) {
  if (process.platform !== 'win32') return { key, deleted: false };

  try {
    await execFileAsync('reg', ['delete', key, '/f'], { windowsHide: true });
    return { key, deleted: true };
  } catch (error) {
    return { key, deleted: false };
  }
}

/**
 * Executes a plan produced by planCleanup().
 */
async function executePlan(plan, {
  config = {},
  env = process.env,
  log = () => {},
  onProgress = () => {}
} = {}) {
  const paths = windowsEnv(env);
  const result = {
    removedPaths: 0,
    removedFiles: 0,
    failed: [],
    registry: [],
    processes: null,
    trashed: 0,
    deleted: 0
  };

  const steps = plan.steps || [];
  const total = steps.length;

  for (let index = 0; index < total; index += 1) {
    const step = steps[index];
    onProgress({ index, total, label: step.label, status: 'running' });

    if (step.kind === 'process') {
      result.processes = await killProcesses(step.paths);
      for (const error of result.processes.errors || []) log('warn', error);
      if (result.processes.killed) log('success', `Terminated ${result.processes.killed} process(es)`);
      else log('info', 'No Roblox processes were running');

      // Give Windows a moment to release file handles.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      onProgress({ index, total, label: step.label, status: 'done' });
      continue;
    }

    if (step.kind === 'registry') {
      for (const key of step.keys) {
        const outcome = await deleteRegistryKey(key);
        result.registry.push(outcome);
        log(outcome.deleted ? 'success' : 'info',
          outcome.deleted ? `Removed ${key}` : `${key} already absent`);
      }
      onProgress({ index, total, label: step.label, status: 'done' });
      continue;
    }

    for (const target of step.paths) {
      const outcome = await removeDirectory(target, {
        trash: config.useTrash !== false,
        userProfile: paths.userProfile
      });

      if (!outcome.removed) {
        if (outcome.reason !== 'absent') {
          result.failed.push({ target, reason: outcome.reason });
          log('warn', `Failed to remove ${target}: ${outcome.reason}`);
        }
        continue;
      }

      result.removedPaths += 1;
      // Individual files (auth purge) count one by one; directories are counted
      // through the plan measurement instead.
      if (step.kind === 'files' || step.kind === 'prefetch') result.removedFiles += 1;
      if (outcome.reason === 'trash') result.trashed += 1;
      else result.deleted += 1;
      log('success', `Removed ${path.basename(target) || target}`);
    }

    onProgress({ index, total, label: step.label, status: 'done' });
  }

  onProgress({ index: total, total, label: 'Done', status: 'complete' });
  return result;
}

async function runCleanup({
  config = {},
  weblauncherDir = null,
  env = process.env,
  dryRun = false,
  log = () => {},
  onProgress = () => {}
} = {}) {
  const plan = await planCleanup({ config, weblauncherDir, env });

  if (dryRun) {
    log('info', `Dry run: ${plan.steps.length} steps, ${plan.totals.count} files, ${plan.totals.human}`);
    return { dryRun: true, plan, backups: 0 };
  }

  const backups = await collectPreservedFiles({ config, env });
  if (backups.length) log('info', `Backed up ${backups.length} settings/fastflag file(s)`);

  const result = await executePlan(plan, { config, env, log, onProgress });

  if (backups.length) await restorePreservedFiles(backups, log);

  log('success', `Cleanup finished: ${result.removedPaths} path(s) removed, ${result.failed.length} failure(s)`);
  return { dryRun: false, plan, result, backups: backups.length };
}

module.exports = {
  planCleanup,
  executePlan,
  runCleanup,
  collectPreservedFiles,
  restorePreservedFiles,
  collectFiles,
  collectAllFiles,
  hasWeblauncherMarker,
  isRootOrDrive,
  windowsEnv,
  killProcesses,
  removeDirectory,
  deleteRegistryKey,
  REGISTRY_ROBLOX_KEY
};
