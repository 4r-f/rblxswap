'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeMac,
  isValidMac,
  isUnicastMac,
  randomMac,
  isSafeExternalUrl,
  escapeHtml,
  parseChecksumFile,
  stripControlChars
} = require('../src/shared/security');

test('normalizeMac accepts common formats', () => {
  assert.equal(normalizeMac('AA:BB:CC:DD:EE:FF'), 'AA-BB-CC-DD-EE-FF');
  assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), 'AA-BB-CC-DD-EE-FF');
  assert.equal(normalizeMac('aabbccddeeff'), 'AA-BB-CC-DD-EE-FF');
  assert.equal(normalizeMac('AA-BB-CC-DD-EE'), null);
  assert.equal(normalizeMac('GG-BB-CC-DD-EE-FF'), null);
  assert.equal(normalizeMac(null), null);
});

test('isValidMac and isUnicastMac', () => {
  assert.equal(isValidMac('AA-BB-CC-DD-EE-FF'), true);
  assert.equal(isValidMac('nope'), false);
  assert.equal(isUnicastMac('AA-BB-CC-DD-EE-FF'), true);
  assert.equal(isUnicastMac('01-BB-CC-DD-EE-FF'), false);
});

test('randomMac mirrors the OUI and sets the locally administered bit', () => {
  const original = 'AA-BB-CC-DD-EE-FF';
  const mac = randomMac(original, { mirror: true });
  const bytes = mac.split('-');

  assert.equal(bytes.length, 6);
  assert.equal(parseInt(bytes[0], 16) & 0x02, 0x02, 'locally administered bit');
  assert.equal(parseInt(bytes[0], 16) & 0x01, 0x00, 'unicast bit');
  assert.deepEqual(bytes.slice(1, 3), ['BB', 'CC'], 'OUI preserved');
  assert.notEqual(mac, original);
});

test('randomMac without mirror still produces a valid unicast MAC', () => {
  const mac = randomMac(null, { mirror: false });
  assert.match(mac, /^[0-9A-F]{2}(-[0-9A-F]{2}){5}$/);
  assert.equal(parseInt(mac.slice(0, 2), 16) & 0x01, 0);
  assert.equal(parseInt(mac.slice(0, 2), 16) & 0x02, 0x02);
});

test('isSafeExternalUrl only allows https on allowed hosts', () => {
  assert.equal(isSafeExternalUrl('https://github.com/user/repo'), true);
  assert.equal(isSafeExternalUrl('https://discord.gg/abc'), true);
  assert.equal(isSafeExternalUrl('https://api.github.com/repos'), true);
  assert.equal(isSafeExternalUrl('https://github.com.evil.example/'), false);
  assert.equal(isSafeExternalUrl('http://github.com/'), false);
  assert.equal(isSafeExternalUrl('file:///C:/Windows/System32/cmd.exe'), false);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
  assert.equal(isSafeExternalUrl('https://user:pass@github.com/'), false);
  assert.equal(isSafeExternalUrl(''), false);
});

test('escapeHtml escapes every dangerous character', () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert('x')">&`),
    '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;');
});

test('parseChecksumFile finds a file hash', () => {
  const hash = 'a'.repeat(64);
  const text = [
    `${'b'.repeat(64)}  other.exe`,
    `${hash}  *rblxswap.exe`
  ].join('\n');

  assert.equal(parseChecksumFile(text, 'rblxswap.exe'), hash);
  assert.equal(parseChecksumFile(text, 'rblxswap.EXE'), hash);
  assert.equal(parseChecksumFile(text, 'missing.exe'), null);
});

test('stripControlChars removes control characters and caps length', () => {
  assert.equal(stripControlChars('a\u0000b\u0007c'), 'abc');
  assert.equal(stripControlChars('x'.repeat(5000), 10).length, 10);
});
