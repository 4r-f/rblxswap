# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.5.x | ✅ |
| 0.4.x | ✅ (security fixes, no one-click UI) |
| < 0.4 | ❌ (no update verification, arbitrary URL updater, inline JS) |

## Reporting a vulnerability

Open a private security advisory on the repository (Security → Advisories) or contact the maintainer directly. Please do not open a public issue for exploitable bugs.

## Threat model

rblxswap runs **as administrator** and intentionally modifies system state:

- registry keys (`MachineGuid`, `HwProfileGuid`, `MachineId`, `NetworkAddress`, Roblox keys)
- the boot sector VSN field when volume spoofing is enabled
- files under `%LOCALAPPDATA%`, `%APPDATA%`, `%TEMP%`, `%PROGRAMDATA%`, `%ProgramFiles%` and `%SystemRoot%\Prefetch`

Treat it like a system utility, not a sandboxed app.

## Update trust

The updater accepts a download only when one of these checks passes:

1. GitHub asset digest (`sha256:...`)
2. `SHA256SUMS.txt` / `checksums.txt` release asset
3. Valid Authenticode signature (optional publisher pin)

Otherwise the update is rejected. `updates.allowUnsigned` exists for local testing and is **off by default**.

## Hardening in 0.4

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`
- CSP without `unsafe-eval`; module scripts only; no inline handlers
- external URLs restricted to HTTPS + allow-listed hosts
- IPC payloads validated; no arbitrary update URLs from the renderer
- PowerShell values passed through environment variables (no string interpolation)
- update download: redirect limit, 10 s timeout, 300 MB cap, partial-file cleanup
- config and backup written atomically (temp file + rename)

## Known limitations

- The boot-sector write cannot hold `FSCTL_LOCK_VOLUME` on a busy system volume; the app verifies the write afterwards but a reboot is required for the change to be visible.
- Volume spoofing is refused when BitLocker protection is on.
- Antivirus/SmartScreen will likely flag the tool because it writes the boot sector and kills processes. Code signing is recommended.
