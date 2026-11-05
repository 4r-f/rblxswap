'use strict';

const cleaner = require('./cleaner');
const spoof = require('./spoof');
const { isValidMac } = require('../shared/security');

const USAGE = `rblxswap CLI

Usage:
  rblxswap --clean [--dry-run] [--json] [--silent]
  rblxswap --spoof [--no-mac] [--no-hwid] [--volume] [--adapter=<guid>] [--mac=<addr>] [--dhcp] [--json]
  rblxswap --dry-run [--json]

Options:
  --clean            Clean Roblox traces
  --spoof            Spoof identifiers (MAC + HWID by default)
  --dry-run          Only show what would be removed; delete nothing
  --json             Machine-readable output
  --silent           Suppress human-readable logs
  --no-mac           Skip MAC spoofing
  --no-hwid          Skip hardware GUID spoofing
  --volume           Also spoof the disk volume serial (requires admin, reboot)
  --adapter=<guid>   Spoof only this adapter
  --mac=<addr>       Use this MAC (advanced mode)
  --dhcp             Refresh DHCP after MAC spoof
  --no-trash         Permanently delete instead of using the recycle bin
  --help             Show this help
  --version          Print the version
`;

const CLI_FLAGS = new Set([
  '--clean', '--spoof', '--dry-run', '--json', '--silent', '--help', '--version',
  '--no-mac', '--no-hwid', '--volume', '--dhcp', '--no-trash', '--allow-unsigned'
]);

function parseArgs(argv) {
  const args = {
    clean: false,
    spoof: false,
    dryRun: false,
    json: false,
    silent: false,
    help: false,
    version: false,
    mac: true,
    hwid: true,
    volume: false,
    dhcp: false,
    trash: true,
    adapter: null,
    macAddress: null,
    allowUnsigned: false
  };

  for (const raw of argv) {
    if (typeof raw !== 'string' || !raw.startsWith('--')) continue;

    const [flag, value] = raw.split('=');
    switch (flag) {
      case '--clean': args.clean = true; break;
      case '--spoof': args.spoof = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--json': args.json = true; break;
      case '--silent': args.silent = true; break;
      case '--help': args.help = true; break;
      case '--version': args.version = true; break;
      case '--no-mac': args.mac = false; break;
      case '--no-hwid': args.hwid = false; break;
      case '--volume': args.volume = true; break;
      case '--dhcp': args.dhcp = true; break;
      case '--no-trash': args.trash = false; break;
      case '--allow-unsigned': args.allowUnsigned = true; break;
      case '--adapter': args.adapter = value || null; break;
      case '--mac': args.macAddress = value || null; break;
      default: break;
    }
  }

  return args;
}

function isCliRequest(argv) {
  return argv.some((arg) => {
    if (typeof arg !== 'string') return false;
    const flag = arg.split('=')[0];
    return CLI_FLAGS.has(flag);
  });
}

async function runCli({ argv, configStore, logger, version }) {
  const args = parseArgs(argv);
  const out = { ok: true, version };

  const human = (message) => {
    if (!args.json && !args.silent) console.log(message);
  };
  const fail = (message, code = 1) => {
    if (!args.json) console.error(message);
    else console.log(JSON.stringify({ ok: false, error: message }));
    return code;
  };

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (args.version) {
    console.log(version);
    return 0;
  }

  if (process.platform !== 'win32') {
    return fail('rblxswap is Windows-only', 2);
  }

  if (!args.clean && !args.spoof && !args.dryRun) {
    console.log(USAGE);
    return 1;
  }

  const config = configStore.get();

  if (!args.trash) config.useTrash = false;
  if (args.allowUnsigned) {
    configStore.set({ updates: { ...config.updates, allowUnsigned: true } });
  }

  const logs = [];
  const log = (level, message) => {
    logs.push({ level, message });
    if (!args.json && !args.silent) console.log(`[${level}] ${message}`);
    logger.append(level, message);
  };

  try {
    if (args.clean || args.dryRun) {
      const result = await cleaner.runCleanup({
        config,
        weblauncherDir: config.weblauncherDir,
        dryRun: args.dryRun,
        log
      });

      out.clean = {
        dryRun: Boolean(result.dryRun),
        steps: result.plan.steps.length,
        files: result.plan.totals.count,
        bytes: result.plan.totals.bytes,
        warnings: result.plan.warnings,
        removed: result.result?.removedPaths ?? 0,
        failed: result.result?.failed?.length ?? 0
      };

      if (out.clean.failed > 0) out.ok = false;

      if (result.dryRun) {
        for (const step of result.plan.steps) {
          human(`- ${step.label}: ${step.count} file(s), ${step.bytes} byte(s)`);
        }
      }
    }

    if (args.spoof) {
      if (args.macAddress && !isValidMac(args.macAddress)) {
        return fail('Invalid --mac value', 2);
      }

      const result = await spoof.runSpoof({
        config,
        options: {
          targets: { mac: args.mac, hwid: args.hwid, volume: args.volume },
          allAdapters: !args.adapter,
          adapterGuid: args.adapter,
          mac: args.macAddress,
          mirror: true,
          dhcp: args.dhcp
        },
        log,
        markSpoofed: () => configStore.set({ lastSpoofAt: Date.now() })
      });

      out.spoof = {
        ok: result.ok,
        mac: result.mac,
        hwid: result.hwid,
        needsReboot: result.needsReboot,
        errors: result.errors
      };

      if (!result.ok) out.ok = false;
    }
  } catch (error) {
    logger.append('error', error.stack || error.message);
    return fail(error.message, 1);
  }

  if (args.json) {
    console.log(JSON.stringify(out));
  } else {
    human(out.ok ? 'Done.' : 'Completed with errors.');
  }

  return out.ok ? 0 : 1;
}

module.exports = { parseArgs, isCliRequest, runCli, USAGE };
