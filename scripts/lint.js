'use strict';

/**
 * Zero-dependency lint:
 *  - syntax-checks every JS/MJS file with `node --check`
 *  - forbids inline event handlers / inline scripts (CSP)
 *  - forbids eval/new Function
 *  - forbids weakening Electron security flags
 *  - forbids plain http:// URLs in app code
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const errors = [];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = [
  path.join(root, 'main.js'),
  path.join(root, 'hwid.js'),
  path.join(root, 'preload.js'),
  path.join(root, 'preload-toast.js'),
  ...walk(path.join(root, 'src')),
  ...walk(path.join(root, 'test')),
  ...walk(path.join(root, 'scripts'))
].filter((file) => /\.(js|mjs)$/.test(file));

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    errors.push(`${path.relative(root, file)}: syntax error\n${error.stderr?.toString() || error.message}`);
  }
}

const htmlPath = path.join(root, 'src', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

if (/\son[a-z]+\s*=\s*"/i.test(html)) errors.push('src/index.html: inline event handler found (CSP)');
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) errors.push('src/index.html: inline script found (CSP)');
for (const match of html.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
  if (!match[0].startsWith('https://') && !match[0].includes('www.w3.org')) {
    errors.push(`src/index.html: insecure URL ${match[0]}`);
  }
}

const codeFiles = files.filter((file) => !file.includes(`${path.sep}test${path.sep}`) && path.basename(file) !== 'lint.js');
for (const file of codeFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const name = path.relative(root, file);

  if (/\beval\s*\(/.test(source)) errors.push(`${name}: eval() is forbidden`);
  if (/\bnew\s+Function\s*\(/.test(source)) errors.push(`${name}: new Function() is forbidden`);
  if (/nodeIntegration\s*:\s*true/.test(source)) errors.push(`${name}: nodeIntegration must stay false`);
  if (/contextIsolation\s*:\s*false/.test(source)) errors.push(`${name}: contextIsolation must stay true`);
  if (/sandbox\s*:\s*false/.test(source)) errors.push(`${name}: sandbox must stay enabled`);
  if (/(["'`])http:\/\//.test(source)) errors.push(`${name}: plain http:// URL found`);
}

if (errors.length) {
  console.error(`lint failed (${errors.length} issue(s)):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`lint ok: ${files.length} files checked`);
