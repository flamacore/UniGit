# Windows Release

This project is now set up to produce a Windows NSIS installer (`.exe`) through Tauri.

The release path is built around a local self-signed code-signing certificate so you can produce installer builds immediately without waiting on a commercial signing workflow.

## What This Produces

- A Windows setup executable from the Tauri NSIS bundler
- Local code signing through `signtool.exe`
- WebView2 bootstrapper embedded in the installer for a smoother first install

## Important Limitation

Self-signed certificates are useful for internal testing, early distribution, and verifying the full packaging pipeline.

They do not establish public trust with Windows SmartScreen.

That means:

- the installer is signed
- the installer is installable
- Windows may still warn users because the certificate is not publicly trusted

For a true public release without SmartScreen reputation pain, move later to OV, EV, or Azure Trusted Signing.

## Prerequisites

- Windows machine
- Git
- Node.js and npm
- Rust toolchain
- Tauri prerequisites already working in this repo
- Windows SDK signing tools available so `signtool.exe` exists

## 1. Create a Local Self-Signed Certificate

From the repository root:

```powershell
npm run release:windows:cert
```

That creates or reuses a code-signing certificate in `Cert:\CurrentUser\My` with the default subject:

```text
CN=UniGit Self Signed
```

## 2. Build the Installer

From the repository root:

```powershell
npm run release:windows
```

This build script:

- requires signing instead of silently skipping it
- looks for the default `CN=UniGit Self Signed` certificate
- runs `tauri build`
- emits the NSIS installer bundle

Expected output directory:

```text
src-tauri\target\release\bundle\nsis\
```

## Optional Environment Overrides

If you want to use a different local certificate or timestamp service:

```powershell
$env:UNIGIT_SIGN_SUBJECT = "CN=My Custom Cert"
$env:UNIGIT_CERT_THUMBPRINT = "ABCDEF1234567890ABCDEF1234567890ABCDEF12"
$env:UNIGIT_TIMESTAMP_URL = "http://timestamp.digicert.com"
npm run release:windows
```

## Installer Notes

The Tauri config is now set to:

- bundle NSIS installers for Windows release output
- embed the WebView2 bootstrapper in the installer
- install for the current user by default
- place Start Menu entries under `UniGit`

## Later Upgrade Path

Once the repo is public and you want real public trust:

1. Replace the self-signed certificate with OV, EV, or Azure Trusted Signing
2. Keep the installer flow and swap only the signing configuration
3. Add CI release automation after the local packaging flow is stable