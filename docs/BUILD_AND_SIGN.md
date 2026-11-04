# Building and Code Signing

## Building the app

- **Renderer (Vite):** `npm run build:renderer`
- **Full app (no signing):** `npm run build:win` (Windows), `npm run build:mac`, `npm run build:linux`
- **All platforms:** `npm run build:all`

Output goes to `dist/` (installer and unpacked artifacts).

## macOS without a Developer ID

With no certificate configured (no `CSC_LINK` or `CSC_NAME`), `build/afterPack.cjs` signs the app ad hoc and verifies the signature before the DMG and zip are made. Without it, the bundle keeps only the Electron binary's own signature, which no longer matches its contents, and macOS reports a downloaded copy as "damaged" with no way to open it. Signed ad hoc, macOS asks once instead: System Settings › Privacy & Security › Open Anyway. With a Developer ID configured, electron-builder signs (and notarizes) the app properly after the hook.

## Windows code signing (avoid “Unknown publisher” warnings)

To sign the Windows executable so users don’t see SmartScreen / “Windows protected your PC”:

1. **Obtain a code signing certificate**
   - **EV (recommended):** from a CA (DigiCert, Sectigo, etc.). Often requires hardware token; gives immediate SmartScreen reputation.
   - **Standard (OV):** cheaper; SmartScreen reputation builds over time.

2. **Export to PFX** (if you have a cert in Windows Certificate Store)
   - `certmgr.msc` → Personal → Certificates → your code signing cert → Right‑click → All Tasks → Export.
   - Export private key, format **PFX**, set a password.

3. **Configure electron-builder with env vars**

   | Variable | Description |
   |--------|--------------|
   | `WIN_CSC_LINK` | Path to your `.pfx` file (or base64 of the file for CI) |
   | `WIN_CSC_KEY_PASSWORD` | Password for the PFX |
   | `WIN_CSC_SUBJECT_NAME` | Subject name of the cert (e.g. `"CN=Your Name"`); optional if only one cert in PFX |

   Example (PowerShell, local):

   ```powershell
   $env:WIN_CSC_LINK = "C:\path\to\your-cert.pfx"
   $env:WIN_CSC_KEY_PASSWORD = "YourPfxPassword"
   npm run build:win
   ```

4. **CI (GitHub Actions)**
   Add the PFX as a base64 secret and its password; the release workflow passes them to electron-builder. See [electron-builder code signing](https://www.electron.build/code-signing).

If these env vars are **not** set, the build still runs but the exe is **unsigned**; users may see SmartScreen or “Unknown publisher”.

## macOS signing and notarization

You need an Apple Developer account ($99/year) and a **Developer ID Application** certificate.

1. Export the certificate with its private key from Keychain Access as a `.p12` with a password.
2. Create an app-specific password at appleid.apple.com.
3. Add the secrets below. electron-builder signs with the certificate and notarizes automatically when the Apple ID secrets are present.

## Release secrets (repository › Settings › Secrets and variables › Actions)

| Secret | Used for |
|---|---|
| `MAC_CSC_LINK` | base64 of the Developer ID Application `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CSC_KEY_PASSWORD` | password of that `.p12` |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | your 10-character team ID |
| `WIN_CSC_LINK` | base64 of the Windows code-signing `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | password of that `.pfx` |

All are optional: missing secrets mean an unsigned build for that platform, not a failed one.

## Clean machine / portable testing

After building:

1. Copy the installer (e.g. `dist/Impulse-IDE-Setup-2.0.0-beta.2.exe`) to a clean machine or VM.
2. Install and run. Confirm: open folder, compile, upload, serial monitor, AI panel.
3. Check that user data (sketches, memory, settings) lives under the correct app data folder (e.g. `%APPDATA%\Impulse IDE` on Windows when built with this productName).

## No CDN dependency (packaged app)

The packaged app does **not** rely on any CDN:

- **CodeMirror:** Bundled by Vite from `node_modules/codemirror`.
- **Fonts:** Inter and JetBrains Mono come from `@fontsource-variable/*`; Vite copies them into `dist-renderer/assets/`.
- **CSP:** `default-src 'self'`; fonts load only from the app itself (see `Content-Security-Policy` in `src/main/main.js`). Network access is limited to AI providers and update checks from the main process.
