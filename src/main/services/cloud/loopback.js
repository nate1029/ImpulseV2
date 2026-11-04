/**
 * Browser sign-in for the desktop app (RFC 8252 loopback + PKCE): listen on a
 * random 127.0.0.1 port, let the browser sign in on Impulse Cloud, and receive
 * a one-time code at /callback that only this app's verifier can redeem.
 * @module main/services/cloud/loopback
 */

const http = require('http');
const crypto = require('crypto');

const b64url = (buf) => buf.toString('base64url');

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  return { verifier, challenge, state };
}

/**
 * Start listening. `code` resolves with { code, finish } once the browser comes
 * back; call finish(url) to send the browser to a result page.
 * @param {{ state: string, timeoutMs?: number }} opts
 * @returns {Promise<{ port: number, code: Promise<{ code: string, finish: (url: string) => void }>, close: () => void, cancel: () => void }>}
 */
function listenForCode({ state, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolveListening, rejectListening) => {
    let settle;
    let fail;
    const code = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
    code.catch(() => {});
    let timer = null;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const got = url.searchParams.get('code') || '';
      // A request without our state isn't from this sign-in: ignore it.
      if (url.searchParams.get('state') !== state || !/^[A-Za-z0-9_-]{43}$/.test(got)) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('This sign-in link does not belong to the Impulse window that is waiting.');
        return;
      }
      clearTimeout(timer);
      settle({
        code: got,
        finish: (target) => {
          res.writeHead(302, { location: target, 'cache-control': 'no-store' });
          // Close only once the redirect has gone out.
          res.end(() => close());
        },
      });
    });

    /** Stop listening; `force` also drops open connections (cancel, timeout). */
    function close(force = false) {
      clearTimeout(timer);
      server.close();
      if (force) server.closeAllConnections?.();
    }

    server.on('error', (error) => {
      fail(error);
      rejectListening(error);
    });
    server.listen(0, '127.0.0.1', () => {
      timer = setTimeout(() => {
        fail(Object.assign(new Error('The sign-in took too long. Try again.'), { code: 'timeout' }));
        close(true);
      }, timeoutMs);
      resolveListening({
        port: server.address().port,
        code,
        // After a code arrived this only stops listening; before, it cancels.
        close: () => {
          fail(Object.assign(new Error('Sign-in cancelled.'), { code: 'cancelled' }));
          close(false);
        },
        cancel: () => {
          fail(Object.assign(new Error('Sign-in cancelled.'), { code: 'cancelled' }));
          close(true);
        },
      });
    });
  });
}

module.exports = { pkcePair, listenForCode };
