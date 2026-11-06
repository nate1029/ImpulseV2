// Text to an embedding vector via OpenAI's embeddings API, reusing the OpenAI
// key the gateway already has. Returns null when there is no key or on any
// failure, so the learning loop falls back to exact-signature matching. No
// model is trained — this only turns text into a vector for similarity search.

const MODEL = 'text-embedding-3-small'; // 1536 dims; matches migration 004.
export const EMBED_DIMS = 1536;

export function createEmbedder(config, fetchImpl = fetch) {
  const { apiKey, baseURL } = config.openai || {};
  const embed = async function embed(text) {
    const input = String(text || '').replace(/\s+/g, ' ').slice(0, 8000).trim();
    if (!apiKey || !input) return null;
    try {
      const res = await fetchImpl(`${baseURL}/v1/embeddings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, input }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const vec = data?.data?.[0]?.embedding;
      return Array.isArray(vec) && vec.length === EMBED_DIMS ? vec : null;
    } catch {
      return null;
    }
  };
  embed.enabled = Boolean(apiKey);
  return embed;
}

// A pgvector parameter literal: '[0.1,0.2,...]'.
export const toVector = (vec) => (Array.isArray(vec) && vec.length ? `[${vec.join(',')}]` : null);
