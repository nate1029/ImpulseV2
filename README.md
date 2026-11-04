# Impulse

**[impulse-ide.vercel.app](https://impulse-ide.vercel.app)** · [Releases](https://github.com/Meet-1010/Impulse-IDE-v2/releases) · [Changelog](CHANGELOG.md)

An AI-assisted Arduino IDE with a built-in hardware simulator. Say what the board should do: Impulse writes the sketch, wires the circuit, runs it in the simulator, checks it against hardware tests, and uploads it to the board. The full IDE is one click away.

## Features

- **Chat mode**: the view Impulse opens in. One conversation to plan, build and debug (Agent, Plan and Debug modes), a side panel with the simulator, the serial monitor and the code, chats saved with the projects they build, and the Chat | IDE switch (⌘E) for everything else.
- **Accounts and credits**: sign in with Google, GitHub or email and the AI runs on Impulse's own keys with free credits (200 to start, then a small allowance every few hours on the Free plan; Pro and Max for more). No API key to bring. The server is in [`cloud/`](cloud/README.md).
- **Editor**: Arduino-aware syntax highlighting, find/replace, go to line, auto-indent, multi-tab sketches.
- **Compile, upload, programmers**: through `arduino-cli`, including Upload Using Programmer, Export Compiled Binary and Archive Sketch.
- **Simulator**: runs the compiled firmware of **every board in the board menu**: the **Arduino Uno, Nano and Mega 2560** (emulated AVR, and every board built on the ATmega328P, 168, 2560, 1280 or 8: Pro Mini, Fio, LilyPad, Mega ADK, NG…), the **Leonardo** and every ATmega32U4 board (Micro, Esplora, Yún…, with USB Serial emulated), the **Raspberry Pi Pico** (emulated RP2040, Arduino-Pico core, 3.3 V logic, Serial over USB; other RP2040 boards such as the XIAO RP2040 and Feather RP2040 run on it too) and the **ATtiny85** (and ATtiny25/45) (ATTinyCore, a DIP-8 chip on a breadboard with its software Serial, and I²C and SPI through its USI) and **ESP32 boards** (ESP32, ESP32-S2, ESP32-S3, ESP32-C3 and the Nano ESP32: 215 boards, the real firmware in Espressif's QEMU, with pins, PWM, analog inputs, I²C, the RGB LED and a pretend Wi-Fi network), wired to **91 parts** on a canvas — LEDs, buttons, pots, breadboards, LCDs, OLED and TFT displays, NeoPixels, 7-segment and TM1637 displays, LED matrices, HC-SR04, DHT11/22, DS18B20 (1-Wire), PIR, IMU, RTC, load cell, keypads, rotary encoders, IR remote, servos, steppers (NEMA 17, 28BYJ-48 + ULN2003, A4988), DC motors with L293D/L298N, relays, 74HC595, transistors and MOSFETs, diodes, capacitors (they charge and discharge in real time: RC delays, debouncing, PWM smoothing), batteries and logic gates. Real libraries (Servo, LiquidCrystal I2C, Adafruit SSD1306/NeoPixel, DallasTemperature, TM1637, Keypad, IRremote, AccelStepper…) work unchanged.
  - **Part picker** with typo-tolerant search; when something isn't simulated (an ESP8266, Bluetooth, GPS, SD…) it says so and suggests what to use instead.
  - **48 example projects** that open as a sketch plus a wired circuit, from Blink to a robot car, a thermometer, a logic-gate truth table, a capacitor charging curve, two for the Pico, three for the ATtiny85 and six for ESP32 boards.
  - **Circuit check**: missing resistors, unpowered parts, floating logic inputs, I²C address clashes, batteries over 5 V on a pin, short circuits.
  - Circuits save as `diagram.json` next to the sketch; Wokwi `diagram.json` files import and export.
  - **AI circuit builder** wires the parts your sketch uses; the **AI agent** compiles, simulates, checks and fixes.
- **Logic analyzer**: waveforms for every active pin during a simulation, with frequency and duty cycle.
- **Hardware tests**: describe expected behaviour as comments in the sketch and check it in the simulator (Sketch › Run Hardware Tests, ⌘/Ctrl+Shift+T):

  ```cpp
  // @run 3s
  // @expect serial contains "ready"
  // @expect serial matches /temp=\d+/
  // @expect pin 13 toggles
  // @expect pin LED_BUILTIN frequency 1Hz ±10%
  // @expect pin 9 high
  // @expect no serial
  ```

  The same tests run in CI with `impulse-test`, a single-file command-line runner that compiles, simulates with the sketch's circuit and writes JUnit/JSON reports: see [docs/TESTING.md](docs/TESTING.md).

- **Debugger**: click left of a line number to set a breakpoint and press Debug (F5). The simulated board stops on that line; step over, into and out of functions (F10, F11, ⇧F11), run to the cursor, follow the call stack (each frame's locals), and read globals (structs, arrays, `String`s, enums), registers and flags. Works with multi-file sketches.
- **Source control**: a Source Control panel (⌘/Ctrl+Shift+G) for the open folder: start a Git repository, see what changed and each file's diff, commit, pull and push, and browse recent history. It uses the Git installed on your computer and never prompts for passwords; a push that needs credentials reports git's reason.
- **PlatformIO projects**: open a folder with `platformio.ini` and Verify, Upload, the simulator and the debugger use PlatformIO Core (`pio`). Pick the environment in the status bar or Tools › PlatformIO Environment; the simulator builds the environment for its board (Uno, Nano or Mega 2560) and keeps the circuit in `diagram.json` at the project root, as Wokwi does.
- **Pin-aware editor**: hover a pin to see what it's wired to. The gutter flags `digitalWrite` without `pinMode(OUTPUT)`, `analogWrite` on pins without PWM, pins 0/1 used alongside `Serial`, and (when a circuit exists) unwired pins or code that drives an input part.
- **AI agent**: Impulse AI, through your account, reads and edits the sketch, compiles, uses the serial monitor and knows the selected board's real pins and limits. Which model answers is decided on the server per kind of work, cheapest first, climbing when a turn fails. Every AI code change is run in the simulator automatically and gets a pass/fail card with a "Fix it" button. Uploading to a real board always asks for your approval.
- **Board detection**: the board you plug in is selected for upload with its port, and the simulator follows it.
- **Simulator vs board**: runs the sketch in the simulator and on a connected Uno, Nano or Mega for the same time, then diffs the serial output line by line (Sketch › Compare Simulator with Board).

## Requirements

- Node.js 22+
- [`arduino-cli`](https://arduino.github.io/arduino-cli/) with the AVR core: `arduino-cli core install arduino:avr`
- Apple silicon Macs: the AVR toolchain is an Intel binary, so install Rosetta once:

  ```bash
  softwareupdate --install-rosetta --agree-to-license
  ```

## Develop

```bash
npm install
npm run dev
```

`npm run dev` starts Vite and Electron with hot reload. `npm start` builds the renderer and runs Electron without the dev server.

## Test

```bash
npm test             # unit tests (includes a real compile → simulate test when arduino-cli is installed)
npm run lint         # ESLint; CI runs it with --max-warnings=0
npm run test:smoke   # launches the app with a throwaway profile, opens every panel and the simulator, fails on any runtime error
npm run test:e2e     # opens an example, compiles and runs it, presses its button; accessibility audit (axe) of the main screens in both themes
npm run build:cli    # builds dist-cli/impulse-test.mjs, the command-line hardware test runner (docs/TESTING.md)
```

Example and part tests compile real sketches; tests whose libraries aren't installed are skipped. To run them without installing libraries globally, point `IMPULSE_TEST_LIBRARIES` at a folder of libraries (for example one filled with `ARDUINO_DIRECTORIES_USER=/tmp/libs arduino-cli lib install OneWire DallasTemperature TM1637`, then `IMPULSE_TEST_LIBRARIES=/tmp/libs/libraries npm test`).

## Package

```bash
npm run build:mac    # or build:win, build:linux
```

Signing and release steps: [docs/BUILD_AND_SIGN.md](docs/BUILD_AND_SIGN.md), [docs/RELEASE.md](docs/RELEASE.md). Auto-update reads GitHub Releases from `Meet-1010/Impulse-IDE-v2`.

## Security model

- The renderer runs sandboxed with context isolation and no Node access, and its content security policy allows only bundled resources.
- File access is limited to folders you opened through a system dialog. Library examples are read-only. Approvals are remembered by the main process, never by the renderer.
- Nobody brings an API key. The Impulse session token is stored with the OS credential store (macOS Keychain, Windows DPAPI, libsecret) through Electron `safeStorage` and never reaches the renderer; the AI key exists only on Impulse Cloud, which checks the account, its plan and credits, the request rate and a daily budget before paying for a request.
- The AI agent can't run shell commands, and every upload to hardware needs your confirmation.
- Uncaught errors from both processes are written to `impulse.log` in the app's logs folder.

## Layout

```
src/main/        Electron main process: window, menu, IPC handlers, arduino-cli, serial, AI agent, the Impulse account, saved chats
src/renderer/    UI: the IDE (editor, panels, AI chat, hardware tests, pin insights, design system)
src/renderer/vibe/         chat mode, the default view (see docs/design/chat-mode.md)
src/renderer/simulation/   AVR, RP2040 and ESP32 runners, boards, circuit engine, parts and devices, canvas, examples, headless runner (see ARCHITECTURE.md)
src/cli/         impulse-test, the command-line hardware test runner (bin/impulse-test.mjs)
cloud/           Impulse Cloud: accounts, credits, the AI gateway, the admin console (Hono + Postgres; a container for Cloud Run, or Vercel)
scripts/smoke.mjs, scripts/e2e.mjs   smoke and end-to-end tests of the built app
```
