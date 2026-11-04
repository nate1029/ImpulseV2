// One-time codes by email, through Resend's HTTP API. Without an API key
// (local development) the code is printed to the server log instead.

const SUBJECTS = {
  'email-verification': 'Your Impulse verification code',
  'sign-in': 'Your Impulse sign-in code',
  'forget-password': 'Reset your Impulse password',
  'change-email': 'Confirm your new email for Impulse',
};

const LINES = {
  'email-verification': 'Enter this code in Impulse to finish creating your account.',
  'sign-in': 'Enter this code in Impulse to sign in.',
  'forget-password': 'Enter this code in Impulse to choose a new password.',
  'change-email': 'Enter this code in Impulse to confirm this address.',
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function codeEmail(type, otp) {
  const line = LINES[type] || LINES['sign-in'];
  const text = `${line}\n\n${otp}\n\nThe code expires in 10 minutes. If you didn't ask for it, you can ignore this email.`;
  const html = `<!doctype html><html><body style="margin:0;background:#0c0c0d;padding:40px 16px;font-family:-apple-system,Segoe UI,Inter,Arial,sans-serif;color:#eeeef2">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="440" cellspacing="0" cellpadding="0" style="max-width:440px;background:#18181a;border:1px solid #26262a;border-radius:8px">
<tr><td style="padding:28px 28px 8px;font:500 11px/1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.08em;color:#8a8a90">IMPULSE</td></tr>
<tr><td style="padding:8px 28px 0;font-size:15px;line-height:1.5;color:#b4b4b8">${escapeHtml(line)}</td></tr>
<tr><td style="padding:20px 28px;font:500 32px/1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.24em;color:#ffffff">${escapeHtml(otp)}</td></tr>
<tr><td style="padding:0 28px 28px;font-size:13px;line-height:1.5;color:#8a8a90">The code expires in 10 minutes. If you didn't ask for it, you can ignore this email.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject: SUBJECTS[type] || SUBJECTS['sign-in'], text, html };
}

/**
 * @param {{ resendKey: string, from: string }} config
 * @param {(msg: string) => void} [log]
 */
export function createMailer(config, log = console.log) {
  return async function sendCode({ email, otp, type }) {
    const message = codeEmail(type, otp);
    if (!config.resendKey) {
      log(`[email] ${type} code for ${email}: ${otp}`);
      return;
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.from, to: [email], subject: message.subject, text: message.text, html: message.html }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend refused the email (${res.status}): ${detail.slice(0, 200)}`);
    }
  };
}
