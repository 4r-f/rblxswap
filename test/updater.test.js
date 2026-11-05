'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  releaseVersion,
  pickAsset,
  assetSha256,
  isAllowedDownloadUrl
} = require('../src/main/updater');

test('releaseVersion prefers tag_name and falls back to the release name', () => {
  assert.equal(releaseVersion({ tag_name: 'v1.2.3' }), 'v1.2.3');
  assert.equal(releaseVersion({ name: 'rblxswap v0.9.0' }), 'v0.9.0');
  assert.equal(releaseVersion({ name: 'no version here' }), null);
  assert.equal(releaseVersion(null), null);
});

test('pickAsset prefers an architecture-matching exe', () => {
  const arch = process.arch;
  const release = {
    assets: [
      { name: 'rblxswap.exe', browser_download_url: 'https://github.com/x/y/releases/download/v1/rblxswap.exe' },
      { name: `rblxswap-${arch}.exe`, browser_download_url: 'https://github.com/x/y/releases/download/v1/rblxswap-arm.exe' },
      { name: 'notes.txt', browser_download_url: 'https://github.com/x/y/releases/download/v1/notes.txt' }
    ]
  };

  assert.equal(pickAsset(release).name, `rblxswap-${arch}.exe`);
  assert.equal(pickAsset({ assets: [{ name: 'notes.txt' }] }), null);
});

test('assetSha256 reads GitHub digests and names with embedded hashes', () => {
  const hash = 'c'.repeat(64);
  assert.equal(assetSha256({ digest: `sha256:${hash}` }), hash);
  assert.equal(assetSha256({ name: `rblxswap-${hash}.exe` }), hash);
  assert.equal(assetSha256({ name: 'rblxswap.exe' }), null);
});

test('isAllowedDownloadUrl only accepts GitHub release hosts over https', () => {
  assert.equal(isAllowedDownloadUrl('https://github.com/o/r/releases/download/v1/rblxswap.exe'), true);
  assert.equal(isAllowedDownloadUrl('https://objects.githubusercontent.com/abc'), true);
  assert.equal(isAllowedDownloadUrl('http://github.com/o/r'), false);
  assert.equal(isAllowedDownloadUrl('https://evil.example.com/rblxswap.exe'), false);
  assert.equal(isAllowedDownloadUrl('file:///C:/rblxswap.exe'), false);
});
