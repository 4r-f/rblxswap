'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = new Set(['debug', 'info', 'success', 'warn', 'error']);

/**
 * Tiny rotating file logger. The app used to lose all diagnostics because
 * nothing was written to disk.
 */
function createLogger({ dir, filename = 'main.log', maxBytes = 5 * 1024 * 1024, maxFiles = 3, mirrorToConsole = false } = {}) {
  const file = path.join(dir, filename);
  let queue = Promise.resolve();

  function rotateIfNeeded(incoming) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch (error) {
      size = 0;
    }
    if (size + incoming <= maxBytes) return;

    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const from = index === 1 ? file : `${file}.${index - 1}`;
      const to = `${file}.${index}`;
      try {
        fs.renameSync(from, to);
      } catch (error) {
        // A missing rotation target is fine.
      }
    }
  }

  function append(level, message) {
    const normalized = LEVELS.has(level) ? level : 'info';
    const line = `${new Date().toISOString()} [${normalized}] ${String(message).replace(/\r?\n/g, ' ')}\n`;

    if (mirrorToConsole) {
      const sink = normalized === 'error' || normalized === 'warn' ? console.error : console.log;
      sink(line.trimEnd());
    }

    queue = queue.then(async () => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        rotateIfNeeded(Buffer.byteLength(line));
        fs.appendFileSync(file, line, 'utf8');
      } catch (error) {
        // Logging must never crash the app.
      }
    });

    return line;
  }

  function tail(maxLines = 200) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      return content.split(/\r?\n/).filter(Boolean).slice(-maxLines);
    } catch (error) {
      return [];
    }
  }

  return { append, tail, file, dir };
}

module.exports = { createLogger };
