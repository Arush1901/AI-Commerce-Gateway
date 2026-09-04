'use strict';

/**
 * optionsService tests — the goal-driven ALTERNATIVES feature (Problem 3).
 *
 * Part 1  generateOptions()          — pure, deterministic A/B/C generation.
 * Part 2  prepareOptions() +
 *         selectPurchase() +
 *         orchestrate({lockedCart})   — the end-to-end options → select → confirm
 *                                       flow, no LLM, payment mocked.
 *
 * Self-contained: a dummy GROQ key is set BEFORE requiring orchestrator (which
 * pulls in intentService, whose module throws at load without a key). No network
 * call is ever made — parseIntent is never invoked; intents are built directly.
 */

process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'dummy-test-key';

const { generateOptions } = require('../src/services/optionsService');
const { classifyGoal } = require('../src/services/goalService');
const { growthMandateFromIntent } = require('../src/agents/mandate');
const {
  prepareOptions, selectPurchase, confirmPurchase, _resetPendingOptions,
} = require('../src/core/orchestrator');
const { _setClient, _resetClient } = require('../src/services/paymentService');
const { _reset: _resetPending, getPending } = require('../src/services/pendingService');
const { createAudit, getAudit } = require('../src/services/auditService');

// ─── assert harness ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(desc, condition, detail = '') {
  if (condition) { console.log(`   ${desc}`); passed++; }
  else { console.error(`   ${desc}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ─── payment mock ─────────────────────────────────────────────────────────────
const MOCK_ORDER = { id: 'order_OPT001', amount: 1850000, currency: 'INR' };
const mockRazorpay = { orders: { create: async () => MOCK_ORDER } };

// ─── deterministic catalog fixture ──────────────────────────────────────────────
// Tuned so a gaming setup's IDEAL (hs-pro + kb-pro + ms-pro = 21000) overshoots a
// 19000 budget, and A/B/C come out DISTINCT:
//   A best-affordable (max total ≤ budget) = hs-mid + kb-pro + ms-pro = 18500
//   B balanced (heroes maxed, rest cheap)   = hs-lite + kb-pro + ms-pro = 17000
//   C cheapest complete                      = hs-lite + kb-lite + ms-lite = 8000
// kb-office (office useCase, cheaper than kb-lite) must NEVER enter the gaming pool.
const catalog = [
  { id: 'hs-lite',   name: 'Headset Lite',    category: 'headset',  tier: 'lite',   price: 2000, useCases: ['gaming', 'general'], stock: 10, features: ['stereo'],                complements: [] },
  { id: 'hs-mid',    name: 'Headset Mid',     category: 'headset',  tier: 'office', price: 3500, useCases: ['gaming', 'general'], stock: 10, features: ['surround'],              complements: [] },
  { id: 'hs-pro',    name: 'Headset Pro',     category: 'headset',  tier: 'pro',    price: 6000, useCases: ['gaming'],            stock: 10, features: ['surround', 'noise-cancel'], complements: [] },
  { id: 'kb-lite',   name: 'Keyboard Lite',   category: 'keyboard', tier: 'lite',   price: 3000, useCases: ['gaming', 'general'], stock: 10, features: ['membrane'],              complements: [] },
  { id: 'kb-pro',    name: 'Keyboard Pro',    category: 'keyboard', tier: 'pro',    price: 7000, useCases: ['gaming'],            stock: 10, features: ['mechanical', 'rgb'],       complements: [] },
  { id: 'kb-office', name: 'Keyboard Office', category: 'keyboard', tier: 'office', price: 2500, useCases: ['office'],            stock: 10, features: ['quiet'],                  complements: [] },
  { id: 'ms-lite',   name: 'Mouse Lite',      category: 'mouse',    tier: 'lite',   price: 3000, useCases: ['gaming', 'general'], stock: 10, features: ['6400dpi'],               complements: [] },
  { id: 'ms-pro',    name: 'Mouse Pro',       category: 'mouse',    tier: 'pro',    price: 8000, useCases: ['gaming'],            stock: 10, features: ['26000dpi'],              complements: [] },
];

const GAMING_CATS = ['headset', 'keyboard', 'mouse'];
const idsOf = items => items.map(i => i.product.id).sort();
const has = (items, id) => items.some(i => i.product.id === id);

(async () => {

// ═══════════════════════════════════════════════════════════════════════════════
// PART 1 — generateOptions() (pure)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── G1: ideal fits budget → no options ─────────────────────────────────────────
console.log('\nG1: ideal within budget → fits, zero options\n');
const g1 = generateOptions({ categories: GAMING_CATS, useCase: 'gaming', budget: 25000, catalog, goalType: 'gaming', heroCategories: ['mouse', 'keyboard'] });
assert('[G1] fits = true',                 g1.fits === true, String(g1.fits));
assert('[G1] options empty',               Array.isArray(g1.options) && g1.options.length === 0, `len=${g1.options.length}`);
assert('[G1] feasible = true',             g1.feasible === true);
assert('[G1] ideal total = 21000',         g1.ideal.total === 21000, String(g1.ideal.total));

// ─── G2: ideal over budget, feasible → 3 distinct A/B/C ──────────────────────────
console.log('\nG2: ideal over budget → three distinct within-budget options\n');
const g2 = generateOptions({ categories: GAMING_CATS, useCase: 'gaming', budget: 19000, catalog, goalType: 'gaming', heroCategories: ['mouse', 'keyboard'] });
assert('[G2] fits = false',                g2.fits === false);
assert('[G2] feasible = true',             g2.feasible === true);
assert('[G2] exactly 3 options',           g2.options.length === 3, `len=${g2.options.length}`);
assert('[G2] option ids A/B/C',            g2.options.map(o => o.id).join('') === 'ABC', g2.options.map(o => o.id).join(''));
const [oA, oB, oC] = g2.options;
assert('[G2] A total = 18500 (best affordable)', oA.total === 18500, String(oA.total));
assert('[G2] B total = 17000 (balanced)',        oB.total === 17000, String(oB.total));
assert('[G2] C total = 8000 (cheapest)',         oC.total === 8000,  String(oC.total));
assert('[G2] every option within budget',        g2.options.every(o => o.withinBudget === true));
assert('[G2] totals strictly descending A>B>C',  oA.total > oB.total && oB.total > oC.total);
assert('[G2] all three carts distinct',          new Set(g2.options.map(o => idsOf(o.items).join('|'))).size === 3);
assert('[G2] each option has tradeoffs[]',        g2.options.every(o => Array.isArray(o.tradeoffs) && o.tradeoffs.length > 0));
assert('[G2] each option has upgrades[]',         g2.options.every(o => Array.isArray(o.upgrades) && o.upgrades.length > 0));
assert('[G2] A = hs-mid+kb-pro+ms-pro',           idsOf(oA.items).join('|') === ['hs-mid', 'kb-pro', 'ms-pro'].sort().join('|'), idsOf(oA.items).join('|'));

// ─── G3: use-case filtering — cheaper office keyboard never leaks in ─────────────
console.log('\nG3: goal-fit filtering excludes the cheaper office keyboard\n');
assert('[G3] no option contains kb-office',       g2.options.every(o => !has(o.items, 'kb-office')));
assert('[G3] cheapest option keyboard = kb-lite', has(oC.items, 'kb-lite'), idsOf(oC.items).join('|'));

// ─── G4: balanced option biases hero categories ─────────────────────────────────
console.log('\nG4: balanced invests in hero peripherals, saves on the rest\n');
assert('[G4] B upgrades hero keyboard → kb-pro',  has(oB.items, 'kb-pro'));
assert('[G4] B upgrades hero mouse → ms-pro',     has(oB.items, 'ms-pro'));
assert('[G4] B keeps non-hero headset cheap → hs-lite', has(oB.items, 'hs-lite'));

// ─── G5: infeasible-but-partial — cheapest complete over budget, a core fits ─────
console.log('\nG5: no complete setup fits → over-budget A + within-budget core B\n');
const g5 = generateOptions({ categories: GAMING_CATS, useCase: 'gaming', budget: 7000, catalog, goalType: 'gaming', heroCategories: ['mouse', 'keyboard'] });
assert('[G5] fits = false',                g5.fits === false);
assert('[G5] feasible = true (a core fits)', g5.feasible === true);
assert('[G5] >= 2 options',                g5.options.length >= 2, `len=${g5.options.length}`);
const g5A = g5.options.find(o => o.id === 'A');
const g5B = g5.options.find(o => o.id === 'B');
assert('[G5] A = closest complete, over budget', g5A && g5A.withinBudget === false && g5A.total === 8000, g5A && String(g5A.total));
assert('[G5] B = core within budget',            g5B && g5B.withinBudget === true && g5B.total <= 7000, g5B && String(g5B.total));
assert('[G5] B keeps both hero categories',      g5B && has(g5B.items, 'kb-lite') && has(g5B.items, 'ms-lite'));
assert('[G5] B drops the non-hero headset',      g5B && !g5B.items.some(i => i.category === 'headset'));

// ─── G6: fully infeasible — not even a single item fits → only over-budget A ─────
console.log('\nG6: budget below every product → single honest over-budget option\n');
const g6 = generateOptions({ categories: GAMING_CATS, useCase: 'gaming', budget: 1000, catalog, goalType: 'gaming', heroCategories: ['mouse', 'keyboard'] });
assert('[G6] fits = false',                g6.fits === false);
assert('[G6] feasible = false',            g6.feasible === false);
assert('[G6] exactly 1 option',            g6.options.length === 1, `len=${g6.options.length}`);
assert('[G6] the option is over budget',   g6.options[0].withinBudget === false);

// ─── G7: single-category still generates a coherent (deduped) option ─────────────
console.log('\nG7: single category, premium over budget → one affordable option\n');
const g7 = generateOptions({ categories: ['mouse'], useCase: 'gaming', budget: 5000, catalog, goalType: 'gaming', heroCategories: ['mouse'] });
assert('[G7] fits = false',                g7.fits === false);
assert('[G7] one option after dedupe',     g7.options.length === 1, `len=${g7.options.length}`);
assert('[G7] option = affordable ms-lite', has(g7.options[0].items, 'ms-lite') && g7.options[0].total === 3000, String(g7.options[0].total));

// ═══════════════════════════════════════════════════════════════════════════════
// PART 2 — prepareOptions + selectPurchase + orchestrate({lockedCart})
// ═══════════════════════════════════════════════════════════════════════════════

// Build a goal-enriched intent the way purchaseHandler does, minus the LLM.
function makeIntent(goal, budget, prefs) {
  const intent = { goal, budget, preferences: prefs };
  Object.assign(intent, classifyGoal(intent));
  intent.baselineStrategy = 'goalfit';
  intent.mandate = growthMandateFromIntent(intent, catalog);
  return intent;
}
const merchantPolicy = { max_discount: 60, min_margin: 100 };

// ─── P1: single-item scope → prepareOptions declines (returns null) ──────────────
console.log('\nP1: single-item request never triggers options\n');
_resetPendingOptions(); _resetPending();
const iSingle = makeIntent('a good gaming mouse', 5000, { mouse: 'medium' });
const uSingle = { max_spending: 5000, allowed_categories: iSingle.allowedCategories };
createAudit('tx-p1');
const p1 = prepareOptions(iSingle, uSingle, merchantPolicy, 'tx-p1', catalog);
assert('[P1] scope classified single-item', iSingle.scope === 'single-item', iSingle.scope);
assert('[P1] prepareOptions returns null',   p1 === null);

// ─── P2: ideal fits → prepareOptions declines (normal pipeline runs) ─────────────
console.log('\nP2: setup whose ideal fits budget → no options\n');
const iFits = makeIntent('gaming setup', 25000, { headset: 'medium', keyboard: 'medium', mouse: 'medium' });
const uFits = { max_spending: 25000, allowed_categories: iFits.allowedCategories };
createAudit('tx-p2');
const p2 = prepareOptions(iFits, uFits, merchantPolicy, 'tx-p2', catalog);
assert('[P2] scope classified setup',        iFits.scope === 'setup', iFits.scope);
assert('[P2] prepareOptions returns null',   p2 === null);

// ─── P3: setup over budget → options_required response, stashed ──────────────────
console.log('\nP3: setup over budget → options_required envelope\n');
const iOpt = makeIntent('gaming setup', 19000, { headset: 'medium', keyboard: 'medium', mouse: 'medium' });
const uOpt = { max_spending: 19000, allowed_categories: iOpt.allowedCategories };
createAudit('tx-p3');
const p3 = prepareOptions(iOpt, uOpt, merchantPolicy, 'tx-p3', catalog);
assert('[P3] response returned (not null)',  p3 !== null);
assert('[P3] status = options_required',     p3 && p3.status === 'options_required', p3 && p3.status);
assert('[P3] decision = options_required',   p3 && p3.decision === 'options_required');
assert('[P3] 3 options in envelope',         p3 && p3.options.length === 3, p3 && String(p3.options.length));
assert('[P3] options serialized w/ product', p3 && typeof p3.options[0].items[0].product.id === 'string' && typeof p3.options[0].items[0].price === 'number');
assert('[P3] ideal total present = 21000',   p3 && p3.ideal.total === 21000, p3 && String(p3.ideal.total));
assert('[P3] reasoning mentions budget',      p3 && /budget/i.test(p3.reasoning));
assert('[P3] payment/finalCart null',         p3 && p3.payment === null && p3.finalCart === null);
const p3audit = getAudit('tx-p3');
assert('[P3] options_generated audited',      !!p3audit.entries.find(e => e.step === 'options_generated'));

// ─── P4: select A → pending_confirmation → confirm → paid ────────────────────────
console.log('\nP4: select option A → locked cart → confirm → paid\n');
_setClient(mockRazorpay);
const p4 = await selectPurchase('tx-p3', 'A', catalog);
assert('[P4] status = pending_confirmation', p4.status === 'pending_confirmation', p4.status);
assert('[P4] finalCart total = 18500',       p4.finalCart && p4.finalCart.total === 18500, p4.finalCart && String(p4.finalCart.total));
assert('[P4] finalCart within budget',       p4.finalCart && p4.finalCart.over_budget === false);
assert('[P4] revenue baseline = final (no re-negotiation)', p4.revenue && p4.revenue.baseline === p4.revenue.final);
const p4audit = getAudit('tx-p3');
const selEntry = p4audit.entries.find(e => e.step === 'option_selected');
const cbEntry  = p4audit.entries.find(e => e.step === 'cart_building');
const negEntry = p4audit.entries.find(e => e.step === 'negotiation');
assert('[P4] option_selected audited (A)',   selEntry && selEntry.output.id === 'A');
assert('[P4] cart_building flagged locked',  cbEntry && cbEntry.input.locked === true);
assert('[P4] negotiation skipped (rounds 0)', negEntry && negEntry.output.rounds === 0);
assert('[P4] negotiation carries skip note',  negEntry && /skipped/i.test(negEntry.output.note || ''));
assert('[P4] pending record created',         getPending('tx-p3') !== null);

const p4c = await confirmPurchase('tx-p3');
assert('[P4] confirm → paid',                 p4c.status === 'paid', p4c.status);
assert('[P4] payment order created',          p4c.payment && p4c.payment.orderId === 'order_OPT001');
assert('[P4] pending cleared after charge',   getPending('tx-p3') === null);

const p4again = await selectPurchase('tx-p3', 'A', catalog);
assert('[P4] re-select after consume → not_pending_options', p4again.code === 'not_pending_options', p4again.code);
_resetClient();

// ─── P5: invalid option id is rejected, pending retained for a retry ─────────────
console.log('\nP5: unknown option id rejected; a valid retry still works\n');
_setClient(mockRazorpay);
const iOpt5 = makeIntent('gaming setup', 19000, { headset: 'medium', keyboard: 'medium', mouse: 'medium' });
const uOpt5 = { max_spending: 19000, allowed_categories: iOpt5.allowedCategories };
createAudit('tx-p5');
prepareOptions(iOpt5, uOpt5, merchantPolicy, 'tx-p5', catalog);
const p5bad = await selectPurchase('tx-p5', 'Z', catalog);
assert('[P5] unknown id → invalid_option',    p5bad.code === 'invalid_option', p5bad.code);
assert('[P5] options still pending after bad id', (await (async () => {
  const r = await selectPurchase('tx-p5', 'C', catalog);
  return r.status === 'pending_confirmation';
})()), 'valid retry did not reach pending_confirmation');
assert('[P5] C total = 8000',                 getPending('tx-p5') && getPending('tx-p5').effectiveCart.total === 8000);
_resetClient();

// ─── P6: over-budget option → human-in-the-loop over-budget authorization ────────
// The buyer CONSCIOUSLY picked the over-budget "closest complete setup". The agent
// won't charge it on its own, but the human holder may authorize the overage with an
// explicit acknowledgment. So: select → pending_confirmation (flagged over-budget);
// confirm WITHOUT ack → still refused at containment; confirm WITH ack → paid +
// budget_override audited. A signature-stage failure would still hard-refuse (covered
// by the two-phase suite's tampered-mandate tests).
console.log('\nP6: over-budget pick → held for explicit human authorization, then paid\n');
_setClient(mockRazorpay);
// budget (and thus mandate ceiling) = 7000; user ceiling set high so the SIGNED
// MANDATE gate is the sole blocker we are exercising here.
const iInfeasible = makeIntent('gaming setup', 7000, { headset: 'medium', keyboard: 'medium', mouse: 'medium' });
const uInfeasible = { max_spending: 999999, allowed_categories: iInfeasible.allowedCategories };
createAudit('tx-p6');
const p6prep = prepareOptions(iInfeasible, uInfeasible, merchantPolicy, 'tx-p6', catalog);
assert('[P6] options offered for infeasible setup', p6prep && p6prep.status === 'options_required');
assert('[P6] envelope flags feasible=true (core fits)', p6prep && p6prep.feasible === true);

const p6 = await selectPurchase('tx-p6', 'A', catalog); // A = over-budget complete setup (8000 > 7000)
assert('[P6] over-budget pick → pending_confirmation (not hard-escalated)', p6.status === 'pending_confirmation', p6.status);
assert('[P6] finalCart flagged over budget', p6.finalCart && p6.finalCart.over_budget === true);
assert('[P6] finalCart total exceeds ceiling', p6.finalCart && p6.finalCart.total > 7000, p6.finalCart && String(p6.finalCart.total));
assert('[P6] no payment yet',                 p6.payment == null);
assert('[P6] pending record created',         getPending('tx-p6') !== null);
assert('[P6] reasoning invites over-budget authorization', p6 && /authoriz/i.test(p6.reasoning), p6 && p6.reasoning);
const p6prepAudit = getAudit('tx-p6');
assert('[P6] gate recorded blocked at containment', !!p6prepAudit.entries.find(e => e.step === 'mandate_payment_gate' && e.output.ok === false && e.output.stage === 'containment'));
assert('[P6] awaiting_confirmation flags overBudget', !!p6prepAudit.entries.find(e => e.step === 'awaiting_confirmation' && e.input.overBudget === true));

// Confirm WITHOUT acknowledgment → the human hasn't authorized the overage → refused.
const p6noAck = await confirmPurchase('tx-p6', { items: p6.finalCart.items.map(i => ({ productId: i.product.id })) }, catalog);
assert('[P6] confirm w/o ack → gate_failed',  p6noAck.code === 'gate_failed', p6noAck.code);
assert('[P6] confirm w/o ack → escalated',    p6noAck.status === 'escalated', p6noAck.status);
assert('[P6] confirm w/o ack → no charge',    p6noAck.payment == null);
assert('[P6] pending dropped after refused confirm', getPending('tx-p6') === null);

// Fresh selection, then confirm WITH explicit acknowledgment → paid + audited override.
createAudit('tx-p6ack');
prepareOptions(makeIntentInto(iInfeasible), uInfeasible, merchantPolicy, 'tx-p6ack', catalog);
const p6sel = await selectPurchase('tx-p6ack', 'A', catalog);
assert('[P6] re-select over-budget → pending_confirmation', p6sel.status === 'pending_confirmation', p6sel.status);
const p6ack = await confirmPurchase('tx-p6ack', { items: p6sel.finalCart.items.map(i => ({ productId: i.product.id })), acknowledgeOverBudget: true }, catalog);
assert('[P6] confirm WITH ack → paid',        p6ack.status === 'paid', p6ack.status);
assert('[P6] confirm WITH ack → overridden',  p6ack.overridden === true);
assert('[P6] payment order created',          p6ack.payment && p6ack.payment.orderId === 'order_OPT001');
assert('[P6] pending cleared after charge',   getPending('tx-p6ack') === null);
const p6ackAudit = getAudit('tx-p6ack');
assert('[P6] budget_override audited (buyer)', !!p6ackAudit.entries.find(e => e.step === 'budget_override' && e.output.acknowledgedBy === 'buyer'));

// The within-budget core (B) from the SAME infeasible situation proceeds cleanly.
createAudit('tx-p6b');
prepareOptions(makeIntentInto(iInfeasible), uInfeasible, merchantPolicy, 'tx-p6b', catalog);
const p6b = await selectPurchase('tx-p6b', 'B', catalog);
assert('[P6] within-budget core (B) → pending_confirmation', p6b.status === 'pending_confirmation', p6b.status);
assert('[P6] core cart within mandate ceiling', p6b.finalCart && p6b.finalCart.total <= 7000);
_resetClient();
_resetPendingOptions(); _resetPending();

// helper: fresh copy of an intent so a second prepareOptions doesn't reuse a
// consumed one (intents are plain objects; a shallow clone is enough here).
function makeIntentInto(src) { return { ...src }; }

// ─── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`optionsService.test.js: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

})().catch(err => { console.error('FATAL', err); process.exit(1); });
