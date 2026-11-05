'use strict';

/** Small semver-ish helpers (no dependency). */

function parseVersion(input) {
  const text = String(input == null ? '' : input).trim();
  const match = text.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
    prerelease: match[4] || '',
    raw: text
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);

  // Unparseable versions are treated as older than anything valid.
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }

  // A release is newer than a prerelease of the same version.
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (a.prerelease === b.prerelease) return 0;
  return a.prerelease > b.prerelease ? 1 : -1;
}

function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

module.exports = { parseVersion, compareVersions, isNewerVersion };
