# EmbedBench

Real embedded tasks with a machine-checked definition of success, to measure
whether Impulse's knowledge makes a model write working firmware: the same
model alone, and with the facts the app sends with every request. The plan
it serves is `docs/design/knowledge-strategy.md` §6.

## What a task is

`tasks.json` lists them. Each has:

- `board`: the simulated board (`uno`, `esp32`, `esp32s3`, `esp32c3`, `pico`,
  `nanoesp32`), and optionally `boardName`, the board as the user names it;
- `ask`: the request, worded the way a student would type it, wiring included;
- `circuit`: the parts and the board pins they are wired to (built into a
  `diagram.json` with the app's own circuit builder);
- `expect`: checks the simulator runs (`pin 2 frequency 2Hz ±5%`,
  `serial contains "IP: 10.0.2.15"`…), with `seconds` of simulated time;
- `why` (some): the fact a model needs to get it right;
- a reference sketch, `reference/<id>.ino`, that passes the checks. A task
  only counts when its reference passes: `npm run bench -- --reference`.

The checks come from the task, never from the sketch: the runner strips any
`@expect` lines a model writes and appends the task's own.

The simulator's sensors read fixed values unless changed: a DHT22 reads
24.0 °C and 40 %, an HC-SR04 100 cm, a potentiometer sits at mid-scale, an
HX711 reads 0 g, and Wi-Fi on the ESP32 boards joins a pretend network with
the address 10.0.2.15.

## Variants

- `alone`: a short instruction to write one complete sketch, then the board's
  name and the request. What a general chatbot gets.
- `impulse`: the same, plus what the app adds: the board facts read from the
  installed core (pins, core version and its API, with their proof levels),
  the facts and known-good recipe for any part the request names, and the
  circuit as the app describes it.
- `impulse-fix`: `impulse`, then what the app does before an answer stands:
  the hardware linter's mechanical fixes, a compile, the error decoder's
  rewrites, and, if the sketch still does not compile or the linter still
  finds an error, one more round with the model, given the decoded causes and
  the linter's findings.
- `reference`: the task's reference sketch (validates the tasks).

Compile-only tasks (`compileOnly`, for features the simulator cannot run,
like ESP-NOW) pass when the sketch builds for the real core.

## Running it

```bash
npm run bench -- --reference                       # every task's reference must pass
npm run bench -- --model gpt-5.4-mini              # both variants, every task
npm run bench -- --model gpt-5.4-mini --tasks esp32-,s3-timer --variants impulse
npm run bench -- --model gpt-5.4 --jobs 4 --write --label gpt-5.4
npm run bench -- --model gpt-5.4-mini --variants reference,alone,impulse,impulse-fix --sim-jobs 3 --write
```

`--sim-jobs` (default 2) limits simulations at once: the ESP32 emulator
follows the host clock, so too many at a time fail timing checks a correct
sketch passes. A sketch that builds but fails a check is simulated once more
before it counts as failed.

- Needs arduino-cli with `arduino:avr`, `esp32:esp32` (3.x) and
  `arduino:esp32` (the Nano ESP32's core). Pico tasks need
  `IMPULSE_EXTRA_CORES_CONFIG` pointing at an arduino-cli config whose data
  folder has `rp2040:rp2040`; without it they are skipped.
- Libraries a sketch needs are installed the way the app installs them, into
  a scratch sketchbook (`--scratch DIR`, default a folder in the system temp
  dir), never into the global Arduino folders.
- Model runs read `OPENAI_API_KEY`, or the `OPENAI_API_KEY` line of
  `cloud/.env`, and call OpenAI's Responses API directly (not through Impulse
  Cloud). `--effort` sets the reasoning effort (default `low`).
- Every run writes the answers, the sketches and a full report under
  `<scratch>/runs/`; `--write` also saves the report to `reports/`.

## What it costs

The report adds up the model's tokens at the list prices in
`cloud/src/pricing.js`. The first full run of the three model variants over
all 60 tasks cost $0.28 with `gpt-5.4-mini` at low reasoning; `gpt-5.4`
lists at about 3.3 times its price per token. The simulator part is free
and takes about 30 s per ESP32 task (QEMU) and a few seconds per AVR or Pico
task; `--jobs` runs several at once.

## Reading the report

`summary` gives, per variant, how many tasks passed every check, how many at
least compiled and ran, what the model cost and the cost per working sketch.
`byBoard` splits the passes per board, and `results` has each task's error:
a compile error, or which check failed and what the simulator measured.

## Results

Every run saved with `--write` is in `reports/` (JSON, and a readable
`.md`). The first full run, 2026-10-19, gpt-5.4-mini at low reasoning:

| Variant | Passed | Cost per working sketch |
|---|---|---|
| reference | 60/60 | – |
| alone | 53/60 | $0.0017 |
| impulse | 56/60 | $0.0020 |
| impulse-fix | 58/60 | $0.0013 |

Its failures taught (see the CHANGELOG): a board the user names must bring
its facts, LED pin included (the ESP32-C3 SuperMini), the ESP32 simulator
must follow ESP-IDF's GPIO calls, prints lost before a native-USB monitor
connects are an error with a mechanical fix (also through a helper
function), and two tasks were worded badly. The tasks that failed anywhere
were run again (`reports/*-taught*`); taking each task's latest result:

| Variant | Passed |
|---|---|
| alone | 56/60 |
| impulse | 60/60 |
| impulse-fix | 60/60 |

The model alone still fails where only Impulse's facts help (the SuperMini's
LED, the Nano ESP32's core 2 APIs). One sample per task makes single runs
noisy, and the rerun tasks had a second sample: the next version runs three
samples per task and reports the spread.

## Next

The knowledge strategy grows this into the nightly benchmark: more tasks
(120+, including error-fixing and wiring-bug tasks), three samples per task
with the spread, real boards for a subset, and a scheduled run that
publishes the trend. Teach only what the model gets wrong: the failures here
say which facts to add next.
