'use strict';

const { runPowerShell, runCommand } = require('../shared/powershell');
const { normalizeMac, isValidMac } = require('../shared/security');

const ADAPTER_RE = /WARP|VPN|Virtual|Tap|Teredo|Loopback|ISATAP|Tunnel|WAN Miniport|Kernel Debug/i;
const CLASS_KEY = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e972-e325-11ce-bfc1-08002be10318}';

const LIST_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$class = '${CLASS_KEY}'
$rows = @()
$adapters = @(Get-NetAdapter -Physical | Where-Object { $_.MacAddress -and $_.InterfaceDescription -notmatch $env:ADAPTER_FILTER })
if ($adapters.Count -eq 0) {
  $adapters = @(Get-NetAdapter | Where-Object { $_.MacAddress -and $_.InterfaceDescription -notmatch $env:ADAPTER_FILTER })
}
foreach ($a in $adapters) {
  $reg = $null
  Get-ChildItem $class | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    if ($p.NetCfgInstanceId -eq $a.InterfaceGuid) { $reg = $p }
  }
  $rows += [pscustomobject]@{
    Name = $a.Name
    Description = $a.InterfaceDescription
    Mac = $a.MacAddress
    Guid = $a.InterfaceGuid
    Status = $a.Status
    NetworkAddress = $reg.NetworkAddress
  }
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 3
`;

const FIND_KEY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$class = '${CLASS_KEY}'
$key = Get-ChildItem $class | Where-Object {
  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
  $p.NetCfgInstanceId -eq $env:ADAPTER_GUID
} | Select-Object -First 1
if (-not $key) { Write-Output 'NOT_FOUND'; exit 0 }
$key.PSPath
`;

async function listAdapters() {
  if (process.platform !== 'win32') return [];

  try {
    const { stdout } = await runPowerShell(LIST_SCRIPT, {
      env: { ADAPTER_FILTER: ADAPTER_RE.source },
      timeout: 20_000
    });
    if (!stdout) return [];

    const parsed = JSON.parse(stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];

    return list
      .filter((adapter) => adapter && typeof adapter.Guid === 'string' && adapter.Guid)
      .map((adapter) => ({
        name: adapter.Name,
        description: adapter.Description,
        mac: adapter.Mac,
        guid: adapter.Guid,
        status: adapter.Status,
        networkAddress: adapter.NetworkAddress || null
      }));
  } catch (error) {
    return [];
  }
}

async function findAdapterKey(guid) {
  const { stdout } = await runPowerShell(FIND_KEY_SCRIPT, {
    env: { ADAPTER_GUID: guid },
    timeout: 15_000
  });
  if (!stdout || stdout === 'NOT_FOUND') return null;
  return stdout.split(/\r?\n/).filter(Boolean).pop();
}

async function spoofAdapter(guid, mac) {
  if (!isValidMac(mac)) {
    return { ok: false, error: 'invalid-mac' };
  }
  if (process.platform !== 'win32') {
    return { ok: false, error: 'unsupported-platform' };
  }

  const normalized = normalizeMac(mac);
  const keyPath = await findAdapterKey(guid);
  if (!keyPath) return { ok: false, error: 'adapter-not-found' };

  try {
    await runPowerShell(
      'Set-ItemProperty -Path $env:ADAPTER_KEY -Name NetworkAddress -Value $env:NEW_MAC -ErrorAction Stop; Write-Output "SUCCESS"',
      { env: { ADAPTER_KEY: keyPath, NEW_MAC: normalized.replace(/-/g, '') }, timeout: 20_000 }
    );
    return { ok: true, mac: normalized };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function resetAdapter(guid) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'unsupported-platform' };
  }

  const keyPath = await findAdapterKey(guid);
  if (!keyPath) return { ok: false, error: 'adapter-not-found' };

  try {
    await runPowerShell(
      'Remove-ItemProperty -Path $env:ADAPTER_KEY -Name NetworkAddress -ErrorAction SilentlyContinue; Write-Output "SUCCESS"',
      { env: { ADAPTER_KEY: keyPath }, timeout: 20_000 }
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function restartAdapter(guid) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'unsupported-platform' };
  }

  try {
    const { stdout } = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$adapter = Get-NetAdapter -InterfaceGuid $env:ADAPTER_GUID -ErrorAction Stop
Disable-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction Stop
Start-Sleep -Milliseconds 400
Enable-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction Stop
Start-Sleep -Milliseconds 800
$status = (Get-NetAdapter -Name $adapter.Name).Status
Write-Output ('SUCCESS:' + $status)
`, { env: { ADAPTER_GUID: guid }, timeout: 25_000 });

    const match = stdout.match(/^SUCCESS:(\w+)/);
    if (!match) return { ok: false, error: 'restart-failed' };
    return { ok: true, status: match[1] };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function dhcpRefresh() {
  if (process.platform !== 'win32') return false;

  try {
    await runCommand('ipconfig', ['/release']);
    await runCommand('ipconfig', ['/renew']);
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  listAdapters,
  spoofAdapter,
  resetAdapter,
  restartAdapter,
  dhcpRefresh
};
