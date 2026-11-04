/**
 * Impulse account IPC: sign-in and sign-out, account status, credits, usage,
 * plans and upgrade requests. The session token never leaves the main process.
 * @module main/ipc/cloudHandlers
 */

const { z } = require('zod');
const { withDebugLog } = require('../utils/logger');

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(1).max(128);
const otp = z.string().trim().regex(/^\d{6}$/);

const inputs = {
  signIn: z.object({ email, password }),
  signUp: z.object({ name: z.string().trim().min(1).max(80), email, password: z.string().min(8).max(128) }),
  verify: z.object({ email, otp }),
  emailOnly: z.object({ email }),
  reset: z.object({ email, otp, password: z.string().min(8).max(128) }),
  provider: z.object({ provider: z.enum(['google', 'github']) }),
  upgrade: z.object({ plan: z.enum(['pro', 'max']), note: z.string().max(500).optional().nullable() }),
  days: z.object({ days: z.number().int().min(1).max(90).optional().default(30) }),
};

const invalid = (parsed) => ({ ok: false, error: parsed.error.issues[0]?.message || 'Check what you entered.' });

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ cloudAccount: import('../services/cloud/account').CloudAccount, mainWindow: import('electron').BrowserWindow | null, app: import('electron').App, shell: import('electron').Shell }} ctx
 */
function register(ipcMain, ctx) {
  const account = ctx.cloudAccount;
  // Each channel is registered with a literal name (the IPC contract test reads them).
  const handle = (channel, schema, fn) => withDebugLog(channel, async (event, payload) => {
    if (!schema) return fn();
    const parsed = schema.safeParse(payload ?? {});
    if (!parsed.success) return invalid(parsed);
    return fn(parsed.data);
  });

  // Status pushes: credits after every AI reply, sign-in finishing in the browser.
  account.on('change', (status) => {
    const win = ctx.mainWindow;
    if (win && !win.isDestroyed()) win.webContents.send('cloud:status', status);
  });

  ipcMain.handle('cloud:status', handle('cloud:status', null, async () => {
    await account.config().catch(() => null);
    return account.status();
  }));
  ipcMain.handle('cloud:refresh', handle('cloud:refresh', null, () => account.refresh()));
  ipcMain.handle('cloud:sign-in-email', handle('cloud:sign-in-email', inputs.signIn, ({ email: e, password: p }) => account.signInEmail(e, p)));
  ipcMain.handle('cloud:sign-up-email', handle('cloud:sign-up-email', inputs.signUp, ({ name, email: e, password: p }) => account.signUpEmail(name, e, p)));
  ipcMain.handle('cloud:verify-email', handle('cloud:verify-email', inputs.verify, ({ email: e, otp: code }) => account.verifyEmail(e, code)));
  ipcMain.handle('cloud:resend-code', handle('cloud:resend-code', inputs.emailOnly, ({ email: e }) => account.resendCode(e)));
  ipcMain.handle('cloud:request-password-reset', handle('cloud:request-password-reset', inputs.emailOnly, ({ email: e }) => account.requestPasswordReset(e)));
  ipcMain.handle('cloud:reset-password', handle('cloud:reset-password', inputs.reset, ({ email: e, otp: code, password: p }) => account.resetPassword(e, code, p)));
  ipcMain.handle('cloud:sign-in-provider', handle('cloud:sign-in-provider', inputs.provider, async ({ provider }) => {
    const result = await account.signInWithProvider(provider);
    // Back from the browser: bring Impulse to the front.
    if (result.ok) {
      const win = ctx.mainWindow;
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
      if (process.platform === 'darwin') ctx.app.focus({ steal: true });
    }
    return result;
  }));
  ipcMain.handle('cloud:cancel-sign-in', handle('cloud:cancel-sign-in', null, () => {
    account.cancelSignIn();
    return { ok: true };
  }));
  ipcMain.handle('cloud:sign-out', handle('cloud:sign-out', null, () => account.signOut()));
  ipcMain.handle('cloud:usage', handle('cloud:usage', inputs.days, ({ days }) => account.usage(days)));
  ipcMain.handle('cloud:plans', handle('cloud:plans', null, () => account.plans()));
  ipcMain.handle('cloud:models', handle('cloud:models', null, () => account.models()));
  ipcMain.handle('cloud:request-upgrade', handle('cloud:request-upgrade', inputs.upgrade, ({ plan, note }) => account.requestUpgrade(plan, note)));
  ipcMain.handle('cloud:open-admin', handle('cloud:open-admin', null, async () => {
    const url = account.status().adminURL;
    if (!url) return { ok: false, error: 'Impulse Cloud isn\'t set up in this build.' };
    await ctx.shell.openExternal(url);
    return { ok: true };
  }));
}

module.exports = { register };
