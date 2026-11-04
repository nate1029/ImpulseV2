# The knowledge layer: how Impulse beats every AI coding tool at embedded work

Status: proposal for the owner's review (2026-10-19). Nothing in sections 4–10
is built yet except where a line says "today". Builds on
[harness-plan.md](harness-plan.md) §5 and §6.

## The idea in one paragraph

Every AI coding tool rents the same models, so the model cannot be Impulse's
advantage. What a model lacks for embedded work is **facts outside the code**:
which pins this exact board has, what changed in this exact core version,
which library owns this header, what the wiring on the bench actually is,
what the board printed when it crashed. Impulse sits where those facts are
born (the installed toolchain, the simulator, the plugged-in board, the
compiler's output, every user's fixed error), so it can hand the model the
truth instead of letting it guess. The strategy: **proof-carrying knowledge**.
Every fact Impulse uses carries its proof (derived from the core, compiled,
simulated, run on a board, or fixed real users' builds), deterministic engines
check the model's work, every fixed error makes the layer better for the next
user, and a benchmark measures all of it every night. A wrapper can copy a
prompt in an afternoon. It cannot copy a toolchain-connected truth engine fed
by thousands of real builds.

---

## 1. Why AI tools fail at embedded work

These are not hypothetical. Each one happened in Impulse this week, with a
strong model:

| What went wrong | Why the model got it wrong | The fact that fixes it |
|---|---|---|
| `ledcSetup()` on an ESP32 with core 3 | Most tutorials it learned from are for core 2 | API changes keyed by core version |
| I²C on GPIO 22 of an ESP32-S3 | Habit from the classic ESP32 | Pins per chip and per board, from the installed core |
| `#include <esp_sleep.h>` made the build install a stray library | It cannot know which library owns a header | Header ownership, SDK headers marked as core |
| LedControl on an ESP32 does not build | It cannot compile in its head | Library × architecture compatibility, tested |
| "Boot 1" never appeared after deep sleep | It does not know the S3's native USB re-enumerates on wake | Runtime behaviour of the board's USB |
| An upload to a sleeping board failed | It cannot see the device's state | Live device state |
| Touch detection inverted on the S3 | Classic ESP32 touch values fall; S3 values rise | Per-chip peripheral behaviour |

The pattern: the code was plausible C++, and wrong for **this board, this
core, this library, this circuit, this moment**. A general model's memory is a
blurry average of years of tutorials for other boards and older cores. More
model intelligence does not fix missing facts. Facts fix missing facts.

## 2. The principle: knowledge that proves itself

Seven properties every piece of Impulse knowledge must have:

1. **Grounded.** Derived from the real toolchain where possible (variant pin
   headers, `boards.txt`, library headers, compiler output), not typed from
   memory.
2. **Versioned.** Keyed by board × core version × library version. "Valid for
   esp32 core ≥ 3.0" is part of the fact.
3. **Proven.** Every fact carries a proof level (below). The AI prefers higher
   levels and says how sure it is.
4. **Executable.** Recipes, probes and expectations are code that runs:
   compile, simulate, run on a board. Knowledge you can run is knowledge you
   can regression-test.
5. **Measured.** A benchmark says whether a fact improves results. Facts that
   change nothing are not sent.
6. **Fresh.** Upstream releases are watched; facts are re-proven
   automatically when a core or library moves.
7. **Minimal.** Only what the model gets wrong goes into the prompt, inside a
   token budget. Less text, fewer credits, better answers.

**The proof ladder.** Each fact records how it is known:

| Level | Proof | Example |
|---|---|---|
| L0 | Model memory | Never trusted for pins, voltages or APIs |
| L1 | Cited official source | Espressif datasheet table, with the link |
| L2 | Derived from the installed core | `SDA = 8` from the S3 variant header |
| L3 | Compiled | The DHT22 recipe builds on core 3.3.12 (today: all 595 recipe-and-board pairs, 81 recipes on 8 boards) |
| L4 | Simulated | Runs in Impulse's simulator and its `@expect` checks pass |
| L5 | Run on real hardware | Printed "duty 32…224" on an ESP32-S3 (today: 8 jobs, by script) |
| L6 | Field-proven | Fixed this error for 412 users on this board and core |

The level shows in answers ("verified on an ESP32-S3") and in the UI as a
small badge. No other tool can show this, because no other tool has the
machinery to produce it.

**It already pays for itself.** The first day of proof-checking Impulse's
*own* knowledge (2026-10-19) found:

- more than 70 recipe pins that were wrong for some chip (strapping and USB
  pins on the ESP32-C3 and C6, among them a servo wired to the C3's USB pin),
  caught by running every recipe through the pin tables;
- a popular library (OneWire 2.3.8) that does not compile for the ESP32-C6
  at all, and an ESP-NOW sketch that only builds on core 3.x, caught by
  compiling every recipe for every chip;
- ten recipe headers whose library Impulse's auto-installer could not find,
  because the library index lists headers for fewer than half of its
  releases, caught by replaying the installer against the real index;
- sketches whose output never appears on boards with native USB (the S3,
  C3, Pico), caught by running them on a real ESP32-S3.

Each was written by careful hands and looked right. Without the checks they
would have reached users as confident, wrong advice. That is what the proof
ladder is for, and why each proof is bound to the exact text it proved: edit
a recipe and it is unproven until it compiles again.

## 3. What goes into the layer

Eight kinds of knowledge, plus one that belongs to each user:

| Layer | What it holds | Today | To add |
|---|---|---|---|
| **Boards and chips** | Pins with capabilities (ADC1/ADC2, PWM, touch, RTC, interrupts, strapping, flash/PSRAM, input-only, USB), onboard parts, USB mode, memory, power limits, clones and variants (N16R8), upload procedures | 100-board catalog, family notes, pin truth checked on every build | A capability table per pin; board fingerprints |
| **Cores and APIs** | What changed between versions: old call, new call, the compiler error it causes | ESP32 core 3 notes as text | Machine-readable rewrites that are compile-checked, applied without a model call |
| **Libraries** | Which library owns each header, which architectures it builds on, API changes between its versions, conflicts, RAM/flash cost | Curated header owners, SDK headers marked as core | A compatibility matrix: top 300 libraries × 6 cores, built by CI |
| **Parts** | Electrical specs, interfaces, I²C addresses, wiring per board family, compiled recipes, failure modes, substitutes, simulator model | 81 parts and ESP32 features, each with a recipe; all 595 recipe-and-board pairs compiled | Self-tests for each part (for the probe), expectations for each recipe |
| **Circuits** | Electrical rules: voltage domains, pull-ups, current budgets, shared buses, address clashes, boot-strapping pins, ADC2 with Wi-Fi | The circuit's wiring goes with each request, a basic wiring check | A full electrical rules check and a pin planner |
| **Errors** | Error signature → cause → fix, with success rates per board and core | Failure codes, fix capture, a cloud store of fixes | Ranked fix playbooks; one-click fixes |
| **Runtime** | Reset reasons, ESP32 panics and backtraces, watchdog, brownout, heap, USB behaviour | — | A decoder in the serial monitor that turns a crash into a file and line |
| **Projects** | Blueprints for the projects Indian students build: parts list with prices in ₹, circuit, code, expectations, the failures to expect | — | 30 blueprints built from recipes |
| **You** (private) | Your boards (fingerprinted), your parts bin, your past fixes and preferences | Chat history only | "My boards" and "My parts" that the AI designs with |

## 4. The engines: where a machine beats a model

The model writes. Deterministic engines check, plan and decode. They are
free to run (no credits), give the same answer every time, and turn into
facts the model can use. This is how Impulse stays correct even when the
model is having a bad day.

1. **Context compiler.** Decides what goes into each request: links the
   message, the code, the circuit, the serial output and the last error to
   the facts that matter, inside a token budget, in a stable order so
   OpenAI's prompt cache keeps working. Today: `[BOARD FACTS]`, `[CIRCUIT]`
   and `[COMPONENT FACTS]` already ride with each request.
2. **Hardware linter.** About 150 rules run on every edit, before compiling,
   and show in the editor and to the agent: a pin the board lacks, PWM on a
   pin without it, ADC2 while Wi-Fi is on, `while(!Serial)` that hangs a
   battery-powered board, `delay()` or `Serial.print()` inside an interrupt,
   a missing `volatile`, `String` concatenation in a loop on an Uno,
   `millis()` stored in an `int`, two parts on one I²C address,
   `SoftwareSerial` on an ESP32. Today: 27 rules (`knowledge/linter.js`), in
   every build, the Problems tab and the agent's verify step.
3. **Pin planner.** Given a board and the parts, assigns pins that satisfy
   every constraint (hardware buses, PWM/ADC/interrupt capability, no
   strapping, flash or USB pins, ADC1 when Wi-Fi is on). The model asks the
   planner instead of guessing, and the circuit diagram follows.
4. **Electrical rules check.** Runs on the circuit: 5 V signals into 3.3 V
   pins, missing pull-ups, a servo powered from the 3.3 V pin, current over
   budget, a relay without a flyback diode.
5. **Error decoder.** Compiler, linker and upload errors → cause and exact
   fix, from the drift tables and the fix playbooks. Most common errors get
   fixed without spending a model call. Today: 56 rules
   (`knowledge/errorDecoder.js`), 39 proven on real compilers with their
   automatic rewrites (`npm run knowledge:errors`).
6. **Crash decoder.** An ESP32 "Guru Meditation" backtrace becomes the file
   and line in the user's sketch, using the build's own symbols; brownouts
   and watchdog resets are named in plain words.
7. **Board fingerprint.** When a board is plugged in, Impulse reads what it
   really is without flashing anything: chip, revision, flash size, PSRAM and
   MAC from the bootloader, or the AVR signature bytes. "Your ESP32-S3 has 16
   MB flash and octal PSRAM, so GPIO35–37 are taken" becomes a fact, not a
   guess. With permission, the **Impulse Probe** firmware goes further:
   every I²C address that answers, which pins float, a self-test of each part
   ("nothing answers at 0x3C where the OLED should be").
8. **Verifiers.** Compile, then simulate with `@expect` checks, then run on
   the real board and check `@expect` against its serial output. The agent
   proves the sketch works instead of saying "done". This week's hardware run
   did exactly this by script; the product should do it every time a board
   is connected.

## 5. The flywheel: why it gets better with every user

```
users build ──▶ errors happen ──▶ the fix is captured (opt-in, no sketch content)
     ▲                                          │
     │                                          ▼
better first answers ◀── ranked playbooks ◀── aggregated per board, core, library
```

When a failed build is followed by a working one, Impulse already records the
error's signature, the board, core and libraries, and the smallest diff that
fixed it (today). The next step is ranking: "for this error on esp32 core
3.x, 97 % of users fixed it by switching to `ledcAttach()`". The next user gets
that fix immediately, often without a model call. The same loop records which
recipes worked on real hardware (proof level L6). More users make the layer
better, which makes Impulse better, which brings more users. A wrapper sees no
compiler output and no boards, so it has nothing to learn from.

Privacy stays first: sharing is a visible switch, the sketch never leaves the
computer (only the error line, versions and a redacted diff), and a user can
delete what they shared.

## 6. Proof: a benchmark that runs every night

**EmbedBench** (v0 today: 60 tasks on six boards, `bench/`): a few hundred real tasks (student projects, sensors and
displays, ESP32 features, errors to fix, wiring bugs to find), each with a
board, its parts, the request, and a machine-checked definition of success:
it compiles, its `@expect` checks pass in the simulator, and for a subset, on
real boards.

- It runs every night for: the model alone, and the model with Impulse.
- Every knowledge change must raise the score or hold it, and the report
  tracks first-try success, number of rounds, and **cost per working build**.
- **Teach only what the model gets wrong.** The failures say which facts to
  add next; facts the model already gets right are not sent, which saves
  tokens on every request. This is the most efficient rule in the whole
  strategy: knowledge is curated by measured failure, not by guessing what
  might help.
- Published, it becomes the strongest marketing line Impulse can have:
  "the same model gets X % of embedded tasks right alone, and Y % inside
  Impulse".

## 7. Efficiency: the cheapest correct answer

Each request takes the cheapest path that is correct:

1. Engines first (free): the linter, decoders and planner answer or fix
   without a model.
2. Proven facts next (a few hundred tokens): only the ones this request needs.
3. A small model for routine work with those facts in hand.
4. The large model only when a verification fails (the escalation that
   exists today).

Facts make small models perform like large ones, and every avoided
compile-fix round is a model call saved. The benchmark measures it; the
hypothesis to prove is that GPT-5.4 mini with Impulse's knowledge beats
GPT-5.4 without it, at a fraction of the credits. That is better answers and
better margins at once.

## 8. Freshness: never out of date

A nightly job watches the Arduino, Espressif and RP2040 core releases and the
most-used libraries. When one moves: pin maps are re-derived from the new
variants and compared, recipes and the compatibility matrix are re-compiled,
the benchmark runs, and a short drift note is drafted for review ("core 3.4
renamed X"). Knowledge ships from the server, so a correction reaches every
app the same day without a new release. A model's memory is frozen at its
training date; Impulse's knowledge is a week old at most.

## 9. Why nobody can copy this quickly

- **Data**: the fix flywheel needs users building on a toolchain-connected
  product. Late competitors start at zero.
- **Verification machinery**: a simulator for AVR, RP2040 and ESP32, a
  hardware bench, and the scripts that drive them. Months of engineering
  before the first proven fact.
- **Engines**: the pin planner, rules check, linter and decoders are real
  software, not prompts.
- **Time**: benchmark history, the compatibility matrix and the flywheel
  compound. Every month widens the gap.
- **Focus**: the boards, clones, parts, prices and projects of Indian
  students and makers, verified, in one place.

What the advantage is **not**: a secret prompt or a fine-tuned model. Those
are copied or made obsolete by the next model release. The knowledge layer
is model-agnostic: when a better model ships, Impulse switches to it and is
better on day one.

## 10. Build plan

In order; each step has a test of done.

**Phase 1: foundation and measurement** — built on 2026-10-19 (the
owner approved the plan that day): proof levels on every answer, EmbedBench
v0 (60 tasks), the hardware linter v1 (27 rules) and the error decoder v1 (56
rules, 39 proven on real compilers, with automatic rewrites the AI's verify
step applies by itself). EmbedBench's first run with gpt-5.4-mini: 53/60
alone, 56/60 with Impulse's facts, 58/60 with its verify loop, which was also
the cheapest per working sketch; after teaching what failed, every task's
latest result passes with Impulse (60/60) against 56/60 alone
(`bench/README.md`). HANDOFF.md has the details and what is next.

1. **Knowledge schema v2.** Every fact gets a proof level, source, version
   range and verified date; existing boards, parts, recipes and drift notes
   are migrated. Done when every tool answer shows its levels.
2. **EmbedBench v0.** 120 tasks across Uno, ESP32, ESP32-S3, ESP32-C3 and
   Pico, scored by compile and simulator checks; first baseline of the model
   alone against Impulse. Done when it runs nightly and writes a report.
3. **Hardware linter v1.** The 60 rules the benchmark's failures call for, in
   the editor and in the agent's verify step. Done when the benchmark score
   rises.
4. **Error decoder v1 with automatic API rewrites.** Done when the 50 most
   common compile errors get a cause and a fix without a model call.

**Phase 2: engines**

5. Pin planner. 6. Electrical rules check. 7. Board fingerprint. 8. Crash
decoder in the serial monitor. 9. Hardware `@expect` on a connected board.

**Phase 3: compounding**

10. Ranked fix playbooks and one-click known fixes. 11. Library
compatibility matrix in CI. 12. The freshness job. 13. Knowledge delivered
from the server.

**Phase 4: reach**

14. 30 project blueprints with prices in ₹. 15. "My boards" and "My parts".
16. Publish EmbedBench.

## 11. Decisions for the owner

1. **The plan and its order.** Approve, or move steps (for example, the pin
   planner before the linter).
2. **A hardware bench.** A small set of boards that stay plugged into a
   computer for automated hardware tests: an Uno clone, a Nano clone, a
   classic ESP32 DevKit, an ESP32-C3, a Pico and a NodeMCU, next to your S3.
   A few thousand rupees in total.
3. **Sharing fixes.** Keep it on by default with a clear notice (today), or
   ask on first run. More data against more caution.
4. **The benchmark.** Publish the scores, or keep them internal.
