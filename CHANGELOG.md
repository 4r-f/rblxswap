# Changelog

All notable changes to rblxswap are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.6.0] - 2026-11-05

### Added

- **Automatic mode**: when the exe is launched as administrator it shows a 5-second countdown, then cleans traces and rotates MAC + HWID without any further clicks. Cancel is always available.
- **`--auto` launch flag** and a **desktop auto shortcut** button (`rblxswap (Auto).lnk`) for a true double-click workflow.
- `autoRun` setting (default on) to control the launch behaviour.
- Smoke coverage for the countdown auto flow.

### Changed

- The portable exe still requests administrator rights via its manifest, so Windows shows the UAC prompt automatically.
- First launch still shows the 3-step guide; automatic mode starts from the second launch (or immediately with `--auto`).

## [0.5.0] - 2026-11-05

### Added

- **One-click setup**: clean + MAC + HWID with safe defaults, a single confirm and a final “You are ready” screen.
- **First-run onboarding** and a permanent help screen in the header.
- **Health chips** for administrator rights, running Roblox and backup availability.
- **Restart as administrator** (UAC) from the banner and the admin modal.
- **Automatic language detection** on first launch (Turkish systems start in Turkish).
- **Update repository field** in Settings; the default is derived from `package.json` `repository` (or `RBLXSWAP_UPDATE_REPO`).
- Optional **auto-spoof after cleaning** toggle (`quickSpoof`, default on).

### Changed

- Home screen is now beginner-first: one big primary action, “Clean only” / “Spoof only” secondary, revert and help links.
- The post-clean screen reports whether spoofing ran and whether a reboot is required.
- Settings gained a “Recommended settings” reset button.
- Version bumped to 0.5.0; the updater now points at the fork by default.

## [0.4.0] - 2026-11-05

### Added

- **Cleanup preview (dry-run)** with per-step file counts, sizes, admin requirements and warnings.
- **Recycle-bin deletes** (`useTrash`, default on) and a strict allow-list for `%TEMP%\Roblox*` folders.
- **CLI mode**: `--clean`, `--spoof`, `--dry-run`, `--json`, `--silent`, `--adapter`, `--mac`, `--volume`, `--dhcp`, `--no-trash`.
- **Profiles** for launcher type, spoof mode and targets; **theme import/export**.
- **Diagnostics** panel with versions, paths, elevation, adapters, backup state and the log tail.
- **EN/TR UI**, keyboard activation for action buttons, `aria-live` logs.
- **Tests**: 36 unit/UI-contract tests plus an Electron smoke test.
- **CI**: GitHub Actions on `windows-latest`, release workflow with SHA-256 checksums.
- `LICENSE` (MIT) and `SECURITY.md`.

### Changed

- `main.js` is now a thin bootstrap; logic lives in `src/main/*` and `src/shared/*`.
- Renderer is split into classic-script modules with no inline event handlers.
- Settings are sanitized and written atomically; unknown/unsafe values are dropped.
- Adapters are matched by `NetCfgInstanceId` (GUID) instead of `DriverDesc`.
- MAC spoofing uses one shared function for UI and CLI; invalid MACs are rejected before PowerShell.
- Toast windows are capped at 5, position themselves on the display under the cursor, and include a CSP.

### Security

- **No PowerShell string interpolation** for MAC/adapter values; values are passed through environment variables.
- **Strict CSP** with `script-src 'self' file:`, no inline scripts/handlers.
- **External URL allow-list** (HTTPS + GitHub/Discord hosts) for `shell.openExternal`.
- **Updater verification**: GitHub asset digest, `SHA256SUMS.txt`, or a valid Authenticode signature; unsigned updates rejected by default.
- Download hardening: status/timeout checks, redirect limit, 300 MB cap, partial-file cleanup.
- IPC validation, single-instance lock, permission handler (clipboard writes only), `sandbox: true`, `nodeIntegration: false`.

### Fixed

- Updater no longer reports "update available" when the upstream repo returns 404; semver comparison and channel support added.
- `findExeShallow` is case-insensitive (`WebLauncher.exe` works).
- Missing `LOCALAPPDATA`/`APPDATA`/`USERPROFILE` no longer crash path building.
- `Downloads`/`Logs` are cleaned even when `Versions` is absent.
- The close button follows the `minimizeClose` setting instead of always hiding.
- `backupHwid()` failures abort spoofing instead of continuing without a restore path.
- Partial HWID spoofing is reported as partial instead of success.
- `backup.json` is written atomically; corrupt backups abort the spoof; a GUID-only backup is upgraded with the boot sector before volume spoofing.
- Volume spoofing detects 4Kn sectors, refuses BitLocker, verifies the write, and restores the System Restore throttle value.
- Stale "Spoofed at" label now reflects backup state.
- Version is read from `package.json` instead of being duplicated.
- Log cleanup is saved to `%APPDATA%\rblxswap-launcher\logs\main.log`.

### Removed

- Dead code: `buttonsJson`, unused `psEscape`, unused preload APIs (`downloadUpdate`, `getStats`, `purgeRoblox`), duplicated renderer MAC logic.
- Google Fonts network call (offline-friendly UI).
- Arbitrary-URL update IPC (`update:download`); only verified latest-release installs remain.
