# Release process

Releases are built by GitHub Actions (`.github/workflows/release.yml`) for macOS
(dmg + zip, Intel and Apple silicon), Windows (NSIS installer) and Linux
(AppImage + deb), and attached to a **draft** GitHub Release together with the
`latest*.yml` files the in-app updater reads.

1. **Update the version and changelog**
   - Set `version` in `package.json` (for example `2.0.0-beta.2` or `2.0.0`).
   - Run `npm install --package-lock-only` so `package-lock.json` matches.
   - In `CHANGELOG.md`, move the `[Unreleased]` items into a new `[X.Y.Z] - YYYY-MM-DD` section and add its link at the bottom.

2. **Commit, tag and push**
   ```bash
   git commit -am "Release vX.Y.Z"
   git tag vX.Y.Z
   git push v2 dev/meetchauhan:main vX.Y.Z
   ```
   The workflow refuses a tag that doesn't match `package.json`.

3. **Check the draft**
   - Actions › Release: all three build jobs must pass.
   - Releases › the draft `Impulse IDE X.Y.Z`: installers for every platform plus `latest.yml`, `latest-mac.yml` and `latest-linux.yml`.
   - Install on a clean machine and confirm: open a folder, verify, upload, Serial Monitor, the simulator and an example.

4. **Publish** the draft (paste the changelog section as the notes).
   Versions with a pre-release suffix (`-beta.N`) are marked as pre-releases;
   beta builds update to newer betas, stable builds only to stable releases.

Signing: without the secrets in [BUILD_AND_SIGN.md](BUILD_AND_SIGN.md) the
installers are unsigned. macOS then shows "unidentified developer" and in-app
updates can't install on macOS (Squirrel requires a signed app); Windows shows
SmartScreen.
