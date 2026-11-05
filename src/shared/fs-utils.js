'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

async function pathExists(target) {
  try {
    await fsp.access(target, fs.constants.F_OK);
    return true;
  } catch (error) {
    return false;
  }
}

async function ensureDir(target) {
  await fsp.mkdir(target, { recursive: true });
}

function readJsonSync(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

/**
 * Writes JSON through a temp file + rename so a crash can never leave a
 * half-written config/backup behind.
 */
async function atomicWriteJson(file, data) {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

async function fileSize(target) {
  try {
    const stat = await fsp.stat(target);
    return stat.size;
  } catch (error) {
    return 0;
  }
}

/**
 * Recursively measures a path. Bounded so a dry-run on a huge Program Files
 * folder cannot freeze the UI.
 */
async function measurePath(target, { maxEntries = 5000, maxDepth = 12 } = {}) {
  const result = { count: 0, bytes: 0, truncated: false };

  async function walk(current, depth) {
    if (result.count >= maxEntries) {
      result.truncated = true;
      return;
    }

    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      return;
    }

    if (stat.isFile()) {
      result.count += 1;
      result.bytes += stat.size;
      return;
    }

    if (!stat.isDirectory() || depth > maxDepth) return;

    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      return;
    }

    for (const entry of entries) {
      if (result.count >= maxEntries) {
        result.truncated = true;
        return;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const fileStat = await fsp.lstat(full);
          result.count += 1;
          result.bytes += fileStat.size;
        } catch (error) {
          // Ignore files deleted while measuring.
        }
      }
    }
  }

  await walk(target, 0);
  return result;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

module.exports = {
  pathExists,
  ensureDir,
  readJsonSync,
  atomicWriteJson,
  fileSize,
  measurePath,
  formatBytes
};
