// End-to-end: real arduino-cli build → headless AVR run → @expect checks.
// Skipped when arduino-cli or the arduino:avr core isn't installed (e.g. CI).
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runHeadless } from '../headless.js';
import { parseExpectations, evaluateExpectations } from '../expectations.js';

function findCliWithAvrCore() {
  for (const candidate of ['/opt/homebrew/bin/arduino-cli', '/usr/local/bin/arduino-cli', 'arduino-cli']) {
    try {
      const cores = execFileSync(candidate, ['core', 'list'], { stdio: 'pipe' }).toString();
      if (cores.includes('arduino:avr')) return candidate;
    } catch { /* not installed at this path */ }
  }
  return null;
}

const CLI = findCliWithAvrCore();

const SKETCH = `// @run 2.2s
// @expect serial contains "on"
// @expect serial matches /off\\r?\\n/
// @expect pin 13 toggles
// @expect pin 13 frequency 1Hz ±5%
void setup() {
  Serial.begin(115200);
  pinMode(13, OUTPUT);
}
void loop() {
  digitalWrite(13, HIGH);
  Serial.println("on");
  delay(500);
  digitalWrite(13, LOW);
  Serial.println("off");
  delay(500);
}
`;

(CLI ? describe : describe.skip)('compile → simulate → expect (needs arduino-cli + arduino:avr)', () => {
  it('runs Blink in the simulator and passes its own expectations', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-e2e-'));
    const sketchDir = path.join(dir, 'blink');
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(sketchDir);
    fs.writeFileSync(path.join(sketchDir, 'blink.ino'), SKETCH);
    execFileSync(CLI, ['compile', '--fqbn', 'arduino:avr:uno', '--output-dir', outDir, sketchDir], { stdio: 'pipe' });
    const hex = fs.readFileSync(path.join(outDir, 'blink.ino.hex'), 'utf8');

    const { seconds, items, errors } = parseExpectations(SKETCH);
    expect(errors).toEqual([]);
    const run = await runHeadless(hex, { seconds });
    const results = evaluateExpectations(items, run);
    for (const r of results) expect({ check: r.raw, pass: r.pass, detail: r.detail }).toMatchObject({ pass: true });
  }, 120000);
});
