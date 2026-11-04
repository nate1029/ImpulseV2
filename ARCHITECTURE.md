
# Impulse IDE - Architecture

## Overview

Impulse is an **AI-assisted IDE for Arduino development with a built-in circuit simulator**. It provides an intelligent coding environment with AI assistance, serial monitoring, and seamless Arduino CLI integration.

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Impulse IDE                               │
├──────────────┬─────────────────────────────┬───────────────────────┤
│   Sidebar    │      Code Editor            │    AI Assistant       │
│              │                             │                       │
│ • Open File  │  • Syntax highlighting      │ • Natural language    │
│ • Board      │  • Line numbers             │ • Multi-model         │
│ • Port       │  • Auto-complete            │ • Tool execution      │
│ • Verify     │                             │ • Error analysis      │
│ • Upload     │                             │                       │
│              ├─────────────────────────────┤                       │
│ • Serial     │      Output Panel           │                       │
│              │  • Console                  │                       │
│              │  • Serial Monitor           │                       │
│              │  • Problems                 │                       │
└──────────────┴─────────────────────────────┴───────────────────────┘
```

## Tech Stack

- **Electron** - Desktop application framework
- **Arduino CLI** - Compile & upload (no IDE modification)
- **CodeMirror** - Code editor with syntax highlighting
- **SerialPort** - Serial communication
- **OpenAI/Gemini/Claude** - AI providers

## Directory Structure

```
src/
├── main/                           # Electron Main Process
│   ├── main.js                     # Entry point, window, menu, services
│   ├── preload.js                  # Secure bridge to renderer
│   ├── ipc/                        # IPC handlers (arduino, serial, ai, cloud, chats, sketch, git, esp32sim…)
│   └── services/
│       ├── arduinoService.js       # Arduino CLI operations
│       ├── serialMonitor.js        # Serial port communication
│       ├── errorMemory.js          # Legacy error tracking
│       ├── chatStore.js            # Saved chats (chat mode)
│       ├── cloud/
│       │   ├── account.js          # The signed-in Impulse account (token in safeStorage)
│       │   ├── loopback.js         # Browser sign-in → app (RFC 8252 loopback + PKCE)
│       │   └── config.js           # Where Impulse Cloud is (package.json impulse.cloudUrl / IMPULSE_CLOUD_URL)
│       ├── esp32sim/               # ESP32 boards in Espressif's QEMU
│       └── ai/
│           ├── agent.js            # AI orchestrator
│           ├── providers/          # LLM adapters
│           │   ├── baseProvider.js
│           │   ├── claudeProvider.js        # Anthropic Messages API (what the gateway speaks)
│           │   ├── openaiProvider.js        # OpenAI Responses API (what the gateway's OpenAI lane speaks)
│           │   ├── impulseProvider.js       # Claude lane through Impulse Cloud (account session)
│           │   └── impulseOpenAIProvider.js # OpenAI lane through Impulse Cloud (account session)
│           ├── tools/              # Tool system
│           │   ├── toolSchema.js   # Tool definitions (agent, plan and debug sets)
│           │   └── toolExecutor.js # Tool execution
│           ├── knowledge/          # Board facts, chip-family and component guides
│           ├── memory/
│           │   └── simpleMemory.js # JSON-based memory
│           ├── prompts/
│           │   └── systemPrompt.js # Agent, plan and debug prompts
│           └── config/
│               └── modelPreferences.js
│
└── renderer/                       # Electron Renderer (UI)
    ├── index.html                  # The IDE's HTML
    ├── styles.css, design-system.css
    ├── vibe/                       # Chat mode, the default view (index.js, char-field.js, bench.js, account.js, chats.js…)
    ├── morph-orb/                  # The IDE's AI chat: the pill composer, thinking orb and answer card
    ├── simulation/                 # The simulator (see below)
    └── renderer.js                 # IDE logic, and the window.impulse bridge chat mode drives it through

