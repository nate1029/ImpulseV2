// What the browser shows after handing a sign-in to the desktop app.
const COPY = {
  ok: ['green', 'Connected', 'You\'re signed in', 'Go back to Impulse. You can close this tab.'],
  error: ['red', 'Not connected', 'That didn\'t finish', 'Impulse couldn\'t complete the sign-in. Close this tab and choose Sign in again in Impulse.'],
  invalid: ['red', 'Not connected', 'This sign-in link expired', 'Close this tab and choose Sign in again in Impulse.'],
  suspended: ['red', 'Suspended', 'This account is suspended', 'Contact Impulse support if you think this is a mistake.'],
};

const status = new URLSearchParams(location.search).get('status') || 'ok';
const [led, state, title, text] = COPY[status] || COPY.error;
document.getElementById('led').className = `led ${led}`;
document.getElementById('state').textContent = state;
document.getElementById('title').textContent = title;
document.getElementById('text').textContent = text;
