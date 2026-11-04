#!/usr/bin/env node
// impulse-test: run a sketch's // @expect hardware tests in the simulator.
// See src/cli/impulse-test.js and docs/TESTING.md.

import fs from 'node:fs';
import process from 'node:process';

// The simulator's modules are ES modules in a package without "type":
// "module"; Node loads them fine but warns about it on every run.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.code !== 'MODULE_TYPELESS_PACKAGE_JSON') process.stderr.write(`${w.name}: ${w.message}\n`);
});

/* global __IMPULSE_VERSION__ */
const version = typeof __IMPULSE_VERSION__ === 'string'
  ? __IMPULSE_VERSION__
  : JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const { main } = await import('../src/cli/impulse-test.js');
const color = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
process.exitCode = await main(process.argv.slice(2), { version, color });
