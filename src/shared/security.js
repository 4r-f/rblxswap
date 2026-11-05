'use strict';

const crypto = require('crypto');

/**
 * Validation and escaping helpers shared by the main process, the renderer
 * (via the preload bridge) and the tests.
 */

const HEX_12 = /^[0-9A-F]{12}$/;

/** Accepts AA:BB:CC:DD:EE:FF, AA-BB-CC-DD-EE-FF, aabbccddeeff. Returns AA-BB-... or null. */
function normalizeMac(input) {
  if (typeof input !== 'string') return null;
  const hex = input.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (!HEX_12.test(hex)) return null;
  return hex.match(/.{2}/g).join('-');
}

function isValidMac(input) {
  return normalizeMac(input) !== null;
}

function isUnicastMac(input) {
  const mac = normalizeMac(input);
  if (!mac) return false;
  return (parseInt(mac.slice(0, 2), 16) & 0x01) === 0;
}

/**
 * Generates a locally-administered unicast MAC.
 * With mirror=true the original OUI (first 3 bytes) is kept when available,
 * matching the old "OUI mirror" behaviour.
 */
function randomMac(original, { mirror = true } = {}) {
  const source = normalizeMac(original);
  const bytes = [];

  if (mirror && source) {
    const oui = source.split('-').map((part) => parseInt(part, 16));
    bytes.push((oui[0] & 0xfe) | 0x02, oui[1], oui[2]);
  } else {
    const first = crypto.randomBytes(1)[0];
    bytes.push((first & 0xfe) | 0x02, crypto.randomBytes(1)[0], crypto.randomBytes(1)[0]);
  }

  for (let i = 0; i < 3; i += 1) bytes.push(crypto.randomBytes(1)[0]);
  return bytes.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join('-');
}

/**
 * Only https URLs on an allow-listed host are allowed to reach shell.openExternal.
 * This blocks file://, ms-settings:, javascript: and arbitrary hosts.
 */
function isSafeExternalUrl(raw, {
  allowedHosts = ['github.com', 'discord.gg', 'discord.com'],
  allowSubdomains = true
} = {}) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false;

  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase();
  return allowedHosts.some((allowed) => {
    const target = String(allowed).toLowerCase();
    return host === target || (allowSubdomains && host.endsWith(`.${target}`));
  });
}

function escapeHtml(input) {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isHex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

/** Parses a `sha256sum`-style file and returns the hash for `filename` (case-insensitive). */
function parseChecksumFile(text, filename) {
  if (typeof text !== 'string' || typeof filename !== 'string') return null;
  const wanted = filename.toLowerCase();

  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (!match) continue;
    const name = match[2].trim().split(/[\\/]/).pop().toLowerCase();
    if (name === wanted) return match[1].toLowerCase();
  }
  return null;
}

/** Rejects strings that contain control characters (used for toast/title text). */
function stripControlChars(input, maxLength = 4000) {
  return String(input == null ? '' : input)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maxLength);
}

module.exports = {
  normalizeMac,
  isValidMac,
  isUnicastMac,
  randomMac,
  isSafeExternalUrl,
  escapeHtml,
  isHex64,
  parseChecksumFile,
  stripControlChars
};
