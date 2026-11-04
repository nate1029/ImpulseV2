// Reads the environment once; the rest of the server gets a plain object.

const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ config: object | null, missing: string[] }}
 */
export function loadConfig(env = process.env) {
  const missing = [];
  if (!env.DATABASE_URL) missing.push('DATABASE_URL');
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) missing.push('BETTER_AUTH_SECRET (32+ characters)');
  if (missing.length) return { config: null, missing };

  const vercelURL = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '';
  const baseURL = (env.IMPULSE_CLOUD_URL || env.BETTER_AUTH_URL || vercelURL || 'http://localhost:8787').replace(/\/+$/, '');
  const production = env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production';
  const resendKey = env.RESEND_API_KEY || '';

  return {
    missing,
    config: {
      baseURL,
      production,
      // Dev-only Test sign-in (fixed code 234567). Needs TEST_LOGIN=1 AND a
      // non-production build, so a mis-set NODE_ENV on a live host can't enable it.
      testLogin: env.TEST_LOGIN === '1' && !production,
      secret: env.BETTER_AUTH_SECRET,
      databaseURL: env.DATABASE_URL,
      // One key per vendor; a vendor without a key is simply not offered.
      openai: {
        apiKey: env.OPENAI_API_KEY || '',
        baseURL: (env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, ''),
      },
      anthropic: {
        apiKey: env.ANTHROPIC_API_KEY || '',
        baseURL: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
      },
      google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : null,
      github: env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
        : null,
      email: {
        resendKey,
        // Resend's shared test sender until a domain of ours is verified there.
        from: env.EMAIL_FROM || 'Impulse <onboarding@resend.dev>',
        // Without a mail service, codes are printed to the server log, which
        // is only acceptable outside production.
        enabled: Boolean(resendKey) || !production,
      },
      adminEmails: list(env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
      trustedOrigins: list(env.TRUSTED_ORIGINS),
      websiteURL: (env.IMPULSE_WEBSITE_URL || 'https://impulse-ide.vercel.app').replace(/\/+$/, ''),
    },
  };
}
