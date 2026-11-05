'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { runPowerShell, runCommand } = require('./src/shared/powershell');
const { atomicWriteJson, readJsonSync } = require('./src/shared/fs-utils');
const { isHex64 } = require('./src/shared/security');
const { REGISTRY_PURGE_KEYS } = require('./src/shared/constants');
const adapterService = require('./src/main/adapters');

const IDENTIFIERS = {
  machineGuid: {
    hive: 'HKLM',
    key: 'SOFTWARE\\Microsoft\\Cryptography',
    value: 'MachineGuid',
    braces: false,
    upper: false
  },
  hwProfileGuid: {
    hive: 'HKLM',
    key: 'SYSTEM\\CurrentControlSet\\Control\\IDConfigDB\\Hardware Profiles\\0001',
    value: 'HwProfileGuid',
    braces: true,
    upper: true
  },
  machineId: {
    hive: 'HKLM',
    key: 'SOFTWARE\\Microsoft\\SQMClient',
    value: 'MachineId',
    braces: true,
    upper: true
  }
};

const GUID_RE = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;
const SYSTEM_DRIVE = (process.env.SystemDrive || 'C:').replace(/[\\/]+$/, '').toUpperCase();
const BACKUP_SCHEMA = 2;

function getExecutionDir() {
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath) || __dirname;
}

function getBackupPath() {
  if (process.env.RBLXSWAP_BACKUP_DIR) {
    return path.join(process.env.RBLXSWAP_BACKUP_DIR, 'backup.json');
  }

  const primary = path.join(getExecutionDir(), 'backup.json');
  try {
    fs.accessSync(path.dirname(primary), fs.constants.W_OK);
    return primary;
  } catch (error) {
    const fallbackDir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'rblxswap');
    return path.join(fallbackDir, 'backup.json');
  }
}

async function isElevated() {
  if (process.platform !== 'win32') return false;

  try {
    await runCommand('net', ['session']);
    return true;
  } catch (error) {
    return false;
  }
}

function backupExists() {
  return fs.existsSync(getBackupPath());
}

function generateGuid({ braces = false, upper = false } = {}) {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1

  const hex = bytes.toString('hex');
  let guid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (upper) guid = guid.toUpperCase();
  return braces ? `{${guid}}` : guid;
}

function isValidGuid(value) {
  return typeof value === 'string' && GUID_RE.test(value.trim());
}

async function regRead(hive, key, value) {
  try {
    const { stdout } = await runCommand('reg', ['query', `${hive}\\${key}`, '/v', value]);
    const match = stdout.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, 'i'));
    return match ? match[1].trim() : null;
  } catch (error) {
    return null;
  }
}

async function regWrite(hive, key, value, data) {
  await runCommand('reg', ['add', `${hive}\\${key}`, '/v', value, '/t', 'REG_SZ', '/d', data, '/f']);

  // Verify the write instead of trusting reg.exe's exit code.
  const written = await regRead(hive, key, value);
  if (written !== data) {
    throw new Error(`registry verification failed for ${value}`);
  }
}

