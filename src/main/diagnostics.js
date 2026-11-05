'use strict';

const os = require('os');
const path = require('path');

/**
 * Collects everything support needs in one place: versions, paths, elevation,
 * adapters, backup state and the tail of the log.
 */
function createDiagnostics({ app, configStore, logger, hwid, adapters }) {
  async function collect() {
    const config = configStore.get();
    const backup = hwid.backupInfo();

    let elevated = null;
    let adapterList = [];

    if (process.platform === 'win32') {
      elevated = await hwid.isElevated();
      adapterList = await adapters.listAdapters();
    }

    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
      osRelease: os.release(),
      elevated,
      paths: {
        userData: app.getPath('userData'),
        config: configStore.file,
        logs: logger.file,
        backup: hwid.getBackupPath(),
        temp: os.tmpdir()
      },
      config: {
        launcherType: config.launcherType,
        spoofMode: config.spoofMode,
        spoofTargets: config.spoofTargets,
        updates: config.updates,
        language: config.language
      },
      backup: {
        exists: backup.exists,
        savedAt: backup.savedAt || null,
        has: backup.has || null
      },
      adapters: adapterList.map((adapter) => ({
        name: adapter.name,
        description: adapter.description,
        mac: adapter.mac,
        guid: adapter.guid,
        status: adapter.status
      })),
      logTail: logger.tail(80)
    };
  }

  return { collect, paths: { logs: path.dirname(logger.file) } };
}

module.exports = { createDiagnostics };
