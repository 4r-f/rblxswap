'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseVersion, compareVersions, isNewerVersion } = require('../src/shared/version');

test('parseVersion handles v-prefix and prerelease', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: '', raw: 'v1.2.3' });
  assert.equal(parseVersion('1.2').patch, 0);
  assert.equal(parseVersion('1.2.3-beta.1').prerelease, 'beta.1');
  assert.equal(parseVersion('not-a-version'), null);
});

test('compareVersions orders releases correctly', () => {
  assert.equal(compareVersions('0.4.0', '0.3.0'), 1);
  assert.equal(compareVersions('v0.3.0', '0.3.0'), 0);
  assert.equal(compareVersions('0.3.0', '0.4.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta'), 1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
});

test('isNewerVersion is used by the updater', () => {
  assert.equal(isNewerVersion('v0.5.0', '0.4.0'), true);
  assert.equal(isNewerVersion('0.4.0', '0.4.0'), false);
  assert.equal(isNewerVersion('0.3.9', '0.4.0'), false);
});
