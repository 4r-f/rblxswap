<div align="center">
  <img src="assets/rblxswap_banner.png" alt="rblxswap banner"/>
</div>

---

<p align="center">
  A Windows utility that cleans Roblox traces and rotates device identifiers<br/>
  so the next session is not linked to the previous one.
</p>

---

> **Use at your own risk.** Automating ban evasion violates Roblox's Terms of Use and may violate local law. This project is published for research and personal use only.

## What it does

| Area | What happens |
|---|---|
| **Trace cleanup** | Kills Roblox processes, removes version folders, launcher caches, `%TEMP%` caches, Roaming logs/HTTP cache, Prefetch entries, `HKCU\Software\ROBLOX Corporation`, ProgramData files and (optionally) local auth tokens. |
| **MAC spoof** | Writes a new `NetworkAddress` registry value per adapter (OUI mirror or fully random), restarts the adapter and optionally refreshes DHCP. |
| **HWID spoof** | Regenerates `MachineGuid`, `HwProfileGuid` and `MachineId` as valid RFC-4122 v4 GUIDs. |
| **Volume serial** | Optionally patches the VSN field in the boot sector (512e and 4Kn aware, BitLocker aware, hash-verified backup). |
| **Backup / restore** | Everything is snapshotted to `backup.json` before the first write; selective restore from the UI. |

## What's new in v0.4

- **Dry-run preview**: nothing is deleted before you see the file count, size, admin requirements and warnings.
- **Safer deletes**: recycle bin support, strict temp-folder allow-list, marker check for the WebLauncher folder.
- **Hardened updater**: HTTP status/timeout handling, redirect limit, size cap, SHA-256 (`SHA256SUMS.txt`) or Authenticode verification, unsigned updates rejected by default.
- **Security fixes**: no inline event handlers, strict CSP, URL allow-list for external links, no PowerShell string interpolation, `sandbox: true`, single-instance lock, permission handler that denies everything.
- **Safer HWID**: 4Kn sector support, BitLocker refusal, read-back verification, atomic `backup.json`, restore-point throttle restored after use.
- **Quality**: modular main process (`src/main/*`), 36 unit tests (`node --test`), custom lint, GitHub Actions CI, CLI mode, profiles, diagnostics, EN/TR UI.

## Requirements

- Windows 10/11 (x64)
- Administrator rights (MAC/HWID/Prefetch/ProgramData need elevation)
- Node.js 20+ only for building from source

## Usage

1. Download the latest `rblxswap.exe` from Releases and run it as administrator.
2. **Scan & Clean** — review the plan, then confirm.
3. **Spoof** — choose MAC / hardware IDs / volume serial, run it, reboot if the volume serial was changed.
4. Use **Revert spoof & restore identifiers** to restore from the backup.

## CLI

```bat
rblxswap.exe --clean --dry-run
rblxswap.exe --clean --json
rblxswap.exe --spoof --no-mac --volume
rblxswap.exe --spoof --adapter=<guid> --mac=AA-BB-CC-DD-EE-FF --dhcp
```

`--help` lists every flag. CLI mode never opens a window and exits with a non-zero code on failure.

## Build

```bash
npm ci
npm run check      # lint + tests
npm run build      # dist/rblxswap.exe (portable)
```

See [BUILDING.md](BUILDING.md) for details, including release signing.

## Configuration

Stored at `%APPDATA%\rblxswap-launcher\config.json` (atomic writes, sanitized on load).
Logs: `%APPDATA%\rblxswap-launcher\logs\main.log` (rotated, 3 × 5 MB).
Backup: `backup.json` next to the executable (fallback: `%LOCALAPPDATA%\rblxswap`).

## Updates

The updater reads `updates.repo` (default `hackyue/rblxswap`) and verifies the downloaded file in this order:

1. GitHub asset `digest` (SHA-256)
2. `SHA256SUMS.txt` (or `checksums.txt`) release asset
3. Authenticode signature (must be valid; optional publisher pin)

If none is available the update is **rejected** unless *Allow unsigned updates* is enabled (not recommended).

## Security

Please read [SECURITY.md](SECURITY.md). The short version: run it on a machine you can afford to reinstall, keep the backup, and never enable unsigned updates.

## Credits

- [focat69](https://github.com/focat69) — original author
- [sevenv1](https://github.com/sevenv1) — UI contributions
- [centerepic's ByeBanAsync](https://github.com/centerepic/ByeBanAsync) — MAC spoofing reference

## License

[MIT](LICENSE)
