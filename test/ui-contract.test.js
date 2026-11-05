'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer', 'main.js'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'src', 'renderer', 'i18n.js'), 'utf8');

function collect(source, pattern) {
  const values = new Set();
  for (const match of source.matchAll(pattern)) values.add(match[1]);
  return values;
}

const htmlIds = collect(html, /\bid="([^"]+)"/g);
const htmlActions = collect(html, /data-action="([^"]+)"/g);
const htmlChanges = collect(html, /data-change="([^"]+)"/g);
const htmlI18nKeys = [
  ...collect(html, /data-i18n="([^"]+)"/g),
  ...collect(html, /data-i18n-title="([^"]+)"/g),
  ...collect(html, /data-i18n-placeholder="([^"]+)"/g)
];

const rendererIds = collect(renderer, /\$\('([^']+)'\)/g);
const actionBlock = renderer.slice(renderer.indexOf('const actions = {'), renderer.indexOf('const changes = {'));
const changesBlock = renderer.slice(renderer.indexOf('const changes = {'), renderer.indexOf('function bindEvents'));
const actionKeys = collect(actionBlock, /^\s*'?([\w-]+)'?\s*:/gm);
const changeKeys = collect(changesBlock, /^\s*'?([\w-]+)'?\s*:/gm);

test('every DOM id used by the renderer exists in index.html', () => {
  const missing = [...rendererIds].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, []);
});

test('every data-action in the HTML has a handler', () => {
  const missing = [...htmlActions].filter((action) => !actionKeys.has(action));
  assert.deepEqual(missing, []);
});

test('every data-change in the HTML has a handler', () => {
  const missing = [...htmlChanges].filter((change) => !changeKeys.has(change));
  assert.deepEqual(missing, []);
});

test('every data-i18n key used in the HTML exists in both dictionaries', () => {
  const missing = [];
  for (const key of htmlI18nKeys) {
    const occurrences = i18n.split(`'${key}':`).length - 1;
    if (occurrences < 2) missing.push(key);
  }
  assert.deepEqual(missing, []);
});

test('the HTML has no inline event handlers or inline scripts (CSP-safe)', () => {
  assert.equal(/\son[a-z]+\s*=\s*"/i.test(html), false, 'inline event handler found');
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, 'inline script found');
});

test('close-modal actions point at real modal ids', () => {
  const targets = collect(html, /data-action="close-modal"\s+data-arg="([^"]+)"/g);
  for (const target of targets) assert.ok(htmlIds.has(target), `missing modal ${target}`);
});
