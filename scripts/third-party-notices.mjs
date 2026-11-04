// Writes THIRD_PARTY_NOTICES.md: every package that ships in the app (main
// process and the bundled renderer) with its license text, plus the tools the
// app downloads at runtime. Run with `npm run notices` before a release.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const all = JSON.parse(execFileSync(npm, ['query', '.prod'], { cwd: root, maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' }).toString());
const self = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

function licenseText(dir) {
  try {
    const file = fs.readdirSync(dir).find(f => LICENSE_FILE.test(f));
    return file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : null;
  } catch {
    return null;
  }
}

function licenseId(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map(l => l.type || l).join(' OR ');
  return 'See license text';
}

const seen = new Set();
const packages = all
  .filter(p => p.name !== self.name && p.version && p.path)
  .map(p => ({ name: p.name, version: p.version, license: licenseId(p), homepage: p.homepage || p.repository?.url || p.repository || '', text: licenseText(p.realpath || p.path) }))
  .filter(p => !seen.has(`${p.name}@${p.version}`) && seen.add(`${p.name}@${p.version}`))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const runtime = [
  {
    name: 'arduino-cli', version: '1.5.1', license: 'GPL-3.0',
    homepage: 'https://github.com/arduino/arduino-cli',
    note: 'Not bundled. When no arduino-cli is installed, Impulse downloads the official release into its data folder on request and runs it as a separate program; its LICENSE.txt is kept next to it. Board cores and libraries it installs carry their own licenses.',
  },
  {
    name: 'Arduino-Pico core (rp2040:rp2040)', version: 'latest', license: 'LGPL-2.1',
    homepage: 'https://github.com/earlephilhower/arduino-pico',
    note: 'Not bundled. Installed through arduino-cli when you simulate a Raspberry Pi Pico for the first time and agree to the download; it brings its own toolchains and licenses.',
  },
  {
    name: 'ATTinyCore (ATTinyCore:avr)', version: 'latest', license: 'LGPL-2.1',
    homepage: 'https://github.com/SpenceKonde/ATTinyCore',
    note: 'Not bundled. Installed through arduino-cli when you simulate an ATtiny85 for the first time and agree to the download; it uses the AVR compiler of the Arduino AVR core.',
  },
  {
    name: 'ESP32 cores (esp32:esp32, arduino:esp32)', version: 'installed', license: 'LGPL-2.1 and others',
    homepage: 'https://github.com/espressif/arduino-esp32',
    note: 'Not bundled. Installed through arduino-cli when you simulate an ESP32 board without its core and agree to the download. Impulse compiles a small simulator bridge (src/main/services/esp32sim/impulse_sim.cpp) into sketches it simulates, never into uploads.',
  },
  {
    name: 'Espressif QEMU', version: 'esp-develop-9.2.2-20260417', license: 'GPL-2.0-or-later',
    homepage: 'https://github.com/espressif/qemu',
    note: 'The ESP32 emulator, run as a separate program. On Windows and Linux it is downloaded from Espressif\'s release the first time you simulate an ESP32 board (you are asked first) and checked against its published SHA-256. On macOS it ships with the app (Contents/Resources/qemu) together with the libraries listed next. Source code: https://github.com/espressif/qemu/releases/download/esp-develop-9.2.2-20260417/qemu-esp_develop_9.2.2_20260417-src.tar.xz. The ESP32 ROM images in its share/qemu folder are Espressif\'s.',
  },
  {
    name: 'pixman', version: '0.46.4', license: 'MIT',
    homepage: 'https://www.cairographics.org/releases/pixman-0.46.4.tar.gz',
    note: 'macOS only: built from the release source by scripts/qemu-mac-pack.mjs and shipped as a dynamic library next to QEMU.',
  },
  {
    name: 'libgcrypt', version: '1.12.4', license: 'LGPL-2.1-or-later',
    homepage: 'https://gnupg.org/ftp/gcrypt/libgcrypt/libgcrypt-1.12.4.tar.bz2',
    note: 'macOS only: built unmodified from the release source by scripts/qemu-mac-pack.mjs and shipped as a separate dynamic library (Contents/Resources/qemu/*/qemu/lib) that QEMU loads; it can be replaced with another build.',
  },
  {
    name: 'libgpg-error', version: '1.61', license: 'LGPL-2.1-or-later',
    homepage: 'https://gnupg.org/ftp/gcrypt/libgpg-error/libgpg-error-1.61.tar.bz2',
    note: 'macOS only: built unmodified from the release source by scripts/qemu-mac-pack.mjs and shipped as a separate dynamic library next to libgcrypt; it can be replaced with another build.',
  },
  {
    name: 'Electron', version: self.devDependencies.electron.replace(/^[^\d]*/, ''), license: 'MIT',
    homepage: 'https://www.electronjs.org',
    note: 'The app runtime. The licenses of Chromium and its components ship inside the app as LICENSES.chromium.html.',
  },
];

// Files in the app that don't come from npm.
const bundled = [
  {
    name: 'RP2040 boot ROM (B1)', license: 'BSD-3-Clause',
    homepage: 'https://github.com/raspberrypi/pico-bootrom',
    file: 'src/renderer/simulation/rp2040/bootrom.js',
    text: `Copyright (c) 2020 Raspberry Pi (Trading) Ltd.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  },
];

const lines = [
  '# Third-party notices',
  '',
  `Impulse IDE ${self.version} includes the open-source packages below. Generated by \`npm run notices\`.`,
  '',
  '## Downloaded or provided at runtime',
  '',
  ...runtime.flatMap(r => [`### ${r.name} ${r.version} (${r.license})`, '', r.homepage, '', r.note, '']),
  '## Files included in the app',
  '',
  ...bundled.flatMap(b => [`### ${b.name} (${b.license})`, '', `${b.homepage} · \`${b.file}\``, '', '```', b.text, '```', '']),
  '## Packages included in the app',
  '',
  '| Package | Version | License |',
  '|---|---|---|',
  ...packages.map(p => `| ${p.name} | ${p.version} | ${p.license} |`),
  '',
  '## License texts',
  '',
  ...packages.flatMap(p => [
    `### ${p.name} ${p.version}`,
    '',
    `License: ${p.license}${p.homepage ? ` · ${String(p.homepage).replace(/^git\+/, '')}` : ''}`,
    '',
    p.text ? ['```', p.text.replace(/```/g, "'''"), '```'].join('\n') : '_No license file in the package; see the license identifier above._',
    '',
  ]),
];

fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), `${lines.join('\n')}\n`);
console.log(`THIRD_PARTY_NOTICES.md: ${packages.length} packages, ${packages.filter(p => !p.text).length} without a license file.`);
