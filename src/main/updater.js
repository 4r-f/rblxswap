'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const { isNewerVersion } = require('../shared/version');
const { isHex64, parseChecksumFile } = require('../shared/security');
const { runPowerShell } = require('../shared/powershell');
const {
  MAX_UPDATE_BYTES,
  MAX_REDIRECTS,
  HTTP_TIMEOUT_MS,
  APP_NAME
} = require('../shared/constants');

const USER_AGENT = 'rblxswap-updater';
const API_BASE = 'https://api.github.com';
const ALLOWED_DOWNLOAD_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com'
];

function isAllowedDownloadUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return ALLOWED_DOWNLOAD_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch (error) {
    return false;
  }
}

function requestJson(url, { timeout = HTTP_TIMEOUT_MS, maxBytes = 2 * 1024 * 1024, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
      timeout
    }, (response) => {
      const status = response.statusCode || 0;

      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error('Too many redirects'));
          return;
        }
        const next = new URL(response.headers.location, url).toString();
        requestJson(next, { timeout, maxBytes, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }

      if (status !== 200) {
        response.resume();
        const error = new Error(`GitHub API responded with HTTP ${status}`);
        error.status = status;
        reject(error);
        return;
      }

      let received = 0;
      const chunks = [];

      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          request.destroy(new Error('Response too large'));
          return;
        }
        chunks.push(chunk);
      });

      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(new Error('Invalid JSON from GitHub API'));
        }
      });

      response.on('error', reject);
    });

    request.on('timeout', () => request.destroy(new Error('Request timed out')));
    request.on('error', reject);
  });
}

function releaseVersion(release) {
  if (!release || typeof release !== 'object') return null;
  if (typeof release.tag_name === 'string' && release.tag_name.trim()) return release.tag_name.trim();
  if (typeof release.name === 'string') {
    const match = release.name.match(/v?\d+\.\d+\.\d+/);
    if (match) return match[0];
  }
  return null;
}

function pickAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const exes = assets.filter((asset) => typeof asset?.name === 'string' && /\.exe$/i.test(asset.name));
  if (exes.length === 0) return null;

  const arch = process.arch;
  const archMatch = exes.find((asset) => asset.name.toLowerCase().includes(arch.toLowerCase()));
  return archMatch || exes[0];
}

function assetSha256(asset) {
  if (!asset || typeof asset !== 'object') return null;

  if (typeof asset.digest === 'string') {
    const value = asset.digest.replace(/^sha256:/i, '').trim();
    if (isHex64(value)) return value.toLowerCase();
  }

  // Allow a checksum to be embedded in the asset name, e.g. app-<sha256>.exe
  const match = String(asset.name || '').match(/([0-9a-f]{64})/i);
  return match ? match[1].toLowerCase() : null;
}

async function fetchRelease({ repo, channel = 'stable', request = requestJson } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || ''))) {
    throw new Error('Invalid update repository');
  }

  if (channel === 'beta') {
    const releases = await request(`${API_BASE}/repos/${repo}/releases?per_page=20`);
    if (!Array.isArray(releases)) throw new Error('Unexpected release payload');
    const release = releases.find((item) => item && !item.draft);
    if (!release) throw new Error('No releases found');
    return release;
  }

  return request(`${API_BASE}/repos/${repo}/releases/latest`);
}

async function checkForUpdates({
  repo,
  channel = 'stable',
  currentVersion,
  request = requestJson
} = {}) {
  try {
    const release = await fetchRelease({ repo, channel, request });
    const version = releaseVersion(release);

    if (!version) {
      return { error: true, code: 'invalid-release', message: 'Release has no version tag' };
    }

    return {
      updateAvailable: isNewerVersion(version, currentVersion),
      version,
      url: typeof release.html_url === 'string' ? release.html_url : null,
      release
    };
  } catch (error) {
    return {
      error: true,
      code: error.status === 404 ? 'not-found' : error.status === 403 ? 'rate-limited' : 'network',
      message: error.message
    };
  }
}