async function regDeleteKey(hive, key) {
  try {
    await runCommand('reg', ['delete', `${hive}\\${key}`, '/f']);
    return true;
  } catch (error) {
    return false;
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function rawVolumePath(drive) {
  return `\\\\.\\${String(drive).replace(/:$/, '')}:`;
}

function volumeLetter(drive) {
  return String(drive).replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 1);
}

/** Boot-sector metadata + BitLocker state. */
async function getVolumeInfo(drive = SYSTEM_DRIVE) {
  if (process.platform !== 'win32') {
    return { drive, bytesPerSector: 512, bitlocker: 'Unknown', serial: null };
  }

  try {
    const { stdout } = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$letter = $env:DRIVE_LETTER
$partition = Get-Partition -DriveLetter $letter -ErrorAction Stop
$disk = Get-Disk -Number $partition.DiskNumber -ErrorAction Stop
$bitlocker = 'Unknown'
try {
  $bl = Get-BitLockerVolume -MountPoint ($letter + ':') -ErrorAction Stop
  $bitlocker = $bl.ProtectionStatus.ToString()
} catch { }
$serial = (Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $letter + ":'")).VolumeSerialNumber
[pscustomobject]@{
  BytesPerSector = [int]$disk.LogicalSectorSize
  BitLocker = $bitlocker
  Serial = $serial
} | ConvertTo-Json -Compress
`, { env: { DRIVE_LETTER: volumeLetter(drive) }, timeout: 20_000 });

    const parsed = JSON.parse(stdout);
    const bytesPerSector = Number(parsed.BytesPerSector) || 512;
    const serial = String(parsed.Serial || '').toUpperCase();
    return {
      drive,
      bytesPerSector,
      bitlocker: String(parsed.BitLocker || 'Unknown'),
      serial: /^[0-9A-F]{8}$/.test(serial) ? `${serial.slice(0, 4)}-${serial.slice(4)}` : null
    };
  } catch (error) {
    return { drive, bytesPerSector: 512, bitlocker: 'Unknown', serial: null, error: error.message };
  }
}

/**
 * Reads a full physical sector. The old code always assumed 512 bytes, which is
 * wrong on 4Kn drives.
 */
async function readSector(drive = SYSTEM_DRIVE, bytesPerSector = 512) {
  const size = Number(bytesPerSector) === 4096 ? 4096 : 512;

  const { stdout } = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$path = $env:VOLUME_PATH
$size = [int]$env:SECTOR_SIZE
$fs = New-Object System.IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  $buf = New-Object byte[] $size
  $total = 0
  while ($total -lt $size) {
    $n = $fs.Read($buf, $total, $size - $total)
    if ($n -le 0) { break }
    $total += $n
  }
  if ($total -lt $size) { throw 'short read' }
  [Convert]::ToBase64String($buf)
} finally {
  $fs.Close()
}
`, { env: { VOLUME_PATH: rawVolumePath(drive), SECTOR_SIZE: String(size) }, timeout: 20_000 });

  const buffer = Buffer.from(stdout.replace(/\s+/g, ''), 'base64');
  if (buffer.length !== size) throw new Error('short read');
  return buffer;
}

function vsnOffset(sector) {
  if (!Buffer.isBuffer(sector) || sector.length < 512) return null;
  if (sector.toString('ascii', 3, 7) === 'NTFS') return 0x48;
  if (sector.toString('ascii', 0x52, 0x57) === 'FAT32') return 0x43;
  if (sector.toString('ascii', 0x36, 0x39) === 'FAT') return 0x27;
  return null;
}

function isBootSector(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 512
    && buffer[510] === 0x55
    && buffer[511] === 0xaa
    && vsnOffset(buffer) !== null;
}

