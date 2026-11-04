// The chat's MorphOrb: the agent's steps as labels, the original's easing and
// timelines, and the palettes. The DOM flow runs in scripts/e2e.mjs.
import { stepLabel, cubicBezier, launchTracks, unfoldTracks, PALETTES, COPY, STAGE_H } from '../morph-orb/morph-orb.js';

describe('agent steps on the orb', () => {
  test('model calls think; tools say what they do, each with a light program', () => {
    expect(stepLabel({ type: 'thinking' })).toEqual(['Thinking', 0]);
    expect(stepLabel(null)).toEqual([COPY.labels[0], 0]);
    expect(stepLabel({ type: 'tool', name: 'get_editor_code' })).toEqual(['Reading the sketch', 1]);
    expect(stepLabel({ type: 'tool', name: 'search_memory' })).toEqual(['Searching past fixes', 1]);
    expect(stepLabel({ type: 'tool', name: 'analyze_error' })).toEqual(['Analyzing', 2]);
    expect(stepLabel({ type: 'tool', name: 'compile_sketch' })).toEqual(['Compiling', 3]);
    expect(stepLabel({ type: 'tool', name: 'upload_sketch' })).toEqual(['Uploading', 3]);
    expect(stepLabel({ type: 'tool', name: 'something_new' })).toEqual(['Working', 3]);
  });
});

describe('the original choreography', () => {
  test('cubic-bezier easing hits its ends and the CSS curve between them', () => {
    const ease = cubicBezier(0.22, 1, 0.36, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeGreaterThan(0.9); // a strong ease-out
    const linear = cubicBezier(0, 0, 1, 1);
    expect(linear(0.3)).toBeCloseTo(0.3, 4);
  });

  test('launch folds the pill as it is (width and height) into the 132 px orb', () => {
    const tracks = launchTracks({ pw: 360, ph: 100 });
    const first = (ch) => tracks.find(t => t.ch === ch);
    const last = (ch) => [...tracks].reverse().find(t => t.ch === ch);
    expect(first('w').from).toBe(360);
    expect(first('h').from).toBe(100);
    expect(last('w').to).toBe(132);
    expect(last('h').to).toBe(132);
    expect(Math.max(...tracks.map(t => t.t1))).toBe(1500);
  });

  test('unfold opens into the message box, docks at 700 ms, then brings the words in', () => {
    const tracks = unfoldTracks({ cw: 340, ch: 220 }, 600);
    const at = (ch) => tracks.filter(t => t.ch === ch);
    expect(at('w').pop().to).toBe(340);
    expect(at('h').pop().to).toBe(220);
    expect(at('r').pop().to).toBe(20);
    expect(at('dock')[0].t1).toBe(700);
    expect(at('m')[0].t1).toBe(700);
    expect(at('wp')[0].t0).toBeGreaterThanOrEqual(700);
    expect(at('wp')[0].t1 - at('wp')[0].t0).toBe(600);
  });

  test('the orb has room for itself and its label', () => {
    expect(STAGE_H).toBeGreaterThanOrEqual(220);
  });
});

describe('palettes', () => {
  test('every theme and outcome has a colour for each sweep and alpha step', () => {
    for (const name of ['dark', 'darkError', 'light', 'lightError']) {
      expect(PALETTES[name]).toHaveLength(25 * 49);
    }
    // The original's dark palette: light grey at rest, emerald when done.
    expect(PALETTES.dark[48]).toBe('rgba(235,235,235,1.000)');
    expect(PALETTES.dark[PALETTES.dark.length - 1]).toBe('rgba(52,211,153,1.000)');
    expect(PALETTES.darkError[PALETTES.darkError.length - 1]).toBe('rgba(248,113,113,1.000)');
  });
});