function downloadToFile(url, destination, { onProgress = () => {}, maxBytes = MAX_UPDATE_BYTES, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (!isAllowedDownloadUrl(url)) {
      reject(new Error('Download URL is not an allowed GitHub release URL'));
      return;
    }

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const request = https.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' },
      timeout: HTTP_TIMEOUT_MS
    }, (response) => {
      const status = response.statusCode || 0;

      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          finish(reject, new Error('Too many redirects'));
          return;
        }
        const next = new URL(response.headers.location, url).toString();
        downloadToFile(next, destination, { onProgress, maxBytes, redirects: redirects + 1 })
          .then((value) => finish(resolve, value), (error) => finish(reject, error));
        return;
      }

      if (status !== 200) {
        response.resume();
        finish(reject, new Error(`Download failed: HTTP ${status}`));
        return;
      }

      const total = parseInt(response.headers['content-length'], 10) || 0;
      if (total > maxBytes) {
        response.resume();
        finish(reject, new Error('Update file is larger than the allowed limit'));
        return;
      }

      let received = 0;
      const file = fs.createWriteStream(destination);

      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          request.destroy(new Error('Update file is larger than the allowed limit'));
          file.destroy();
          return;
        }
        if (total > 0) {
          onProgress({
            percentage: Math.min(100, Math.round((received / total) * 100)),
            downloaded: received,
            total
          });
        }
      });

      file.on('error', (error) => {
        response.destroy();
        fsp.unlink(destination).catch(() => {});
        finish(reject, error);
      });

      file.on('finish', () => {
        file.close(() => finish(resolve, destination));
      });

      response.pipe(file);
      response.on('error', (error) => {
        file.destroy();
        fsp.unlink(destination).catch(() => {});
        finish(reject, error);
      });
    });

    request.on('timeout', () => request.destroy(new Error('Download timed out')));
    request.on('error', (error) => {
      fsp.unlink(destination).catch(() => {});
      finish(reject, error);
    });
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function fetchChecksums(release, { request = requestJson, download = downloadToFile } = {}) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const checksumAsset = assets.find((asset) => /^(sha256sums?|checksums?)(\.txt)?$/i.test(String(asset?.name || '')));
  if (!checksumAsset || !checksumAsset.browser_download_url) return null;

  const destination = path.join(os.tmpdir(), `${APP_NAME}-checksums-${Date.now()}.txt`);
  try {
    await download(checksumAsset.browser_download_url, destination, { maxBytes: 256 * 1024 });
    const text = await fsp.readFile(destination, 'utf8');
    return text;
  } catch (error) {
    return null;
  } finally {
    fsp.unlink(destination).catch(() => {});
  }
}

