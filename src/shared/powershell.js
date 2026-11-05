'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/**
 * Runs a PowerShell snippet with values passed through the environment.
 *
 * Why env vars: the old code interpolated user-controlled strings (MAC address,
 * adapter description) directly into the script, which made command injection
 * trivial. Environment variables are data, never code.
 */
async function runPowerShell(script, { env = {}, timeout = 30_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('PowerShell is only available on Windows');
  }

  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      env: { ...process.env, ...env },
      timeout,
      maxBuffer,
      windowsHide: true
    }
  );

  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function runCommand(command, args = [], { timeout = 30_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout,
    maxBuffer,
    windowsHide: true
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

module.exports = { runPowerShell, runCommand };
