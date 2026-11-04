import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { validateFix } from '../src/learning.js';

const FIX = {
  hash: '9f2b7c1d3e4a5b60', signature: "compile:CODE_ERROR:<file>:<line>: error: 'ledcSetup' was not declared in this scope", kind: 'compile', failureCode: 'CODE_ERROR',
  board: 'esp32:esp32:esp32doit-devkit-v1', core: 'esp32:esp32', coreVersion: '3.3.12', libraries: ['WiFi'],
  errorExcerpt: "<file>:6:3: error: 'ledcSetup' was not declared in this scope",
  diff: '@@ -6 +6 @@\n-  ledcSetup(0, 5000, 8);\n-  ledcAttachPin(2, 0);\n+  ledcAttach(2, 5000, 8);', fixedBy: 'agent', model: 'claude-sonnet-5-5',
};

describe('learning from fixes', () => {
  let t;
  let a;
  let b;
  let owner;
  before(async () => {
    t = await setup();
    a = await t.signUp('learner-a@impulse.test');
    b = await t.signUp('learner-b@impulse.test');
    owner = await t.signUp('owner@impulse.test');
  });
  after(async () => { await t.close(); });

  test('validation bounds every field', () => {
    assert.equal(validateFix(null).error, 'Send a fix record.');
    assert.match(validateFix({ ...FIX, hash: 'nope' }).error, /signature and its hash/);
    assert.match(validateFix({ ...FIX, kind: 'link' }).error, /compile or upload/);
    assert.match(validateFix({ ...FIX, diff: 'x'.repeat(7000) }).error, /too long/);
    assert.match(validateFix({ ...FIX, diff: '' }).error, /compile fix needs a diff/);
    assert.equal(validateFix({ ...FIX, kind: 'upload', diff: '' }).error, undefined);
    const ok = validateFix({ ...FIX, fixedBy: 'robot', libraries: ['a', 1, 'b'] });
    assert.equal(ok.value.fixedBy, 'unknown');
    assert.deepEqual(ok.value.libraries, ['a', 'b']);
  });

  test('a signed-in user shares a fix; it is stored with the app version', async () => {
    const res = await t.json('/v1/learn/fixes', FIX, { headers: { ...t.bearer(a.token), 'x-impulse-client': 'Impulse IDE/2.0.0-beta.2' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.stored, true);
    const { rows } = await t.pool.query('select * from fix_record where id = $1', [body.id]);
    assert.equal(rows[0].signature_hash, FIX.hash);
    assert.equal(rows[0].app_version, 'Impulse IDE/2.0.0-beta.2');
    assert.deepEqual(rows[0].libraries, ['WiFi']);
  });

  test('anonymous and invalid records are refused', async () => {
    assert.equal((await t.json('/v1/learn/fixes', FIX)).status, 401);
    const bad = await t.json('/v1/learn/fixes', { ...FIX, errorExcerpt: '' }, { headers: t.bearer(a.token) });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'invalid_fix');
  });

  test('known fixes come back with counts, the same board first', async () => {
    await t.json('/v1/learn/fixes', { ...FIX, board: 'esp32:esp32:esp32', diff: FIX.diff.replace('5000', '4000') }, { headers: t.bearer(b.token) });
    const res = await t.request(`/v1/learn/fixes?hash=${FIX.hash}&board=esp32:esp32:esp32`, { headers: t.bearer(b.token) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.fixes, 2);
    assert.equal(body.users, 2);
    assert.equal(body.known.length, 2);
    assert.equal(body.known[0].board, 'esp32:esp32:esp32');
    assert.match(body.known[0].diff, /4000/);
    const none = await (await t.request('/v1/learn/fixes?hash=0000000000000000', { headers: t.bearer(a.token) })).json();
    assert.deepEqual(none, { hash: '0000000000000000', fixes: 0, users: 0, known: [] });
  });

  test('the manifest lists the most common errors with their latest fix', async () => {
    const res = await t.request('/v1/knowledge/manifest', { headers: t.bearer(a.token) });
    assert.equal(res.status, 200);
    const m = await res.json();
    assert.equal(m.version, 1);
    assert.equal(m.signatures[0].hash, FIX.hash);
    assert.equal(m.signatures[0].fixes, 2);
    assert.equal(m.signatures[0].users, 2);
    assert.equal(m.signatures[0].byAgent, 2);
    assert.match(m.signatures[0].diff, /ledcAttach/);
  });

  test('the admin sees what people struggle with', async () => {
    const res = await t.request('/admin/api/learning?days=30', { headers: t.bearer(owner.token) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.signatures[0].hash, FIX.hash);
    assert.equal(body.total, 2);
    assert.equal((await t.request('/admin/api/learning', { headers: t.bearer(a.token) })).status, 403);
  });

  test('turning learning off stops intake without failing the app', async () => {
    await t.pool.query(`insert into app_setting (key, value) values ('learningEnabled', 'false') on conflict (key) do update set value = 'false'`);
    t.settings.invalidate();
    const res = await t.json('/v1/learn/fixes', FIX, { headers: t.bearer(a.token) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, stored: false, reason: 'learning_off' });
    await t.pool.query(`delete from app_setting where key = 'learningEnabled'`);
    t.settings.invalidate();
  });

  test('a user cannot flood the store', async () => {
    const c = await t.signUp('learner-c@impulse.test');
    for (let i = 0; i < 60; i++) {
      const r = await t.json('/v1/learn/fixes', { ...FIX, hash: `a${String(i).padStart(15, '0')}` }, { headers: t.bearer(c.token) });
      assert.equal(r.status, 200);
    }
    const over = await t.json('/v1/learn/fixes', FIX, { headers: t.bearer(c.token) });
    assert.equal(over.status, 429);
  });
});