function generateVolumeSerial() {
  const hex = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

async function readVolumeSerial(drive = SYSTEM_DRIVE) {
  const info = await getVolumeInfo(drive);
  return info.serial;
}

/**
 * Writes exactly one sector back. Tries FSCTL_LOCK_VOLUME first, then verifies
 * the write by reading the VSN field back from the same handle.
 */
async function writeSector(drive, buffer, bytesPerSector = 512) {
  const size = Number(bytesPerSector) === 4096 ? 4096 : 512;
  if (!Buffer.isBuffer(buffer) || buffer.length !== size) {
    throw new Error(`refusing to write a non-${size}-byte sector`);
  }
  if (!isBootSector(buffer)) {
    throw new Error('refusing to write a buffer that is not a boot sector');
  }

  const offset = vsnOffset(buffer);
  const expected = buffer.subarray(offset, offset + 4).toString('hex');
  const base64 = buffer.toString('base64');

  const { stdout } = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$path = $env:VOLUME_PATH
$size = [int]$env:SECTOR_SIZE
$bytes = [Convert]::FromBase64String($env:SECTOR_B64)
if ($bytes.Length -ne $size) { throw 'decoded sector size mismatch' }

$locked = $false
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class RblxVolume {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool DeviceIoControl(IntPtr handle, uint code, IntPtr inBuf, int inSize, IntPtr outBuf, int outSize, out int returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr handle);
}
"@ -ErrorAction Stop

  $handle = [RblxVolume]::CreateFileW($path, 0xC0000000, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($handle.ToInt64() -ne -1 -and $handle.ToInt64() -ne 0) {
    $returned = 0
    $locked = [RblxVolume]::DeviceIoControl($handle, 0x00090018, [IntPtr]::Zero, 0, [IntPtr]::Zero, 0, [ref]$returned, [IntPtr]::Zero)
    [void][RblxVolume]::CloseHandle($handle)
  }
} catch { $locked = $false }

$fs = New-Object System.IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
try {
  $fs.Seek(0, [IO.SeekOrigin]::Begin) | Out-Null
  $fs.Write($bytes, 0, $size)
  $fs.Flush($true)

  $fs.Seek(0, [IO.SeekOrigin]::Begin) | Out-Null
  $check = New-Object byte[] $size
  $read = 0
  while ($read -lt $size) {
    $n = $fs.Read($check, $read, $size - $read)
    if ($n -le 0) { break }
    $read += $n
  }
  $expected = $env:EXPECTED_HEX
  $actual = ([BitConverter]::ToString($check, [int]$env:VSN_OFFSET, 4)).Replace('-', '').ToLowerInvariant()
  $verified = ($actual -eq $expected)
} finally {
  $fs.Close()
}

[pscustomobject]@{ Locked = $locked; Verified = $verified } | ConvertTo-Json -Compress
`, {
    env: {
      VOLUME_PATH: rawVolumePath(drive),
      SECTOR_SIZE: String(size),
      SECTOR_B64: base64,
      EXPECTED_HEX: expected,
      VSN_OFFSET: String(offset)
    },
    timeout: 30_000
  });

  const parsed = JSON.parse(stdout);
  return { locked: Boolean(parsed.Locked), verified: Boolean(parsed.Verified) };
}

async function readVolumeBackup(drive = SYSTEM_DRIVE) {
  const info = await getVolumeInfo(drive);
  const entry = {
    drive,
    serial: info.serial,
    bytesPerSector: info.bytesPerSector,
    bitlocker: info.bitlocker,
    sector: null,
    sectorHash: null,
    offset: null
  };

  try {
    const buffer = await readSector(drive, info.bytesPerSector);
    if (isBootSector(buffer)) {
      entry.sector = buffer.toString('base64');
      entry.sectorHash = sha256(buffer);
      entry.offset = vsnOffset(buffer);
    }
  } catch (error) {
    entry.error = error.message;
  }

  return entry;
}

async function spoofVolumeSerial(drive = SYSTEM_DRIVE, { allowBitLocker = false } = {}) {
  try {
    const info = await getVolumeInfo(drive);
    if (/on/i.test(info.bitlocker) && !allowBitLocker) {
      return { drive, ok: false, error: 'BitLocker is enabled; refusing to modify the boot sector' };
    }

    const buffer = await readSector(drive, info.bytesPerSector);
    if (!isBootSector(buffer)) {
      return { drive, ok: false, error: 'not a valid boot sector (run as administrator?)' };
    }

    const serial = generateVolumeSerial();
    buffer.writeUInt32LE(parseInt(serial.replace('-', ''), 16) >>> 0, vsnOffset(buffer));

    const write = await writeSector(drive, buffer, info.bytesPerSector);
    if (!write.verified) {
      return { drive, ok: false, error: 'write verification failed; reboot may still apply it' };
    }

    return { drive, ok: true, serial, reboot: true, locked: write.locked, bytesPerSector: info.bytesPerSector };
  } catch (error) {
    return { drive, ok: false, error: error.message };
  }
}

async function restoreVolumeSerial(entry) {
  if (!entry || !entry.sector) {
    return { drive: entry?.drive, restored: false, reason: 'no-sector' };
  }

  const buffer = Buffer.from(String(entry.sector).replace(/\s+/g, ''), 'base64');
  if (!isBootSector(buffer)) {
    return { drive: entry.drive, restored: false, reason: 'backup is not a valid boot sector' };
  }

  if (!entry.sectorHash || !isHex64(entry.sectorHash) || sha256(buffer) !== entry.sectorHash) {
    return { drive: entry.drive, restored: false, reason: 'integrity check failed; backup not written' };
  }

  try {
    const size = Number(entry.bytesPerSector) === 4096 ? 4096 : 512;
    const write = await writeSector(entry.drive, buffer, size);
    if (!write.verified) {
      return { drive: entry.drive, restored: false, reason: 'write verification failed' };
    }
    return { drive: entry.drive, restored: true, reboot: true, locked: write.locked };
  } catch (error) {
    return { drive: entry.drive, restored: false, reason: error.message };
  }
}

/**
 * Creates a System Restore point and restores the previous throttle value
 * instead of permanently setting it to zero.
 */
async function createSystemRestorePoint(description = 'rblxswap pre-spoof') {
  if (process.platform !== 'win32') {
    return { ok: false, message: 'Windows only' };
  }

  try {
    const { stdout } = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$key = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore'
$previous = $null
try { $previous = (Get-ItemProperty -Path $key -Name SystemRestorePointCreationFrequency -ErrorAction Stop).SystemRestorePointCreationFrequency } catch { }
$hadPrevious = ($null -ne $previous)
try {
  Enable-ComputerRestore -Drive ($env:SystemDrive + '\\') -ErrorAction SilentlyContinue
  New-ItemProperty -Path $key -Name SystemRestorePointCreationFrequency -Value 0 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null
  Checkpoint-Computer -Description $env:RESTORE_DESC -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop
  Write-Output 'OK'
} catch {
  Write-Output ('ERR: ' + $_.Exception.Message)
} finally {
  if ($hadPrevious) {
    New-ItemProperty -Path $key -Name SystemRestorePointCreationFrequency -Value $previous -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null
  } else {
    Remove-ItemProperty -Path $key -Name SystemRestorePointCreationFrequency -ErrorAction SilentlyContinue
  }
}
`, { env: { RESTORE_DESC: String(description).slice(0, 200) }, timeout: 90_000 });

    if (stdout.startsWith('OK')) return { ok: true };
    return { ok: false, message: stdout.replace(/^ERR:\s*/, '') || 'System Restore unavailable' };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

async function createBackup({ noVolume = false, ensureVolume = false } = {}) {
  if (backupExists()) {
    const existing = readBackup();
    if (!existing) {
      throw new Error('backup.json exists but is unreadable; fix or remove it before spoofing');
    }

    // A GUID-only spoof may have created a backup without the boot sector.
    // Upgrade it before the first volume write so restore stays possible.
    if (ensureVolume && !noVolume && !existing.volume?.sector) {
      existing.volume = await readVolumeBackup();
      await atomicWriteJson(getBackupPath(), existing);
      return { created: false, upgraded: true, snapshot: existing };
    }

    return { created: false, snapshot: existing };
  }

  const snapshot = {
    schema: BACKUP_SCHEMA,
    savedAt: new Date().toISOString(),
    identifiers: {},
    adapters: await adapterService.listAdapters(),
    volume: noVolume ? null : await readVolumeBackup()
  };

  for (const [name, spec] of Object.entries(IDENTIFIERS)) {
    snapshot.identifiers[name] = await regRead(spec.hive, spec.key, spec.value);
  }

  await atomicWriteJson(getBackupPath(), snapshot);
  return { created: true, snapshot };
}

function readBackup() {
  const data = readJsonSync(getBackupPath(), null);
  if (!data || typeof data !== 'object') return null;

  return {
    schema: Number(data.schema) || 1,
    savedAt: data.savedAt || null,
    identifiers: data.identifiers && typeof data.identifiers === 'object' ? data.identifiers : {},
    adapters: Array.isArray(data.adapters) ? data.adapters : [],
    volume: data.volume && typeof data.volume === 'object' ? data.volume : null
  };
}

function backupInfo() {
  const backup = readBackup();
  if (!backup) return { exists: false };

  return {
    exists: true,
    savedAt: backup.savedAt,
    has: {
      guids: Object.values(backup.identifiers || {}).some(isValidGuid),
      mac: (backup.adapters || []).length > 0,
      volume: Boolean(backup.volume && backup.volume.sector)
    },
    serials: {
      machineGuid: backup.identifiers?.machineGuid || null,
      volume: backup.volume?.serial || null
    }
  };
}

async function spoofIdentifiers(opts = {}) {
  const guids = opts.guids !== false;
  const volume = opts.volume === true;
  await createBackup({ noVolume: !volume, ensureVolume: volume });

  const results = [];

  if (guids) {
    for (const [name, spec] of Object.entries(IDENTIFIERS)) {
      const fresh = generateGuid({ braces: spec.braces, upper: spec.upper });
      try {
        await regWrite(spec.hive, spec.key, spec.value, fresh);
        results.push({ name, value: fresh, ok: true });
      } catch (error) {
        results.push({ name, value: fresh, ok: false, error: error.message });
      }
    }
  }

  if (volume) {
    const outcome = await spoofVolumeSerial();
    results.push({
      name: 'volumeSerial',
      value: outcome.serial || null,
      ok: outcome.ok,
      error: outcome.error,
      reboot: outcome.reboot
    });
  }

  return results;
}

async function restoreIdentifiers(opts = {}) {
  const backup = readBackup();
  if (!backup) return { ok: false, reason: 'no-backup' };

  const info = backupInfo();
  const guids = opts.guids !== false;
  const mac = opts.mac !== false;
  const volume = opts.volume !== false;

  const results = { identifiers: [], adapters: [], errors: [] };

  if (guids) {
    for (const [name, spec] of Object.entries(IDENTIFIERS)) {
      const original = backup.identifiers?.[name];
      if (!isValidGuid(original)) {
        results.identifiers.push({ name, restored: false, reason: 'missing-or-invalid' });
        continue;
      }
      try {
        await regWrite(spec.hive, spec.key, spec.value, original);
        results.identifiers.push({ name, restored: true });
      } catch (error) {
        results.identifiers.push({ name, restored: false, reason: error.message });
        results.errors.push(`${name}: ${error.message}`);
      }
    }
  }

  if (mac) {
    for (const adapter of backup.adapters || []) {
      try {
        let guid = adapter.guid || adapter.Guid;

        // Backups created before 0.4 only stored the adapter description.
        if (!guid) {
          const list = await adapterService.listAdapters();
          const description = adapter.Desc || adapter.description;
          const match = list.find((entry) => (
            (description && entry.description === description)
            || (adapter.Name && entry.name === adapter.Name)
          ));
          guid = match?.guid || null;
        }

        if (!guid) {
          results.adapters.push({ name: adapter.name || adapter.Name, restored: false, reason: 'missing-guid' });
          continue;
        }

        const networkAddress = adapter.networkAddress || adapter.NetworkAddress || null;
        const outcome = networkAddress
          ? await adapterService.spoofAdapter(guid, networkAddress)
          : await adapterService.resetAdapter(guid);

        if (!outcome.ok) {
          results.adapters.push({ name: adapter.name || adapter.Name, restored: false, reason: outcome.error });
          results.errors.push(`${adapter.name || adapter.Name}: ${outcome.error}`);
          continue;
        }

        await adapterService.restartAdapter(guid);
        results.adapters.push({ name: adapter.name || adapter.Name, restored: true });
      } catch (error) {
        results.adapters.push({ name: adapter.name || adapter.Name, restored: false, reason: error.message });
        results.errors.push(`${adapter.name || adapter.Name}: ${error.message}`);
      }
    }
  }

  if (volume && backup.volume) {
    results.volume = await restoreVolumeSerial(backup.volume);
    if (results.volume.restored === false && results.volume.reason && results.volume.reason !== 'no-sector') {
      results.errors.push(`volume ${results.volume.drive}: ${results.volume.reason}`);
    }
  }

  const coveredEverything =
    (guids || !info.has.guids) &&
    (mac || !info.has.mac) &&
    (volume || !info.has.volume);

  const ok = results.errors.length === 0;
  if (ok && coveredEverything) {
    try {
      await fsp.unlink(getBackupPath());
    } catch (error) {
      // Keep the backup if it cannot be removed.
    }
  }

  return { ok, coveredEverything, ...results };
}

async function detectAnticheats() {
  if (process.platform !== 'win32') return [];

  let running = { services: [], processes: [] };
  try {
    const { stdout } = await runPowerShell(`
$svc = @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Running' } | Select-Object -ExpandProperty Name)
$proc = @(Get-Process -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
ConvertTo-Json -Compress @{ services = $svc; processes = $proc }
`, { timeout: 25_000 });

    if (stdout) {
      const parsed = JSON.parse(stdout);
      running.services = (parsed.services || []).map((name) => String(name).toLowerCase());
      running.processes = (parsed.processes || []).map((name) => String(name).toLowerCase());
    }
  } catch (error) {
    return [];
  }

  const antiCheats = [
    { name: 'Riot Vanguard', services: ['vgc', 'vgk'], processes: ['vgc', 'vgtray'] },
    { name: 'FACEIT AC', services: ['faceit', 'faceitac'], processes: ['faceitclient', 'faceit'] },
    { name: 'EasyAntiCheat', services: ['easyanticheat', 'easyanticheat_eos'], processes: ['easyanticheat'] },
    { name: 'BattlEye', services: ['beservice', 'bedaisy'], processes: ['beservice'] },
    { name: 'ESEA', services: ['eseaclient'], processes: ['eseaclient'] }
  ];

  const detected = [];
  for (const antiCheat of antiCheats) {
    const service = antiCheat.services.find((name) => running.services.includes(name));
    const process = antiCheat.processes.find((name) => running.processes.includes(name));
    if (service || process) {
      detected.push({
        name: antiCheat.name,
        service: service || null,
        steps: [
          { t: `Close ${antiCheat.name} before spoofing. It watches hardware identifiers.` },
          { t: 'If it runs as a service, stop it from an elevated terminal:' },
          { c: `sc stop ${service || antiCheat.services[0]}` }
        ]
      });
    }
  }

  return detected;
}

async function clearDirFiles(dir, out) {
  let count = 0;
  let entries;

  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    return 0;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) count += await clearDirFiles(full, out);
      else {
        await fsp.unlink(full);
        count += 1;
      }
    } catch (error) {
      out.errors.push(`${full}: ${error.message}`);
    }
  }

  return count;
}

