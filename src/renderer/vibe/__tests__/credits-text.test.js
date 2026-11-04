import { periodNoun, periodWords, refillWhen } from '../credits-text.js';

describe('credits-text', () => {
  it('names the refill period', () => {
    expect(periodWords(null)).toBe('every month');
    expect(periodWords(0)).toBe('every month');
    expect(periodWords(1)).toBe('every hour');
    expect(periodWords(5)).toBe('every 5 hours');
    expect(periodWords(24)).toBe('every day');
    expect(periodWords(72)).toBe('every 3 days');
    expect(periodNoun(5)).toBe('This period');
    expect(periodNoun(null)).toBe('This month');
  });

  it('counts down to an hourly refill and dates a monthly one', () => {
    const now = Date.parse('2026-06-01T09:00:00Z');
    expect(refillWhen('2026-06-01T11:10:00Z', 5, now)).toBe('in 2 h 10 min');
    expect(refillWhen('2026-06-01T12:00:00Z', 5, now)).toBe('in 3 h');
    // 4 h 59 min 50 s rounds to five whole hours, never "4 h 60 min".
    expect(refillWhen('2026-06-01T13:59:50Z', 5, now)).toBe('in 5 h');
    expect(refillWhen('2026-06-01T09:20:00Z', 5, now)).toBe('in 20 min');
    expect(refillWhen('2026-06-01T09:00:30Z', 5, now)).toBe('in a minute');
    expect(refillWhen('2026-07-01T09:00:00Z', null, now)).toMatch(/^on /);
    expect(refillWhen('garbage', 5, now)).toBe('');
  });
});
