import { baseFqbn } from './board-options.js';

// Which connected board to select for upload, from what arduino-cli recognised.
//
// arduino-cli matches a port to boards by its USB id, from the installed cores.
// A genuine Uno matches exactly one board; clones with a CH340 or CP210x
// adapter match none, and native-USB chips (ESP32-S3, RP2040) can match many.
// The rules keep the user in charge:
//  - A board plugged in while the IDE runs is what they want to use now: select it.
//  - At launch, select a recognised board only when nothing usable is selected.
//  - Several candidates: keep the selected board if it's one of them, else
//    take the port and ask which board it is.

/**
 * @param {{ ports: Array<{ port: string, boards?: Array<{ name: string, fqbn: string }> }>,
 *   added: Array<{ port: string }>, isBaseline: boolean,
 *   selectedBoard?: string, selectedPort?: string, installed?: (fqbn: string) => boolean }} s
 * @returns {null | { port: string, fqbn: string | null, name: string | null, choices: Array<{ name: string, fqbn: string }>, reason: 'plugged-in' | 'launch' }}
 *   fqbn null: select the port, and ask which of `choices` the board is.
 */
export function pickDetectedBoard({ ports, added, isBaseline, selectedBoard = '', selectedPort = '', installed = () => true }) {
  const candidatesOf = (p) => (p.boards || []).filter((b) => b.fqbn && installed(b.fqbn));
  const decide = (p, reason) => {
    const choices = candidatesOf(p);
    if (!choices.length) return null;
    const keep = choices.find((b) => b.fqbn === baseFqbn(selectedBoard));
    if (keep) {
      // Already the selected board: only the port may need to follow.
      return p.port === selectedPort ? null : { port: p.port, fqbn: keep.fqbn, name: keep.name, choices, reason, keepBoard: true };
    }
    if (choices.length === 1) return { port: p.port, fqbn: choices[0].fqbn, name: choices[0].name, choices, reason };
    return { port: p.port, fqbn: null, name: null, choices, reason };
  };

  if (!isBaseline) {
    // The most recently plugged-in recognised board wins.
    for (const a of [...added].reverse()) {
      const p = ports.find((x) => x.port === a.port);
      const pick = p && decide(p, 'plugged-in');
      if (pick) return pick;
    }
    return null;
  }

  // At launch: leave a working selection alone.
  const selectedPresent = selectedPort && ports.some((p) => p.port === selectedPort);
  if (selectedBoard && selectedPresent) return null;
  const recognised = ports.filter((p) => candidatesOf(p).length);
  if (recognised.length !== 1) return null;
  return decide(recognised[0], 'launch');
}
