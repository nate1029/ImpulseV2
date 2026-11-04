# Impulse harness: backend architecture plan

Status: **plan for discussion**, written 2026-10-18. Nothing in this document is
built. It exists so we agree on the shape of the backend before any of it is
designed in detail. Sections 7 and 8 list the order of work and the decisions
only the owner can make.

The reference points are the open-source **DeepSeek Harness** (`dsh`,
MIT, github.com/deepseek-ai/deepseek-harness) and the paper it belongs with,
*Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents*
(arXiv 2609.00006). Impulse takes the anatomy and a handful of their design
decisions, and leaves out everything that exists to run many general-purpose
agents at once. Impulse is one agent, for one domain (embedded), on one
machine, and that is what makes it cheaper to run.

---

## 0. Summary

- **Where we are.** The product surface is done: chat mode and the IDE both
  ship, the simulator covers AVR, RP2040 and ESP32 boards, accounts and
  credits are built and tested. The AI agent is a *minimal* harness: one loop,
  28 tools always loaded, a 40-message window, no verification before it says
  "done". Impulse Cloud is a metered proxy that knows nothing about Arduino.
  Nothing is deployed yet.
- **What to build.** Keep the agent loop in the desktop app (the tools touch
  the user's hardware), and give it the five things a real harness has: one
  request-assembly step that chooses prompt sections *and* tools per mode,
  typed and bounded tool results, token-pressure compaction that prunes before
  it summarises, a verify-before-done guard, and an append-only chat event log.
- **Token efficiency.** Measured today: ~2.2K fresh input, ~14K cache-read and
  ~1K output tokens per model call. The plan targets 35–50% fewer fresh input
  tokens per call (tool tiers, split prompt, bounded results) and fewer calls
  per task (the verify guard, structured results), without dropping the cached
  prefix below the provider's minimum cacheable length.
- **Multi-device projects.** A project file that lists devices, their boards,
  sketches and ports, plus a shared *contract* (the ESP-NOW message struct,
  channel, peer addresses). One deterministic coordinator runs the same loop
  once per device, in sequence, each with only its own board facts in context.
  No parallel agents.
- **Board knowledge.** Yes, add a layer, but a compact structured one: the
  installed core already gives exact pin maps for free; what the model lacks
  are board *quirks* and *core-version API drift*. One record per board
  (~400 tokens, only the selected board is injected) for ~100 boards, kept
  true by CI probe compiles. Not datasheets in a vector store.
- **Diagnosis.** A deterministic, evidence-first fault locator: toolchain
  health → compiler → simulator-versus-hardware → static circuit checks →
  serial and sensor-value signatures → an optional *Impulse Probe* firmware
  that measures the real circuit. The model turns symptoms into structure and
  writes the verdict; it does not guess the fault from raw logs.

---

## 1. Where Impulse stands today

### 1.1 Frontend (Electron renderer, vanilla JS + Vite)

| Area | State |
|---|---|
| Chat mode (`src/renderer/vibe/`) | Shipped. Default view; plan / build / debug in one conversation; Chat / IDE switch (⌘E); sign-in, credits and plans in the side panel; saved chats; WebGL character field with the click ripple. Every ripple number is a slider in `docs/design/field-lab.html` (owner's settings still to come). |
| IDE (`renderer.js`) | Shipped, unchanged in behaviour; the `window.impulse` bridge lets chat mode drive the same editor, board, simulator and agent. |
| Simulator (`src/renderer/simulation/`) | AVR (Uno, Nano, Mega, Leonardo and the 32U4 boards, ATmega8, ATtiny85, Gemma), RP2040 (Pico), ESP32 / S3 / C3 (Espressif QEMU; S2 runs as S3). 91 parts, 42 examples. A real circuit engine (`netlist.js`: nets, DC operating point, RC transients), **static circuit checks** (`checks.js`: missing resistors and power, floating inputs, I²C clashes, batteries on pins, shorts), **hardware expectations as sketch comments** (`expectations.js`: `// @expect serial contains "ready"`, `// @expect pin 13 toggles`), a headless runner, logic analyser, source-level debugger. |
| Hardware I/O | arduino-cli compile and upload, serial monitor with baud auto-detection and auto-reconnect, plugged-in board detection (`board-detect.js`), PlatformIO projects (`platformio.ini` with several environments: build and upload only). |
| Quality gates | lint, 451 Jest tests, smoke, e2e (19/19), `impulse-test` CLI for CI. All green at the last run. |

### 1.2 Backend in the app: the AI agent (`src/main/services/ai/`)

This is the part the rest of this document is about.

| Piece | Today |
|---|---|
| Loop (`agent.js`) | One `while` loop, max 10 iterations, temperature 0.7; modes agent / plan / debug / ask. Effort `high` (plan and ask: `medium`). |
| Providers | Two lanes through Impulse Cloud with the account token: `impulse-openai` (GPT-5 models, OpenAI's Responses API: the one that runs function tools with reasoning) and `impulse` (Claude models). Local models were removed on 2026-10-18 at the owner's request: paid API only. Prompt caching on every request on both lanes. |
| Tools | 28, **all loaded on every request** (~2,450 tokens): compile, upload, boards, ports, 9 serial tools, 7 editor tools, memory, knowledge, playground. Plan mode 11, debug 3, ask 0. Dispatch is one `switch`; results are free text. |
| Prompt | System ~1,590 tokens; plan +285, debug +128, ask +72. Board facts (`boardKnowledge.js`, from the installed core's `boards.txt` and `pins_arduino.h`) appended to the system message on every request, recomputed through arduino-cli with an 8 s timeout. |
| Memory | Sliding window of 40 messages, then a model-written summary (`summarizeAndCompact`). `SimpleMemory` (JSON) and `errorMemory` (fixes that worked). |
| Verification | `agentVerify.js` ("observe & fix": compile status + simulator serial + pin activity → corrected sketch) exists but is a separate call, not part of the loop. `circuitGenerator.js` turns a sketch into a circuit. |
| Measured cost | Per model call: ~2.2K fresh input, ~14K cache-read, ~1K output tokens; 6.1–6.6 s. |
| Missing | Deferred tool loading, token-based compaction, bounded tool output, typed results, a verify-before-done guard, per-task cost accounting, an eval set, sessions as an event log, any notion of more than one device. |

### 1.3 Impulse Cloud (`cloud/`)

Hono + Postgres, deployable on Vercel. Built and tested (47 tests against a
scratch Postgres), **not deployed**. It is a *metered proxy*:

- `/ai/v1/messages`: Anthropic-compatible. Checks account, plan, credits, rate
  and the daily budget; forwards with Impulse's own key; streams back unchanged;
  reads usage out of the stream and charges real tokens (input, output, cache
  read, cache write at 1.25×/2×). Every call is a row in `usage_event` with
  model, tokens, cost and the client tag. This table is the measuring
  instrument for everything in section 3.4.
- Credits ledger (millicredits; plan and bonus buckets), pricing per model
  (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1), admin console (users, grants,
  bans, settings, budget), account API, desktop sign-in pages.
- The cloud knows nothing about Arduino, boards or sketches. All intelligence
  is in the app.

To go live it needs the owner: a Neon project, a Vercel project with root
`cloud`, Google and GitHub OAuth apps, Resend, and the env vars in
`cloud/.env.example` (runbook: `cloud/README.md`). Payments (Stripe) and
self-service account deletion are not built.

### 1.4 Authentication and accounts

Better Auth: Google, GitHub and email one-time code; bearer sessions; admin
roles and bans. The desktop signs in through the browser with a loopback port
and PKCE and keeps the token in Electron `safeStorage`. Works end to end
against the local dev stack. Not live, because the cloud is not deployed.

### 1.5 Maturity at a glance

| Layer | Built | Verified | Live |
|---|---|---|---|
| Frontend: chat mode + IDE | ~95% | lint / tests / smoke / e2e | installed app |
| Simulator | broad; no radios, no multi-MCU | tests + examples | yes |
| Agent harness | ~40% (works, minimal) | unit tests, no eval set | yes |
| Impulse Cloud | ~85% (no payments, no deletion) | 47 tests | **no** |
| Auth + accounts | ~90% | tests + local end-to-end | **no** |

---

## 2. What DeepSeek Harness is, and what Impulse takes from it

### 2.1 The anatomy

The paper's claim is *Agent = Model + Harness*, and every coding agent it
surveys decomposes into seven subsystems plus two cross-cutting surfaces:

1. **Agent loop** (the step cycle, stop conditions)
2. **LLM integration** (adapters, streaming, caching, routing)
3. **Tools & actions** (registry, schemas, execution, output bounding)
4. **Memory & context** (window management, compaction, project memory)
5. **Safety & permissions** (what needs consent, what is sandboxed)
6. **Orchestration** (sub-agents, workflows, parallelism)
7. **Extensibility** (plugins, hooks, skills)

plus the **interface layer** (how the user sees steps) and the **session
substrate** (how a conversation is stored and resumed). Impulse's agent today
has 1, 2, 3 and a thin 4; the rest is absent or implicit. Section 3 fills in
each one for Impulse.

### 2.2 Decisions in `dsh` worth copying

`dsh` is a TypeScript monorepo of ~45 packages on the Cordis microkernel
("everything is a plugin"). Its architecture notes (`.agents/notes/`) record
the decisions. These are the ones that transfer:

| `dsh` decision | Why it matters | Impulse version |
|---|---|---|
| **Prompt assembly owns the tool list.** `PromptAssembly { sections, tools }` is one waterfall; plan mode and tool filtering are an *assembly rewrite*, not two separate seams. | Everything the model is told up front is decided in one place, so token budgets are enforceable. | `assembleRequest(mode, context)` returns `{ system[], tools[] }`. Tool tiers (§3.3) and board facts are rules in that one step. |
| **Compaction = token meter + pressure policy; prune tool results before summarising.** Threshold ratio 0.8, retained tail 0.16, a model-free pruner first, one summary call only if still over; context-overflow errors retry once after a visible change. | Most context bulk is tool output (compiler logs, serial). Deleting it costs no model call. | Token-based pressure replaces the 40-message window; compile and serial results get pruned to a one-line digest first; the summary call is the last resort. |
| **Output retention library.** Head / tail / head-and-tail with *exact* omission counts; tools own the wording of the "narrowed" notice. | Bounded results, and the model knows what it did not see. | `retain(text, {strategy, bytes})` used by compile (head+tail), serial (tail), searches (head N). |
| **Canonical tool output contract.** Every tool returns a typed value; a pure `render()` projects it to model text; UI and policy read the value. | The model never has to parse prose; the UI gets structure for free (diagnostics → Problems panel). | Tools return `{ value, render() }`. Compile returns structured diagnostics; serial returns lines with timestamps; the diagnosis tool returns an evidence sheet. |
| **Structured error taxonomy.** One `HarnessError` base with a stable `code`; tool results carry `{ name, code }` into the session log. | Diagnosis (§6) routes on codes, not on message substrings. | `ImpulseError` codes: `COMPILE_ERROR`, `CORE_MISSING`, `PORT_BUSY`, `PORT_GONE`, `UPLOAD_SYNC`, `UPLOAD_BOOTMODE`, `SERIAL_TIMEOUT`, `CREDITS_EXHAUSTED`, … |
| **Event-sourced sessions.** The session is an append-only log of turns, steps, tool calls and results; the visible conversation is a projection; compaction is itself an event. | Resume exactly, debug user reports, measure cost per task, never lose a tool result on a crash. | `chatStore` keeps a JSONL event log per chat; the transcript the UI shows is derived from it. |
| **Turn enclosure invariant.** Every durable tool call gets a result, even on cancel (a synthetic aborted result). | No dangling calls that break the next request. | The loop writes an aborted result for undispatched calls when the user stops it. |
| **Agent-scope contexts.** Shared infrastructure, per-agent registration layer (tools, prompt sections) with a persona, a tool filter and a depth limit. | Scoping is how a device agent in a multi-board project sees *only* its own board. | Used for §4, but as *sequential* scopes, not concurrent agents. |
| **Timeouts as a library; cooperative cancellation.** | Compile, upload and serial are the operations that hang. | Every tool call has a deadline from the assembly step; the existing `signal` is passed through. |

### 2.3 What Impulse deliberately leaves out

| In `dsh` | Why not in Impulse |
|---|---|
| Cordis microkernel, plugin market, dynamic plugin loading | Impulse is one product with one tool set. A small internal registry (tools, prompt sections, knowledge sources) gives the same seams at a fraction of the complexity. |
| Sub-agents, workflows, "ralph" loops, parallel orchestration | The owner's call: embedded work is sequential (compile → upload → observe). Parallel agents multiply tokens and make cost unpredictable. Multi-device projects use one coordinator and one loop at a time (§4). |
| PTC runtime (Python tool calling), browser-use, computer-use, LSP, MCP server, SSH, sandbox, scheduler | Not embedded concerns. |
| Web UI, desktop host, ACP | Impulse has its own UI. |
| Zstandard session logs, multi-GB session benchmarks | Chats are small; plain JSONL is enough. |

---

## 3. Target architecture

### 3.1 Principles

1. **One loop, narrow context, typed observations.** The model sees a short,
   stable prefix and bounded, structured results. Everything deterministic
   stays out of the model.
2. **Measure before and after.** `usage_event` already records tokens per
   call; add a task id so cost per *task* is a query, and keep a small eval
   set so changes to prompts and tools are checked, not felt.
3. **Verify before "done".** The harness, not the model, decides that a build
   step is finished: the code compiles, and when the board is simulable the
   expectations hold.
4. **Deterministic first, model second.** Classification of errors, fault
   location, device/port mapping and contract consistency are tables and
   checks; the model explains and fills gaps.
5. **Works offline, except the model.** Everything the harness needs (prompt,
   tools, knowledge) ships in the app; the cloud updates it, never gates it.
   The model itself runs through Impulse Cloud on the account's credits.

### 3.2 Where the harness lives

**Recommendation: the agent loop stays in the desktop app (main process).**
The tools act on local hardware (serial ports, arduino-cli, the simulator in
the renderer); a cloud-hosted loop would need a tool-callback channel back to
the app and add a round trip per step. The cloud
remains the gateway, accounts and credits, and gains three things:

- a **harness manifest**: versioned prompt sections, tool descriptions and
  knowledge records the app fetches at start-up and caches, with the bundled
  copy as the offline fallback. Prompt and knowledge fixes ship without an app
  release;
- **cost per task** in `usage_event` (an `x-impulse-task` header the gateway
  stores next to the client tag it already keeps);
- later, **opt-in aggregated fix memory** (which fix resolved which error
  signature on which board) — a privacy decision for the owner (§8).

### 3.3 The seven subsystems in Impulse

**1. Agent loop.** Keep the single loop. Add: a step budget per mode (ask 1,
plan 4, debug 8, agent 12); the verify-before-done guard (if the sketch
changed since the last compile, compile without asking the model; if the
board is simulable and the task has expectations, run headless; feed the
result back as one more observation); the turn-enclosure rule on cancel; a
per-task id that every event and gateway call carries.

**2. LLM integration.** Providers stay. Add a token meter fed by the usage the
gateway already streams back (exact, not estimated); a stable prefix order
(static system → mode section → board facts block → tools) so the cache hits
every step; model routing by step kind (section 3.4); and the manifest-driven
prompt text.

**3. Tools & actions.** Tool *tiers*, decided in the assembly step:

| Tier | Tools (proposed) | Loaded |
|---|---|---|
| Core | `get_current_state`, `read_code`, `edit_code`, `compile_sketch`, `upload_sketch`, `read_serial`, `get_board_info`, `get_component_guide`, `load_tools` | always (≈9 tools, ~0.8K tokens) |
| Serial pack | one `serial` tool with `action` = connect, disconnect, send, set_baud or auto_baud (replaces 9 tools) | debug mode, or on request |
| Knowledge pack | `search_boards`, `get_mcu_guide`, `list_boards`, `list_ports` | plan mode, or on request |
| Project pack | `save_sketch`, `sketch_path`, `set_editor_code`, `project_devices` (§4) | agent mode when a project exists |
| Verification pack | `run_simulation` (headless + expectations), `circuit_check`, `diagnose` (§6) | debug mode, verify guard |
| Memory pack | `search_memory`, `record_fix` | debug mode |
| Playground | `update_playground` | playground open |

Every tool returns a typed value with a renderer and an error code, and
bounds its text with the retention helper. Expected: 28 tools / ~2.4K tokens
→ 9 + one pack / ~1.0K tokens on a typical step.

**4. Memory & context.** Three layers: (a) the turn context, managed by token
pressure with pruning first; (b) **project memory**, a short block from the
project file (boards, devices, pins in use, decisions made) injected per
request instead of being re-derived; (c) **fix memory** (`errorMemory`), local
today, aggregated later if the owner opts in. Board facts cached on disk per
`fqbn` and core version instead of an arduino-cli call per request.

**5. Safety & permissions.** Side effects on hardware are explicit: upload
needs a successful compile for the *selected* board and a confirmed port
(policy in §8: auto after compile, or always ask). Serial `send` is logged.
File writes stay inside the sketch or project folder. Each turn shows an
estimated and then actual credit cost. The gateway's daily budget and
per-user rate limits remain the backstop.

**6. Orchestration.** A **coordinator**, not an agent: a deterministic state
machine that runs *plan → per-device build → per-device verify → per-device
upload → cross-device verify*, one device at a time, each in a scoped
context. Described in §4.

**7. Extensibility.** A small internal registry for tools, prompt sections and
knowledge sources, filled from the bundle and the manifest. Not a public
plugin system in v1; component and board records are the extension point
(community contributions as data, reviewed, not as code).

**Interface layer.** Chat mode already renders steps; it gains the device
tabs for multi-device projects, the evidence sheet view for diagnosis, and
the cost line per turn.

**Session substrate.** The JSONL event log per chat (§2.2), with the
transcript as a projection; `chatStore` keeps the index.

### 3.4 Request assembly and the token budget

| Block | Today | Target | How |
|---|---|---|---|
| System prompt | ~1.6K, one string | ~1.2K static (cached) + 0.1–0.3K per mode | Split; move rarely needed guidance into tool descriptions and knowledge fetched on demand. |
| Tool schemas | ~2.4K, 28 tools, every request | ~0.8–1.0K | Tiers + `load_tools`; fold the 9 serial tools into one. |
| Board facts | recomputed per request, size varies | same content, own cached block, from disk | Cache per fqbn + core version; one block after the mode section. |
| Tool results | raw (a compiler log can be tens of KB) | compile: structured diagnostics + 2 KB head/tail; serial: last 2 KB; searches: first N | Retention helper + typed values. |
| History | 40 messages, then one summary | pressure threshold (~65% of a per-mode budget), prune results, then summarise | Token meter from gateway usage. |

Expected effect: fresh input per step down 35–50%; steps per task down
because the verify guard replaces "did it compile?" round trips; cache-read
share up because the prefix is stable. Two cautions: the cached prefix must
stay above the provider's minimum cacheable length for the cheapest routed
model (1–2K tokens), or caching stops paying; and every estimate here is to
be confirmed against `usage_event` before and after (that is Phase 0).

**Model routing by step kind** (the gateway already prices per model):

| Step | Model | Why |
|---|---|---|
| Chat title, symptom structuring, summaries, classification | Haiku 5.5 | Cheap, deterministic-ish tasks |
| Build and edit steps | Sonnet 5.5 (default), Opus 5.5 on request | Quality per credit |
| Diagnosis verdicts, multi-device planning | Opus 5.5 / Fable 5.1 | Where reasoning depth pays |

### 3.5 Sessions: the chat event log

One JSONL file per chat: `turn/start`, `step/request` (model, token counts,
cache stats), `tool/call`, `tool/result` (rendered text, error code, bytes
omitted), `compaction/summary`, `turn/end`, plus `project/*` events for
multi-device state. The visible transcript is derived. Benefits: exact resume
after a crash, reproducible bug reports (the problem reporter can attach a
redacted log), cost per task from the log alone when offline.

---

## 4. Multi-device projects

### 4.1 What exists

One sketch, one board, one port, one serial monitor. PlatformIO projects with
several `[env:…]` sections build and upload per environment, which is the
only multi-board shape Impulse understands today. The simulator runs one MCU.

### 4.2 The project model

A project is a folder with `impulse.json`:

```json
{
  "name": "garden-link",
  "devices": [
    { "id": "sender",   "board": "esp32:esp32:esp32", "sketch": "sender/sender.ino",
      "role": "reads the soil sensor and sends readings every 10 s",
      "port": { "usbSerial": "0001ABCD", "last": "/dev/cu.usbserial-0001" } },
    { "id": "receiver", "board": "esp32:esp32:esp32", "sketch": "receiver/receiver.ino",
      "role": "receives readings and shows them on the OLED" }
  ],
  "contracts": [
    { "kind": "espnow", "file": "shared/protocol.h", "channel": 1,
      "message": "struct Reading { uint16_t moisture; float temp; uint32_t seq; }",
      "peers": { "receiver": "read from its serial after upload" } }
  ]
}
```

The **contract** is the single source of truth both sketches include
(`shared/protocol.h`): message struct, channel, pin assignments of any wired
link (UART, I²C) between boards. Generated once, in the plan step; every
device's build step sees the contract, not the other device's code.

### 4.3 Understanding complexity

A deterministic classifier runs before planning, with Haiku asked only when it
is unsure:

| Signal | Source |
|---|---|
| "two", "pair", "sender/receiver", "master/slave", "node/gateway", "mesh", ESP-NOW, LoRa, nRF24, RS-485, "between two boards" | the request |
| More than one board part, or a programmable part (ATtiny, ESP-01, an Arduino as I²C slave) in the drawn circuit | the simulator's parts catalog |
| Several `[env:…]` sections | `platformio.ini` |
| Radios, buses between boards, number of parts, several power domains | the plan |

The result is a tier that sets the step budget, the model and whether to ask
first:

- **S** — one board, one sketch, parts the catalog knows. Build directly.
- **M** — one board, a bus or display with a library, or expectations the
  simulator can check. Build, then verify in the simulator.
- **L** — two or more devices, or a radio, or hardware the simulator lacks.
  Plan mode first (devices, contract, open questions), then the coordinator.

### 4.4 The sequence, with the ESP-NOW pair as the worked example

1. **Plan** (one model call, L tier): devices, roles, boards, the contract.
   Shown to the user as a plan; they confirm or edit.
2. **Scaffold**: `impulse.json`, one sketch folder per device,
   `shared/protocol.h`. Deterministic.
3. **Build device by device**, each in a scoped context: the core tools, the
   project pack, the board facts *of that board only*, the contract, the
   device's role, a one-paragraph summary of the other devices. The verify
   guard compiles. If the board is simulable, headless run against the
   device's expectations (e.g. the receiver prints `impulse:receiver` and its
   MAC on boot).
4. **Upload the receiver**, read its serial for the boot banner and MAC (a
   deterministic read with a deadline), **write the MAC into the contract**,
   rebuild the sender, **upload the sender**.
5. **Cross-device verify**: with both ports open, expect the receiver's serial
   to show `received seq=1…` within N seconds. Pass → done. Fail → the
   diagnosis flow (§6) with both devices' evidence.

The data-dependent step (MAC from one device into the other's build) is why
the coordinator is a state machine and not a prompt: it is the same every
time, and it is where a model would otherwise burn tokens re-deriving it. A
first version can use the broadcast address and skip step 4's read.

### 4.5 Uploading to the right board, every time

- Devices remember their port by **USB serial number** (and VID:PID), not by
  path: macOS paths change between plugs, and two identical devkits look the
  same except for the serial number.
- When two identical boards are connected and unassigned, Impulse asks once
  ("plug in only the SENDER now, or tell me which port") and remembers.
- After every upload, the boot banner (`impulse:<deviceId> <sketch hash>`)
  confirms which device got which build. Mismatch → stop and say so.
- One serial monitor **per device** (`SerialMonitor` is already a class;
  instantiate per port), with the chat showing a tab per device.

### 4.6 Simulating several devices

Feasible now: each device runs headless on its own against the contract and
its own expectations. Not now: a virtual radio between two QEMU instances
(ESP-NOW/Wi-Fi), or wired links between two emulated MCUs. The plan treats
multi-MCU simulation as a later phase and relies on the real hardware step
(4.4 step 5) for cross-device verification. This is a decision for the owner
(§8).

---

## 5. Board knowledge layer

### 5.1 What the installed core already gives us

`boardKnowledge.js` reads `boards.txt` and the variant's `pins_arduino.h` of
the installed core: exact digital/analog pin counts, PWM pins, I²C/SPI/UART
pins, LED_BUILTIN, flash and RAM, F_CPU, the board's menu options. This is
authoritative and free; no scraped documentation can beat it for pin numbers.
`mcuGuide.js` (24 chip families) and `components.js` (65 parts) add the
how-to layer.

### 5.2 What it does not give us

The failures models actually produce come from what is *not* in the core:

- **Pin quirks**: ESP32 strapping pins (GPIO 0, 2, 12, 15), input-only pins
  (34–39), flash pins (6–11), ADC2 unusable while Wi-Fi is on, pins taken by
  onboard peripherals (NeoPixel, display, SD, PSRAM), 3.3 V logic on a board
  users treat as 5 V-tolerant.
- **Upload procedure**: hold BOOT, 1200-baud touch for native USB, DTR reset,
  BOOTSEL + UF2, the ESP32-S3 "USB CDC On Boot" option (off → no serial on the
  native port; a very common "nothing on serial" cause that is *board options*,
  not code).
- **Power and radio**: current limits of the 3.3 V regulator, brownout with
  motors, ESP-NOW channel rules, long-range mode, antenna variants.
- **Core-version API drift** — the single biggest cause of compile errors in
  model-written code. Examples: ESP32 Arduino core 3.x changed the ESP-NOW
  receive callback signature (`esp_now_recv_info_t*` instead of the MAC
  pointer) and replaced `ledcSetup`/`ledcAttachPin` with `ledcAttach`; Pico
  cores differ (Arduino Mbed vs Earle Philhower) in Wi-Fi and PIO APIs. The
  installed core version is known, so this can be looked up, not guessed.
- **Library choice**: which library a part needs, which fork, which
  constructor on which board.

### 5.3 Recommendation

Add the layer as **compact, structured, retrieved on demand**, not as
documents in the prompt:

- `knowledge/boards/<id>.json`, one record per board, ~40–80 lines (~300–600
  tokens): identity (fqbn aliases, USB VID:PID, PlatformIO id), pin quirks,
  onboard peripherals and the pins they take, upload procedure and the board
  options that matter, power and radio facts, library notes.
- `knowledge/cores/<core>@<major>.json`: the API-drift table per core major
  version (what changed, the old and new call, the compiler error it causes).
- Injection: the core-derived facts (authoritative for pin numbers) merged
  with the **selected board's record only** and the installed core's drift
  entries, as one cached block. Other boards through `search_boards`.
- Versioned in the harness manifest, so a wrong fact is fixed server-side the
  same day; bundled copy for offline.

Not recommended: datasheets or vendor docs in a vector store. It costs tokens
on every retrieval, goes stale, and the compile errors we are preventing come
from API drift and quirks, not from missing datasheet pages.

### 5.4 The ~100 boards (proposed, by family)

| Family | Boards |
|---|---|
| Arduino AVR | Uno R3, Nano, Nano Every, Mega 2560, Leonardo, Micro, Pro Mini 5 V/3.3 V, Pro Micro, Uno WiFi Rev2 |
| Arduino (SAMD / Renesas / Nano) | Uno R4 Minima, Uno R4 WiFi, Nano 33 IoT, Nano 33 BLE / BLE Sense, Nano RP2040 Connect, Nano ESP32, MKR WiFi 1010, MKR Zero, GIGA R1 |
| ESP32 devkits | ESP32 DevKit V1 (DOIT), WROOM-32 NodeMCU, WROVER kit, ESP32-S2 Saola, ESP32-S3 DevKitC-1, ESP32-C3 DevKitM-1, ESP32-C6 DevKitC-1, ESP32-H2, ESP32-CAM, ESP-01 |
| ESP32 vendor boards | Adafruit Feather ESP32 / S2 / S3 / V2, QT Py ESP32-S2 / S3 / C3, Seeed XIAO ESP32-C3 / S3 / C6, Lolin D32 / S2 mini / S3 mini / C3 mini, M5Stack Core2 / AtomS3 / StickC Plus2, LilyGO T-Display / T-Display-S3, SparkFun Thing Plus ESP32-S3, Heltec WiFi LoRa 32 V3, Freenove ESP32-WROVER |
| ESP8266 | NodeMCU 1.0, Wemos D1 mini, ESP-12E |
| RP2040 / RP2350 | Raspberry Pi Pico, Pico W, Pico 2, Pico 2 W, Seeed XIAO RP2040, Adafruit Feather RP2040, QT Py RP2040, SparkFun Pro Micro RP2040, Waveshare RP2040-Zero |
| Teensy | 4.0, 4.1, LC |
| STM32 | Nucleo-F401RE, Nucleo-F446RE, Blue Pill (F103C8), Black Pill (F411CE) |
| nRF52 | Seeed XIAO nRF52840 (Sense), Adafruit Feather nRF52840 Express, Nordic nRF52840 DK |
| ATtiny / small AVR | ATtiny85 (Digispark), ATtiny84, ATtiny1614/1616/3216 (megaTinyCore), Gemma, Trinket |
| Others common in kits | Arduino Due, Seeeduino XIAO (SAMD21), Adafruit Feather M0 / M4, Circuit Playground Express, micro:bit V2 |

Ninety-odd here; the owner picks and trims. The first twenty should be the
ones users actually select in Impulse, which `usage_event` plus the board
menu will tell us within weeks of launch.

### 5.5 Keeping it true

Every record carries a **probe sketch** that uses the pins and APIs the record
claims. CI compiles each probe against the pinned core versions; a record
whose probe fails to compile is wrong (or the core moved, which is exactly
what the drift table must record). Facts come from the core first, vendor
pinouts second, and are marked `verified: <date>`.

---

## 6. Diagnosis: code, Impulse, wiring or hardware

### 6.1 Evidence Impulse can collect

| Evidence | Source | What it can tell |
|---|---|---|
| Toolchain health | arduino-cli present, core installed, a known-good blink compiles for this fqbn | Impulse / setup fault vs everything else |
| Compile diagnostics (structured) | compiler | code; or core-API drift (match against the drift table) |
| Upload log signature | avrdude / esptool / picotool / bossac | port, boot mode, cable, wrong board selected, port held by the monitor |
| Port and USB identity | `list_ports`, VID:PID, serial number | board present at all; which board it is; driver missing (CH340/CP210x) |
| Board options | fqbn options | S3 USB CDC on boot, flash mode, partition scheme, clock |
| Simulator run of the same binary with the drawn circuit | headless runner + expectations | **does the code do what it intends?** If yes on the simulator and no on the bench, the fault is outside the code. |
| Static circuit checks | `checks.js` | missing resistor / power / pull-up, floating inputs, I²C clashes, shorts |
| Pin-usage diff | code pins vs circuit pins vs board record | pin constant wrong, input-only pin driven, strapping pin used |
| Serial boot log | serial | reset reason (brownout = power; panic = code; watchdog = blocking code), garbage (baud or clock mismatch), silence |
| Sensor-value signatures | serial values | which part is absent, unpowered, missing a pull-up, or answering wrongly |
| **Impulse Probe** measurements | a probe firmware flashed with consent (§6.4) | which I²C addresses answer, pin levels with pull-ups on/off, analog levels, part self-tests |
| The user's symptom | chat | structured by Haiku into `{ part, expected, observed, when }` |

### 6.2 The algorithm

Hypotheses: `impulse` (toolchain, options, gateway), `selection` (wrong board
or port), `code`, `wiring:<pin>`, `power`, `component:<id>` (absent /
unpowered / damaged). Each layer adds weighted evidence; the walk stops as
soon as one hypothesis is confirmed by a decisive signal, so the cheap layers
run first and most cases never reach the probe.

```
L0  Impulse itself      toolchain health, core version, board options, port state,
                        gateway/credits.  Decisive: known-good blink fails → impulse.
L1  Code                compile → drift table → code.  Simulable board + circuit:
                        run headless with expectations derived from the sketch's
                        intent (agentVerify already does this).
                        Decisive: sim fails → code.  Sim passes → not code (weight).
L2  Wiring (static)     circuitChecks on the drawn circuit (or on the circuit
                        generated from the code, shown to the user as "is this how
                        it is wired?").  Pin-usage diff.  Board record quirks.
                        Decisive: used pin is input-only / taken / strapping →
                        wiring or selection.
L3  Hardware (dynamic)  reset reason, panics, sensor-value signatures from the
                        user's own sketch.  Then, with consent, the Impulse Probe:
                        I²C scan, pin levels, analog levels, part self-tests.
                        Decisive: no device at the expected address with pull-ups
                        present → component absent/unpowered; wrong WHO_AM_I →
                        different or damaged part; stuck value with correct
                        wiring → damaged (likely).
Score  each hypothesis sums its evidence; report the top one with the evidence
       lines, the confidence, and ONE check the user can do.  Ties → the
       cheapest check first.
```

The output is an **evidence sheet** (~300–500 tokens): the structured symptom,
each layer's findings, the scores. The model receives *that*, not raw logs,
and writes the verdict and the one next step.

### 6.3 Signature library (seed)

Upload and boot:

| Signature | Hypothesis |
|---|---|
| avrdude `stk500_recv(): programmer is not responding` / `not in sync` | selection (wrong board/bootloader), pins 0/1 in use, no auto-reset, cable |
| `can't open device … Permission denied` / `Resource busy` | impulse (monitor holding the port) or OS permission |
| esptool `Wrong boot mode detected (0x13)` | hardware: hold BOOT / auto-reset circuit |
| esptool `No serial data received` / `Timed out waiting for packet header` | cable, driver, boot mode, baud |
| esptool `MD5 of file does not match data in flash` | power during flash, damaged flash |
| No `RPI-RP2` drive appears | BOOTSEL not held (RP2040) |
| Serial garbage at the sketch's baud, readable at half or double | selection: wrong clock variant (8 vs 16 MHz) |
| `Brownout detector was triggered` / `ESP_RST_BROWNOUT` | power (supply, motor on the same rail, thin cable) |
| `Guru Meditation Error` / `ESP_RST_PANIC` | code |
| `ESP_RST_TASK_WDT` / `ESP_RST_INT_WDT` | code (blocking loop) |
| Nothing on serial, ESP32-S3 native USB | impulse: "USB CDC On Boot" off (board options) |

Sensor values from the user's own sketch:

| Value | Part | Hypothesis |
|---|---|---|
| `nan` | DHT11/22 | no response: wrong pin, wiring, missing pull-up on long leads, 3.3 V marginal for DHT11 |
| `-127.00` | DS18B20 | no device on the bus (wiring, missing 4.7 kΩ pull-up) |
| `85.00` constant | DS18B20 | power-up default never updated: parasite power / insufficient time / power |
| all `0xFF` | any I²C | no ACK: device absent/unpowered, or lines only pulled high |
| all `0x00` | any I²C | SDA stuck low: short, or a part holding the bus |
| `Wire.endTransmission()` = 2 | I²C | NACK on address: wrong address or no device |
| WHO_AM_I ≠ 0x68 (0x70/0x71) | MPU6050 | different chip or clone (MPU6500 / MPU9250) |
| duration `0` | HC-SR04 | no echo: wiring, or 3.3 V board driving a 5 V module |
| stuck `0` or `1023`/`4095` | analog | shorted to GND/VCC; noisy drifting → floating input |

Each row carries a *check*: "swap SDA and SCL", "add a 4.7 kΩ pull-up between
DATA and 3.3 V", "power the servo from the 5 V pin, not 3.3 V". The library
is data (`knowledge/signatures/*.json`), grows from `errorMemory`, and is
versioned through the manifest.

### 6.4 The Impulse Probe

A small firmware per board family that Impulse can flash **with consent**
when L0–L2 are inconclusive. It reports over serial: every I²C address that
answers; each pin's level with the internal pull-up off and on (a pin that
follows the pull-up is floating; one that stays put is driven); analog levels;
and, for parts the circuit says are present, a self-test (DHT handshake,
DS18B20 ROM search, HC-SR04 echo, WHO_AM_I reads). Then Impulse recompiles and
re-uploads the user's sketch. This is the step that lets Impulse say
"nothing answers at 0x3C where the OLED should be, and SDA reads floating:
the SDA wire is not connected" without a multimeter.

### 6.5 Saying it right

- The verdict names the part and the pin, quotes the evidence lines, gives a
  confidence, and one check. "The DS18B20 on D4 reads −127: nothing answers on
  the 1-Wire bus. Most often the 4.7 kΩ pull-up between DATA and 3.3 V is
  missing. Check: add it, or the probe can test the bus."
- **Disconnected vs damaged.** Disconnected: no response at any level, the
  pin floats, nothing changes with pull-ups. Damaged: wiring verified by the
  probe (pull-ups present, lines not floating) and the part still answers
  wrongly, with a wrong ID, or with a stuck value. "Damaged" is always
  "likely", stated only after wiring is confirmed, with the alternative
  ("or a clone with a different ID") named.
- **When Impulse is the cause**, say so plainly and offer the problem report
  (`problemReporter`, redacted).

### 6.6 Where the model is used, and where it is not

Model: turning the user's words into the structured symptom (Haiku); deriving
expectations from the sketch's intent; writing the verdict. Everything else —
signature matching, circuit checks, pin diffs, probe interpretation, scoring —
is deterministic. That is what keeps diagnosis cheap in tokens and, more
importantly, reproducible: the same bench gives the same verdict.

---

## 7. Phasing (order of work, not dates)

| Phase | Work | Size |
|---|---|---|
| **0 Instrument** | task id on every call (`x-impulse-task` → `usage_event`); chat JSONL event log; a 30-task eval set (blink → ESP-NOW pair) runnable headless; baseline numbers written down. | S |
| **1 Harness core** | request assembly with tool tiers and `load_tools`; serial tools folded; typed outputs + retention; error codes; token meter and pressure compaction; verify-before-done guard; turn enclosure on cancel; board-facts cache. Re-measure against Phase 0. | M |
| **2 Knowledge** | board record schema; cores drift tables for ESP32 3.x, Pico, AVR; first 20 boards with probe sketches in CI; manifest fetch with offline fallback; then grow toward ~100. | M, then ongoing |
| **3 Diagnosis** | signature library (seed above), evidence sheet, L0–L2 in the debug flow, sim-vs-bench comparison, structured symptom; then the Impulse Probe per family (AVR, ESP32, RP2040). | M + M |
| **4 Multi-device** | `impulse.json`, scaffold, coordinator state machine, scoped device contexts, per-device serial, port memory by USB serial, boot banner, ESP-NOW worked example end to end. | L |
| **5 Cloud additions** | manifest hosting, cost-per-task views in the admin console, opt-in aggregated fix memory (if approved), later multi-MCU simulation research. | M |

Phases 1 → 2 → 3 build on each other; 4 can start after 1. Nothing here
blocks deploying Impulse Cloud, which stays the first thing to ship.

---

## 8. Decisions needed from the owner

1. **Harness location.** Agree the loop stays in the app and the cloud serves
   a versioned manifest (prompt, tool text, knowledge) — or should the cloud
   assemble prompts server-side so the prompt never ships in the client?
2. **Upload policy in chat mode.** Auto-upload after a successful compile to
   a confirmed port, or always ask before touching hardware?
3. **Impulse Probe consent.** Flashing Impulse's own firmware temporarily onto
   the user's board, with their sketch restored after: acceptable, and under
   what wording?
4. **Knowledge dataset.** In-repo and bundled (works offline) with cloud
   updates — yes? Trim or extend the board list in §5.4?
5. **Multi-device simulation.** Defer the virtual radio and rely on the real
   hardware step for cross-device verification in v1?
6. **Model routing.** Haiku for structuring and summaries, Sonnet default for
   building, Opus/Fable for diagnosis and L-tier planning — with the credit
   pricing as it stands?
7. **Aggregated fix memory.** Opt-in upload of (error signature, board, fix)
   tuples to improve everyone's diagnosis: a PRIVACY.md change. Yes, later, or
   never?
8. **Project file.** `impulse.json` in the sketch folder, or inside a
   `.impulse/` folder?

---

## 10. Decisions after the owner's review (2026-10-18)

The owner read the plan, called it good, and asked for the design to be
completed and **built**, with these additions and corrections. Each item
names what is built and the decision behind it.

| # | Owner's point | Decision |
|---|---|---|
| 1 | Circuit edits the user makes in the simulator must be saved and known to the agent in the next chat; the agent may suggest drawing the circuit when that would help. | The circuit already lives in `diagram.json` next to the sketch. New: the main process reads it for every request and injects a compact `[CIRCUIT]` wiring list into the board-facts block, with `[CIRCUIT CHANGED]` when its hash differs from the last turn and "edited by the user" when the file says so. A `get_circuit` tool returns the full list. The system prompt tells the model to suggest the simulator when it cannot see the hardware. |
| 2 | **Major bug.** Arduino IDE shows compile and upload output live, upload progress and errors such as "Sketch too big"; Impulse leaves the user blind, reports success while still compiling, and a second click starts a second job. | **Build jobs.** One job at a time in the main process; a repeated request for the same job joins it, a different one is refused with `BUSY` and the running job's stage. Every output line streams to the renderer as a `build:event`; the IDE console shows the lines as they come, the Verify/Upload buttons show the stage, chat mode shows a live build card with stage, upload percentage, the last lines and a full log. Output is parsed into Arduino IDE's memory summary (flash and RAM, used/max/%), structured diagnostics, upload progress and error codes (`SKETCH_TOO_BIG`, `RAM_TOO_BIG`, `LIBRARY_MISSING`, `UPLOAD_SYNC`, `UPLOAD_BOOTMODE`, `PORT_BUSY`, …). The fake percentage toasts are gone. Upload is one job with a compiling stage and an uploading stage, so nothing says "compiled" mid-upload. Timeouts are idle-based (no output for N seconds) instead of a wall clock that killed long ESP32 builds. |
| 3 | No "Insert" clicks: code the AI writes goes into the file. Check that Revert still works. | In agent and debug modes the model is told to write with the editor tools, never to paste a sketch for the user to insert. Safety net: a sketch-shaped code block in an agent/debug answer that did not already edit the file is applied to the open sketch and saved, with the usual snapshot so the user's message carries Undo. Ask and plan answers keep the Insert button. Revert verified live (see progress log). |
| 4 | A self-learning, self-healing layer: learn from users' repeated mistakes and push the data to the cloud at minimum cost. | **Fix capture + fix store.** When a compile or upload failure is followed by success in the same chat, the harness records (error signature, board, core version, libraries, the sketch diff, who fixed it) locally and, for signed-in users who leave sharing on, sends it redacted to the cloud. The cloud aggregates per signature and board; the agent's error analysis asks the cloud for known fixes before it asks the model, and a knowledge manifest (drift tables + top fixes) is fetched at start-up. "The model gets better" means the harness retrieves what worked; no weights are trained, which is what keeps the cost near zero. PRIVACY.md changes accordingly, with an off switch in the account menu. |
| 5 | The launch build runs no local models: credits only. Each user gets X credits at sign-up; when they run out they upgrade or wait for the refresh (every few hours). | Local models (Ollama) were removed entirely on 2026-10-18: every build is credits-only, and a build without a cloud address has no AI. The gateway gained an OpenAI lane (GPT-5.4 default, GPT-5.5, mini, nano) next to the Anthropic one; a vendor without a key on the server is not offered. Plans gain `periodHours`: the free plan refills a small allowance every N hours (default 25 credits every 5 hours, editable in the admin console), paid plans stay monthly; the welcome bonus (200) stays. The out-of-credits notice shows the countdown. |
| 6 | Where is the admin panel and how is it reached? | `/admin/` on the cloud; sign in with an address listed in `ADMIN_EMAILS` (verified). Steps for local and production in the progress log and `cloud/README.md`. Verified live against the local dev stack. |
| 7 | Keep the supported boards and the knowledge layer to the ~100 boards most used by students and industry in India (Gujarat at most, India as the scope). | A curated catalog (`knowledge/boards/catalog.json`) of 100 boards with India-first ranking; the board picker shows "Popular boards" from it (grouped, searchable) with "All installed boards" behind a toggle; cores for catalog boards install on demand (ESP8266, STM32, Renesas, SAMD, mbed Nano, Teensy added to the on-demand list). Knowledge records are family files plus per-board overrides, and core drift tables; only the selected board's record is injected. |
| 8 | Design and implement the whole architecture in the background; the knowledge layer is the main thing. | Built in this order: build jobs → auto-apply → circuit facts → credits-only + refresh + admin check → knowledge layer → self-learning loop → harness core (tool tiers, bounded results, verify guard). Each piece verified with the gates (lint, tests, smoke, e2e) and live in the app. Open questions from §8 that the owner did not answer keep the plan's default (upload still asks before flashing). |

---

## 11. Status after the first build day (2026-10-18, evening)

Built and verified live in the app (each piece has unit tests; the cloud
pieces have `node --test` coverage against Postgres):

| Plan item | State | Where |
|---|---|---|
| Build jobs: one at a time, streamed, parsed, named failures (§2.2, decision 2) | **Built** | `src/main/services/buildJobs.js`, `buildOutput.js`, `arduinoService.js`; IDE console + footer; chat build card |
| Auto-apply of answer code, Revert (decision 3) | **Built** | `src/renderer/answer-code.js`, renderer + chat mode |
| Circuit facts for the agent (decision 1) | **Built** | `knowledge/circuitFacts.js`, simulator `circuitFacts()`, `get_circuit` |
| Credits-only launch, hourly refills, admin access (decisions 5, 6) | **Built** | `cloud/src/credits.js`, `settings.js`, desktop `localModelsEnabled()`, `cloud/README.md` |
| Knowledge layer: 100-board catalog, family notes, records, core drift (§5, decision 7) | **Built** (68 of 100 FQBNs checked against installed cores; the rest from the board indexes) | `knowledge/boards/`, `knowledge/cores.json`, `boardRecords.js`, probes + `npm run knowledge:probe` |
| Self-learning loop (decision 4) | **Built**: local fix capture, cloud store, known fixes in tool results, manifest, admin page, privacy text | `ai/learning/fixCapture.js`, `cloud/src/learning.js`, migration 002 |
| Harness core: tool tiers + packs, serial fold, bounded results, verify guard, cost per task (§3.3, §3.4) | **Built** (tool schemas ~2,450 → ~1,670 tokens; verify guard; `usage_event.task_id`) | `tools/toolSchema.js`, `agent.js`, migration 003 |
| Event-sourced chat log (§3.5) | Not yet | the saved chat keeps messages and build/verify cards, not a JSONL event log |
| Token-pressure compaction with pruning (§3.4) | Partly: the renderer compacts at 70K tokens; no pruning step | `renderer.js` AI_COMPACT_THRESHOLD |
| Harness manifest from the cloud (§3.2) | Partly: the learning manifest exists; prompt and knowledge are still bundled only | `cloud/src/learning.js` |
| Multi-device projects (§4) | Not started | — |
| Diagnosis algorithm L0–L3, signature library, Impulse Probe (§6) | Partly: failure codes, known fixes, the pin check (L2 for pins) and the simulator's evidence back to the model (L1); no evidence sheet, no probe firmware | `buildOutput.js`, `pinCheck.js`, `verify.js` |
| Pin truth per chip, checked on every build (owner's report, 2026-10-18) | **Built** | `knowledge/pinMap.js`, `pinCheck.js`, `npm run knowledge:audit` |
| Libraries: auto-install from a failed build, index-backed search, chat UI | **Built** | `libraryService.js`, `vibe/libraries.js` |
| Serial: main-process line assembly, shared history, port handover on upload | **Built** | `serialMonitor.js` |
| Official documentation the agent can read, cached | **Built** | `knowledge/docs.js` |
| File operations (new, rename, delete to Trash) in chat mode | **Built** | `ipc/fileHandlers.js`, `vibe/bench.js` |
| Eval set (§7 phase 0) | Not started | — |

---

## 12. Should Impulse be built on arduino-cli? (answer, 2026-10-18)

**Keep arduino-cli, and stop paying its one real cost by running it as a
daemon. Do not fork the Arduino IDE.**

### What arduino-cli actually does for us

It is not a thin wrapper around a compiler. It owns:

- the package index format, and resolving a core to its exact toolchain
  downloads (compiler, uploader, tools) per platform and version;
- the `platform.txt` / `boards.txt` recipe language — build properties, menu
  options, per-board overrides, pre/post hooks — which is how one command
  compiles for 50 vendors' boards;
- the library index, versions and dependency resolution;
- pluggable discovery (which board is on which port) and pluggable monitors;
- upload orchestration for avrdude, esptool, picotool, bossac, dfu-util,
  teensy_loader, STM32CubeProgrammer and the rest, including the 1200-baud
  touch and reset dances each board needs.

Every core release can change those recipes. Rebuilding this means owning
compatibility with every vendor core, forever, as a side quest.

### The licence decides the question as much as the engineering

| Project | Licence | What it means for Impulse |
|---|---|---|
| `arduino/arduino-cli` | GPL-3.0 | Impulse runs it as a separate executable and talks to it over a process boundary. That is aggregation: Impulse's own source stays Impulse's. The binary must be shipped with its licence and its source offer, which the app already does. |
| `arduino/arduino-ide` (IDE 2.x) | **AGPL-3.0** | Forking its source into Impulse would make Impulse AGPL. Under §13 that reaches users over a network too. For a product with a cloud gateway, that is a decision about the business, not a detail. |

So "build from scratch using the open-source Arduino IDE" is the one option
that costs the most engineering *and* constrains the licence hardest.

### Where Impulse is actually different

Not in the build system: in chat-first building, the simulator, the knowledge
layer, diagnosis and learning from fixes. Every hour spent re-implementing
`platform.txt` is an hour not spent on those.

### The real complaint, and the real fix

The pain was never "arduino-cli is the wrong engine". It was that Impulse ran
it as one short-lived process per command and showed none of it. That is now
fixed above the boundary: build jobs stream every line, parse the memory
summary and name failures; the monitor keeps its own history and hands the
port over for uploads; libraries install themselves from the index.

The next step, when it is worth it, is `arduino-cli daemon` (gRPC):

- streaming progress for compile, upload and library install as structured
  events rather than scraped text;
- a board-watch stream instead of polling `board list`;
- the pluggable monitor, so the serial port is opened by the same tool that
  knows the board;
- one warm process: no per-command start-up, so a compile begins immediately.

It is a contained change: `arduinoService`, `libraryService` and
`serialMonitor` already hide the CLI behind their own interfaces, so the
transport can change without touching the UI or the agent. Treat it as an
optimisation to measure, not a rewrite.

### What Impulse should own itself (and now does)

The serial monitor and the port handover, the pin truth per chip, library
resolution as a product experience, the board knowledge and documentation
layers, the simulator, and the agent harness. Those are the parts that decide
whether the product is good; the build engine is not one of them.

---

## 9. Sources

- DeepSeek Harness: github.com/deepseek-ai/deepseek-harness (MIT; branch
  `master`), README and `.agents/notes/` architecture notes: tool schemas in
  prompt assembly (2026-06-11), structured error taxonomy (2026-06-11), tool
  result retention library (2026-07-06), agent scope contexts (2026-07-08),
  after-call compaction pressure and overflow recovery (2026-07-10), canonical
  tool output contract (2026-07-20), event-sourced sessions, turn enclosure.
- *Harness Engineering: Anatomy, Architecture, and Evolution of Coding
  Agents*, arXiv 2609.00006; Cordis: *A Programming Paradigm for
  Spatiotemporal Composability*, arXiv 2608.25512.
- Impulse: `src/main/services/ai/` (agent, tools, prompts, knowledge,
  agentVerify, circuitGenerator), `src/renderer/simulation/` (checks,
  netlist, expectations, headless), `src/main/services/platformio.js`,
  `serialMonitor.js`, `cloud/src/gateway.js`, `cloud/src/pricing.js`;
  measured usage from the local dev stack's `usage_event` table (2026-10-18).
