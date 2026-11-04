// macOS builds without a Developer ID still need a valid signature. On Apple
// silicon the app otherwise carries only the Electron binary's linker
// signature, which no longer matches the bundle: a downloaded copy is reported
// as "damaged and can't be opened", with no way past it. Signed ad hoc, macOS
// asks once instead (System Settings › Privacy & Security › Open Anyway).
// With a certificate configured, electron-builder signs the app properly next.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • signed ad hoc  app=${path.basename(app)}`);
};