async function purgeRobloxTraces() {
  const out = { files: 0, dirs: 0, registry: [], errors: [] };
  const userProfile = process.env.USERPROFILE;

  if (!userProfile) {
    out.errors.push('USERPROFILE missing');
    return out;
  }

  const robloxLocal = path.join(userProfile, 'AppData', 'Local', 'Roblox');
  const targets = [
    path.join(robloxLocal, 'LocalStorage'),
    path.join(robloxLocal, 'logs')
  ];

  for (const dir of targets) {
    const relative = path.relative(robloxLocal, dir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    out.files += await clearDirFiles(dir, out);
  }

  for (const key of REGISTRY_PURGE_KEYS) {
    const deleted = await regDeleteKey('HKCU', key);
    out.registry.push({ key: `HKCU\\${key}`, deleted });
  }

  return out;
}

module.exports = {
  getBackupPath,
  backupExists,
  isElevated,
  generateGuid,
  isValidGuid,
  generateVolumeSerial,
  readVolumeSerial,
  getVolumeInfo,
  readSector,
  writeSector,
  isBootSector,
  vsnOffset,
  spoofVolumeSerial,
  restoreVolumeSerial,
  createBackup,
  createSystemRestorePoint,
  detectAnticheats,
  readBackup,
  backupInfo,
  spoofIdentifiers,
  restoreIdentifiers,
  purgeRobloxTraces,
  IDENTIFIERS
};
