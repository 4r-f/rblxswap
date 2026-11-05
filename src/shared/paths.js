'use strict';

const path = require('path');

function normalizeForCompare(target) {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when `child` is inside `parent` (or equal to it). Handles Windows casing. */
function isSubPath(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string') return false;
  const relative = path.relative(normalizeForCompare(parent), normalizeForCompare(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function samePath(left, right) {
  return normalizeForCompare(left) === normalizeForCompare(right);
}

function safeBasename(target) {
  return path.basename(String(target || '')).slice(0, 120);
}

module.exports = { isSubPath, samePath, safeBasename };
