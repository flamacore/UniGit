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

If you also want to export a `.pfx` file for GitHub Actions, run:

```powershell
npm run release:windows:cert -- istanbuL_159753
```

Because of how `npm` forwards PowerShell arguments on Windows, the helper accepts a single trailing value as the export password and still keeps the default certificate subject.

That exports the file to:

```text
certificates\unigit-self-signed.pfx
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

## GitHub Actions Releases

This repo now includes a Windows release workflow at `.github/workflows/release.yml`.

It runs when you push a tag that starts with `v`, for example:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

The workflow:

- runs on `windows-latest`
- installs Node.js and Rust
- imports a code-signing certificate from GitHub secrets
- runs the existing Windows release build
- uploads the generated NSIS installer to the GitHub Release for that tag

### Required GitHub Secrets

- `WINDOWS_CERTIFICATE`
	Raw base64 contents of the exported `.pfx` file
- `WINDOWS_CERTIFICATE_PASSWORD`
	Password for the `.pfx` certificate
- `UNIGIT_TIMESTAMP_URL`
	Optional timestamp server URL for signing

To create the base64 value for `WINDOWS_CERTIFICATE` after exporting the `.pfx`:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes(".\certificates\unigit-self-signed.pfx")) | Set-Content ".\certificates\unigit-self-signed.base64.txt"
```

Then copy the contents of `certificates\unigit-self-signed.base64.txt` into the GitHub secret.

### Recommended CI Certificate Path

For early public automation, you can export your local self-signed `.pfx` and store it in GitHub Secrets.

That is good enough to automate installer production, but it still does not solve SmartScreen trust for end users.