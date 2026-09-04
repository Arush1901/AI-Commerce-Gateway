'use strict';

/**
 * Stage 10 — paymentService.js unit tests.
 * All Razorpay API calls are mocked. No real network requests.
 */

const { createPaymentOrder, _setClient, _resetClient } = require('../src/services/paymentService');
const { orchestrate }                                   = require('../src/core/orchestrator');

// ─── assert harness ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(desc, condition, detail = '') {
  if (condition) { console.log(`   ${desc}`); passed++; }
  else { console.error(`   ${desc}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ─── catalog fixture ──────────────────────────────────────────────────────────
const catalog = [
  { id: 'hs-office', name: 'Headset Office',  category: 'headset',  tier: 'office', price: 6000, features: [], stock: 44 },
  { id: 'hs-lite',   name: 'Headset Lite',    category: 'headset',  tier: 'lite',   price: 2999, features: [], stock: 20 },
  { id: 'kb-office', name: 'Keyboard Office', category: 'keyboard', tier: 'office', price: 3500, features: [], stock: 85 },
  { id: 'kb-lite',   name: 'Keyboard Lite',   category: 'keyboard', tier: 'lite',   price: 1999, features: [], stock: 200 },
  { id: 'ms-office', name: 'Mouse Office',    category: 'mouse',    tier: 'office', price: 2000, features: [], stock: 90 },
  { id: 'ms-lite',   name: 'Mouse Lite',      category: 'mouse',    tier: 'lite',   price:  799, features: [], stock: 300 },
];

// ─── Mock factory ─────────────────────────────────────────────────────────────
function mockOk(orderId = 'order_TEST001') {
  return {
    orders: {
      create: async ({ amount, currency }) => ({ id: orderId, amount, currency }),
    },
  };
}
function mockFail(message = 'Network error') {
  return { orders: { create: async () => { throw new Error(message); } } };
}

(async () => {

// ═══════════════════════════════════════════════════════════════════════════════
// Case 1 — createPaymentOrder succeeds → correct shape + paise conversion
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nCase 1: createPaymentOrder — successful order\n');

_setClient(mockOk('order_UNIT001'));
const p1 = await createPaymentOrder({ total: 9999, currency: 'INR' });

assert('[C1] orderId returned',               typeof p1.orderId === 'string');
assert('[C1] orderId = order_UNIT001',        p1.orderId === 'order_UNIT001');
assert('[C1] amount = total × 100 (paise)',   p1.amount === 9999 * 100, `got ${p1.amount}`);
assert('[C1] currency = INR',                 p1.currency === 'INR');
assert('[C1] no secret in return value',      !('keySecret' in p1) && !('key_secret' in p1));

_resetClient();

// ═══════════════════════════════════════════════════════════════════════════════
// Case 2 — Approved orchestrate() → payment object in response
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nCase 2: approved purchase → payment attached\n');

_setClient(mockOk('order_APPROVED_001'));

const r2 = await orchestrate(
  { goal: 'gaming', budget: 12000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } },
  catalog,
  { max_spending: 15000, allowed_categories: ['headset', 'keyboard', 'mouse'] },
  { max_discount: 60, min_margin: 500 }
);

assert('[C2] decision = approved',            r2.decision === 'approved');
assert('[C2] payment is object',              r2.payment !== null && typeof r2.payment === 'object');
assert('[C2] payment.orderId = mocked id',   r2.payment.orderId === 'order_APPROVED_001');
assert('[C2] payment.amount is number',       typeof r2.payment.amount === 'number');
assert('[C2] payment.currency = INR',         r2.payment.currency === 'INR');
assert('[C2] payment.keyId is string',        typeof r2.payment.keyId === 'string');
assert('[C2] secret NOT in payment',          !('keySecret' in r2.payment));

_resetClient();

// ═══════════════════════════════════════════════════════════════════════════════
// Case 3 — Rejected purchase → payment: null (no Razorpay call)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nCase 3: rejected purchase → payment: null\n');

const r3 = await orchestrate(
  { goal: 'gaming', budget: 12000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } },
  catalog,
  { max_spending: 5000, allowed_categories: ['headset', 'keyboard', 'mouse'] },
  { max_discount: 60, min_margin: 500 }
);

assert('[C3-rejected] decision = rejected',   r3.decision === 'rejected');
assert('[C3-rejected] payment = null',        r3.payment === null);

// ─── Escalated subcase ────────────────────────────────────────────────────────
const r3b = await orchestrate(
  { goal: 'gaming', budget: 1000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } },
  catalog,
  { max_spending: 15000, allowed_categories: ['headset', 'keyboard', 'mouse'] },
  { max_discount: 65, min_margin: 200 }   // 65% allows mouse ₹2000→₹799 (60.05%); 200 < ₹799
);

assert('[C3-escalated] decision = escalated', r3b.decision === 'escalated');
assert('[C3-escalated] payment = null',       r3b.payment === null);

// ═══════════════════════════════════════════════════════════════════════════════
// Case 4 — Payment creation failure → clear error thrown
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nCase 4: payment creation failure → throws clear error\n');

_setClient(mockFail('Simulated network timeout'));

let caught = null;
try {
  await createPaymentOrder({ total: 5000, currency: 'INR' });
} catch (err) {
  caught = err;
}

assert('[C4] error is thrown',                caught !== null);
assert('[C4] message mentions Razorpay or order creation',
  caught?.message?.toLowerCase().includes('razorpay') ||
  caught?.message?.toLowerCase().includes('order creation'));
assert('[C4] message includes original error', caught?.message?.includes('Simulated network timeout'));

_resetClient();

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed > 0) { console.error('\nSome tests failed.'); process.exit(1); }
else { console.log('\nAll tests passed '); }

})().catch(err => { console.error(err); process.exit(1); });