cloud/                              # Impulse Cloud (Hono + Postgres, deployed on Vercel)
├── src/                            # auth, credits, pricing, gateway, account API, admin API, desktop hand-off, settings
├── public/                         # /sign-in/, /admin/, /desktop/done/
├── migrations/                     # App tables (Better Auth creates its own)
├── scripts/                        # serve, migrate, seed-demo, fake-anthropic
└── test/                           # node --test against a scratch Postgres
```

## Core Components

### 1. Arduino Service (`arduinoService.js`)

Handles all Arduino CLI operations:

```javascript
// Key methods
checkCLI()              // Verify CLI installed
listBoards()            // Get available boards (JSON)
listPorts()             // Get connected ports (JSON)
compile(sketch, fqbn)   // Compile sketch
upload(sketch, fqbn, port) // Upload to board
```

**FQBN Format**: `vendor:architecture:board`
- Example: `arduino:avr:uno`
- Validated before compile/upload

### 2. Serial Monitor (`serialMonitor.js`)

Real-time serial communication:

```javascript
connect(port, baudRate)  // Open connection
disconnect()             // Close connection
send(data)               // Send data
// Events: 'data', 'connected', 'disconnected', 'error'
```

### 3. AI Agent (`ai/agent.js`)

Orchestrates AI interactions:

```javascript
setProvider(name, credential, model) // 'impulse' (Claude lane) or 'impulse-openai' (OpenAI lane); both use the account's session token
processQuery(query, context)       // Process user input
analyzeError(error, context)       // Analyze errors
```

**Conversation Flow**:
1. User sends message
2. Agent builds context (sketch, board, port, code)
3. LLM processes with tool definitions
4. Tool calls executed by ToolExecutor
5. Results returned to user

### 4. Tool System (`ai/tools/`)

**Available Tools**:
| Tool | Description |
|------|-------------|
| `compile_sketch` | Compile Arduino sketch |
| `upload_sketch` | Upload to board |
| `list_boards` | List available boards |
| `list_ports` | List connected ports |
| `connect_serial` | Open serial monitor |
| `disconnect_serial` | Close serial |
| `send_serial` | Send data |
| `read_serial` | Read recent output |
| `analyze_error` | Analyze error message |
| `search_memory` | Search past errors |
| `record_fix` | Save successful fix |

### 5. Memory System (`ai/memory/simpleMemory.js`)

JSON-based persistence (no SQLite dependency):

```json
{
  "errors": [{ "signature": "...", "message": "...", "count": 1 }],
  "fixes": [{ "errorSignature": "...", "description": "..." }],
  "executions": [{ "tool": "...", "success": true }]
}
```

Stored at: `<userData>/memory.json` (`Impulse IDE`, or `arduino-ide-cursor` for data from pre-2.0 development builds)

### 6. Impulse account (`cloud/account.js`) and saved chats (`chatStore.js`)

`services/cloud/account.js` holds the signed-in Impulse account: sign-in with
email + password (verified by an emailed 6-digit code) or with Google/GitHub
through the browser (RFC 8252 loopback + PKCE, `services/cloud/loopback.js`),
the session token (encrypted with Electron `safeStorage`; the renderer only
ever sees `status()`), and the account's plan and credits from Impulse Cloud
(see below). Nobody brings an API key: `ImpulseProvider` sends the agent's
requests to the cloud's AI gateway with that token, and the gateway adds
Impulse's own Anthropic key and charges the account's credits. A build
without a cloud address has no AI (the simulator and the IDE still work).

`services/chatStore.js` keeps chat mode's conversations in `<userData>/chats`:
an index (title, project folder, times) plus one file per chat with the
messages shown and the agent's history, so reopening a chat continues it.

## Simulator (`src/renderer/simulation/`)

The simulator runs the sketch's compiled firmware on an emulated AVR and wires it to parts on a canvas.

```
arduino-cli compile ──► app .hex ──► AvrRunner (avr8js) ◄──► CircuitEngine ◄──► part behaviors ──► canvas elements
                                       │ ports, timers, USART,     │ nets, voltages,      │ LEDs, LCDs, sensors,
                                       │ ADC, TWI, SPI, EEPROM     │ edges, I²C/SPI       │ motors, gates…
