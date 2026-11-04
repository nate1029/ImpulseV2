import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, validateSettings } from '../src/settings.js';

describe('settings', () => {
  test('plans carry a refill period: hours, or empty for a calendar month', () => {
    const plans = structuredClone(DEFAULTS.plans);
    plans.free.periodHours = 10;
    plans.pro.periodHours = null;
    delete plans.max.periodHours;
    const ok = validateSettings({ plans });
    assert.equal(ok.ok, true);
    assert.equal(ok.value.plans.free.periodHours, 10);
    assert.equal(ok.value.plans.pro.periodHours, null);
    assert.equal(ok.value.plans.max.periodHours, null);
  });

  test('a refill period must be a whole number of hours up to a month', () => {
    for (const bad of [0, 0.5, 721, '5']) {
      const plans = structuredClone(DEFAULTS.plans);
      plans.free.periodHours = bad;
      const res = validateSettings({ plans });
      assert.equal(res.ok, false, `periodHours ${JSON.stringify(bad)} should be refused`);
      assert.match(res.error, /refill period/);
    }
  });

  test('the defaults give the Free plan a small allowance every five hours and the paid plans a month', () => {
    assert.deepEqual([DEFAULTS.plans.free.monthlyCredits, DEFAULTS.plans.free.periodHours], [25, 5]);
    assert.equal(DEFAULTS.plans.pro.periodHours, null);
    assert.equal(DEFAULTS.signupBonusCredits, 200);
  });
});
