// Better Auth: Google, GitHub and email + password (verified with a 6-digit
// code), sessions usable as bearer tokens by the desktop app, and roles/bans
// for the admin console.

import { betterAuth } from 'better-auth';
import { admin, bearer, emailOTP } from 'better-auth/plugins';

const DAY = 60 * 60 * 24;

/**
 * @param {{ config: object, pool: import('pg').Pool, sendCode: Function, background?: (p: Promise<unknown>) => void }} deps
 */
export function authOptions({ config, pool, sendCode, onVerified = async () => {}, background = (p) => { p.catch(() => {}); } }) {
  const isAdminEmail = (email) => Boolean(email) && config.adminEmails.includes(String(email).toLowerCase());
  const socialProviders = {};
  if (config.google) socialProviders.google = { ...config.google, prompt: 'select_account' };
  if (config.github) socialProviders.github = { ...config.github };

  return {
    appName: 'Impulse',
    baseURL: config.baseURL,
    basePath: '/api/auth',
    secret: config.secret,
    database: pool,
    trustedOrigins: [config.baseURL, ...config.trustedOrigins],
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: config.email.enabled,
      requireEmailVerification: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: { autoSignInAfterVerification: true },
    socialProviders,
    account: { accountLinking: { enabled: true, trustedProviders: ['google', 'github'] } },
    // Desktop sessions last 30 days and renew while the app is used.
    session: { expiresIn: 30 * DAY, updateAge: DAY },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 120,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 5 },
      },
    },
    // The client IP for rate limits. Only a single-address X-Forwarded-For is
    // trusted (Better Auth's rule): behind Cloud Run a client that adds its own
    // X-Forwarded-For gets a multi-address header, which lands in one shared
    // bucket instead of a fresh limit per invented address. X-Real-IP is not
    // read: nothing in front of the server sets it, so a client could.
    advanced: { ipAddress: { ipAddressHeaders: ['x-forwarded-for'] } },
    databaseHooks: {
      user: {
        create: {
          // Owners listed in ADMIN_EMAILS become admins, but only with a verified address.
          before: async (user) => (user.emailVerified && isAdminEmail(user.email) ? { data: { ...user, role: 'admin' } } : undefined),
          // Google and GitHub addresses arrive verified: credits start now.
          after: async (user) => { if (user.emailVerified) background(onVerified(user.id)); },
        },
        update: {
          after: async (user) => {
            if (!user.emailVerified) return;
            if (isAdminEmail(user.email) && user.role !== 'admin') {
              await pool.query(`update "user" set role = 'admin' where id = $1`, [user.id]);
            }
            background(onVerified(user.id));
          },
        },
      },
    },
    plugins: [
      bearer(),
      admin({ defaultRole: 'user', adminRoles: ['admin'] }),
      emailOTP({
        overrideDefaultEmailVerification: true,
        sendVerificationOnSignUp: true,
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        storeOTP: 'hashed',
        // Dev-only: the Test button relies on a known code. Off in production.
        ...(config.testLogin ? { generateOTP: () => '234567' } : {}),
        // Not awaited: the response time must not reveal whether the address exists.
        sendVerificationOTP: async ({ email, otp, type }) => {
          background(sendCode({ email, otp, type }));
        },
      }),
    ],
  };
}

export const createAuth = (deps) => betterAuth(authOptions(deps));
