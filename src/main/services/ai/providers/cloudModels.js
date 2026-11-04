/**
 * The models Impulse Cloud offers, as the app knows them before the server's
 * catalog arrives (GET /v1/models replaces names, costs and the default once
 * it loads). In the app every id carries an "impulse:" prefix, so cloud models
 * never mix with anything else; the bare id is what the gateway and the vendor
 * see. Each model names its vendor, which decides the lane the request takes.
 * @module main/services/ai/providers/cloudModels
 */

const PREFIX = 'impulse:';

/** Menu order. `cost` is relative to the default model for a typical agent call. */
const CATALOG = [
  { id: 'gpt-5.4', vendor: 'openai', name: 'GPT-5.4', tagline: 'Best for building', cost: 1 },
  { id: 'gpt-5.5', vendor: 'openai', name: 'GPT-5.5', tagline: 'Most capable', cost: 2 },
  { id: 'gpt-5.4-mini', vendor: 'openai', name: 'GPT-5.4 mini', tagline: 'Fast and capable', cost: 0.3 },
  { id: 'gpt-5.4-nano', vendor: 'openai', name: 'GPT-5.4 nano', tagline: 'Quickest, lowest cost', cost: 0.08 },
  { id: 'claude-opus-5-5', vendor: 'anthropic', name: 'Opus 5.5', tagline: 'Best for building', cost: 1.33 },
  { id: 'claude-sonnet-5-5', vendor: 'anthropic', name: 'Sonnet 5.5', tagline: 'Fast and capable', cost: 0.71 },
  { id: 'claude-haiku-5-5', vendor: 'anthropic', name: 'Haiku 5.5', tagline: 'Quickest, lowest cost', cost: 0.04 },
  { id: 'claude-fable-5-1', vendor: 'anthropic', name: 'Fable 5.1', tagline: 'Most capable', cost: 3.22 },
];

const DEFAULT_MODEL = `${PREFIX}gpt-5.4`;

/** Whether an id is one of ours (prefixed), whatever the model. */
function isCloudId(id) {
  return typeof id === 'string' && id.startsWith(PREFIX) && id.length > PREFIX.length;
}

/** The id without the prefix (a bare id is returned as is). */
function bare(id) {
  return isCloudId(id) ? id.slice(PREFIX.length) : String(id || '');
}

/** Which vendor serves a model; an id not in the catalog is guessed from its name. */
function vendorOf(id) {
  const plain = bare(id);
  const known = CATALOG.find((m) => m.id === plain);
  if (known) return known.vendor;
  if (/^(gpt-|o\d|chatgpt-)/.test(plain)) return 'openai';
  if (/^claude-/.test(plain)) return 'anthropic';
  return null;
}

function displayName(id) {
  const plain = bare(id);
  return CATALOG.find((m) => m.id === plain)?.name || plain;
}

/** Prefixed ids of one vendor, in menu order. */
function modelsOf(vendor) {
  return CATALOG.filter((m) => m.vendor === vendor).map((m) => `${PREFIX}${m.id}`);
}

module.exports = { PREFIX, CATALOG, DEFAULT_MODEL, isCloudId, bare, vendorOf, displayName, modelsOf };
