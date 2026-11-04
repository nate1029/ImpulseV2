/**
 * What arduino-cli, the compilers and the upload tools print, read into facts:
 * the stage a build is in, how far an upload has got, the memory summary
 * Arduino IDE shows, the diagnostics, and a code for the failure. Pure
 * functions, no I/O: the build jobs call them line by line while a build runs
 * and once more on the whole output when it ends.
 * @module main/services/buildOutput
 */

/** Stage keys and the words the UI shows for them. */
const STAGE_LABEL = {
  starting: 'Starting',
  compiling: 'Compiling',
  detecting: 'Detecting libraries',
  'compiling-sketch': 'Compiling the sketch',
  'compiling-libraries': 'Compiling libraries',
  'compiling-core': 'Compiling the core',
  linking: 'Linking',
  sizing: 'Measuring size',
  uploading: 'Uploading',
  connecting: 'Connecting to the board',
  erasing: 'Erasing flash',
  writing: 'Writing',
  verifying: 'Verifying',
  resetting: 'Resetting the board',
};

/** Which stages belong to the compile half of a job and which to the upload half. */
const COMPILE_STAGES = new Set(['compiling', 'detecting', 'compiling-sketch', 'compiling-libraries', 'compiling-core', 'linking', 'sizing']);
const UPLOAD_STAGES = new Set(['uploading', 'connecting', 'erasing', 'writing', 'verifying', 'resetting']);

