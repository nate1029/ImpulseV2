# Contributing

Thanks for helping make Impulse better.

## Set up

```bash
npm install
npm run dev
```

You need Node.js 22 or newer. Impulse can install arduino-cli and the AVR core for you on first launch; on Apple silicon the AVR compiler also needs Rosetta.

## Before you open a pull request

```bash
npm run lint -- --max-warnings=0
npm test
npm run build:renderer && npm run test:smoke && npm run test:e2e
```

- Tests that compile sketches need arduino-cli and the AVR core, and skip otherwise. Point `IMPULSE_TEST_LIBRARIES` at a folder of extra libraries to run the ones that need libraries you haven't installed globally (see README).
- Raspberry Pi Pico and ATtiny85: their tests need the Arduino-Pico core and ATTinyCore, and skip otherwise. To keep them out of your own Arduino setup, point `IMPULSE_EXTRA_CORES_CONFIG` at an arduino-cli config file whose data folder has them (`IMPULSE_PICO_CLI_CONFIG` still works).
- PlatformIO: `IMPULSE_PIO_TESTS=1 npx jest src/main/services/__tests__/platformio.test.js` builds, simulates and debugs a real PlatformIO project (needs `pio`; the first run downloads the AVR toolchain).
- UI changes: check them in the running app, in both the dark and light themes.
- Keep to the existing style: match the surrounding code, its naming and its comment density.

## Adding a simulated part

A part needs an element (`src/renderer/simulation/elements/` or one from `@wokwi/elements`), a behavior (`parts/`), a catalog entry with search keywords (`parts/catalog.js`), its pin positions in `parts/pins.js` (measured from the rendered element), and a test that runs real firmware against it. See ARCHITECTURE.md › Simulator.

## Adding an example

Add the circuit and sketch to `src/renderer/simulation/examples.js` and a check to `__tests__/examples.test.js`. The test suite compiles every example, runs it, checks its `@expect` lines, and rejects layouts whose parts overlap or that fail the circuit check.

## Reporting problems

Use Help › Report a Problem in the app, or the issue templates on GitHub. Security issues: see SECURITY.md.
