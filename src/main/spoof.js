'use strict';

const hwid = require('../../hwid');
const adapters = require('./adapters');
const { randomMac, isValidMac, normalizeMac } = require('../shared/security');

/**
 * One spoof pipeline shared by the UI and the CLI, so both behave identically.
 */
async function runSpoof({
  config = {},
  options = {},
  log = () => {},
  onProgress = () => {},
  markSpoofed = null
} = {}) {
  const targets = {
    mac: options.targets?.mac !== false,
    hwid: options.targets?.hwid !== false,
    volume: options.targets?.volume === true
  };

  const result = {
    ok: false,
    mac: [],
    hwid: [],
    restorePoint: null,
    needsReboot: false,
    errors: []
  };

  if (!targets.mac && !targets.hwid && !targets.volume) {
    result.errors.push('No spoof targets selected');
    return result;
  }

  if (config.restorePoint) {
    onProgress({ step: 'restore-point', status: 'running' });
    result.restorePoint = await hwid.createSystemRestorePoint('rblxswap pre-spoof');
    log(result.restorePoint.ok ? 'success' : 'warn',
      result.restorePoint.ok ? 'System restore point created' : `Restore point skipped: ${result.restorePoint.message}`);
    onProgress({ step: 'restore-point', status: 'done' });
  }

  try {
    onProgress({ step: 'backup', status: 'running' });
    const backup = await hwid.createBackup({ noVolume: !targets.volume });
    log('info', backup.created ? 'Backup created' : 'Existing backup reused');
    onProgress({ step: 'backup', status: 'done' });
  } catch (error) {
    result.errors.push(`Backup failed: ${error.message}`);
    log('error', `Backup failed: ${error.message}`);
    return result;
  }

  if (targets.mac) {
    onProgress({ step: 'mac', status: 'running' });

    const all = await adapters.listAdapters();
    if (all.length === 0) {
      result.errors.push('No spoofable network adapters found');
      log('error', 'No spoofable network adapters found');
    } else {
      const useAll = options.allAdapters !== false;
      const selected = useAll
        ? all
        : all.filter((adapter) => adapter.guid === options.adapterGuid);

      if (selected.length === 0) {
        result.errors.push('Selected adapter not found');
        log('error', 'Selected adapter not found');
      }

      for (const adapter of selected) {
        const requested = !useAll && options.mac ? normalizeMac(options.mac) : null;
        if (!useAll && options.mac && !isValidMac(options.mac)) {
          result.errors.push('Invalid MAC address');
          log('error', 'Invalid MAC address');
          break;
        }

        const mac = requested || randomMac(adapter.mac, { mirror: options.mirror !== false });
        log('info', `Spoofing ${adapter.name} -> ${mac}`);

        const spoofed = await adapters.spoofAdapter(adapter.guid, mac);
        if (!spoofed.ok) {
          result.errors.push(`${adapter.name}: ${spoofed.error}`);
          log('error', `${adapter.name}: ${spoofed.error}`);
          continue;
        }

        const restarted = await adapters.restartAdapter(adapter.guid);
        if (!restarted.ok) {
          log('warn', `${adapter.name} restart failed: ${restarted.error}`);
        }

        result.mac.push({ name: adapter.name, guid: adapter.guid, mac, restarted: restarted.ok });
        log('success', `${adapter.name} spoofed`);
      }

      if (options.dhcp) {
        const refreshed = await adapters.dhcpRefresh();
        log(refreshed ? 'success' : 'warn', refreshed ? 'DHCP refreshed' : 'DHCP refresh failed');
      }
    }

    onProgress({ step: 'mac', status: 'done' });
  }

  if (targets.hwid || targets.volume) {
    onProgress({ step: 'hwid', status: 'running' });
    log('info', 'Spoofing hardware identifiers');

    const results = await hwid.spoofIdentifiers({
      guids: targets.hwid,
      volume: targets.volume
    });

    for (const entry of results) {
      if (entry.ok) {
        log('success', `${entry.name} -> ${entry.value || 'changed'}`);
        if (entry.reboot) result.needsReboot = true;
      } else {
        log('error', `${entry.name}: ${entry.error || 'failed'}`);
        result.errors.push(`${entry.name}: ${entry.error || 'failed'}`);
      }
    }

    result.hwid = results;
    onProgress({ step: 'hwid', status: 'done' });
  }

  result.ok = result.errors.length === 0
    && (result.mac.length > 0 || result.hwid.some((entry) => entry.ok));

  if (result.ok && typeof markSpoofed === 'function') {
    try {
      markSpoofed();
    } catch (error) {
      // Non-fatal.
    }
  }

  return result;
}

module.exports = { runSpoof };