// Stage patterns in the order they are tried. Each tool prints its own words.
const STAGE_PATTERNS = [
  // arduino-cli (compile)
  [/^Detecting libraries used/, 'detecting'],
  [/^Generating function prototypes/, 'compiling-sketch'],
  [/^Compiling sketch\.\.\./, 'compiling-sketch'],
  [/^Compiling librar(?:y|ies)/, 'compiling-libraries'],
  [/^Compiling core\.\.\./, 'compiling-core'],
  [/^Linking everything together/, 'linking'],
  [/^(?:Sketch uses|Global variables use) /, 'sizing'],
  // avrdude (AVR boards)
  [/^avrdude: (?:AVR device initialized|Device signature|stk500|Version )/, 'connecting'],
  [/^avrdude: erasing chip/, 'erasing'],
  [/^avrdude: (?:writing flash|writing \d+ bytes)|^Writing \|/, 'writing'],
  [/^avrdude: (?:reading on-chip flash|verifying flash)|^Reading \|/, 'verifying'],
  // esptool (ESP32, ESP8266)
  [/^(?:esptool\.py|esptool) v|^Serial port |^Connecting\.|^Chip is |^Features: |^Crystal is |^MAC: |^Uploading stub|^Running stub|^Stub running|^Changing baud rate|^Changed\.|^Configuring flash size/, 'connecting'],
  [/^Erasing flash|^Flash will be erased|^Flash params set/, 'erasing'],
  [/^Compressed \d+ bytes to \d+|^Writing at 0x|^Wrote \d+ bytes/, 'writing'],
  [/^Hash of data verified/, 'verifying'],
  [/^Hard resetting|^Leaving\.\.\./, 'resetting'],
  // picotool / rp2040load (RP2040, RP2350)
  [/^Resetting .* to BOOTSEL|^Waiting for .*BOOTSEL|^Found RP|^Loading into Flash: \[\s*\]/, 'connecting'],
  [/^Loading into Flash|^Writing \d+ bytes|^Flashing/, 'writing'],
  [/^Verifying Flash/, 'verifying'],
  [/^The device was rebooted|^Rebooting/, 'resetting'],
  // bossac (SAMD, Due)
  [/^Device\s+:|^Atmel SMART|^Version\s+:|^Address\s+:|^Pages\s+:|^Performing 1200-bps touch reset|^Waiting for upload port/, 'connecting'],
  [/^Erase flash|^Erasing/, 'erasing'],
  [/^Write \d+ bytes to flash|^\[[=\s]+\] \d+%/, 'writing'],
  [/^Verify \d+ bytes|^Verify successful/, 'verifying'],
  [/^CPU reset\./, 'resetting'],
  // dfu-util (Uno R4, STM32 DFU)
  [/^Opening DFU|^Device ID |^Claiming USB DFU|^Setting Alternate|^Determining device status|^dfu-util /, 'connecting'],
  [/^Erase\s+\[|^Erasing page/, 'erasing'],
  [/^Download\s+\[|^Downloading element|^Downloading to address/, 'writing'],
  [/^File downloaded successfully|^Download done/, 'verifying'],
  [/^Resetting USB to switch back|^Transitioning to dfuMANIFEST/, 'resetting'],
  // STM32CubeProgrammer / stm32flash / teensy
  [/^Memory Programming|^Download in Progress|^Programming/, 'writing'],
  [/^File download complete|^Verifying|^Download verified/, 'verifying'],
  [/^Flash written and target reset|^Booting|^Hard reset/, 'resetting'],
];

/**
 * The stage a line of tool output announces, or null when the line says
 * nothing about stages (most compiler lines).
 * @param {string} line
 * @returns {string|null}
 */
function stageOf(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  for (const [re, stage] of STAGE_PATTERNS) if (re.test(text)) return stage;
  return null;
}

// Progress bars of the upload tools. Only lines with a bar or a tool's own
// "(12 %)" count; a bare percentage elsewhere (a warning text) does not.
const PROGRESS_PATTERNS = [
  /^(?:Writing|Reading) \|[#\s]*\| (\d{1,3})%/, // avrdude
  /^Writing at 0x[0-9a-fA-F]+\.\.\. \((\d{1,3}) %\)/, // esptool
  /^Loading into Flash: \[[=\s]*\]\s*(\d{1,3})%/, // picotool
  /^\[[=\s]+\] (\d{1,3})% \(\d+\/\d+ pages\)/, // bossac
  /^(?:Download|Erase)\s+\[[=\s]*\]\s*(\d{1,3})%/, // dfu-util
  /^(?:Memory Programming|Download in Progress).*?(\d{1,3})%/, // STM32CubeProgrammer
];

/**
 * How far along an upload tool says it is, 0..100, or null.
 * @param {string} line
 * @returns {number|null}
 */
function progressOf(line) {
  const text = String(line || '').trim();
  for (const re of PROGRESS_PATTERNS) {
    const m = re.exec(text);
    if (m) return Math.max(0, Math.min(100, Number(m[1])));
  }
  return null;
}

// The compiler command lines of a verbose build: a toolchain binary followed
// by dozens of flags. Arduino IDE hides them unless verbose output is on;
// so does Impulse's live view (the full log keeps them).
const TOOL_COMMAND = /(?:^|[\\/])(?:avr-g\+\+|avr-gcc|avr-gcc-ar|avr-objcopy|avr-size|avr-ar|xtensa-[\w-]+-(?:g\+\+|gcc|ar|objcopy|size)|riscv32-[\w-]+-(?:g\+\+|gcc|ar|objcopy|size)|arm-none-eabi-(?:g\+\+|gcc|ar|objcopy|size|gcc-ar)|ctags|gen_esp32part\.py|esp32-arduino-libs|python3?(?:\.exe)? [^\n]*?(?:gen_esp32part|gen_insights_package)) /;

/**
 * Whether a line is worth showing live: stage lines, warnings, errors, the
 * tools' own messages, sizes, library and platform notes. Compiler command
 * lines and blank lines are not.
 * @param {string} line
 */
function isNoteworthy(line) {
  const text = String(line || '').trimEnd();
  if (!text.trim()) return false;
  if (text.length > 400 && TOOL_COMMAND.test(text)) return false;
  if (TOOL_COMMAND.test(text) && /\s-[a-zA-Z]/.test(text) && text.length > 160) return false;
  if (/^Using (?:core|board|library|platform|precompiled)/.test(text)) return true;
  if (/^(?:Used|Multiple libraries were found)/.test(text)) return true;
  return true;
}

/**
 * Arduino IDE's memory summary, from arduino-cli's or PlatformIO's output.
 * @param {string} text  the whole build output
 * @returns {{ flash?: { used: number, max: number|null, percent: number|null },
 *   ram?: { used: number, max: number|null, percent: number|null, left: number|null }, lowMemory?: boolean } | null}
 */
function parseMemory(text) {
  const s = String(text || '');
  const out = {};
  // One line each; the pieces are read separately because a core may leave
  // out the maximum, or the "leaving" part.
  const flashLine = /Sketch uses [^\n]*/.exec(s);
  if (flashLine) {
    const used = /Sketch uses (\d[\d,]*) bytes/.exec(flashLine[0]);
    const pct = /\((\d+)%\)/.exec(flashLine[0]);
    const max = /Maximum is (\d[\d,]*) bytes/.exec(flashLine[0]);
    if (used) out.flash = { used: n(used[1]), percent: pct ? Number(pct[1]) : null, max: max ? n(max[1]) : null };
  }
  const ramLine = /Global variables use [^\n]*/.exec(s);
  if (ramLine) {
    const used = /Global variables use (\d[\d,]*) bytes/.exec(ramLine[0]);
    const pct = /\((\d+)%\)/.exec(ramLine[0]);
    const left = /leaving (\d[\d,]*) bytes/.exec(ramLine[0]);
    const max = /Maximum is (\d[\d,]*) bytes/.exec(ramLine[0]);
    if (used) out.ram = { used: n(used[1]), percent: pct ? Number(pct[1]) : null, left: left ? n(left[1]) : null, max: max ? n(max[1]) : null };
  }
  const pioFlash = /Flash: \[[=\s]*\]\s*([\d.]+)% \(used (\d+) bytes from (\d+) bytes\)/.exec(s);
  if (pioFlash && !out.flash) out.flash = { used: Number(pioFlash[2]), percent: Math.round(Number(pioFlash[1])), max: Number(pioFlash[3]) };
  const pioRam = /RAM:\s+\[[=\s]*\]\s*([\d.]+)% \(used (\d+) bytes from (\d+) bytes\)/.exec(s);
  if (pioRam && !out.ram) out.ram = { used: Number(pioRam[2]), percent: Math.round(Number(pioRam[1])), max: Number(pioRam[3]), left: Number(pioRam[3]) - Number(pioRam[2]) };
  if (/Low memory available, stability problems may occur/.test(s)) out.lowMemory = true;
  // "Sketch too big": arduino-cli still prints the size line; the maximum tells the story.
  if (!out.flash) {
    const over = /text section exceeds available space in board|Sketch too big/.test(s);
    if (over) out.flash = { used: null, percent: null, max: null, over: true };
  }
  return Object.keys(out).length ? out : null;
}

function n(digits) {
  return Number(String(digits).replace(/,/g, ''));
}

/**
 * The two lines Arduino IDE prints after a build, from a parsed memory
 * summary. Empty when nothing is known.
 * @param {ReturnType<typeof parseMemory>} memory
 * @returns {string[]}
 */
function summaryLines(memory) {
  if (!memory) return [];
  const lines = [];
  const f = memory.flash;
  if (f && f.used !== null && f.used !== undefined) {
    lines.push(`Sketch uses ${fmt(f.used)} bytes${f.percent !== null && f.percent !== undefined ? ` (${f.percent}%)` : ''} of program storage space.${f.max ? ` Maximum is ${fmt(f.max)} bytes.` : ''}`);
  }
  const r = memory.ram;
  if (r && r.used !== null && r.used !== undefined) {
    if (r.left !== null && r.left !== undefined) {
      lines.push(`Global variables use ${fmt(r.used)} bytes${r.percent !== null ? ` (${r.percent}%)` : ''} of dynamic memory, leaving ${fmt(r.left)} bytes for local variables.${r.max ? ` Maximum is ${fmt(r.max)} bytes.` : ''}`);
    } else {
      lines.push(`Global variables use ${fmt(r.used)} bytes${r.percent !== null ? ` (${r.percent}%)` : ''} of dynamic memory.${r.max ? ` Maximum is ${fmt(r.max)} bytes.` : ''}`);
    }
  }
  if (memory.lowMemory) lines.push('Low memory available, stability problems may occur.');
  return lines;
}

const fmt = (v) => Number(v).toLocaleString('en-US');

// "file:line:col: level: message", and the form without a column.
const DIAG_COL = /^(.+):(\d+):(\d+): (fatal error|error|warning|note): (.*)$/;
const DIAG_LINE = /^(.+):(\d+): (fatal error|error|warning|note): (.*)$/;

/**
 * Compiler diagnostics ("file:line:col: error: message"), in order, without
 * repeats. The sketch's own files come first.
 * @param {string} text
 * @param {{ limit?: number }} [opts]
 * @returns {{ file: string, line: number, col: number|null, level: 'error'|'warning'|'note', message: string }[]}
 */
function parseDiagnostics(text, { limit = 50 } = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const t = raw.trimEnd();
    let m = DIAG_COL.exec(t);
    let d;
    if (m) d = { file: m[1], line: Number(m[2]), col: Number(m[3]), rawLevel: m[4], message: m[5] };
    else if ((m = DIAG_LINE.exec(t))) d = { file: m[1], line: Number(m[2]), col: null, rawLevel: m[3], message: m[4] };
    else continue;
    const level = d.rawLevel === 'fatal error' ? 'error' : d.rawLevel;
    const key = `${d.file}:${d.line}:${level}:${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file: d.file, line: d.line, col: d.col, level, message: d.message.trim() });
    if (out.length >= limit) break;
  }
  return out;
}

// What a failure means, by what the tools print. First match wins; the
// upload list is tried first for upload jobs, the compile list for compiles.
const COMPILE_FAILURES = [
  { code: 'SKETCH_TOO_BIG', re: /Sketch too big|text section exceeds available space in board|region `text' overflowed|section `\.text' will not fit in region|region `FLASH' overflowed|region `iram0_0_seg' overflowed|region `dram0_0_seg' overflowed/i,
    title: 'The sketch is too big for this board\'s flash', hint: 'Make it smaller: drop unused libraries and Serial.print text, use PROGMEM or the F() macro for strings, or pick a board with more flash.' },
  { code: 'RAM_TOO_BIG', re: /Not enough memory; see|region `data' overflowed|section `\.bss' will not fit|section `\.data' will not fit|region RAM overflowed/i,
    title: 'The sketch needs more RAM than this board has', hint: 'Move constant data to PROGMEM, wrap string literals in F(), shrink buffers and arrays.' },
  { code: 'LIBRARY_MISSING', re: /fatal error: ([^:\n]+\.h): No such file or directory/,
    title: (m) => `The library that provides ${m[1]} is not installed`, hint: (m) => `Install it from the Libraries panel (search for ${m[1].replace(/\.h$/, '')}), then build again.` },
  { code: 'CORE_MISSING', re: /platform not installed|Platform '.+' not found|Error: Platform .* is not installed|Unknown FQBN|Invalid FQBN|invalid item .* in FQBN/i,
    title: 'The core for this board is not installed', hint: 'Pick the board again so Impulse installs its core, or install it from the Boards Manager.' },
  { code: 'ROSETTA_MISSING', re: /bad CPU type in executable/i,
    title: 'The board toolchain needs Rosetta 2', hint: 'Install it with: softwareupdate --install-rosetta --agree-to-license, then build again.' },
  { code: 'SKETCH_MISSING', re: /Can't open sketch|main file missing|no such file or directory.*\.ino|is not a sketch|Sketch not found/i,
    title: 'The sketch file could not be opened', hint: 'Save the sketch (the folder and the .ino must share a name), then build again.' },
  { code: 'LINK_ERROR', re: /undefined reference to|multiple definition of/i,
    title: 'The sketch did not link', hint: 'A function is declared but never defined, or defined twice. See the first error below.' },
  { code: 'CODE_ERROR', re: /(?:^|\n)[^\n]*:\d+:\d+: (?:fatal )?error:/,
    title: 'The sketch has a compile error', hint: 'See the first error below; it names the file and line.' },
  { code: 'TOOLCHAIN', re: /arduino-cli.*(?:not found|ENOENT)|Arduino CLI is not available|exec: "[^"]+": executable file not found/i,
    title: 'The build tools are not ready', hint: 'Impulse installs them on first start; open Tools › Toolchain setup to repair them.' },
];

const UPLOAD_FAILURES = [
  { code: 'PORT_BUSY', re: /Resource busy|Device or resource busy|Serial port busy|could not open port.*(?:busy|in use)|Access is denied|port is already open|Could not exclusively lock/i,
    title: 'The port is in use', hint: 'Close the Serial Monitor or any other program using the port, then upload again.' },
  { code: 'PERMISSION', re: /Permission denied/i,
    title: 'No permission to open the port', hint: 'On Linux add your user to the dialout (or uucp) group and sign in again; on macOS allow the USB device.' },
  { code: 'UPLOAD_NO_BOOTSEL', re: /No accessible RP2040 devices|No accessible RP-series devices|no RP2040 device in BOOTSEL|Unable to find RP2040 in BOOTSEL/i,
    title: 'The Pico is not in BOOTSEL mode', hint: 'Hold BOOTSEL while plugging the Pico in (its drive appears), then upload again.' },
  { code: 'UPLOAD_BOOTMODE', re: /Wrong boot mode detected|Failed to connect to ESP\d*|No serial data received|Timed out waiting for packet header|Invalid head of packet|Failed to enter bootloader/i,
    title: 'The ESP did not enter download mode', hint: 'Hold the BOOT button as the upload starts (release when "Connecting" ends), use a data USB cable, and try a lower upload speed in Board Options.' },
  { code: 'UPLOAD_SYNC', re: /not in sync|programmer is not responding|stk500v2_ReceiveMessage\(\): timeout|stk500_getsync|stk500v2_getsync|butterfly_recv\(\)|avrdude: ser_recv\(\): programmer is not responding/i,
    title: 'The board did not answer the programmer', hint: 'Check that the right board and port are selected, unplug anything on pins 0 and 1 (RX/TX), and make sure the board resets at upload (press RESET as the upload starts if it has no auto-reset).' },
  { code: 'UPLOAD_SIGNATURE', re: /Expected signature for .* is|Device signature = 0x[0-9a-f]+ \(probably|Yikes!\s+Invalid device signature|Double check chip, or use -F/i,
    title: 'The chip is not the one the selected board has', hint: 'Pick the board (and processor) that matches the chip on your board, e.g. Nano with ATmega328P (Old Bootloader) for many clones.' },
  { code: 'UPLOAD_NO_BOOTLOADER_PORT', re: /Couldn't find a Board on the selected port|Upload port not found|No device found on|device not found|No DFU capable USB device available/i,
    title: 'The board did not come back in bootloader mode', hint: 'Double-tap RESET to enter the bootloader, check the cable, then upload again.' },
  { code: 'PORT_GONE', re: /No such file or directory.*(?:\/dev\/|COM\d)|can't open device|could not open port|Port .* not found|is not available\. Please check|Serial port .* could not be opened|The system cannot find the file specified/i,
    title: 'The port is gone', hint: 'Plug the board back in, pick its port again, then upload.' },
  { code: 'UPLOAD_VERIFY', re: /MD5 of file does not match data in flash|verification error|content mismatch|Verification failed|verify failed/i,
    title: 'The upload did not verify', hint: 'Try again with a shorter cable or a lower upload speed; a board that never verifies may have damaged flash.' },
  { code: 'UPLOAD_LOST', re: /Packet content transfer stopped|Serial data stream stopped|Possible serial noise or corruption|Error: Could not read from the serial port/i,
    title: 'The connection dropped during the upload', hint: 'Check the cable and the board\'s power (motors and radios on the same supply cause this), then upload again.' },
  { code: 'TIMEOUT', re: /timed out|timeout/i,
    title: 'The upload timed out', hint: 'Check the cable and the port, then upload again.' },
];

/**
 * Why a build or upload failed: a stable code, a short title and what to do.
 * @param {string} text  the whole output
 * @param {'compile'|'upload'} kind
 * @param {{ memory?: ReturnType<typeof parseMemory> | null }} [facts]
 * @returns {{ code: string, title: string, hint: string }}
 */
function classifyFailure(text, kind = 'compile', { memory = null } = {}) {
  const s = String(text || '');
  const lists = kind === 'upload' ? [UPLOAD_FAILURES, COMPILE_FAILURES] : [COMPILE_FAILURES, UPLOAD_FAILURES];
  for (const list of lists) {
    for (const f of list) {
      const m = f.re.exec(s);
      if (!m) continue;
      let title = typeof f.title === 'function' ? f.title(m) : f.title;
      const hint = typeof f.hint === 'function' ? f.hint(m) : f.hint;
      if (f.code === 'SKETCH_TOO_BIG' && memory?.flash?.used && memory.flash.max) {
        title = `The sketch is too big: ${fmt(memory.flash.used)} bytes, and this board's flash holds ${fmt(memory.flash.max)}`;
      }
      if (f.code === 'RAM_TOO_BIG' && memory?.ram?.used && memory.ram.max) {
        title = `The sketch needs ${fmt(memory.ram.used)} bytes of RAM, and this board has ${fmt(memory.ram.max)}`;
      }
      return { code: f.code, title, hint };
    }
  }
  return kind === 'upload'
    ? { code: 'UPLOAD_FAILED', title: 'The upload failed', hint: 'The tool\'s output below says why.' }
    : { code: 'COMPILE_FAILED', title: 'The sketch did not compile', hint: 'The output below says why.' };
}

/**
 * The line of a failure worth quoting first: the first error diagnostic, else
 * the last line that looks like an error, else the last non-empty line.
 * @param {string} text
 * @returns {string}
 */
function firstErrorLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  const diag = lines.find((l) => /:\d+:\d+: (?:fatal )?error:|:\d+: (?:fatal )?error:/.test(l));
  if (diag) return diag;
  const err = [...lines].reverse().find((l) => /error|failed|fatal|cannot|unable|not found|denied|timed out/i.test(l) && !TOOL_COMMAND.test(l));
  return err || lines[lines.length - 1] || '';
}

module.exports = {
  STAGE_LABEL,
  COMPILE_STAGES,
  UPLOAD_STAGES,
  stageOf,
  progressOf,
  isNoteworthy,
  parseMemory,
  summaryLines,
  parseDiagnostics,
  classifyFailure,
  firstErrorLine,
};
