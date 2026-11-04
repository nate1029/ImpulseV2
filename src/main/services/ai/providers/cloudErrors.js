/**
 * What the person reads when Impulse Cloud answers with an error. The gateway
 * speaks each vendor's error shape; both lanes' providers put the HTTP status
 * and the server's message on `error.cause`, and this turns them into one
 * sentence with a code the UI acts on (sign in again, out of credits…).
 * @module main/services/ai/providers/cloudErrors
 */

/**
 * @param {Error & { cause?: { status?: number, offline?: boolean, error?: object } }} error
 * @returns {Error & { code?: string }}
 */
function friendlyCloudError(error) {
  const cause = error?.cause;
  const status = cause?.status;
  const serverMessage = cause?.error?.error?.message;
  const make = (message, code) => Object.assign(new Error(message), { code });
  if (cause?.offline) return make("Can't reach Impulse. Check your internet connection.", 'offline');
  if (status === 401) return make('Your Impulse session ended. Sign in again to keep building.', 'signed_out');
  if (status === 402) return make(serverMessage || "You're out of credits. Upgrade for more, or wait for your monthly refill.", 'insufficient_credits');
  if (status === 403) return make(serverMessage || "Your account can't use this right now.", 'forbidden');
  if (status === 413) return make(serverMessage || 'This conversation is too long. Start a new chat.', 'too_long');
  if (status === 429) return make(serverMessage || 'Too many requests at once. Wait a moment and try again.', 'rate_limited');
  if (status === 503 || status === 529) return make(serverMessage || 'Impulse AI is busy right now. Try again soon.', 'unavailable');
  if (status) return make(serverMessage || error.message, 'server');
  return error;
}

module.exports = { friendlyCloudError };
