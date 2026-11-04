# Hardware tests on the command line

`impulse-test` runs the same hardware tests as Sketch › Run Hardware Tests, without the app: it compiles each sketch with arduino-cli, simulates it together with the circuit in its `diagram.json`, and checks the `// @expect` lines in its source. Use it in CI to catch a sketch that stops blinking, printing or reacting before it reaches a board.

## Get it

It needs Node.js 22 or newer and [arduino-cli](https://arduino.github.io/arduino-cli/) with the AVR core (`arduino-cli core install arduino:avr`). If you have installed Impulse IDE, it uses the arduino-cli the app set up.

- **Standalone:** every release has `impulse-test.mjs` attached, a single file with no other dependencies:

  ```bash
  curl -fsSL -o impulse-test.mjs https://github.com/Meet-1010/Impulse-IDE-v2/releases/download/v2.0.0-beta.2/impulse-test.mjs
  node impulse-test.mjs my_sketch
  ```

- **From a checkout of this repository:** `node bin/impulse-test.mjs my_sketch`, or `npm run build:cli` to build `dist-cli/impulse-test.mjs`.

## Write tests

Put the expectations in the sketch as comments. `// @run` sets how long to simulate (3 s if absent, at most 30 s).

```cpp
// @run 2.2s
// @expect serial contains "ready"
// @expect serial matches /temp=\d+/
// @expect pin LED_BUILTIN frequency 1Hz ±5%
// @expect pin 13 toggles
// @expect pin 9 high
// @expect no serial
```

| Expectation | Passes when |
| --- | --- |
| `serial contains "text"` | the Serial output includes the text |
| `serial matches /regex/flags` | the Serial output matches the regular expression |
| `no serial` | nothing was printed |
| `pin P toggles` | the pin changed level at least twice |
| `pin P high` / `pin P low` | the pin ended at that level |
| `pin P frequency 1Hz ±10%` | the pin's measured frequency is within the tolerance (10% if not given) |

Pins can be written `13`, `D13`, `A0` or `LED_BUILTIN`. Expectations in every `.ino` tab of the sketch are checked; `// @run` is read from the main file.

When the sketch folder has a `diagram.json` (Impulse saves one with every sketch; Wokwi projects have one too), the circuit is simulated with it: buttons, sensors, displays and the board it is built around. Without one, the sketch runs on a bare Uno.

## Run

```bash
node impulse-test.mjs path/to/sketch          # a sketch folder or its .ino file
node impulse-test.mjs sketches/               # every sketch under a folder
node impulse-test.mjs sketch --junit report.xml --json report.json
```

| Option | |
| --- | --- |
| `--board uno\|nano\|mega\|pico\|attiny85\|esp32\|esp32s3\|esp32c3\|nanoesp32` | board to simulate; by default the one in `diagram.json`, else the Uno. ESP32 boards need Espressif's core (`arduino-cli core install esp32:esp32 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json`) and run in Espressif's QEMU, which impulse-test downloads into Impulse's data folder (or `IMPULSE_EMULATOR_DIR`) the first time; on Linux it needs `libpixman-1-0 libgcrypt20 libsdl2-2.0-0 libslirp0`. The Pico needs the Arduino-Pico core (`arduino-cli core install rp2040:rp2040 --additional-urls https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json`), the ATtiny85 ATTinyCore (`arduino-cli core install ATTinyCore:avr --additional-urls https://drazzy.com/package_drazzy.com_index.json`) |
| `--fqbn <fqbn>` | compile for this FQBN; it has to be a board the simulator runs (any ESP32, ESP32-S2, ESP32-S3 or ESP32-C3 board of Espressif's core runs, compiled for itself) |
| `--seconds <n>` | simulated time, overriding `// @run` (at most 60) |
| `--expect "<line>"` | an extra expectation for every sketch; repeatable |
| `--hex <file>` | test a prebuilt program instead of compiling: a `.hex` for the AVR boards and the ATtiny85 (from PlatformIO, for example; an ATtiny85 build must be for 16 MHz), a `.uf2` or `.bin` for the Pico |
| `--diagram <file>` | use this circuit instead of the sketch's `diagram.json` |
| `--strict` | also fail on wiring errors from the circuit check |
| `--format human\|json\|junit` | what to print; human-readable by default |
| `--json <file>`, `--junit <file>` | also write a report file |
| `--cli <path>`, `--libraries <dir>` | arduino-cli to use; extra library folder (repeatable) |

A prebuilt HEX with no sketch around it takes its expectations from `--expect`:

```bash
node impulse-test.mjs --hex .pio/build/uno/firmware.hex --diagram diagram.json --expect "pin 13 toggles"
```

Exit codes: **0** every expectation passed; **1** an expectation failed, a sketch didn't compile, or a short circuit happened during the run; **2** nothing could be tested (bad arguments, arduino-cli or its AVR core missing, no sketch, or no `// @expect` lines anywhere). A sketch without `// @expect` lines is reported as skipped.

Wiring warnings from the circuit check (an LED without a resistor, an unpowered module…) are printed but don't fail the run unless you pass `--strict`, which fails on the serious ones (a battery straight onto a pin, a missing board).

## GitHub Actions

```yaml
name: Hardware tests
on: [push, pull_request]

jobs:
  simulate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - uses: arduino/setup-arduino-cli@v2
      - run: |
          arduino-cli core update-index
          arduino-cli core install arduino:avr
          # Libraries your sketches include, pinned:
          # arduino-cli lib install "LiquidCrystal I2C@1.1.2"
      - run: curl -fsSL -o impulse-test.mjs https://github.com/Meet-1010/Impulse-IDE-v2/releases/download/v2.0.0-beta.2/impulse-test.mjs
      - run: node impulse-test.mjs . --junit impulse-test.xml
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: impulse-test-report
          path: impulse-test.xml
```

Pin the release in the download URL so a new version can't change your results unannounced. The file is downloadable once that release is published.
