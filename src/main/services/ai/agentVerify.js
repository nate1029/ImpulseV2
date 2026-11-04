/**
 * Agentic verify step — the "observe & fix" half of the closed simulation loop.
 * Given the sketch plus real observations from the AVR simulation (compile
 * status, captured serial output, pin activity), the model judges whether the
 * program behaves correctly and, if not, returns a corrected sketch.
 * @module main/services/ai/agentVerify
 */

const SYSTEM_PROMPT = `You are the verification engine of Impulse IDE — an AI-native
embedded IDE. You are given an Arduino sketch and REAL observations from running
its compiled machine code in a cycle-accurate AVR simulator (avr8js) of the board
named in BOARD, with the parts wired as listed in CIRCUIT.

Your job: decide whether the sketch behaves correctly, and if it clearly does
not, return a corrected sketch. Judge behavior against what the code evidently
intends (comments, function names, pin usage, serial messages).

You receive:
- BOARD: the simulated board and its microcontroller.
- CIRCUIT: what is wired to each board pin (may be empty if nothing is wired).
- COMPILE: "ok" or the compiler error text.
- SERIAL: the exact bytes the sketch printed to Serial during the run (may be
  empty if the sketch prints nothing — that is fine, not an error by itself).
- PINS: a summary of digital pin activity observed (toggle counts, PWM, inputs).
- RUN_SECONDS: how long the simulation ran.

Rules:
- If COMPILE is an error, the fix is a code change that resolves it. Return fail
  + fixedCode.
- If it compiled and the observed behavior matches the code's intent, return
  status "pass". Do NOT invent problems. A blinking LED that toggles, serial
  banners that print, sensors that idle — these are passing.
- Only return fail for a CONCRETE, evidence-backed defect: a compile error, a
  crash/hang (no expected serial ever appears), an obviously wrong pin, a logic
  bug contradicted by the observations (e.g. code says "blink every 500ms" but
  the pin never toggles), or a broken control-flow the serial reveals.
- When you return fixedCode, return the COMPLETE corrected sketch, not a diff.
  Change as little as possible. Preserve the user's structure and comments.
- Never widen scope: don't add features, don't reformat, don't rename things.

Respond with ONLY this JSON, no markdown fences:
{
  "status": "pass" | "fail",
  "summary": "one or two sentences on what you observed and concluded",
  "issues": ["short bullet", "..."],
  "fixedCode": "complete corrected .ino source, or omit when status is pass"
}`;

/**
 * Run one verify/fix step against the active provider.
 * @param {import('./agent')} aiAgent
 * @param {{code:string, compile:string, serial:string, pins:string, runSeconds:number}} obs
 * @returns {Promise<{success:boolean, status?:string, summary?:string, issues?:string[], fixedCode?:string, error?:string}>}
 */
async function verifyExecution(aiAgent, obs) {
  if (!aiAgent || !aiAgent.currentProvider) {
    return { success: false, error: 'No AI provider configured. Add an API key in the AI panel first.' };
  }

  const user = [
    `BOARD: ${String(obs.board || 'Arduino Uno (ATmega328P)').slice(0, 80)}`,
    `CIRCUIT:\n${String(obs.circuit || '(nothing wired)').slice(0, 4000)}`,
    `COMPILE: ${obs.compile || 'ok'}`,
    `RUN_SECONDS: ${obs.runSeconds ?? 0}`,
    `PINS: ${obs.pins || '(none observed)'}`,
    `SERIAL:\n${(obs.serial || '(no serial output)').slice(0, 4000)}`,
    ``,
    `SKETCH:\n${obs.code}`,
  ].join('\n');

  let raw;
  try {
    const res = await aiAgent.currentProvider.chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
      { temperature: 0, max_tokens: 8000, effort: 'medium', tools: [] }
    );
    raw = res?.content ?? '';
  } catch (err) {
    return { success: false, error: `AI request failed: ${err.message}` };
  }

  const parsed = extractJson(raw);
  if (!parsed || (parsed.status !== 'pass' && parsed.status !== 'fail')) {
    return { success: false, error: 'The AI response was not valid verify JSON.' };
  }
  return {
    success: true,
    status: parsed.status,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    issues: Array.isArray(parsed.issues) ? parsed.issues.filter(x => typeof x === 'string') : [],
    fixedCode: typeof parsed.fixedCode === 'string' && parsed.fixedCode.trim() ? parsed.fixedCode : null,
  };
}

function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

module.exports = { verifyExecution };