async function verifyAuthenticode(file, { expectedPublisher = '' } = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'unsupported-platform' };
  }

  try {
    const { stdout } = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$sig = Get-AuthenticodeSignature -FilePath $env:UPDATE_FILE
$subject = ''
if ($sig.SignerCertificate) { $subject = $sig.SignerCertificate.Subject }
[pscustomobject]@{ Status = $sig.Status.ToString(); Subject = $subject } | ConvertTo-Json -Compress
`, { env: { UPDATE_FILE: file }, timeout: 20_000 });

    const parsed = JSON.parse(stdout);
    const status = String(parsed.Status || '');
    const subject = String(parsed.Subject || '');

    if (status !== 'Valid') return { ok: false, reason: `signature-${status || 'invalid'}` };
    if (expectedPublisher && !subject.toLowerCase().includes(expectedPublisher.toLowerCase())) {
      return { ok: false, reason: 'publisher-mismatch', subject };
    }
    return { ok: true, subject };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

/**
 * Downloads and verifies an update.
 *
 * Verification order:
 *   1. asset.digest (GitHub exposes sha256 digests)
 *   2. a SHA256SUMS.txt / checksums.txt release asset
 *   3. Authenticode signature (valid + optional publisher pin)
 *
 * Unsigned updates are rejected unless the user explicitly allowed them.
 */
async function prepareUpdate({
  release,
  allowUnsigned = false,
  expectedPublisher = '',
  onProgress = () => {},
  download = downloadToFile,
  request = requestJson
} = {}) {
  const asset = pickAsset(release);
  if (!asset || !asset.browser_download_url) {
    return { ok: false, error: 'no-exe-asset' };
  }

  const destination = path.join(os.tmpdir(), `${APP_NAME}-update-${Date.now()}.exe`);
  let expectedSha256 = assetSha256(asset);

  if (!expectedSha256) {
    const checksums = await fetchChecksums(release, { request, download });
    if (checksums) expectedSha256 = parseChecksumFile(checksums, asset.name);
  }

  try {
    await download(asset.browser_download_url, destination, {
      onProgress,
      maxBytes: MAX_UPDATE_BYTES
    });
  } catch (error) {
    fsp.unlink(destination).catch(() => {});
    return { ok: false, error: error.message };
  }

  if (expectedSha256) {
    const actual = await sha256File(destination);
    if (actual !== expectedSha256.toLowerCase()) {
      await fsp.unlink(destination).catch(() => {});
      return { ok: false, error: 'checksum-mismatch' };
    }
    return { ok: true, file: destination, sha256: actual, verifiedBy: 'sha256', asset };
  }

  const signature = await verifyAuthenticode(destination, { expectedPublisher });
  if (signature.ok) {
    return { ok: true, file: destination, sha256: await sha256File(destination), verifiedBy: 'authenticode', asset };
  }

  if (!allowUnsigned) {
    await fsp.unlink(destination).catch(() => {});
    return { ok: false, error: 'unverified-update', reason: signature.reason };
  }

  return {
    ok: true,
    file: destination,
    sha256: await sha256File(destination),
    verifiedBy: 'none',
    asset
  };
}

function targetExecutable() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

/**
 * Replaces the running executable after it exits, then relaunches it.
 * Paths are passed through the environment, so no string interpolation reaches
 * PowerShell.
 */
async function applyUpdate(file, { log = () => {} } = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'unsupported-platform' };
  }

  const stats = await fsp.stat(file).catch(() => null);
  if (!stats || !stats.isFile() || stats.size < 1024) {
    return { ok: false, error: 'invalid-update-file' };
  }

  if (!/\.exe$/i.test(file)) {
    return { ok: false, error: 'invalid-extension' };
  }

  const target = targetExecutable();
  const id = `${process.pid}-${Date.now()}`;
  const scriptPath = path.join(os.tmpdir(), `${APP_NAME}-updater-${id}.ps1`);
  const batPath = path.join(os.tmpdir(), `${APP_NAME}-updater-${id}.bat`);

  const script = `
$ErrorActionPreference = 'Stop'
$host.UI.RawUI.WindowTitle = 'rblxswap updater'
Write-Host ''
Write-Host '  rblxswap update helper' -ForegroundColor White
Write-Host ''
$src = $env:UPDATE_SRC
$dst = $env:UPDATE_DST
$attempts = 0
$updated = $false
while ($true) {
  try {
    $stream = [System.IO.File]::Open($dst, 'Open', 'ReadWrite', 'None')
    $stream.Close()
    $stream.Dispose()
    Write-Host '  Applying update...' -ForegroundColor Yellow
    Copy-Item -Path $src -Destination $dst -Force -ErrorAction Stop
    $sourceHash = (Get-FileHash -Path $src -Algorithm SHA256).Hash
    $targetHash = (Get-FileHash -Path $dst -Algorithm SHA256).Hash
    if ($sourceHash -ne $targetHash) { throw 'Hash mismatch after copy' }
    Remove-Item -Path $src -Force -ErrorAction SilentlyContinue
    $updated = $true
    break
  } catch {
    $attempts++
    if ($attempts -ge 60) {
      Write-Host '  Timed out waiting for rblxswap to close.' -ForegroundColor Red
      break
    }
    Start-Sleep -Milliseconds 300
  }
}
if ($updated) { Write-Host '  Update applied!' -ForegroundColor Green }
Write-Host '  Launching rblxswap...' -ForegroundColor Gray
Start-Process -FilePath $dst
Start-Sleep -Seconds 8
`;

  const bat = `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"\r\n`;

  await fsp.writeFile(scriptPath, script, 'utf8');
  await fsp.writeFile(batPath, bat, 'utf8');

  const { spawn } = require('child_process');
  const child = spawn('cmd.exe', ['/c', batPath], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      UPDATE_SRC: file,
      UPDATE_DST: target
    }
  });
  child.unref();

  log('info', `Update helper started for ${path.basename(target)}`);
  return { ok: true, target };
}

module.exports = {
  isAllowedDownloadUrl,
  releaseVersion,
  pickAsset,
  assetSha256,
  checkForUpdates,
  downloadToFile,
  sha256File,
  fetchChecksums,
  verifyAuthenticode,
  prepareUpdate,
  applyUpdate,
  targetExecutable
};
