/**
 * Proof-carrying knowledge (docs/design/knowledge-strategy.md §2): every fact
 * Impulse hands the model says how it is known, so the model can prefer
 * checked facts over its own memory and say how sure it is.
 *
 *   L0  not yet checked            Impulse's notes that nothing has verified yet
 *   L1  from an official source    the maker's documentation, with its address
 *   L2  read from the installed core   variant pin headers, board definitions
 *   L3  compiled by Impulse         a sketch or probe that builds on a named core
 *   L4  ran in Impulse's simulator  with its // @expect checks passing
 *   L5  ran on a real board         seen on hardware, with what it printed
 *   L6  fixed real users' builds    a fix that worked, counted
 *
 * The evidence lives in proofs.json (written by `npm run knowledge:audit --
 * --write` and `npm run knowledge:probe -- --write`) and recipes.verified.json
 * (`npm run knowledge:recipes -- --write`). A proof is only as good as the
 * text it proved: recipes and probes carry a hash of the exact sketch.
 * @module main/services/ai/knowledge/proof
 */

const crypto = require('crypto');
const PROOFS = require('./proofs.json');

const LEVELS = [
  'not yet checked',
  'from an official source',
  'read from the installed core',
  'compiled by Impulse',
  "ran in Impulse's simulator",
  'ran on a real board',
  "fixed real users' builds",
];

/** sha256 of a text, 12 hex characters: what a proof is bound to. */
const textHash = (text) => crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 12);

/**
 * @param {number} level 0–6
 * @param {string} [detail] what exactly was checked, against what, when
 * @returns {{ level: number, label: string, detail: string }}
 */
function proof(level, detail = '') {
  const l = Math.max(0, Math.min(6, Math.round(Number(level) || 0)));
  return { level: l, label: LEVELS[l], detail: String(detail || '') };
}

/** One line for the model: "Proof L3, compiled by Impulse: …". */
function proofLine(p) {
  if (!p) return '';
  return `Proof L${p.level}, ${p.label}${p.detail ? `: ${p.detail}` : ''}.`;
}

/** The short form for blocks that ride with every request: "L3 (compiled by Impulse)". */
function proofTag(p) {
  return p ? `L${p.level} (${p.label})` : '';
}

/** The strongest of several proofs (null when none). */
function strongest(list) {
  return (list || []).filter(Boolean).reduce((best, p) => (!best || p.level > best.level ? p : best), null);
}

/** Facts read live from the installed core (pins, LED, buses). */
function coreProof(core) {
  return proof(2, `${core || 'the installed core'}, its board definition and variant pin header, read on this computer`);
}

/**
 * A catalog board's notes. "core": its FQBN is known to an installed core and
 * the audit checked its record's pins against that core; "index": listed in
 * the core's board-manager index; "doc": the maker's documentation.
 */
function boardProof(entry) {
  if (!entry) return proof(0, 'Impulse has no record for this board');
  const audit = PROOFS.audit || {};
  if (entry.verified === 'core' && (audit.boards || []).includes(entry.id)) {
    const core = audit.cores?.[entry.platform];
    return proof(2, `checked against ${entry.platform}${core ? ` ${core}` : ''} by Impulse's audit on ${audit.date}`);
  }
  if (entry.verified === 'core') return proof(2, `its board id ${entry.fqbn} is defined by ${entry.platform}; the notes themselves are Impulse's`);
  if (entry.verified === 'index') return proof(1, `listed in ${entry.platform}'s board-manager index; the notes are Impulse's, not checked against the core`);
  if (entry.verified === 'doc') return proof(1, "the maker's documentation; not checked against a core");
  return proof(0, "Impulse's notes");
}

let probeSketches = null;
/** The current text hash of each probe sketch (a proof is void once its sketch changes). */
function probeHashes() {
  if (probeSketches) return probeSketches;
  probeSketches = {};
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, 'boards', 'probes');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).probes || {};
    for (const [name, probe] of Object.entries(manifest)) {
      probeSketches[name] = textHash(fs.readFileSync(path.join(dir, probe.sketch), 'utf8'));
    }
  } catch { /* no probes shipped: no drift proofs */ }
  return probeSketches;
}

/** Which probe proves a platform's drift table, if its sketch is unchanged since it compiled. */
function probeFor(platform) {
  const hashes = probeHashes();
  return Object.entries(PROOFS.probes || {}).find(([name, p]) => String(p.core || '').startsWith(`${platform}@`) && hashes[name] === p.sketch) || null;
}

/**
 * A core's API-drift notes. L3 when the probe sketch, which uses the calls
 * the notes recommend, compiled with that core (the same major version as the
 * one installed); L1 when the drift table names its source; else L0.
 */
function driftProof(platform, coreVersion = '', { source = '' } = {}) {
  const hit = probeFor(platform);
  if (hit) {
    const [name, p] = hit;
    const provedMajor = String(p.core).split('@')[1]?.split('.')[0];
    const major = String(coreVersion || '').split('.')[0];
    if (!major || major === provedMajor) {
      return proof(3, `the "${name}" probe sketch with the recommended calls compiled for ${p.fqbn} with ${p.core} on ${p.date}`);
    }
  }
  if (source) return proof(1, source);
  return proof(0, "Impulse's notes on this core");
}

/** A part's facts: L1 with a datasheet, else Impulse's notes. */
function componentProof(component) {
  const src = component?.sources?.[0];
  if (src) return proof(1, src);
  return proof(0, "Impulse's part notes; the part's datasheet has the limits");
}

/** A recipe: L5 when it ran on a board, L3 when compiled, else unproven. */
function recipeProof(id, family, verified) {
  const hw = PROOFS.hardware?.[id]?.[family];
  if (hw) return proof(5, `ran on ${hw.board} (${hw.core}) on ${hw.date}${hw.saw ? `, printing "${hw.saw}"` : ''}`);
  if (verified) return proof(3, `compiled for ${verified.fqbn} with ${verified.core}`);
  return proof(0, 'not compiled by Impulse for this family yet; compile before relying on it');
}

/** A chip family's guide: its pin table was audited against the cores. */
function guideProof(familyId) {
  const audit = PROOFS.audit || {};
  if ((audit.families || []).includes(familyId)) {
    return proof(2, `its pin ranges were checked against the installed cores on ${audit.date}; the advice is Impulse's notes`);
  }
  return proof(0, "Impulse's notes on this chip");
}

/** A page from the maker's documentation. */
function docsProof(url) {
  return proof(1, url);
}

/** A fix other builds needed: L6 with how often it worked. */
function fixProof(count, scope = 'shared') {
  const n = Number(count) || 0;
  if (n <= 0) return null;
  return proof(6, `${n} build${n === 1 ? '' : 's'} ${scope === 'local' ? 'on this computer' : 'by Impulse users'} were fixed this way`);
}

module.exports = {
  LEVELS, PROOFS, textHash, proof, proofLine, proofTag, strongest,
  coreProof, boardProof, driftProof, componentProof, recipeProof, guideProof, docsProof, fixProof,
};
