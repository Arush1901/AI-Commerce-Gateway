'use strict';

const { validateUserPolicy, validateMerchantPolicy } = require('../src/services/policyService');

// ─── assert harness ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(desc, condition, detail = '') {
  if (condition) { console.log(`   ${desc}`); passed++; }
  else { console.error(`   ${desc}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ─── shared fixtures ──────────────────────────────────────────────────────────
const cart = {
  items: [
    { category: 'headset',  price: 6000 },
    { category: 'keyboard', price: 3500 },
    { category: 'mouse',    price: 2000 },
  ],
  total: 11500,
};

const offer = {
  action:      'substitute',
  replacement: { id: 'kb-lite', name: 'Keyboard Lite', category: 'keyboard', tier: 'lite', price: 1999, stock: 200 },
  saving:      1501,      // original was ₹3500, replacement ₹1999 → discount ≈ 42.9%
  reason:      'Keyboard office → lite',
};

// ═══════════════════════════════════════════════════════════════════════════════
// validateUserPolicy
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nvalidateUserPolicy — tests\n');

// ── Case 1: within limits → approved ─────────────────────────────────────────
console.log('Case 1: cart within user limits → approved\n');

const lenientPolicy = { max_spending: 15000, allowed_categories: ['headset', 'keyboard', 'mouse'] };
const r1 = validateUserPolicy(cart, lenientPolicy);

assert('[C1] status = approved',       r1.status === 'approved',  r1.status);
assert('[C1] reason is a string',      typeof r1.reason === 'string');
assert('[C1] returns object with status + reason',
  'status' in r1 && 'reason' in r1);

// ── Case 2: exceeds max_spending → rejected ───────────────────────────────────
console.log('\nCase 2: cart total exceeds user spending limit → rejected\n');

const tightPolicy = { max_spending: 10000, allowed_categories: ['headset', 'keyboard', 'mouse'] };
const r2 = validateUserPolicy(cart, tightPolicy);

assert('[C2] status = rejected',       r2.status === 'rejected',  r2.status);
assert('[C2] reason mentions limit',   r2.reason.includes('10000'));
assert('[C2] reason mentions actual total', r2.reason.includes('11500'));
// Distinguishable: user rejection must NOT contain "merchant" or "discount"
assert('[C2] reason is user-policy specific',
  !r2.reason.toLowerCase().includes('merchant') &&
  !r2.reason.toLowerCase().includes('discount'));

// ── Case 3 (user): disallowed category → rejected ────────────────────────────
console.log('\nCase 3a: disallowed category → rejected\n');

const restrictedPolicy = { max_spending: 15000, allowed_categories: ['keyboard', 'mouse'] };
const r3a = validateUserPolicy(cart, restrictedPolicy);

assert('[C3a] status = rejected',      r3a.status === 'rejected', r3a.status);
assert('[C3a] reason names blocked category', r3a.reason.includes('headset'));
assert('[C3a] user-policy specific',
  !r3a.reason.toLowerCase().includes('merchant'));

// ── Edge: no allowed_categories → skip category check ────────────────────────
console.log('\nEdge: no allowed_categories field\n');

const noCatPolicy = { max_spending: 15000 };
const rEdge = validateUserPolicy(cart, noCatPolicy);
assert('no allowed_categories → approved', rEdge.status === 'approved');

// ═══════════════════════════════════════════════════════════════════════════════
// validateMerchantPolicy
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nvalidateMerchantPolicy — tests\n');

// ── Case 1: discount within limit → approved ──────────────────────────────────
console.log('Case 1: discount within merchant limit → approved\n');

// offer: saving=1501, original=3500 → discount ≈ 42.9%
const lenientMerchant = { max_discount: 50, min_margin: 1000 };
const m1 = validateMerchantPolicy(offer, lenientMerchant);

assert('[M1] status = approved',       m1.status === 'approved',  m1.status);
assert('[M1] reason is a string',      typeof m1.reason === 'string');

// ── Case 2: discount over limit → rejected ────────────────────────────────────
console.log('\nCase 2: merchant discount exceeds allowed maximum → rejected\n');

const strictMerchant = { max_discount: 30, min_margin: 500 };
const m2 = validateMerchantPolicy(offer, strictMerchant);

assert('[M2] status = rejected',       m2.status === 'rejected',  m2.status);
assert('[M2] reason mentions discount', m2.reason.toLowerCase().includes('discount'));
assert('[M2] reason mentions limit',   m2.reason.includes('30'));
// Distinguishable: must NOT reference user spending
assert('[M2] merchant-policy specific',
  !m2.reason.toLowerCase().includes('user') &&
  !m2.reason.toLowerCase().includes('spending'));

// ── Case 3: below min_margin → escalated ─────────────────────────────────────
console.log('\nCase 3: replacement below min margin → escalated\n');

const highMarginPolicy = { max_discount: 60, min_margin: 2500 }; // kb-lite ₹1999 < ₹2500
const m3 = validateMerchantPolicy(offer, highMarginPolicy);

assert('[M3] status = escalated',      m3.status === 'escalated', m3.status);
assert('[M3] reason mentions margin',  m3.reason.toLowerCase().includes('margin'));
assert('[M3] escalated ≠ rejected',    m3.status !== 'rejected');
assert('[M3] merchant-policy specific',
  !m3.reason.toLowerCase().includes('user'));

// ── Edge: no_offer → approved passthrough ────────────────────────────────────
console.log('\nEdge: no_offer passthrough\n');

const noOffer = { action: 'no_offer', replacement: null, saving: 0, reason: 'none' };
const mEdge   = validateMerchantPolicy(noOffer, strictMerchant);
assert('no_offer → approved (nothing to validate)', mEdge.status === 'approved');

// ── Distinguishability between user and merchant rejections ───────────────────
console.log('\nDistinguishability — user vs merchant rejection\n');

const userRejected     = validateUserPolicy(cart, tightPolicy);
const merchantRejected = validateMerchantPolicy(offer, strictMerchant);

assert('user rejection status = rejected',     userRejected.status     === 'rejected');
assert('merchant rejection status = rejected', merchantRejected.status === 'rejected');
assert('reasons are different strings',        userRejected.reason     !== merchantRejected.reason);
assert('user reason has no discount info',
  !userRejected.reason.toLowerCase().includes('discount'));
assert('merchant reason has no spending info',
  !merchantRejected.reason.toLowerCase().includes('spending'));

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed > 0) { console.error('\nSome tests failed.'); process.exit(1); }
else { console.log('\nAll tests passed '); }
