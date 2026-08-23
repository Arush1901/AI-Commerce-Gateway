'use strict';

/**
 * Stage 9 — Audit Trail tests.
 *
 * Calls orchestrate() with an explicit transactionId so the audit store
 * is populated. No LLM calls — intent is injected directly.
 */

const { orchestrate }                       = require('./orchestrator');
const { createAudit, getAudit, _reset }     = require('./auditService');

// ─── assert harness ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(desc, condition, detail = '') {
  if (condition) { console.log(`  ✅  ${desc}`); passed++; }
  else { console.error(`  ❌  ${desc}${detail ? ' — ' + detail : ''}`); failed++; }
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

// Expected step order for every purchase
const EXPECTED_STEPS = [
  'cart_building',
  'negotiation',
  'user_policy_validation',
  'merchant_policy_validation',
  'decision',
];

// Helper: run orchestrate() under an explicit audit context
function runWithAudit(intent, uPolicy, mPolicy) {
  const txId = 'test-' + Math.random().toString(36).slice(2);
  createAudit(txId);
  const result = orchestrate(intent, catalog, uPolicy, mPolicy, txId);
  const audit  = getAudit(txId);
  return { result, audit, txId };
}

// Reset audit store before each case
function setup() { _reset(); }

// ═══════════════════════════════════════════════════════════════════════════════
// Case 1 — Successful purchase → 5 ordered entries (intent_parsing added by
//           the HTTP handler; here we test the 5 orchestrate() steps)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n📋 Case 1: successful purchase — ordered audit entries\n');
setup();

const { result: r1, audit: a1 } = runWithAudit(
  { goal: 'gaming', budget: 12000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } },
  { max_spending: 15000, allowed_categories: ['headset', 'keyboard', 'mouse'] },
  { max_discount: 60, min_margin: 500 }
);

assert('[C1] decision = approved',                    r1.decision === 'approved');
assert('[C1] audit trail returned',                   a1 !== null);
assert('[C1] transactionId matches',                  a1.transactionId === r1.transactionId);
assert('[C1] entries is array',                       Array.isArray(a1.entries));
assert('[C1] 5 entries recorded',                     a1.entries.length === 5, `got ${a1.entries.length}`);

// Check exact order
const steps1 = a1.entries.map(e => e.step);
assert('[C1] steps in correct order',                 JSON.stringify(steps1) === JSON.stringify(EXPECTED_STEPS),
  `got ${JSON.stringify(steps1)}`);

// Check each entry shape
for (const entry of a1.entries) {
  assert(`[C1] ${entry.step}: has input`,              'input'  in entry);
  assert(`[C1] ${entry.step}: has output`,             'output' in entry);
  assert(`[C1] ${entry.step}: timestamp is ISO string`,
    typeof entry.timestamp === 'string' && entry.timestamp.includes('T'));
}

// Check entry content
const decisionEntry1 = a1.entries.find(e => e.step === 'decision');
assert('[C1] decision output = approved',              decisionEntry1.output.decision === 'approved');

const cartEntry1 = a1.entries.find(e => e.step === 'cart_building');
assert('[C1] cart_building output has items',          Array.isArray(cartEntry1.output.items));
assert('[C1] cart_building output has total',          typeof cartEntry1.output.total === 'number');

// ═══════════════════════════════════════════════════════════════════════════════
// Case 2 — Rejected purchase → decision entry records "rejected"
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n📋 Case 2: rejected purchase — decision entry records rejected\n');
setup();

const { result: r2, audit: a2 } = runWithAudit(
  { goal: 'gaming', budget: 12000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } },
  { max_spending: 5000, allowed_categories: ['headset', 'keyboard', 'mouse'] },  // too tight
  { max_discount: 60,  min_margin: 500 }
);

assert('[C2] decision = rejected',                    r2.decision === 'rejected');
assert('[C2] audit trail returned',                   a2 !== null);
assert('[C2] 5 entries recorded',                     a2.entries.length === 5);
assert('[C2] steps in correct order',
  JSON.stringify(a2.entries.map(e => e.step)) === JSON.stringify(EXPECTED_STEPS));

const decisionEntry2 = a2.entries.find(e => e.step === 'decision');
assert('[C2] decision entry output.decision = rejected', decisionEntry2.output.decision === 'rejected');

const uPolicyEntry2 = a2.entries.find(e => e.step === 'user_policy_validation');
assert('[C2] user_policy_validation output.status = rejected', uPolicyEntry2.output.status === 'rejected');

// ═══════════════════════════════════════════════════════════════════════════════
// Case 3 — Escalated purchase → decision entry records "escalated"
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n📋 Case 3: escalated purchase — decision entry records escalated\n');
setup();

const { result: r3, audit: a3 } = runWithAudit(
  { goal: 'gaming', budget: 1000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } },
  { max_spending: 15000, allowed_categories: ['headset', 'keyboard', 'mouse'] },
  { max_discount: 60, min_margin: 500 }
);

assert('[C3] decision = escalated',                   r3.decision === 'escalated');
assert('[C3] audit trail returned',                   a3 !== null);
assert('[C3] 5 entries recorded',                     a3.entries.length === 5);
assert('[C3] steps in correct order',
  JSON.stringify(a3.entries.map(e => e.step)) === JSON.stringify(EXPECTED_STEPS));

const decisionEntry3 = a3.entries.find(e => e.step === 'decision');
assert('[C3] decision entry output.decision = escalated', decisionEntry3.output.decision === 'escalated');

const negEntry3 = a3.entries.find(e => e.step === 'negotiation');
assert('[C3] negotiation output.status = escalation_needed', negEntry3.output.status === 'escalation_needed');
assert('[C3] negotiation output.gap > 0',             negEntry3.output.gap > 0);

// ═══════════════════════════════════════════════════════════════════════════════
// Case 4 — Unknown transactionId → getAudit returns null (→ HTTP 404)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n📋 Case 4: unknown transactionId → getAudit returns null\n');
setup();

const missing = getAudit('does-not-exist-tx-999');
assert('[C4] getAudit returns null for unknown id',   missing === null);

// Even after a real transaction exists, an unknown id still returns null
createAudit('known-tx');
const stillMissing = getAudit('unknown-tx');
assert('[C4] null when other txIds exist',            stillMissing === null);

// Known id IS returned
const known = getAudit('known-tx');
assert('[C4] known id returns trail object',          known !== null && known.transactionId === 'known-tx');
assert('[C4] known id entries start empty',           known.entries.length === 0);

// ─── Cross-cutting: execution order preserved across runs ────────────────────
console.log('\n🔍 Order invariant — timestamps non-decreasing\n');

setup();
const { audit: aOrd } = runWithAudit(
  { goal: 'order test', budget: 15000, preferences: { headset: 'medium', keyboard: 'low' } },
  { max_spending: 20000, allowed_categories: ['headset', 'keyboard'] },
  { max_discount: 70, min_margin: 200 }
);

const ts = aOrd.entries.map(e => new Date(e.timestamp).getTime());
const nonDecreasing = ts.every((t, i) => i === 0 || t >= ts[i - 1]);
assert('timestamps are non-decreasing (execution order preserved)', nonDecreasing);

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed > 0) { console.error('\nSome tests failed.'); process.exit(1); }
else { console.log('\nAll tests passed ✅'); }
