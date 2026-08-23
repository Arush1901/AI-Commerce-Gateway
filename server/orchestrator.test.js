'use strict';

/**
 * Stage 8 tests — orchestrate() only (no LLM calls).
 * parseIntent is bypassed; intents are injected directly.
 */

const { orchestrate } = require('./orchestrator');

// ─── assert harness ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(desc, condition, detail = '') {
  if (condition) { console.log(`  ✅  ${desc}`); passed++; }
  else { console.error(`  ❌  ${desc}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ─── shared catalog fixture ───────────────────────────────────────────────────
// Kept local so tests are hermetic and do not depend on catalog.json changes.
const catalog = [
  // headset: office=₹6000 (best, locked usually), pro=₹8500 (OOS in some cases)
  { id: 'hs-office', name: 'Headset Office',  category: 'headset',  tier: 'office', price: 6000, features: [], stock: 44 },
  { id: 'hs-lite',   name: 'Headset Lite',    category: 'headset',  tier: 'lite',   price: 2999, features: [], stock: 20 },
  // keyboard: office=₹3500, lite=₹1999
  { id: 'kb-office', name: 'Keyboard Office', category: 'keyboard', tier: 'office', price: 3500, features: [], stock: 85 },
  { id: 'kb-lite',   name: 'Keyboard Lite',   category: 'keyboard', tier: 'lite',   price: 1999, features: [], stock: 200 },
  // mouse: office=₹2000, lite=₹799
  { id: 'ms-office', name: 'Mouse Office',    category: 'mouse',    tier: 'office', price: 2000, features: [], stock: 90 },
  { id: 'ms-lite',   name: 'Mouse Lite',      category: 'mouse',    tier: 'lite',   price:  799, features: [], stock: 300 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// CASE 1 — Canonical gaming example → approved
//
// Cart: hs-office ₹6000 + kb-office ₹3500 + ms-office ₹2000 = ₹11500
// Budget: 12000 → allocation round 1 closes gap (kb→lite saves ₹1501, total ₹9999 ≤ ₹12000)
// Policies: lenient → all approved
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n🎮 Case 1: canonical gaming example → approved\n');

const intent1 = {
  goal: 'gaming setup',
  budget: 12000,
  preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' },
};
const uPolicy1 = { max_spending: 15000, allowed_categories: ['headset', 'keyboard', 'mouse'] };
const mPolicy1 = { max_discount: 60, min_margin: 500 };

const r1 = orchestrate(intent1, catalog, uPolicy1, mPolicy1);

assert('[C1] returns object',                     typeof r1 === 'object');
assert('[C1] has transactionId',                  typeof r1.transactionId === 'string' && r1.transactionId.length > 0);
assert('[C1] decision = approved',                r1.decision === 'approved', r1.decision);
assert('[C1] reasoning is a string',              typeof r1.reasoning === 'string');

// fullTrace shape
assert('[C1] fullTrace.intent present',           typeof r1.fullTrace.intent === 'object');
assert('[C1] fullTrace.cart present',             typeof r1.fullTrace.cart === 'object');
assert('[C1] fullTrace.negotiation present',      typeof r1.fullTrace.negotiation === 'object');
assert('[C1] fullTrace.userPolicyResult present', typeof r1.fullTrace.userPolicyResult === 'object');
assert('[C1] fullTrace.merchantPolicyResult present', typeof r1.fullTrace.merchantPolicyResult === 'object');
assert('[C1] fullTrace.decision present',         typeof r1.fullTrace.decision === 'string');

// Content checks
assert('[C1] negotiation approved',               r1.fullTrace.negotiation.status === 'approved');
assert('[C1] user policy approved',               r1.fullTrace.userPolicyResult.status === 'approved');
assert('[C1] merchant policy approved',           r1.fullTrace.merchantPolicyResult.status === 'approved');
assert('[C1] headset untouched in finalCart',
  r1.fullTrace.negotiation.finalCart.items.find(i => i.category === 'headset')?.price === 6000);

// unique transactionIds
const r1b = orchestrate(intent1, catalog, uPolicy1, mPolicy1);
assert('[C1] each call gets unique transactionId', r1.transactionId !== r1b.transactionId);

// ═══════════════════════════════════════════════════════════════════════════════
// CASE 2 — User spending policy failure → rejected
//
// Same cart/negotiation as C1 (negotiation succeeds, total ≈ ₹9999 after round 1)
// BUT userPolicy.max_spending = 5000 → even final cart ₹9999 > ₹5000 → rejected
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n💳 Case 2: user spending policy failure → rejected\n');

const intent2 = { ...intent1 };
const uPolicy2 = { max_spending: 5000, allowed_categories: ['headset', 'keyboard', 'mouse'] };
const mPolicy2 = { max_discount: 60, min_margin: 500 };

const r2 = orchestrate(intent2, catalog, uPolicy2, mPolicy2);

assert('[C2] decision = rejected',                r2.decision === 'rejected', r2.decision);
assert('[C2] user policy rejected',               r2.fullTrace.userPolicyResult.status === 'rejected');
assert('[C2] reasoning mentions user policy',
  r2.reasoning.toLowerCase().includes('user policy'));
assert('[C2] fullTrace.intent present',           typeof r2.fullTrace.intent === 'object');
assert('[C2] fullTrace.negotiation present',      typeof r2.fullTrace.negotiation === 'object');

// ═══════════════════════════════════════════════════════════════════════════════
// CASE 3 — Negotiation cannot reach budget → escalated
//
// Budget: ₹1000    headset locked ₹6000 (alone > budget)
// Round 1: keyboard ₹3500→lite ₹1999, still over (₹6000+₹1999+₹2000=₹9999>₹1000)
// Round 2: mouse ₹2000→lite ₹799, still over (₹6000+₹1999+₹799=₹8798>₹1000)
// → escalation_needed → decision: escalated
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n🚨 Case 3: impossible budget → escalated\n');

const intent3 = {
  goal: 'gaming setup',
  budget: 1000,
  preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' },
};
const uPolicy3 = { max_spending: 15000, allowed_categories: ['headset', 'keyboard', 'mouse'] };
const mPolicy3 = { max_discount: 60, min_margin: 500 };

const r3 = orchestrate(intent3, catalog, uPolicy3, mPolicy3);

assert('[C3] decision = escalated',               r3.decision === 'escalated', r3.decision);
assert('[C3] negotiation escalated',              r3.fullTrace.negotiation.status === 'escalation_needed');
assert('[C3] gap is positive',                    r3.fullTrace.negotiation.gap > 0);
assert('[C3] reasoning mentions escalation',      r3.reasoning.toLowerCase().includes('escal'));
assert('[C3] fullTrace.intent present',           typeof r3.fullTrace.intent === 'object');
assert('[C3] fullTrace.cart present',             typeof r3.fullTrace.cart === 'object');
// offers and rounds always present (uniform shape from Stage 6 fix)
assert('[C3] negotiation.offers is array',        Array.isArray(r3.fullTrace.negotiation.offers));
assert('[C3] negotiation.rounds is number',       typeof r3.fullTrace.negotiation.rounds === 'number');

// ─── Cross-cutting: fullTrace is structured JSON (not string) ─────────────────
console.log('\n🔍 fullTrace structure — Stage 9/11 readiness\n');

for (const [label, result] of [['C1', r1], ['C2', r2], ['C3', r3]]) {
  const t = result.fullTrace;
  assert(`[${label}] fullTrace is plain object`,       t !== null && typeof t === 'object' && !Array.isArray(t));
  assert(`[${label}] fullTrace has all 6 keys`,
    ['intent','cart','negotiation','userPolicyResult','merchantPolicyResult','decision']
      .every(k => k in t));
  assert(`[${label}] fullTrace is JSON-serialisable`,
    (() => { try { JSON.stringify(t); return true; } catch { return false; } })());
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed > 0) { console.error('\nSome tests failed.'); process.exit(1); }
else { console.log('\nAll tests passed ✅'); }
