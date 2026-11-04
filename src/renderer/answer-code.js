// Code in an answer that belongs in the sketch.
//
// The agent is told to write code with its editor tools, so the user never
// has to click Insert. When an answer nevertheless carries a whole sketch as
// a code block (a model that ignored the rule, or a build mode without
// tools), the sketch-shaped block is written into the open sketch for them.
// Pure functions; the renderer does the writing.

const FENCE = /(^|\n)[ \t]*(```+|~~~+)[ \t]*([\w+#.-]*)[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;

/** Fenced code blocks of a markdown answer, in order. */
export function codeBlocksOf(text) {
  const blocks = [];
  const s = String(text || '');
  let m;
  FENCE.lastIndex = 0;
  while ((m = FENCE.exec(s))) blocks.push({ lang: (m[3] || '').toLowerCase(), code: m[4] });
  return blocks;
}

/** Whether a block is a whole Arduino sketch (or PlatformIO main): it defines setup() and loop(). */
export function isSketchShaped(code) {
  const s = String(code || '');
  return /\bvoid\s+setup\s*\(\s*(?:void)?\s*\)/.test(s) && /\bvoid\s+loop\s*\(\s*(?:void)?\s*\)/.test(s);
}

/**
 * The one sketch-shaped block of an answer, or null when there is none or
 * more than one (two sketches in one answer is ambiguous: leave the choice to
 * the user).
 * @returns {{ code: string, lang: string } | null}
 */
export function sketchBlockFrom(text) {
  const sketches = codeBlocksOf(text).filter((b) => isSketchShaped(b.code));
  return sketches.length === 1 ? sketches[0] : null;
}
