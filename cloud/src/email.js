// One-time codes by email. SMTP (e.g. Gmail) is tried first because mail sent
// through the provider's own authenticated servers lands in the inbox without
// a domain of our own; then Brevo, then Resend. Without any of them (local
// development) the code is printed to the server log instead.
// nodemailer is imported lazily (only when an SMTP send actually happens), so
// the module loads fine where SMTP isn't used.

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

// "Impulse <no-reply@x.com>" or "no-reply@x.com" into { name, email }.
function parseFrom(from) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from || '');
  return m ? { name: m[1] || 'Impulse', email: m[2].trim() } : { name: 'Impulse', email: String(from || '').trim() };
}

// Which sender a config uses, in precedence order. Pure, so it is easy to test.
export function pickProvider(config) {
  if (config.smtpUrl || (config.gmailUser && config.gmailPass)) return 'smtp';
  if (config.brevoKey) return 'brevo';
  if (config.resendKey) return 'resend';
  return 'log';
}

/**
 * @param {{ smtpUrl?: string, gmailUser?: string, gmailPass?: string, resendKey?: string, brevoKey?: string, from: string }} config
 * @param {(msg: string) => void} [log]
 */
export function createMailer(config, log = console.log) {
  let transport = null; // built once, on first SMTP send
  const smtp = async () => {
    if (transport) return transport;
    const { default: nodemailer } = await import('nodemailer');
    transport = config.smtpUrl
      ? nodemailer.createTransport(config.smtpUrl)
      : nodemailer.createTransport({ service: 'gmail', auth: { user: config.gmailUser, pass: config.gmailPass } });
    return transport;
  };

  return async function sendCode({ email, otp, type }) {
    const message = codeEmail(type, otp);
    const provider = pickProvider(config);
    // SMTP (Gmail etc.) first: authenticated sender, best deliverability.
    if (provider === 'smtp') {
      const t = await smtp();
      await t.sendMail({ from: config.from, to: email, subject: message.subject, text: message.text, html: message.html });
      return;
    }
    if (provider === 'brevo') {
      const sender = parseFrom(config.from);
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': config.brevoKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender, to: [{ email }], subject: message.subject, textContent: message.text, htmlContent: message.html }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Brevo refused the email (${res.status}): ${detail.slice(0, 200)}`);
      }
      return;
    }
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
