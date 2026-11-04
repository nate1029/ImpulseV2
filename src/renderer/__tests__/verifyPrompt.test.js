import { simulatorFixPrompt } from '../verify.js';

const RAN = {
  stage: 'done', board: 'Arduino Uno', simSeconds: 3,
  results: [{ raw: '// @expect serial contains "ready"', pass: false, detail: 'the serial output never contained "ready"' },
            { raw: '// @expect pin 13 toggles', pass: true, detail: '' }],
  parseErrors: [],
  serial: 'boot\nsetup done\n',
  pins: [{ pin: 13, label: 'D13', edges: 6, hz: 2.0, high: false }],
};

describe('what a failed simulator run tells the agent', () => {
  it('sends the compile error when it did not compile', () => {
    const text = simulatorFixPrompt({ stage: 'compile', board: 'Arduino Uno', error: "x.ino:4:3: error: 'foo' was not declared" });
    expect(text).toMatch(/^\[SIMULATOR\] The sketch does not compile for the simulated Arduino Uno:/);
    expect(text).toMatch(/'foo' was not declared/);
    expect(text).toMatch(/Fix the code\./);
  });

  it('sends the failing checks, what it printed and what the pins did', () => {
    const text = simulatorFixPrompt(RAN, { hasCircuit: true, wiring: 'D13 → LED led1:A' });
    expect(text).toMatch(/ran 3\.0 s on the simulated Arduino Uno, and one check did not pass/);
    expect(text).toMatch(/- \/\/ @expect serial contains "ready": the serial output never contained "ready"/);
    expect(text).not.toMatch(/pin 13 toggles/); // a check that passed is not evidence of a problem
    expect(text).toMatch(/What it printed:\nboot\nsetup done/);
    expect(text).toMatch(/Pins: D13 6 edges, about 2\.0 Hz/);
    expect(text).toMatch(/Wired on the canvas:\nD13 → LED led1:A/);
    expect(text).toMatch(/Decide what is actually wrong/);
  });

  it('says when nothing is wired, so the model does not twist the code', () => {
    const text = simulatorFixPrompt({ ...RAN, serial: '' }, { hasCircuit: false });
    expect(text).toMatch(/It printed nothing at all\./);
    expect(text).toMatch(/Nothing is wired on the simulator canvas/);
    expect(text).toMatch(/do not twist the code to satisfy the check/);
  });

  it('names a run that stopped as a blocking or crashing sketch', () => {
    const text = simulatorFixPrompt({ stage: 'run', board: 'ESP32', error: 'timed out' });
    expect(text).toMatch(/The run stopped on the simulated ESP32: timed out/);
    expect(text).toMatch(/blocks forever or crashes/);
  });
});
