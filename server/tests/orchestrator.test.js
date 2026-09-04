'use strict';

/**
 * Stage 8 tests — orchestrate() only (no LLM calls, no real Razorpay).
 * parseIntent bypassed; payment mocked via _setClient.
 */

const { orchestrate, purchaseHandler,
        confirmPurchase, cancelPurchase,
        confirmHandler, cancelHandler } = require('../src/core/orchestrator');
const { _setClient, _resetClient }  = require('../src/services/paymentService');
const { _reset: _resetPending, getPending, createPending } = require('../src/services/pendingService');
const { createMandate } = require('../src/agents/mandate');

// ─── assert harness ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(desc, condition, detail = '') {
  if (condition) { console.log(`   ${desc}`); passed++; }
  else { console.error(`   ${desc}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ─── Payment mock ─────────────────────────────────────────────────────────────
const MOCK_ORDER = { id: 'order_MOCK001', amount: 999900, currency: 'INR' };
const mockRazorpay = { orders: { create: async () => MOCK_ORDER } };

// ─── shared catalog fixture ───────────────────────────────────────────────────
const catalog = [
  { id: 'hs-office', name: 'Headset Office',  category: 'headset',  tier: 'office', price: 6000, features: [], stock: 44 },
  { id: 'hs-lite',   name: 'Headset Lite',    category: 'headset',  tier: 'lite',   price: 2999, features: [], stock: 20 },
  { id: 'kb-office', name: 'Keyboard Office', category: 'keyboard', tier: 'office', price: 3500, features: [], stock: 85 },
  { id: 'kb-lite',   name: 'Keyboard Lite',   category: 'keyboard', tier: 'lite',   price: 1999, features: [], stock: 200 },
  { id: 'ms-office', name: 'Mouse Office',    category: 'mouse',    tier: 'office', price: 2000, features: [], stock: 90 },
  { id: 'ms-lite',   name: 'Mouse Lite',      category: 'mouse',    tier: 'lite',   price:  799, features: [], stock: 300 },
];

(async () => {

// ═══════════════════════════════════════════════════════════════════════════════
// CASE 1 — Canonical gaming example → approved + payment object
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nCase 1: canonical gaming example → approved\n');

_setClient(mockRazorpay);

const intent1 = {
  goal: 'gaming setup',
  budget: 12000,
  preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' },
};
const uPolicy1 = { max_spending: 15000, allowed_categories: ['headset', 'keyboard', 'mouse'] };
const mPolicy1 = { max_discount: 60, min_margin: 500 };

const r1 = await orchestrate(intent1, catalog, uPolicy1, mPolicy1);

assert('[C1] returns object',                         typeof r1 === 'object');
assert('[C1] has transactionId',                      typeof r1.transactionId === 'string' && r1.transactionId.length > 0);
assert('[C1] decision = approved',                    r1.decision === 'approved', r1.decision);
assert('[C1] reasoning is a string',                  typeof r1.reasoning === 'string');
assert('[C1] payment object present',                 r1.payment !== null && typeof r1.payment === 'object');
assert('[C1] payment.orderId present',                typeof r1.payment.orderId === 'string');
assert('[C1] payment.amount present',                 typeof r1.payment.amount === 'number');
assert('[C1] payment.currency = INR',                 r1.payment.currency === 'INR');
assert('[C1] payment.keyId present',                  typeof r1.payment.keyId === 'string');
assert('[C1] fullTrace.intent present',               typeof r1.fullTrace.intent === 'object');
assert('[C1] fullTrace.cart present',                 typeof r1.fullTrace.cart === 'object');
assert('[C1] fullTrace.negotiation present',          typeof r1.fullTrace.negotiation === 'object');
assert('[C1] fullTrace.userPolicyResult present',     typeof r1.fullTrace.userPolicyResult === 'object');
assert('[C1] fullTrace.merchantPolicyResult present', typeof r1.fullTrace.merchantPolicyResult === 'object');
assert('[C1] fullTrace.decision present',             typeof r1.fullTrace.decision === 'string');
assert('[C1] negotiation approved',                   r1.fullTrace.negotiation.status === 'approved');
assert('[C1] headset untouched in finalCart',
  r1.fullTrace.negotiation.finalCart.items.find(i => i.category === 'headset')?.price === 6000);

const r1b = await orchestrate(intent1, catalog, uPolicy1, mPolicy1);
assert('[C1] each call gets unique transactionId',    r1.transactionId !== r1b.transactionId);

_resetClient();

// ═══════════════════════════════════════════════════════════════════════════════
// CASE 2 — User spending policy failure → rejected, payment: null
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nCase 2: user spending policy failure → rejected\n');

const r2 = await orchestrate(
  { ...intent1 },
  catalog,
  { max_spending: 5000, allowed_categories: ['headset', 'keyboard', 'mouse'] },
  { max_discount: 60, min_margin: 500 }
);

assert('[C2] decision = rejected',                    r2.decision === 'rejected', r2.decision);
assert('[C2] payment = null',                         r2.payment === null);
assert('[C2] user policy rejected',                   r2.fullTrace.userPolicyResult.status === 'rejected');
assert('[C2] reasoning mentions user policy',         r2.reasoning.toLowerCase().includes('user policy'));
assert('[C2] fullTrace.intent present',               typeof r2.fullTrace.intent === 'object');
assert('[C2] fullTrace.negotiation present',          typeof r2.fullTrace.negotiation === 'object');

// ═══════════════════════════════════════════════════════════════════════════════
// CASE 3 — Negotiation cannot reach budget → escalated, payment: null
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nCase 3: impossible budget → escalated\n');

const r3 = await orchestrate(
  { goal: 'gaming setup', budget: 1000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } },
  catalog,
  { max_spending: 15000, allowed_categories: ['headset', 'keyboard', 'mouse'] },
  { max_discount: 65, min_margin: 200 }   // 65% allows mouse ₹2000→₹799 (60.05%); 200 is below ₹799
);

assert('[C3] decision = escalated',                   r3.decision === 'escalated', r3.decision);
assert('[C3] payment = null',                         r3.payment === null);
assert('[C3] negotiation escalated',                  r3.fullTrace.negotiation.status === 'escalation_needed');
assert('[C3] gap is positive',                        r3.fullTrace.negotiation.gap > 0);
assert('[C3] reasoning mentions escalation',          r3.reasoning.toLowerCase().includes('escal'));
assert('[C3] negotiation.offers is array',            Array.isArray(r3.fullTrace.negotiation.offers));
assert('[C3] negotiation.rounds is number',           typeof r3.fullTrace.negotiation.rounds === 'number');

// ═══════════════════════════════════════════════════════════════════════════════
// CASE 4 — Regression: negotiation escalation + user-policy rejected
//          → MUST be 'rejected', NOT 'escalated'  (priority-inversion bug fix)
//
// Setup: budget=1000 (impossible → negotiation escalates) AND max_spending=500
//        (policy also rejects). Rejected must win.
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nCase 4: escalation_needed + user-policy rejected → "rejected" wins\n');

const r4 = await orchestrate(
  { goal: 'gaming setup', budget: 1000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } },
  catalog,
  { max_spending: 500, allowed_categories: ['headset', 'keyboard', 'mouse'] }, // ← policy also rejects
  { max_discount: 60, min_margin: 500 }
);

assert('[C4] decision = rejected (not escalated)',    r4.decision === 'rejected', r4.decision);
assert('[C4] payment = null',                         r4.payment === null);
assert('[C4] fullTrace.negotiation escalated',        r4.fullTrace.negotiation.status === 'escalation_needed');
assert('[C4] fullTrace.userPolicyResult rejected',    r4.fullTrace.userPolicyResult.status === 'rejected');
assert('[C4] reasoning mentions "user policy"',       r4.reasoning.toLowerCase().includes('user policy'));

// ═══════════════════════════════════════════════════════════════════════════════
// CASE 5 — Regression: merchant-policy escalated + user-policy rejected
//          → MUST be 'rejected', NOT 'escalated'  (same priority-inversion fix)
//
// Setup: negotiation succeeds BUT merchant policy escalates AND user policy
//        also rejects. 'rejected' must outrank merchant escalation.
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nCase 5: merchant-policy escalated + user-policy rejected → "rejected" wins\n');

const r5 = await orchestrate(
  { goal: 'gaming setup', budget: 12000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } },
  catalog,
  { max_spending: 500, allowed_categories: ['headset', 'keyboard', 'mouse'] }, // ← user policy rejects
  { max_discount: 0,  min_margin: 999999 }                                      // ← merchant escalates
);

assert('[C5] decision = rejected (not escalated)',    r5.decision === 'rejected', r5.decision);
assert('[C5] payment = null',                         r5.payment === null);
assert('[C5] reasoning mentions "user policy"',       r5.reasoning.toLowerCase().includes('user policy'));

// ═══════════════════════════════════════════════════════════════════════════════
// CASE 6 — Regression: C1 all-offer merchant policy check
//
// Round 1 offer: keyboard pro → office (saving ₹1501).
//   discount% = 1501 / (1999 + 1501) * 100 = 1501/3500 = 42.9%
//   → within max_discount: 50% 
// Round 2 offer: mouse office → lite (saving ₹1201).
//   discount% = 1201 / (799 + 1201) * 100 = 1201/2000 = 60.05%
//   → violates max_discount: 50%
//
// OLD code: only checked last offer (Round 2's mouse offer — rejected ←)
//   but that still meant Round 1's cart was used, causing an inconsistent result.
// NEW code: validateAllMerchantOffers checks BOTH rounds.
//   Round 2 discount% exceeds cap → merchantPolicyResult = rejected → decision = rejected.
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nCase 6: C1 — Round-1 violates max_discount, Round-2 clean → rejected\n');

// Use max_discount: 45 — Round-1 keyboard saves ₹1501 on ₹3500 = 42.9% (just under 45)
// Round-2 mouse saves ₹1201 on ₹2000 = 60.05% (over 45) → all-offer check rejects
const r6 = await orchestrate(
  { goal: 'gaming setup', budget: 1000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } },
  catalog,
  { max_spending: 15000, allowed_categories: ['headset', 'keyboard', 'mouse'] },
  { max_discount: 43, min_margin: 200 }   // 43% → keyboard 42.9% passes, mouse 60.05% fails
);

assert('[C6] decision = rejected (not escalated)',    r6.decision === 'rejected', r6.decision);
assert('[C6] payment = null',                         r6.payment === null);
assert('[C6] reasoning mentions merchant policy',     r6.reasoning.toLowerCase().includes('merchant policy'));
assert('[C6] negotiation ran (not short-circuited)',  r6.fullTrace.negotiation !== null);

// ═══════════════════════════════════════════════════════════════════════════════
// CASE 7 — I2: budget === 0 short-circuits pipeline immediately
// Pipeline must NOT run (cart/negotiation remain null in fullTrace).
// Decision must be escalated with a clear budget-missing message.
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n Case 7: I2 — budget === 0 → immediate escalated (pipeline skipped)\n');

const r7 = await orchestrate(
  { goal: 'gaming setup', budget: 0, preferences: { headset: 'locked', keyboard: 'medium' } },
  catalog,
  { max_spending: 15000, allowed_categories: ['headset', 'keyboard', 'mouse'] },
  { max_discount: 60, min_margin: 200 }
);

assert('[C7] decision = escalated',                   r7.decision === 'escalated', r7.decision);
assert('[C7] payment = null',                         r7.payment === null);
assert('[C7] reasoning mentions budget',              r7.reasoning.toLowerCase().includes('budget'));
assert('[C7] fullTrace.cart = null (pipeline skipped)', r7.fullTrace.cart === null);
assert('[C7] fullTrace.negotiation = null',           r7.fullTrace.negotiation === null);

// ─── Cross-cutting: fullTrace is structured JSON ───────────────────────────────
console.log('\nfullTrace structure — Stage 9/11 readiness\n');

for (const [label, result] of [['C1', r1], ['C2', r2], ['C3', r3], ['C4', r4], ['C5', r5], ['C6', r6]]) {
  const t = result.fullTrace;
  assert(`[${label}] fullTrace is plain object`,
    t !== null && typeof t === 'object' && !Array.isArray(t));
  assert(`[${label}] fullTrace has all 6 keys`,
    ['intent','cart','negotiation','userPolicyResult','merchantPolicyResult','decision']
      .every(k => k in t));
  assert(`[${label}] fullTrace is JSON-serialisable`,
    (() => { try { JSON.stringify(t); return true; } catch { return false; } })());
}

// ─── purchaseHandler input validation (returns before parseIntent) ─────────────
console.log('\npurchaseHandler — request validation (no LLM)\n');

// Minimal Express res mock capturing status + json.
function mockRes() {
  return {
    _status: 200, _json: null,
    status(c) { this._status = c; return this; },
    json(o)   { this._json = o;  return this; },
  };
}
async function call(body) {
  const res = mockRes();
  await purchaseHandler({ body }, res);
  return res;
}

const goodPolicies = {
  userPolicy:     { max_spending: 20000 },
  merchantPolicy: { max_discount: 60, min_margin: 100 },
};

// userText
const vMissingText = await call({ ...goodPolicies });
assert('[V1] missing userText → 400',            vMissingText._status === 400);
assert('[V1] error mentions userText',           /userText/.test(vMissingText._json.error));

// malformed policy shapes still caught
const vBadPolicy = await call({ userText: 'x', userPolicy: { max_spending: 'lots' }, merchantPolicy: goodPolicies.merchantPolicy });
assert('[V2] malformed max_spending → 400',      vBadPolicy._status === 400 && /max_spending/.test(vBadPolicy._json.error));

// ═══════════════════════════════════════════════════════════════════════════════
// TWO-PHASE PURCHASE — defer payment, human confirm / cancel, graceful failures
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n Two-phase purchase — defer, confirm, cancel\n');

const { createAudit, getAudit } = require('../src/services/auditService');

const twoPhaseIntent = () => ({ goal: 'gaming setup', budget: 12000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } });
const uPolicyTP = { max_spending: 15000, allowed_categories: ['headset', 'keyboard', 'mouse'] };
const mPolicyTP = { max_discount: 60, min_margin: 500 };

// D1 — deferPayment stashes a pending charge and does NOT charge
_setClient(mockRazorpay);
_resetPending();
createAudit('tx-d1');
const d1 = await orchestrate(twoPhaseIntent(), catalog, uPolicyTP, mPolicyTP, 'tx-d1', { deferPayment: true });
assert('[D1] status = pending_confirmation',        d1.status === 'pending_confirmation', d1.status);
assert('[D1] decision still approved',              d1.decision === 'approved', d1.decision);
assert('[D1] no payment yet',                       d1.payment === null);
assert('[D1] finalCart present in result',          d1.finalCart != null && typeof d1.finalCart.total === 'number');
assert('[D1] pending record created',               getPending('tx-d1') !== null);
assert('[D1] audit has awaiting_confirmation',      getAudit('tx-d1').entries.some(e => e.step === 'awaiting_confirmation'));
assert('[D1] audit has NO payment_order_created',   !getAudit('tx-d1').entries.some(e => e.step === 'payment_order_created'));

// D2 — confirm releases the charge and clears the pending record
const d2 = await confirmPurchase('tx-d1');
assert('[D2] confirm ok',                           d2.ok === true);
assert('[D2] status = paid',                        d2.status === 'paid', d2.status);
assert('[D2] payment order returned',               d2.payment != null && typeof d2.payment.orderId === 'string');
assert('[D2] pending cleared after confirm',        getPending('tx-d1') === null);
assert('[D2] audit has purchase_confirmed',         getAudit('tx-d1').entries.some(e => e.step === 'purchase_confirmed'));
assert('[D2] audit has payment_order_created',      getAudit('tx-d1').entries.some(e => e.step === 'payment_order_created'));

// D3 — a second confirm cannot double-charge
const d3 = await confirmPurchase('tx-d1');
assert('[D3] second confirm → not_pending',         d3.ok === false && d3.code === 'not_pending', d3.code);

// D4 — cancel drops the pending charge, audits it, and never charges
_resetPending();
createAudit('tx-d4');
await orchestrate(twoPhaseIntent(), catalog, uPolicyTP, mPolicyTP, 'tx-d4', { deferPayment: true });
assert('[D4] pending exists before cancel',         getPending('tx-d4') !== null);
const d4 = cancelPurchase('tx-d4');
assert('[D4] cancel ok',                            d4.ok === true && d4.status === 'cancelled');
assert('[D4] pending cleared after cancel',         getPending('tx-d4') === null);
assert('[D4] audit has purchase_cancelled',         getAudit('tx-d4').entries.some(e => e.step === 'purchase_cancelled'));
assert('[D4] audit has NO payment',                 !getAudit('tx-d4').entries.some(e => e.step === 'payment_order_created'));
const d4b = cancelPurchase('tx-d4');
assert('[D4] second cancel → not_pending',          d4b.ok === false && d4b.code === 'not_pending');

// D5 — mandate tampered AFTER approval → confirm-time gate refuses, escalates, no charge
_resetPending();
createAudit('tx-d5');
await orchestrate(twoPhaseIntent(), catalog, uPolicyTP, mPolicyTP, 'tx-d5', { deferPayment: true });
getPending('tx-d5').mandate.signature = 'deadbeef-tampered'; // corrupt the stashed signature
const d5 = await confirmPurchase('tx-d5');
assert('[D5] tampered confirm not ok',              d5.ok === false);
assert('[D5] escalated (decision + status)',        d5.status === 'escalated' && d5.decision === 'escalated', d5.status);
assert('[D5] code = gate_failed',                   d5.code === 'gate_failed', d5.code);
assert('[D5] pending dropped',                      getPending('tx-d5') === null);
assert('[D5] audit records decision_override',      getAudit('tx-d5').entries.some(e => e.step === 'decision_override'));
assert('[D5] audit has NO payment',                 !getAudit('tx-d5').entries.some(e => e.step === 'payment_order_created'));

// D6 — confirm/cancel handlers enforce possession-proof auth (txId as token)
_resetPending();
createAudit('tx-d6');
await orchestrate(twoPhaseIntent(), catalog, uPolicyTP, mPolicyTP, 'tx-d6', { deferPayment: true });
const noAuth = mockRes();
await confirmHandler({ params: { transactionId: 'tx-d6' }, headers: {}, query: {} }, noAuth);
assert('[D6] confirm without token → 401',          noAuth._status === 401);
assert('[D6] pending untouched after 401',          getPending('tx-d6') !== null);
const wrongAuth = mockRes();
await confirmHandler({ params: { transactionId: 'tx-d6' }, headers: { 'x-audit-token': 'nope' }, query: {} }, wrongAuth);
assert('[D6] confirm with wrong token → 401',       wrongAuth._status === 401);
const okAuth = mockRes();
await confirmHandler({ params: { transactionId: 'tx-d6' }, headers: { 'x-audit-token': 'tx-d6' }, query: {} }, okAuth);
assert('[D6] confirm with correct token → 200',     okAuth._status === 200);
assert('[D6] handler body status = paid',           okAuth._json.status === 'paid', okAuth._json.status);
const goneAuth = mockRes();
await confirmHandler({ params: { transactionId: 'tx-d6' }, headers: { 'x-audit-token': 'tx-d6' }, query: {} }, goneAuth);
assert('[D6] confirm already-settled → 409',        goneAuth._status === 409);
const cancelNoAuth = mockRes();
cancelHandler({ params: { transactionId: 'tx-d6' }, headers: {}, query: {} }, cancelNoAuth);
assert('[D6] cancel without token → 401',           cancelNoAuth._status === 401);

// D7 — payment provider throws on confirm → payment_failed, pending RETAINED for retry
_resetPending();
createAudit('tx-d7');
await orchestrate(twoPhaseIntent(), catalog, uPolicyTP, mPolicyTP, 'tx-d7', { deferPayment: true });
_setClient({ orders: { create: async () => { throw new Error('gateway timeout'); } } });
const d7 = await confirmPurchase('tx-d7');
assert('[D7] provider failure → not ok',            d7.ok === false && d7.code === 'payment_failed', d7.code);
assert('[D7] pending RETAINED for retry',           getPending('tx-d7') !== null);
assert('[D7] audit records payment_failed',         getAudit('tx-d7').entries.some(e => e.step === 'payment_failed'));
assert('[D7] no payment_order_created yet',         !getAudit('tx-d7').entries.some(e => e.step === 'payment_order_created'));
_setClient(mockRazorpay); // provider recovers
const d7b = await confirmPurchase('tx-d7');
assert('[D7] retry after recovery → paid',          d7b.ok === true && d7b.status === 'paid');
assert('[D7] pending cleared after successful retry', getPending('tx-d7') === null);
_resetClient();
_resetPending();

// ═══════════════════════════════════════════════════════════════════════════════
// EDITABLE CONFIRM + AUDITED OVER-BUDGET OVERRIDE
// The buyer may add/remove/swap items on the confirmation screen. Prices are
// always re-derived server-side (stashed negotiated line first, then catalog list
// price) — the client never supplies a price. Going over the mandate is refused
// UNLESS the human explicitly acknowledges it (logged as budget_override).
// Baseline stashed cart from twoPhaseIntent: [hs-office 6000, kb-office 3500, ms-office 2000] = 11500.
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n Editable confirm + over-budget override\n');

_setClient(mockRazorpay);
_resetPending();

// E1 — within-budget swap (ms-office → ms-lite) charges the edited cart, audits the edit
createAudit('tx-e1');
await orchestrate(twoPhaseIntent(), catalog, uPolicyTP, mPolicyTP, 'tx-e1', { deferPayment: true });
const e1 = await confirmPurchase('tx-e1',
  { items: [{ productId: 'hs-office' }, { productId: 'kb-office' }, { productId: 'ms-lite' }] }, catalog);
assert('[E1] edited within-budget confirm ok',      e1.ok === true && e1.status === 'paid', e1.status);
assert('[E1] edited flag set',                      e1.edited === true);
assert('[E1] not flagged as override',              e1.overridden === false);
assert('[E1] finalCart total = 10299 (6000+3500+799)', e1.finalCart.total === 10299, String(e1.finalCart?.total));
assert('[E1] swapped-in ms-lite priced from catalog (799)',
  e1.finalCart.items.find(i => i.product.id === 'ms-lite')?.price === 799);
assert('[E1] kept lines reuse stashed price (hs-office 6000)',
  e1.finalCart.items.find(i => i.product.id === 'hs-office')?.price === 6000);
assert('[E1] audit records cart_edited',            getAudit('tx-e1').entries.some(e => e.step === 'cart_edited'));
assert('[E1] audit has NO budget_override',         !getAudit('tx-e1').entries.some(e => e.step === 'budget_override'));
assert('[E1] audit has payment_order_created',      getAudit('tx-e1').entries.some(e => e.step === 'payment_order_created'));
assert('[E1] pending cleared after charge',         getPending('tx-e1') === null);

// E2 — over-budget edit WITHOUT acknowledgment → refused, escalated, pending dropped, no charge
createAudit('tx-e2');
await orchestrate(twoPhaseIntent(), catalog, uPolicyTP, mPolicyTP, 'tx-e2', { deferPayment: true });
const e2 = await confirmPurchase('tx-e2',
  { items: [{ productId: 'hs-office' }, { productId: 'kb-office' }, { productId: 'ms-office' }, { productId: 'hs-lite' }] }, catalog);
assert('[E2] over-budget, no ack → not ok',         e2.ok === false);
assert('[E2] code = gate_failed',                   e2.code === 'gate_failed', e2.code);
assert('[E2] status + decision escalated',          e2.status === 'escalated' && e2.decision === 'escalated', e2.status);
assert('[E2] reasoning mentions containment/budget', /budget|exceed|maxSpend|containment/i.test(e2.reasoning));
assert('[E2] pending dropped (no retry on unauthorized breach)', getPending('tx-e2') === null);
assert('[E2] audit records decision_override',      getAudit('tx-e2').entries.some(e => e.step === 'decision_override'));
assert('[E2] audit has NO budget_override',         !getAudit('tx-e2').entries.some(e => e.step === 'budget_override'));
assert('[E2] audit has NO payment_order_created',   !getAudit('tx-e2').entries.some(e => e.step === 'payment_order_created'));

// E3 — same over-budget edit WITH acknowledgment → charged, logged as human override
createAudit('tx-e3');
await orchestrate(twoPhaseIntent(), catalog, uPolicyTP, mPolicyTP, 'tx-e3', { deferPayment: true });
const e3 = await confirmPurchase('tx-e3',
  { items: [{ productId: 'hs-office' }, { productId: 'kb-office' }, { productId: 'ms-office' }, { productId: 'hs-lite' }],
    acknowledgeOverBudget: true }, catalog);
assert('[E3] over-budget + ack → ok + paid',        e3.ok === true && e3.status === 'paid', e3.status);
assert('[E3] overridden flag set',                  e3.overridden === true);
assert('[E3] finalCart total = 14499 (6000+3500+2000+2999)', e3.finalCart.total === 14499, String(e3.finalCart?.total));
assert('[E3] audit records budget_override',        getAudit('tx-e3').entries.some(e => e.step === 'budget_override'));
assert('[E3] budget_override records buyer ack',
  getAudit('tx-e3').entries.find(e => e.step === 'budget_override')?.output?.acknowledgedBy === 'buyer');
assert('[E3] audit has payment_order_created',      getAudit('tx-e3').entries.some(e => e.step === 'payment_order_created'));
assert('[E3] pending cleared after override charge', getPending('tx-e3') === null);

// E4 — unknown product id → invalid_cart, pending RETAINED (fixable), no charge
createAudit('tx-e4');
await orchestrate(twoPhaseIntent(), catalog, uPolicyTP, mPolicyTP, 'tx-e4', { deferPayment: true });
const e4 = await confirmPurchase('tx-e4',
  { items: [{ productId: 'hs-office' }, { productId: 'ghost-999' }] }, catalog);
assert('[E4] unknown product → not ok',             e4.ok === false);
assert('[E4] code = invalid_cart',                  e4.code === 'invalid_cart', e4.code);
assert('[E4] reasoning names the bad id',           /ghost-999/.test(e4.reasoning));
assert('[E4] pending RETAINED for correction',      getPending('tx-e4') !== null);
assert('[E4] no charge made',                       !getAudit('tx-e4').entries.some(e => e.step === 'payment_order_created'));
// empty selection is also invalid, pending still retained
const e4b = await confirmPurchase('tx-e4', { items: [] }, catalog);
assert('[E4] empty cart → invalid_cart',            e4b.ok === false && e4b.code === 'invalid_cart', e4b.code);
assert('[E4] pending still retained after empty edit', getPending('tx-e4') !== null);
// buyer corrects the selection (drop the ghost) → charges cleanly
const e4c = await confirmPurchase('tx-e4',
  { items: [{ productId: 'hs-office' }, { productId: 'kb-office' }] }, catalog);
assert('[E4] corrected edit → paid',                e4c.ok === true && e4c.status === 'paid', e4c.status);
assert('[E4] corrected total = 9500',               e4c.finalCart.total === 9500, String(e4c.finalCart?.total));
assert('[E4] pending cleared after successful correction', getPending('tx-e4') === null);

// E5 — handler path: invalid body → 400 (pending kept); valid removal edit → 200 paid
_resetPending();
createAudit('tx-e5');
await orchestrate(twoPhaseIntent(), catalog, uPolicyTP, mPolicyTP, 'tx-e5', { deferPayment: true });
const e5Invalid = mockRes();
await confirmHandler({ params: { transactionId: 'tx-e5' }, headers: { 'x-audit-token': 'tx-e5' }, query: {},
  body: { items: [{ productId: 'nope' }] } }, e5Invalid);
assert('[E5] invalid edited cart via handler → 400', e5Invalid._status === 400, String(e5Invalid._status));
assert('[E5] handler body code = invalid_cart',      e5Invalid._json.code === 'invalid_cart');
assert('[E5] pending retained after 400',            getPending('tx-e5') !== null);
const e5Ok = mockRes();
await confirmHandler({ params: { transactionId: 'tx-e5' }, headers: { 'x-audit-token': 'tx-e5' }, query: {},
  body: { items: [{ productId: 'hs-office' }, { productId: 'kb-office' }] } }, e5Ok);
assert('[E5] valid removal edit via handler → 200',  e5Ok._status === 200, String(e5Ok._status));
assert('[E5] handler body status = paid',            e5Ok._json.status === 'paid', e5Ok._json.status);
assert('[E5] handler removal total = 9500',          e5Ok._json.finalCart.total === 9500, String(e5Ok._json.finalCart?.total));
assert('[E5] handler edited flag set',               e5Ok._json.edited === true);

// E6 — a kept, negotiated bundle line is charged at its STASHED discounted price,
//      never re-derived from the catalog list price (which would overcharge).
_resetPending();
createAudit('tx-e6');
const e6cat = [
  { id: 'kb-x',  name: 'Keyboard X', category: 'keyboard', tier: 'office',   price: 3500, features: [], stock: 10 },
  // catalog LIST price is 1000, but this transaction negotiated it down to 880
  { id: 'acc-x', name: 'Cable X',    category: 'cable',    tier: 'standard', price: 1000, features: [], stock: 10 },
];
const e6mandate = createMandate({ maxSpend: 6000, allowedCategories: ['keyboard', 'cable'], expiresAt: null, goal: 'bundle test' });
const e6cart = {
  items: [
    { product: e6cat[0], category: 'keyboard', price: 3500 },
    // stashed at the DISCOUNTED price 880, list price retained on the product
    { product: { ...e6cat[1], price: 880, listPrice: 1000 }, category: 'cable', price: 880 },
  ],
  total: 4380, currency: 'INR', budget: 6000, over_budget: false,
};
createPending('tx-e6', { effectiveCart: e6cart, mandate: e6mandate, revenue: { baseline: 4380, final: 4380, uplift: 0, upliftPct: 0, strategy: 'goalfit' } });
const e6 = await confirmPurchase('tx-e6',
  { items: [{ productId: 'kb-x' }, { productId: 'acc-x' }] }, e6cat);
assert('[E6] confirm keeping bundle line → paid',   e6.ok === true && e6.status === 'paid', e6.status);
assert('[E6] discounted line charged at stashed 880 (not list 1000)',
  e6.finalCart.items.find(i => i.product.id === 'acc-x')?.price === 880,
  String(e6.finalCart.items.find(i => i.product.id === 'acc-x')?.price));
assert('[E6] total preserves discount = 4380 (not 4500)', e6.finalCart.total === 4380, String(e6.finalCart?.total));
assert('[E6] pending cleared after charge',         getPending('tx-e6') === null);

_resetClient();
_resetPending();

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed > 0) { console.error('\nSome tests failed.'); process.exit(1); }
else { console.log('\nAll tests passed '); }

})().catch(err => { console.error(err); process.exit(1); });
