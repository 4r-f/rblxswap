'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateGuid,
  isValidGuid,
  vsnOffset,
  isBootSector,
  generateVolumeSerial
} = require('../hwid');

function bootSector(fsTag, tagOffset) {
  const buffer = Buffer.alloc(512);
  buffer.write(fsTag, tagOffset, 'ascii');
  buffer[510] = 0x55;
  buffer[511] = 0xaa;
  return buffer;
}

test('generateGuid creates RFC-4122 v4 GUIDs with the right formatting', () => {
  const lower = generateGuid();
  const upper = generateGuid({ braces: true, upper: true });

  assert.match(lower, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(upper, /^\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/);
  assert.equal(isValidGuid(lower), true);
  assert.equal(isValidGuid(upper), true);
  assert.equal(isValidGuid('nope'), false);
  assert.notEqual(generateGuid(), generateGuid());
});

test('vsnOffset detects NTFS, FAT32 and FAT boot sectors', () => {
  assert.equal(vsnOffset(bootSector('NTFS', 3)), 0x48);
  assert.equal(vsnOffset(bootSector('FAT32', 0x52)), 0x43);
  assert.equal(vsnOffset(bootSector('FAT', 0x36)), 0x27);
  assert.equal(vsnOffset(Buffer.alloc(512)), null);
  assert.equal(vsnOffset(Buffer.alloc(100)), null);
});

test('isBootSector requires the 0x55AA signature and a known filesystem', () => {
  assert.equal(isBootSector(bootSector('NTFS', 3)), true);
  assert.equal(isBootSector(bootSector('FAT32', 0x52)), true);

  const noSignature = bootSector('NTFS', 3);
  noSignature[510] = 0;
  assert.equal(isBootSector(noSignature), false);

  const unknownFs = Buffer.alloc(512);
  unknownFs[510] = 0x55;
  unknownFs[511] = 0xaa;
  assert.equal(isBootSector(unknownFs), false);

  assert.equal(isBootSector(null), false);
  assert.equal(isBootSector(Buffer.alloc(511)), false);
});

test('generateVolumeSerial matches XXXX-XXXX', () => {
  const serial = generateVolumeSerial();
  assert.match(serial, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
});
