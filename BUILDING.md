<div align="center">
  <img src="assets/rblxswap_banner.png" alt="rblxswap banner"/>
</div>

---

<p align="center">Building from source</p>

---

## Requirements

- Windows 10/11 x64 (the build itself can run on any OS that supports Electron, but the app is Windows-only)
- Node.js 20+
- npm 10+

## Setup

```bash
npm ci
```

`electron` and `electron-builder` are pinned in `package.json`; no global installs are required.

## Checks

```bash
npm run lint       # syntax, CSP, security flags, no http://
npm test           # 36 unit tests (node:test)
npm run check      # both
```

## Build

```bash
npm run build        # portable exe -> dist/rblxswap.exe
npm run build:dir    # unpacked build  -> dist/win-unpacked
```

`build.bat` is a convenience wrapper that elevates and runs the same command.

## Release

1. Bump the version in `package.json` (`npm version 0.4.1 --no-git-tag-version`).
2. Commit and tag: `git tag v0.4.1 && git push --tags`.
3. `.github/workflows/release.yml` builds the portable exe, writes `SHA256SUMS.txt` and attaches both to the GitHub release.
4. The in-app updater verifies the checksum before running the new executable.

### Code signing

Set repository secrets `WIN_CSC_LINK` (base64 PFX or file URL) and `WIN_CSC_KEY_PASSWORD`.
Without them the build is unsigned and the updater will reject it unless *Allow unsigned updates* is enabled.

## Project layout

```
main.js                 bootstrap only
hwid.js                 HWID / volume engine
preload.js              contextBridge API
preload-toast.js        toast button bridge
src/main/*              app, ipc, cleaner, adapters, updater, spoof, toasts, cli
src/shared/*            config, security, paths, logging, PowerShell helper
src/renderer/*.mjs      UI modules (ES modules, no inline JS)
src/index.html          UI
src/styles.css          styles
test/*.test.js          unit + UI contract tests
scripts/lint.js         zero-dependency lint
```
