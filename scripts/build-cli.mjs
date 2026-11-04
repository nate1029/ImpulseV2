// Bundle impulse-test into one file that needs only Node 22+ and arduino-cli:
// dist-cli/impulse-test.mjs, attached to every release.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outfile = path.join(root, 'dist-cli', 'impulse-test.mjs');

await build({
  entryPoints: [path.join(root, 'bin', 'impulse-test.mjs')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // The toolchain module is CommonJS; give it a require() inside the ES module bundle.
  banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
  define: {
    __IMPULSE_VERSION__: JSON.stringify(pkg.version),
    // The ESP32 simulator bridge, compiled into ESP32 sketches (see src/main/services/esp32sim).
    __IMPULSE_BRIDGE_SOURCE__: JSON.stringify(fs.readFileSync(path.join(root, 'src', 'main', 'services', 'esp32sim', 'impulse_sim.cpp'), 'utf8')),
  },
  legalComments: 'eof',
  logLevel: 'warning',
});
fs.chmodSync(outfile, 0o755);
console.log(`${path.relative(root, outfile)} (${(fs.statSync(outfile).size / 1024).toFixed(0)} KB, impulse-test ${pkg.version})`);
