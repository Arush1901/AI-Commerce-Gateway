'use strict';

/**
 * Stage 9 — Audit Trail tests (updated for Stage 10 async orchestrate).
 *
 * Calls orchestrate() with an explicit transactionId so the audit store
 * is populated. No LLM calls; Razorpay mocked for approved cases.
 */

const { orchestrate }                       = require('../src/core/orchestrator');
const { createAudit, getAudit, _reset }     = require('../src/services/auditService');
const { _setClient, _resetClient }          = require('../src/services/paymentService');

// ─── assert harness ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(desc, condition, detail = '') {
  if (condition) { console.log(`   ${desc}`); passed++; }
  else { console.error(`   ${desc}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ─── shared catalog fixture ───────────────────────────────────────────────────
const catalog = [
  { id: 'hs-office', name: 'Headset Office',  category: 'headset',  tier: 'office', price: 6000, features: [], stock: 44 },
  { id: 'hs-lite',   name: 'Headset Lite',    category: 'headset',  tier: 'lite',   price: 2999, features: [], stock: 20 },
  { id: 'kb-office', name: 'Keyboard Office', category: 'keyboard', tier: 'office', price: 3500, features: [], stock: 85 },
  { id: 'kb-lite',   name: 'Keyboard Lite',   category: 'keyboard', tier: 'lite',   price: 1999, features: [], stock: 200 },
  { id: 'ms-office', name: 'Mouse Office',    category: 'mouse',    tier: 'office', price: 2000, features: [], stock: 90 },
  { id: 'ms-lite',   name: 'Mouse Lite',      category: 'mouse',    tier: 'lite',   price:  799, features: [], stock: 300 },
];

// Payment mock (used for approved cases)
const mockRazorpay = { orders: { create: async ({ amount, currency }) => ({ id: 'order_AUDIT_MOCK', amount, currency }) } };

// Steps for approved (9 entries): 7 pipeline steps + mandate gate + payment
const APPROVED_STEPS = [
  'cart_building',
  'mandate_issued',
  'negotiation',
  'revenue_uplift',
  'user_policy_validation',
  'merchant_policy_validation',
  'decision',
  'mandate_payment_gate',
  'payment_order_created',
];

// Steps for rejected/escalated (7 entries — no mandate gate, no payment step)
const NONAPPROVED_STEPS = [
  'cart_building',
  'mandate_issued',
  'negotiation',
  'revenue_uplift',
  'user_policy_validation',
  'merchant_policy_validation',
  'decision',
];

// Helper: run async orchestrate() under an explicit audit context
async function runWithAudit(intent, uPolicy, mPolicy) {
  const txId = 'test-' + Math.random().toString(36).slice(2);
  createAudit(txId);
  const result = await orchestrate(intent, catalog, uPolicy, mPolicy, txId);
  const audit  = getAudit(txId);
  return { result, audit, txId };
}

function setup() { _reset(); }

(async () => {

// ═══════════════════════════════════════════════════════════════════════════════
// Case 1 — Successful (approved) purchase → 9 ordered entries
//           7 pipeline steps + mandate_payment_gate + payment_order_created
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nCase 1: successful purchase — ordered audit entries\n');
setup();
_setClient(mockRazorpay);

const { result: r1, audit: a1 } = await runWithAudit(
  { goal: 'gaming', budget: 12000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } },
  { max_spending: 15000, allowed_categories: ['headset', 'keyboard', 'mouse'] },
  { max_discount: 60, min_margin: 500 }
);

_resetClient();

assert('[C1] decision = approved',                     r1.decision === 'approved');
assert('[C1] audit trail returned',                    a1 !== null);
assert('[C1] transactionId matches',                   a1.transactionId === r1.transactionId);
assert('[C1] entries is array',                        Array.isArray(a1.entries));
assert('[C1] 9 entries recorded (incl. mandate gate + payment)', a1.entries.length === 9, `got ${a1.entries.length}`);

const steps1 = a1.entries.map(e => e.step);
assert('[C1] steps in correct order',
  JSON.stringify(steps1) === JSON.stringify(APPROVED_STEPS),
  `got ${JSON.stringify(steps1)}`);

// Check each entry has the right shape
for (const entry of a1.entries) {
  assert(`[C1] ${entry.step}: has input`,              'input'  in entry);
  assert(`[C1] ${entry.step}: has output`,             'output' in entry);
  assert(`[C1] ${entry.step}: timestamp is ISO string`,
    typeof entry.timestamp === 'string' && entry.timestamp.includes('T'));
}

// Content spot-checks
const decisionEntry1 = a1.entries.find(e => e.step === 'decision');
assert('[C1] decision output = approved',              decisionEntry1.output.decision === 'approved');

const cartEntry1 = a1.entries.find(e => e.step === 'cart_building');
assert('[C1] cart_building output has items',          Array.isArray(cartEntry1.output.items));
assert('[C1] cart_building output has total',          typeof cartEntry1.output.total === 'number');

const pmtEntry1 = a1.entries.find(e => e.step === 'payment_order_created');
assert('[C1] payment_order_created entry exists',      pmtEntry1 !== undefined);
assert('[C1] payment entry has orderId in output',     typeof pmtEntry1?.output?.orderId === 'string');
assert('[C1] payment entry stores total in input',     typeof pmtEntry1?.input?.total === 'number');
assert('[C1] payment entry does NOT store secret',
  !('keySecret' in (pmtEntry1?.output ?? {})) && !('key_secret' in (pmtEntry1?.output ?? {})));

// ═══════════════════════════════════════════════════════════════════════════════
// Case 2 — Rejected purchase → 7 entries, decision = rejected
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nCase 2: rejected purchase — decision entry records rejected\n');
setup();

const { result: r2, audit: a2 } = await runWithAudit(
  { goal: 'gaming', budget: 12000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } },
  { max_spending: 5000, allowed_categories: ['headset', 'keyboard', 'mouse'] },
  { max_discount: 60, min_margin: 500 }
);

assert('[C2] decision = rejected',                     r2.decision === 'rejected');
assert('[C2] audit trail returned',                    a2 !== null);
assert('[C2] 7 entries (no mandate gate, no payment)', a2.entries.length === 7, `got ${a2.entries.length}`);
assert('[C2] steps in correct order',
  JSON.stringify(a2.entries.map(e => e.step)) === JSON.stringify(NONAPPROVED_STEPS));

const decisionEntry2 = a2.entries.find(e => e.step === 'decision');
assert('[C2] decision entry output.decision = rejected', decisionEntry2.output.decision === 'rejected');

const uPolicyEntry2 = a2.entries.find(e => e.step === 'user_policy_validation');
assert('[C2] user_policy_validation output.status = rejected', uPolicyEntry2.output.status === 'rejected');

// ═══════════════════════════════════════════════════════════════════════════════
// Case 3 — Escalated purchase → 7 entries, decision = escalated
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nCase 3: escalated purchase — decision entry records escalated\n');
setup();

const { result: r3, audit: a3 } = await runWithAudit(
  { goal: 'gaming', budget: 1000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } },
  { max_spending: 15000, allowed_categories: ['headset', 'keyboard', 'mouse'] },
  { max_discount: 65, min_margin: 200 }   // 65% allows mouse ₹2000→₹799 (60.05%); 200 < ₹799
);

assert('[C3] decision = escalated',                    r3.decision === 'escalated');
assert('[C3] audit trail returned',                    a3 !== null);
assert('[C3] 7 entries (no mandate gate, no payment)', a3.entries.length === 7, `got ${a3.entries.length}`);
assert('[C3] steps in correct order',
  JSON.stringify(a3.entries.map(e => e.step)) === JSON.stringify(NONAPPROVED_STEPS));

const decisionEntry3 = a3.entries.find(e => e.step === 'decision');
assert('[C3] decision entry output.decision = escalated', decisionEntry3.output.decision === 'escalated');

const negEntry3 = a3.entries.find(e => e.step === 'negotiation');
assert('[C3] negotiation output.status = escalation_needed', negEntry3.output.status === 'escalation_needed');
assert('[C3] negotiation output.gap > 0',              negEntry3.output.gap > 0);

// ═══════════════════════════════════════════════════════════════════════════════
// Case 4 — Unknown transactionId → getAudit returns null (→ HTTP 404)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nCase 4: unknown transactionId → getAudit returns null\n');
setup();

const missing = getAudit('does-not-exist-tx-999');
assert('[C4] getAudit returns null for unknown id',    missing === null);

createAudit('known-tx');
const stillMissing = getAudit('unknown-tx');
assert('[C4] null when other txIds exist',             stillMissing === null);

const known = getAudit('known-tx');
assert('[C4] known id returns trail object',           known !== null && known.transactionId === 'known-tx');
assert('[C4] known id entries start empty',            known.entries.length === 0);

// ─── Order invariant ──────────────────────────────────────────────────────────
console.log('\nOrder invariant — timestamps non-decreasing\n');

setup();
_setClient(mockRazorpay);
const { audit: aOrd } = await runWithAudit(
  { goal: 'order test', budget: 15000, preferences: { headset: 'medium', keyboard: 'low' } },
  { max_spending: 20000, allowed_categories: ['headset', 'keyboard'] },
  { max_discount: 70, min_margin: 200 }
);
_resetClient();

const ts = aOrd.entries.map(e => new Date(e.timestamp).getTime());
const nonDecreasing = ts.every((t, i) => i === 0 || t >= ts[i - 1]);
assert('timestamps are non-decreasing (execution order preserved)', nonDecreasing);

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed > 0) { console.error('\nSome tests failed.'); process.exit(1); }
else { console.log('\nAll tests passed '); }

})().catch(err => { console.error(err); process.exit(1); });
