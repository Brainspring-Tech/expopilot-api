const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeHasActiveAccess,
  findActiveGrant,
  validateGrantInput,
  hasActiveAccess,
  getActiveGrantForOrg,
} = require('../src/services/accessGrants');

const NOW = new Date('2026-07-10T00:00:00Z');
const HOUR = 60 * 60 * 1000;

function grant(overrides = {}) {
  return {
    id: 'grant-1',
    organization_id: 'org-1',
    starts_at: new Date(NOW.getTime() - HOUR).toISOString(),
    expires_at: new Date(NOW.getTime() + 30 * 24 * HOUR).toISOString(), // ~30 days out
    revoked_at: null,
    reason: 'Pilot tester — usability feedback',
    ...overrides,
  };
}

// Minimal stand-in for the supabase-js query builder, just deep enough to
// exercise the .from().select().eq().order() chain that
// getGrantsForOrg/getActiveGrantForOrg/hasActiveAccess actually call.
function fakeClient(rowsByTable) {
  return {
    from(table) {
      let rows = rowsByTable[table] || [];
      const builder = {
        select: () => builder,
        eq: (col, val) => { rows = rows.filter((r) => r[col] === val); return builder; },
        order: () => builder,
        then: (resolve) => resolve({ data: rows, error: null }),
      };
      return builder;
    },
  };
}

describe('findActiveGrant / computeHasActiveAccess (grant window)', () => {
  test('a grant within its starts_at/expires_at window is active', () => {
    const g = grant();
    assert.equal(findActiveGrant([g], NOW), g);
    assert.equal(computeHasActiveAccess({ plan_status: 'trial' }, [g], NOW), true);
  });

  test('a grant is not active before its starts_at', () => {
    const g = grant({ starts_at: new Date(NOW.getTime() + HOUR).toISOString() });
    assert.equal(findActiveGrant([g], NOW), null);
    assert.equal(computeHasActiveAccess({ plan_status: 'trial' }, [g], NOW), false);
  });

  test('an expired grant no longer grants access', () => {
    const g = grant({
      starts_at: new Date(NOW.getTime() - 400 * 24 * HOUR).toISOString(),
      expires_at: new Date(NOW.getTime() - HOUR).toISOString(), // expired an hour ago
    });
    assert.equal(findActiveGrant([g], NOW), null);
    assert.equal(computeHasActiveAccess({ plan_status: 'trial' }, [g], NOW), false);
  });

  test('a revoked grant no longer grants access even if not yet expired', () => {
    const g = grant({ revoked_at: new Date(NOW.getTime() - HOUR).toISOString() });
    assert.equal(findActiveGrant([g], NOW), null);
    assert.equal(computeHasActiveAccess({ plan_status: 'trial' }, [g], NOW), false);
  });

  test('picks the furthest-expiring grant when more than one is active', () => {
    const soon = grant({ id: 'soon', expires_at: new Date(NOW.getTime() + HOUR).toISOString() });
    const later = grant({ id: 'later', expires_at: new Date(NOW.getTime() + 100 * HOUR).toISOString() });
    assert.equal(findActiveGrant([soon, later], NOW).id, 'later');
  });
});

describe('precedence: Stripe subscription vs. manual grant', () => {
  test('an active Stripe subscription grants access with no manual grant at all', () => {
    assert.equal(computeHasActiveAccess({ plan_status: 'active' }, [], NOW), true);
  });

  test('no Stripe subscription and no manual grant means no access', () => {
    assert.equal(computeHasActiveAccess({ plan_status: 'trial' }, [], NOW), false);
    assert.equal(computeHasActiveAccess({ plan_status: 'canceled' }, [], NOW), false);
  });

  test('a manual grant alone (no active Stripe subscription) grants access', () => {
    assert.equal(computeHasActiveAccess({ plan_status: 'canceled' }, [grant()], NOW), true);
  });

  test('Stripe active + an unrelated expired/revoked grant still grants access — no conflict', () => {
    const expired = grant({ expires_at: new Date(NOW.getTime() - HOUR).toISOString() });
    assert.equal(computeHasActiveAccess({ plan_status: 'active' }, [expired], NOW), true);
  });

  test('Stripe active + a real active manual grant does not double-grant or conflict — still just true', () => {
    assert.equal(computeHasActiveAccess({ plan_status: 'active' }, [grant()], NOW), true);
  });
});

describe('validateGrantInput', () => {
  test('accepts a valid grant (default 12 months, non-empty reason)', () => {
    assert.deepEqual(validateGrantInput({ months: 12, reason: 'Pilot tester' }), []);
  });

  test('rejects a missing or blank reason', () => {
    assert.ok(validateGrantInput({ months: 12, reason: '' }).length > 0);
    assert.ok(validateGrantInput({ months: 12, reason: '   ' }).length > 0);
    assert.ok(validateGrantInput({ months: 12, reason: undefined }).length > 0);
  });

  test('rejects non-integer, zero, negative, or absurdly large months', () => {
    assert.ok(validateGrantInput({ months: 0, reason: 'x' }).length > 0);
    assert.ok(validateGrantInput({ months: -3, reason: 'x' }).length > 0);
    assert.ok(validateGrantInput({ months: 6.5, reason: 'x' }).length > 0);
    assert.ok(validateGrantInput({ months: 1000, reason: 'x' }).length > 0);
  });
});

describe('hasActiveAccess / getActiveGrantForOrg (I/O wrapper over a fake client)', () => {
  test('true during the grant window', async () => {
    const client = fakeClient({ manual_access_grants: [grant({ organization_id: 'org-1' })] });
    assert.equal(await hasActiveAccess({ id: 'org-1', plan_status: 'trial' }, client, NOW), true);
  });

  test('false once the grant has expired', async () => {
    const expired = grant({
      organization_id: 'org-1',
      expires_at: new Date(NOW.getTime() - HOUR).toISOString(),
    });
    const client = fakeClient({ manual_access_grants: [expired] });
    assert.equal(await hasActiveAccess({ id: 'org-1', plan_status: 'trial' }, client, NOW), false);
  });

  test('false once the grant is revoked', async () => {
    const revoked = grant({ organization_id: 'org-1', revoked_at: new Date(NOW.getTime() - HOUR).toISOString() });
    const client = fakeClient({ manual_access_grants: [revoked] });
    assert.equal(await hasActiveAccess({ id: 'org-1', plan_status: 'trial' }, client, NOW), false);
  });

  test('getActiveGrantForOrg returns null when no grant is active', async () => {
    const client = fakeClient({ manual_access_grants: [] });
    assert.equal(await getActiveGrantForOrg('org-1', client, NOW), null);
  });
});
