import { runHeadless, summarizeTrace, pinLabel } from '../headless.js';
import { wordsToHex, TOGGLE_D13 } from './helpers.js';

describe('runHeadless', () => {
  it('runs a program for the requested simulated time and records pin edges', async () => {
    const run = await runHeadless(wordsToHex(TOGGLE_D13), { seconds: 0.005 });
    expect(run.simSeconds).toBeGreaterThanOrEqual(0.005);
    const d13 = run.trace.filter(e => e.pin === 13);
    expect(d13.length).toBeGreaterThan(1000);
    expect(run.trace.every(e => e.pin === 13)).toBe(true);
  });

  it('measures the square-wave frequency from the trace', async () => {
    // One loop is 5-6 CPU cycles depending on how avr8js counts SBI/CBI.
    const run = await runHeadless(wordsToHex(TOGGLE_D13), { seconds: 0.002 });
    const [d13] = summarizeTrace(run.trace, run.finalStates);
    expect(d13.label).toBe('D13');
    expect(d13.hz).toBeGreaterThanOrEqual(16e6 / 6 - 1);
    expect(d13.hz).toBeLessThanOrEqual(16e6 / 5 + 1);
  });

  it('can be cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runHeadless(wordsToHex(TOGGLE_D13), { seconds: 1, signal: controller.signal })).rejects.toThrow('cancelled');
  });

  it('labels analog pins', () => {
    expect(pinLabel(14)).toBe('A0');
    expect(pinLabel(9)).toBe('D9');
  });
});