```

| Module | Role |
|---|---|
| `mcu.js`, `boards.js` | ATmega328P / ATmega2560 / ATtiny85 descriptions and the Uno, Nano, Mega 2560, Raspberry Pi Pico and ATtiny85 pin maps (PWM, analog, I²C, SPI, serial, interrupts), with each board's electrical levels (logic voltage, input threshold, pull-ups and pull-downs, ADC reference, pin limit). |
| `rp2040-runner.js`, `runners.js` | The Pico: an RP2040 from rp2040js behind AvrRunner's interface. It counts simulated time in the AVR's 16 MHz cycles so every part model's timing carries over, starts from the second-stage loader with the RP2040 boot ROM loaded, and maps USB CDC to Serial, UART0/1 to Serial1/2, and the I²C/SPI peripherals to the shared buses. `runners.js` picks the runner for a board; the simulator swaps it when the chip family changes. |
| `esp32-runner.js`, `src/main/services/esp32sim/` | ESP32 boards. The main process builds the sketch with a bridge (`impulse_sim.cpp`, wrapped in at link time: pin functions, LEDC, the RGB LED, pulseIn, I²C, the Wi-Fi driver), merges bootloader, partitions and app into a flash image, and runs it in Espressif's QEMU (`qemu.js` downloads it, or uses the copy bundled in the Mac app by `scripts/qemu-mac-pack.mjs`; `session.js` connects UART0 = Serial, UART1 = the bridge and the QEMU monitor over local sockets). `Esp32Runner` has AvrRunner's interface but follows the firmware's own clock from the bridge's timestamps: parts' timers fire as it passes, input levels, analog voltages and I²C replies go back over the bridge, slow PWM (servos) is replayed as timed edges. |
| `avr-runner.js` | Runs the CPU in real time (12 ms budget per frame), exposes pin states, ADC voltages, an I²C bus and an SPI bus, keeps EEPROM per board, handles the watchdog and RESET. On the ATtiny85 it adds Timer/Counter1 (`tiny-timer1.js`, the datasheet's fast PWM to OCR1C, which avr8js models as phase-correct), the analog comparator, and a software UART (`soft-uart.js`): TX is decoded from PB0 using the port write of each bit to measure the baud rate, and typed text is clocked into PB1, where the comparator's interrupt starts TinySoftwareSerial's receive. `usi.js` is the ATtiny85's USI: two-wire mode makes PB0/PB2 open drain and detects START and STOP, and `I2CPinBridge` plays the byte-level I²C devices on the pins (ACKs and data bits pulled onto SDA, which PINB reads see); three-wire SPI stays on the pins, so parts clock it in bit by bit (`spiByPins`). The ATtiny85 also passes its own CLKPR address to avr8js' clock, whose ATmega default (0x61) is SRAM on this chip. |
| `netlist.js` | Union-find nets plus nodal analysis per island: pull-ups, voltage dividers, shorts, and capacitors (backward Euler: a capacitor holds its voltage through an instant change and charges through its resistors). The engine steps an island with capacitors on the CPU clock while they move (about 20 mV per step, 20 µs to 20 ms), integrating each interval with the sources that held during it, and lands a step on each input pin's threshold crossing. |
| `engine.js` | Builds nets from wires, breadboard plugs and part internals; resolves every input pin; measures PWM duty and frequency; routes Arduino pin edges to `onPin` and any net level change to `onNet` (so gates can feed gates). |
| `parts/catalog.js` | Every part: label, category, search keywords, description, pins, editable props, live controls, libraries, behavior, Wokwi aliases. `parts/pins.js` holds pin positions captured from the rendered elements for headless use. |
| `parts/*.js`, `devices/*.js` | Behaviors (basic, displays, input, sensors, motion, power, logic, modules) and protocol models (HD44780, SSD1306, ILI9341, WS2812, DHT, DS18B20 1-Wire, TM1637, MAX7219/74HC595, NEC IR, DS1307/MPU6050 registers). |
| `elements/` | Custom elements for parts not in `@wokwi/elements` (breadboards, chips, gates, modules), drawn in millimetres on the 0.1" grid. |
| `canvas.js` | Wiring canvas: placement, rotation, wiring with waypoints, breadboard plugging, selection, zoom. |
| `diagram.js` | Wokwi-compatible `diagram.json` read/write, routing hints, breadboard plug detection. |
| `search.js`, `ui/` | Part picker (search with typo tolerance, synonyms and advice for things that aren't simulated), inspector, examples gallery. |
| `examples.js` | Example projects (sketch + circuit); each is compiled and run by the test suite. |
| `headless.js`, `expectations.js` | Runs firmware without a DOM for hardware tests (`// @expect …`) and AI verification. |
| `dwarf.js`, `debugger.js` | Source-level debugger. `dwarf.js` reads the line table, functions, variables, types, location lists and call frame information (DWARF 2–4) straight from the ELF. `debugger.js` maps flash words to sketch lines, stops the CPU between instructions through `AvrRunner.stopCheck` (breakpoints, step into/over/out by line and stack depth, run to cursor) evaluates DWARF location expressions to show locals, globals and registers, and unwinds the call stack from `.debug_frame` (callers' locals use the call-saved registers of the avr-gcc ABI). |
| `index.js` | `SimulationManager`: toolbar, board switching, persistence (diagram.json next to the sketch), circuit checks, serial pane, logic analyzer, debugger session, AI circuit builder and agent loop. |

Debug builds (`arduino:compile-debug`) use `-Og` without link-time optimization, in a build folder of their own, because LTO folds most of a sketch's line information away. Breakpoints live in the editor (`src/renderer/breakpoints.js`) per file and survive restarts.

PlatformIO projects (`src/main/services/platformio.js`): `ArduinoService` hands any sketch path inside a folder with `platformio.ini` to `pio`, so Verify, Upload, the simulator, the debugger and the AI tools work unchanged. Environments come from `pio project config`; debug builds strip `-Os` and LTO through `PLATFORMIO_BUILD_UNFLAGS` in a build folder of their own.

`src/cli/impulse-test.js` (`bin/impulse-test.mjs`) runs the same headless simulator from the command line for CI; see docs/TESTING.md.

Circuits are saved as `diagram.json` beside the sketch. Opening an example writes the sketch and its diagram to `<sketchbook>/Impulse Examples/<name>/`.

## Impulse Cloud (`cloud/`)

A Hono app (deployed on Vercel with zero configuration from `src/index.js`;
`npm run dev` locally) on Postgres:

- Accounts with Better Auth (`src/auth.js`): Google, GitHub, email + password
  with a 6-digit emailed code; sessions double as bearer tokens for the app;
  roles and suspensions for the admin console.
- Credits (`src/credits.js`): an append-only ledger in millicredits with a
  plan bucket (the monthly allowance, refilled each period) and a bonus bucket
  (welcome, granted and bought credits that never expire); `src/pricing.js`
  turns Anthropic's reported usage into credits (list price × markup).
- The AI gateway (`src/gateway.js`): an Anthropic-compatible
  `POST /ai/v1/messages`. Each request is checked (signed in, verified, not
  suspended, model on the plan, credits left, per-minute rate, daily budget),
  sanitised (known fields only, server-side tools refused, `max_tokens`
  capped), forwarded with Impulse's key, streamed back unchanged and charged
  from the usage in the stream; a stopped stream is charged for what it used.
- The account API (`/v1/*`), the admin API and console (`/admin/`, with an
  audit log), the desktop sign-in hand-off (`src/desktop.js`, PKCE) and the
  web pages (`public/`). Business settings (plans, prices, limits, maintenance,
  announcement) live in the database and change from the console.

See `cloud/README.md` for running and deploying it.

## Data Flow

### Compile Flow
```
User clicks "Verify"
      ↓
renderer.js: compileSketch()
      ↓
IPC: 'arduino:compile'
      ↓
main.js → arduinoService.compile()
      ↓
arduino-cli compile --fqbn xxx
      ↓
Result → renderer
      ↓
Display in console/problems
```

### AI Query Flow
```
User sends message
      ↓
renderer.js: sendAIMessage() → morph-orb: the pill folds into a ball and flies up into the chat
      ↓
IPC: 'ai:process-query'
      ↓
agent.js → Provider (OpenAI/Gemini/Claude)      ── 'ai:step' (each model call, each tool) → the orb's label
      ↓
LLM returns tool calls
      ↓
toolExecutor.execute() → arduinoService/serialMonitor
      ↓
Results → LLM → Final response
      ↓
morph-orb: the orb turns green (red on an error), condenses and unfolds
into the answer card, which stays in the chat; the pill comes back
```

`morph-orb/morph-orb.js` is a plain-DOM port of the MorphOrb React component:
the same timelines, easing and dotted-orb canvas renderer, laid out in the
panel (the pill's home is the composer slot, the orb's spot a spacer after the
question), with light and dark palettes and reduced-motion cross-fades. The
card unfolds into the real message's box and hands over to it at 700 ms.

## IPC Channels

### Arduino
- `arduino:compile` - Compile sketch
- `arduino:upload` - Upload to board
- `arduino:list-boards` - Get boards
- `arduino:list-ports` - Get ports
- `arduino:check-cli` - Check CLI status

### Serial
- `serial:connect` - Open port
- `serial:disconnect` - Close port
- `serial:send` - Send data
- `serial:list-ports` - List ports
- `serial:data` (event) - Incoming data

### Simulator
- `arduino:compile-hex` - Compile for a simulated board and return the application HEX
- `arduino:compile-debug` - Debug build (-Og, no LTO): HEX, ELF and the sketch folder's paths
- `platformio:project` / `platformio:select-env` - The PlatformIO project of a file, its environments, and the one to build
- `esp32sim:status` / `esp32sim:install` - Whether the ESP32 emulator is installed, and installing it (progress on `esp32sim:progress`)
- `esp32sim:start` / `esp32sim:send` / `esp32sim:write` / `esp32sim:control` - Run a built ESP32 image, talk to its bridge and Serial, pause/resume/reset/stop it (output on `esp32sim:event`)
- `esp32sim:chip-of` - The chip (build.mcu) of an ESP32-family board, from the installed core

### Source control
- `git:status` / `git:init` / `git:diff` / `git:identity` / `git:commit` / `git:log` / `git:push` / `git:pull` - The system's git for a folder the user opened (`services/git.js`): argument arrays, no shell, no interactive prompts (`GIT_TERMINAL_PROMPT=0`), file paths confined to the repository
- `sketch:create-example` - Write an example sketch and its `diagram.json` into the sketchbook
- `dialog:open-diagram` / `dialog:save-diagram` - Import and export circuits
- `ai:generate-circuit` - Build a circuit for the current sketch
- `ai:verify-execution` - Judge a simulated run (board, wiring, serial, pins) and propose a fix

### AI
- `ai:process-query` - Send query (modes: agent, plan, debug)
- `ai:set-model` - Choose a model (`impulse:…` needs a signed-in account; Claude and OpenAI lanes are picked by model id)
- `ai:analyze-error` - Analyze error
- `ai:get-history` / `ai:set-history` - The agent's conversation, saved with each chat

### Account and chats
- `cloud:status` / `cloud:refresh`, `cloud:status` (event) - The signed-in account, its plan and credits
- `cloud:sign-in-email` / `cloud:sign-up-email` / `cloud:verify-email` / `cloud:resend-code` / `cloud:request-password-reset` / `cloud:reset-password` - Email accounts
- `cloud:sign-in-provider` / `cloud:cancel-sign-in` - Google or GitHub through the browser
- `cloud:sign-out` / `cloud:usage` / `cloud:plans` / `cloud:models` / `cloud:request-upgrade` / `cloud:open-admin`
- `chats:list` / `chats:get` / `chats:save` / `chats:rename` / `chats:delete` - Saved chats
- `sketch:create-project` - A new chat's project folder in the sketchbook's "Impulse Projects"

## UI Components

### Chat mode (`src/renderer/vibe/`)

The default view (the Chat | IDE switch, ⌘E): one conversation with the
agent (Agent, Plan and Debug), the board chip, a side panel with the simulator,
the serial monitor and the code (the same live circuit and the same editor
document as the IDE), saved chats with the project folders they build, and
the account (sign-in, credits, plans). `vibe/index.js` drives the IDE through
`window.impulse` (defined at the end of `renderer.js`), so both views always
show the same state; the IDE's chat panel shows the same conversation.
`char-field.js` draws the empty state's field of firmware hex (WebGL2, 30 fps)
and runs only before the first message. Design decisions: `docs/design/chat-mode.md`.

### Sidebar
- File selection
- Board dropdown (populated from CLI)
- Port dropdown (auto-detected)
- Verify/Upload buttons
- Serial controls

### Code Editor
- CodeMirror with C/C++ syntax
- Dark theme (Dracula)
- Line numbers
- Bracket matching

### Output Panel
- **Console**: Build output, logs
- **Serial Monitor**: Real-time data
- **Problems**: Errors with suggestions

### AI Panel
- Provider selector
- Chat interface
- Tool execution feedback

## Configuration

### package.json Dependencies
```json
{
  "electron": "^27.0.0",
  "serialport": "^12.0.0",
  "openai": "^4.20.0",
  "@anthropic-ai/sdk": "^0.20.0",
  "@google/generative-ai": "^0.2.1",
  "electron-store": "^8.1.0"
}
```

### Build Configuration
```json
{
  "build": {
    "appId": "com.arduinoidecursor.app",
    "productName": "Impulse IDE",
    "win": { "target": "nsis" }
  }
}
```

## Error Handling

1. **FQBN Validation**: Ensures format `vendor:arch:board`
2. **Port Detection**: Falls back to empty list
3. **Board List**: Provides defaults if CLI fails
4. **AI Errors**: Graceful fallback messages
5. **Memory Errors**: Operations continue without persistence

## Security

- Context isolation enabled
- No direct Node.js in renderer
- Preload bridge for IPC
- The Impulse session token is encrypted with the OS credential store; the AI key exists only on Impulse Cloud
- No shell injection (validated inputs)

## Getting Started

1. Install Arduino CLI
2. `npm install`
3. `npm start`
4. Select board and port
5. Open sketch
6. Verify/Upload
7. Use AI for help

## Future Improvements

- [ ] Multiple file support
- [ ] Library manager
- [ ] Board manager
- [ ] Git integration
- [ ] Sketch templates
- [ ] Auto-complete for Arduino
- [ ] Live error detection

