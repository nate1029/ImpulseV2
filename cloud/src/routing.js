// Which model answers which kind of work. To the person there is one
// "Impulse AI"; the app asks the server for each turn, and the server picks
// the cheapest model that does the job from the admin's routing table, moving
// up the escalation ladder when a turn has already failed once.

/** The kinds of work the app asks about. */
export const ROUTE_KINDS = ['agent', 'plan', 'debug', 'ask', 'summary'];

/**
 * @param {{ routing: object, kind: string, escalate?: number, servable: string[], fallback?: string }} input
 *   routing: the admin's table (per kind, plus `escalation`, best last)
 *   servable: models this server can run that the user's plan allows, in catalog order
 * @returns {string} a model id from `servable`
 */
export function chooseModel({ routing, kind, escalate = 0, servable, fallback }) {
  const ok = (m) => typeof m === 'string' && servable.includes(m);
  if (escalate > 0) {
    const ladder = (routing?.escalation || []).filter(ok);
    if (ladder.length) return ladder[Math.min(escalate, ladder.length) - 1];
  }
  const wanted = routing?.[kind] || routing?.agent;
  if (ok(wanted)) return wanted;
  if (ok(fallback)) return fallback;
  return servable[0];
}
