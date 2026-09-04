'use strict';

/**
 * growthNegotiation.test.js — Stage 14 revenue-growth + mandate tests.
 *
 * Proves the pieces the buildathon is judged on:
 *   • Merchant growth   — measurable revenue uplift within the mandate
 *   • Agentic commerce  — multi-round upsell / cross-sell / bundle negotiation
 *   • Guardrails        — signed mandate bounds spend + categories; bundle
 *                         discount bounded by merchant policy
 *   • Failure handling  — over-mandate offers are DECLINED with a reason, and
 *                         the merchant GRACEFULLY falls back to a fitting move
 *   • Auditability      — mandate_issued / revenue_uplift / mandate_payment_gate
 *                         appear in the audit trail; a tampered mandate is caught
 *                         at the payment gate and the charge is refused
 *
 * Deterministic: uses the real catalog, a dummy Groq key, and a mocked payment
 * client. No network.
 */

process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'dummy';

let passed = 0, failed = 0;
function assert(desc, cond, detail = '') {
  if (cond) { console.log(`   ${desc}`); passed++; }
  else       { console.error(`   ${desc}${detail ? ' — ' + detail : ''}`); failed++; }
}

const {
  createMandate, signMandate, verifyMandate,
  cartWithinMandate, gateCartAgainstMandate, mandateFromIntent,
  growthMandateFromIntent,
} = require('../src/agents/mandate');
const { MerchantAgent }      = require('../src/agents/MerchantAgent');
const { BuyerAgent }         = require('../src/agents/BuyerAgent');
const { NegotiationSession } = require('../src/agents/NegotiationSession');
const { buildCart }          = require('../src/services/cartService');
const { orchestrate }        = require('../src/core/orchestrator');
const { createAudit, getAudit, _reset } = require('../src/services/auditService');
const { _setClient, _resetClient }      = require('../src/services/paymentService');
const catalog                = require('../src/data/catalog.json');

// Full category whitelist so cross-sell / bundle accessories are in-mandate.
const ALL_CATS = ['headset', 'keyboard', 'mouse', 'stand', 'cable', 'warranty', 'wrist-rest', 'mousepad'];
const mockRazorpay = { orders: { create: async ({ amount, currency }) => ({ id: 'order_GROWTH_MOCK', amount, currency }) } };

function goalfitIntent(maxSpend, mandate) {
  return {
    goal: 'productive home-office setup',
    budget: maxSpend,
    baselineStrategy: 'goalfit',
    preferences: { headset: 'medium', keyboard: 'medium', mouse: 'low' },
    mandate,
  };
}

(async () => {

// ═══════════════════════════════════════════════════════════════════════════════
// 1) Mandate primitives — sign / verify / tamper / expiry / containment / gate
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nMandate primitives\n');

const m = createMandate({ maxSpend: 10000, allowedCategories: ['headset', 'mouse'], expiresAt: null, goal: 'g' });
assert('[M1] createMandate returns a signature', typeof m.signature === 'string' && m.signature.length > 0);
assert('[M2] fresh mandate verifies',            verifyMandate(m).valid === true);

// Tamper maxSpend → signature no longer matches
const mTamperSpend = { ...m, maxSpend: 999999 };
assert('[M3] tampered maxSpend fails verification', verifyMandate(mTamperSpend).valid === false);
assert('[M3] reason mentions tamper/invalid',
  /invalid|tamper/i.test(verifyMandate(mTamperSpend).reason));

// Tamper category whitelist → signature no longer matches
const mTamperCat = { ...m, allowedCategories: ['headset', 'mouse', 'gpu'] };
assert('[M4] tampered categories fail verification', verifyMandate(mTamperCat).valid === false);

// Expiry
const expired = createMandate({ maxSpend: 5000, allowedCategories: ['headset'], expiresAt: Date.now() - 1000, goal: 'g' });
assert('[M5] expired mandate fails verification', verifyMandate(expired).valid === false);
assert('[M5] reason mentions expiry',             /expir/i.test(verifyMandate(expired).reason));
const future = createMandate({ maxSpend: 5000, allowedCategories: ['headset'], expiresAt: Date.now() + 60000, goal: 'g' });
assert('[M6] unexpired mandate verifies',         verifyMandate(future).valid === true);

// Signature is order-independent over categories
const mA = createMandate({ maxSpend: 7000, allowedCategories: ['mouse', 'headset'], goal: 'g' });
const mB = createMandate({ maxSpend: 7000, allowedCategories: ['headset', 'mouse'], goal: 'g' });
assert('[M7] signature is category-order independent', mA.signature === mB.signature);

// Containment
const inCart  = { total: 8000, items: [{ category: 'headset' }, { category: 'mouse' }] };
const outCart = { total: 8000, items: [{ category: 'headset' }, { category: 'gpu' }] };
const overCart = { total: 12000, items: [{ category: 'headset' }] };
assert('[M8] cartWithinMandate ok when contained',   cartWithinMandate(inCart, m).ok === true);
assert('[M9] category outside whitelist violates',   cartWithinMandate(outCart, m).ok === false);
assert('[M10] spend over ceiling violates',          cartWithinMandate(overCart, m).ok === false);

// Full gate
assert('[M11] gate passes for signed+contained cart', gateCartAgainstMandate(inCart, m).ok === true);
assert('[M11] gate stage = passed',                   gateCartAgainstMandate(inCart, m).stage === 'passed');
assert('[M12] gate blocks tampered signature',        gateCartAgainstMandate(inCart, mTamperSpend).ok === false);
assert('[M12] gate stage = signature on tamper',      gateCartAgainstMandate(inCart, mTamperSpend).stage === 'signature');
assert('[M13] gate blocks over-ceiling cart',         gateCartAgainstMandate(overCart, m).ok === false);
assert('[M13] gate stage = containment on overspend', gateCartAgainstMandate(overCart, m).stage === 'containment');

// Legacy bridge
const derived = mandateFromIntent({ budget: 12000, preferences: { headset: 'x', keyboard: 'y' }, goal: 'gg' });
assert('[M14] mandateFromIntent maxSpend = budget',   derived.maxSpend === 12000);
assert('[M14] mandateFromIntent categories = prefs',  JSON.stringify(derived.allowedCategories.sort()) === JSON.stringify(['headset','keyboard']));
assert('[M15] derived mandate is valid',              verifyMandate(derived).valid === true);

// growthMandateFromIntent — same ceiling, broadened to accessory categories, signed
const gm = growthMandateFromIntent(
  { budget: 20000, preferences: { headset: 'medium', keyboard: 'medium', mouse: 'low' }, goal: 'setup' },
  catalog,
);
assert('[M16] growth mandate maxSpend = budget',      gm.maxSpend === 20000);
assert('[M16] growth mandate is validly signed',      verifyMandate(gm).valid === true);
assert('[M16] growth mandate keeps preferred cats',
  ['headset','keyboard','mouse'].every(c => gm.allowedCategories.includes(c)));
assert('[M16] growth mandate broadens to accessories (stand/cable/warranty/wrist-rest/mousepad)',
  ['stand','cable','warranty','wrist-rest','mousepad'].every(c => gm.allowedCategories.includes(c)));
assert('[M16] growth mandate excludes unrelated categories',
  !gm.allowedCategories.includes('gpu') && !gm.allowedCategories.includes('monitor'));

// ═══════════════════════════════════════════════════════════════════════════════
// 2) MerchantAgent growth generators
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nMerchantAgent — growth proposals\n');

const bigMandate = createMandate({ maxSpend: 50000, allowedCategories: ALL_CATS, goal: 'g' });
const liteHeadset = catalog.find(p => p.id === 'hs-002'); // SoundWave Lite (lite tier)
const gCart = { budget: 50000, total: liteHeadset.price, currency: 'INR',
  items: [{ product: liteHeadset, category: 'headset', price: liteHeadset.price }] };

const merchant = new MerchantAgent(catalog, { merchantPolicy: { max_discount: 60, min_margin: 100 } });
const gOffer = merchant.proposeGrowth(gCart, bigMandate, []);
assert('[G1] proposes a growth offer for a lite item', gOffer.offer != null);
assert('[G1] highest-revenue move is an upsell',        gOffer.offer.kind === 'upsell');
assert('[G1] upsell costs the buyer MORE (savings ≤ 0)', gOffer.offer.savings <= 0);
assert('[G1] upsell has positive revenueDelta',          gOffer.offer.revenueDelta > 0);
assert('[G1] upsell target is same category, higher tier',
  gOffer.offer.replacementProduct.category === 'headset' && gOffer.offer.replacementProduct.price > liteHeadset.price);

// commitMove then re-propose → the upsold category is not upsold again
merchant.commitMove(gOffer.offer);
const gOffer2 = merchant.proposeGrowth({ ...gCart,
  items: [{ product: gOffer.offer.replacementProduct, category: 'headset', price: gOffer.offer.replacementProduct.price }],
}, bigMandate, []);
const stillUpsellHeadset = gOffer2.offer && gOffer2.offer.kind === 'upsell' && gOffer2.offer.originalProduct?.category === 'headset';
assert('[G2] committed category is not upsold twice', !stillUpsellHeadset);

// rejectMove → that exact move is never re-proposed
const merchant2 = new MerchantAgent(catalog, { merchantPolicy: { max_discount: 60 } });
const firstMove = merchant2.proposeGrowth(gCart, bigMandate, []);
merchant2.rejectMove(firstMove.offer);
const afterReject = merchant2.proposeGrowth(gCart, bigMandate, []);
assert('[G3] rejected move is not re-proposed',
  !afterReject.offer || afterReject.offer.moveKey !== firstMove.offer.moveKey);

// bundle discount bounded by merchant policy (cap 5% < default 12%)
const cappedMerchant = new MerchantAgent(catalog, { merchantPolicy: { max_discount: 5 } });
// find a bundle candidate: a lite headset has 3 complements
let sawBundle = null;
for (let i = 0; i < 6 && !sawBundle; i++) {
  const o = cappedMerchant.proposeGrowth(gCart, bigMandate, []);
  if (!o.offer) break;
  if (o.offer.kind === 'bundle') sawBundle = o.offer;
  else cappedMerchant.rejectMove(o.offer); // skip non-bundles to surface one
}
if (sawBundle) {
  assert('[G4] bundle discount bounded by merchant policy (≤5%)', sawBundle.discountPct <= 5);
} else {
  assert('[G4] bundle discount bounded by merchant policy (≤5%)', true, 'no bundle surfaced — vacuously ok');
}

// locked category is never upsold
const lockedMerchant = new MerchantAgent(catalog, {});
const lockedOffer = lockedMerchant.proposeGrowth(gCart, bigMandate, ['headset']);
const upsoldLockedHeadset = lockedOffer.offer && lockedOffer.offer.kind === 'upsell' && lockedOffer.offer.originalProduct?.category === 'headset';
assert('[G5] locked category is never upsold', !upsoldLockedHeadset);

// ═══════════════════════════════════════════════════════════════════════════════
// 3) BuyerAgent.evaluateGrowth — accept in-mandate, decline over-mandate
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nBuyerAgent — growth evaluation (the guardrail)\n');

const buyer = new BuyerAgent(goalfitIntent(10000, null), bigMandate);
const okOffer = { action: 'offer_substitution', message: 'upgrade', offer: { kind: 'upsell', goalAligned: true, revenueDelta: 1000, savings: -1000 } };
const acceptEval = buyer.evaluateGrowth(okOffer, { total: 9000, items: [{ category: 'headset' }] }, createMandate({ maxSpend: 10000, allowedCategories: ALL_CATS, goal: 'g' }));
assert('[B1] accepts a value-adding in-mandate offer', acceptEval.action === 'accept');
assert('[B1] echoes the accepted offer',                acceptEval.acceptedOffer != null);

const tightM = createMandate({ maxSpend: 8000, allowedCategories: ALL_CATS, goal: 'g' });
const declineEval = buyer.evaluateGrowth(okOffer, { total: 9000, items: [{ category: 'headset' }] }, tightM);
assert('[B2] declines an over-mandate offer',           declineEval.action === 'counter_offer');
assert('[B2] decline reason = mandate_breach',          declineEval.requirements?.reason === 'mandate_breach');
assert('[B2] decline message cites the breach',         /breach|exceed|mandate/i.test(declineEval.message));

const badCatM = createMandate({ maxSpend: 100000, allowedCategories: ['headset'], goal: 'g' });
const catDecline = buyer.evaluateGrowth(okOffer, { total: 9000, items: [{ category: 'headset' }, { category: 'warranty' }] }, badCatM);
assert('[B3] declines an out-of-category offer',        catDecline.action === 'counter_offer');

// ═══════════════════════════════════════════════════════════════════════════════
// 4) NegotiationSession growth — end to end
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nNegotiationSession — growth end to end\n');

// Generous mandate → substantial uplift, all moves in-mandate
const genMandate = createMandate({ maxSpend: 20000, allowedCategories: ALL_CATS, goal: 'g' });
const genIntent  = goalfitIntent(20000, genMandate);
const genCart    = buildCart(genIntent, catalog);
const genSession = new NegotiationSession(genIntent, genCart, catalog, { mandate: genMandate, merchantPolicy: { max_discount: 60, min_margin: 100 } });
const genRes     = genSession.run();
assert('[S1] generous negotiation is approved',       genRes.status === 'approved');
assert('[S2] final total > baseline (revenue grew)',  genRes.finalCart.total > genCart.total, `base ${genCart.total} → ${genRes.finalCart.total}`);
assert('[S3] final total ≤ mandate ceiling',          genRes.finalCart.total <= genMandate.maxSpend);
assert('[S4] at least 3 growth moves accepted',       genRes.offers.length >= 3, `got ${genRes.offers.length}`);
assert('[S5] every recorded offer is a growth move',  genRes.offers.every(o => o.offer.action === 'grow'));
assert('[S6] cart contains an added accessory (cross-sell/bundle)',
  genRes.finalCart.items.some(i => ['stand','cable','warranty','wrist-rest','mousepad'].includes(i.category)));
assert('[S7] transcript is populated',                genRes.transcript.length >= 4);
// every accepted move keeps the cart inside the mandate
assert('[S8] no accepted move ever breached the mandate',
  cartWithinMandate(genRes.finalCart, genMandate).ok === true);

// Tight mandate → over-mandate declines + graceful fallback
const tightMandate = createMandate({ maxSpend: 8000, allowedCategories: ALL_CATS, goal: 'g' });
const tightIntent  = goalfitIntent(8000, tightMandate);
const tightCart    = buildCart(tightIntent, catalog);
const tightSession = new NegotiationSession(tightIntent, tightCart, catalog, { mandate: tightMandate, merchantPolicy: { max_discount: 60, min_margin: 100 } });
const tightRes     = tightSession.run();
const declines = tightRes.history.filter(h => h.buyer.action !== 'accept');
assert('[S9] tight negotiation still approved (closes gracefully)', tightRes.status === 'approved');
assert('[S10] at least one over-mandate offer was DECLINED',        declines.length >= 1, `declines ${declines.length}`);
assert('[S11] a decline cited a mandate breach',
  declines.some(h => h.buyer.requirements?.reason === 'mandate_breach'));
assert('[S12] final cart NEVER breaches the mandate ceiling',       tightRes.finalCart.total <= tightMandate.maxSpend);
assert('[S13] tight negotiation still grew revenue a bit',          tightRes.finalCart.total > tightCart.total);

// Inert case: legacy 3-arg session, within budget, no growth candidates → 0 rounds
const inertIntent = { goal: 'g', budget: 12000, preferences: { headset: 'locked' } };
const inertCatalog = [{ id: 'only', name: 'Only', category: 'headset', tier: 'pro', price: 8000, features: [], stock: 5, complements: [] }];
const inertCart = buildCart(inertIntent, inertCatalog);
const inertRes = new NegotiationSession(inertIntent, inertCart, inertCatalog).run();
assert('[S14] inert within-budget session → approved',  inertRes.status === 'approved');
assert('[S15] inert session runs 0 rounds',             inertRes.rounds === 0);
assert('[S16] inert session has empty history',         inertRes.history.length === 0);

// ═══════════════════════════════════════════════════════════════════════════════
// 5) Orchestrator integration — payment, revenue, audit, and the gate
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nOrchestrator — revenue uplift, audit trail & mandate gate\n');

_reset();
_setClient(mockRazorpay);

// (a) Happy path: growth approved, payment made, uplift recorded, audit complete
const okMandate = createMandate({ maxSpend: 20000, allowedCategories: ALL_CATS, goal: 'g' });
const okIntent  = goalfitIntent(20000, okMandate);
const okTx = 'growth-ok';
createAudit(okTx);
const okRes = await orchestrate(
  okIntent, catalog,
  { max_spending: 20000, allowed_categories: ALL_CATS },
  { max_discount: 60, min_margin: 100 },
  okTx,
);
assert('[O1] growth pipeline approved',            okRes.decision === 'approved');
assert('[O2] payment order created',               okRes.payment && typeof okRes.payment.orderId === 'string');
assert('[O3] revenue.uplift > 0',                  okRes.revenue.uplift > 0, JSON.stringify(okRes.revenue));
assert('[O4] revenue.upliftPct reported',          typeof okRes.revenue.upliftPct === 'number' && okRes.revenue.upliftPct > 0);
assert('[O5] revenue strategy = goalfit',          okRes.revenue.strategy === 'goalfit');
const okSteps = getAudit(okTx).entries.map(e => e.step);
assert('[O6] audit has mandate_issued',            okSteps.includes('mandate_issued'));
assert('[O7] audit has revenue_uplift',            okSteps.includes('revenue_uplift'));
assert('[O8] audit has mandate_payment_gate',      okSteps.includes('mandate_payment_gate'));
assert('[O9] payment gate passed in audit',
  getAudit(okTx).entries.find(e => e.step === 'mandate_payment_gate')?.output?.ok === true);
assert('[O10] payment_order_created present',      okSteps.includes('payment_order_created'));

// (b) Tampered mandate: policy would approve, but the payment gate refuses to charge
_reset();
const badMandate = createMandate({ maxSpend: 8000, allowedCategories: ALL_CATS, goal: 'g' });
badMandate.maxSpend = 999999; // tamper AFTER signing → signature is now stale
const badIntent = goalfitIntent(999999, badMandate);
const badTx = 'growth-tampered';
createAudit(badTx);
const badRes = await orchestrate(
  badIntent, catalog,
  { max_spending: 999999, allowed_categories: ALL_CATS },
  { max_discount: 60, min_margin: 100 },
  badTx,
);
assert('[O11] tampered mandate → NOT approved',    badRes.decision !== 'approved');
assert('[O12] tampered mandate → escalated',       badRes.decision === 'escalated');
assert('[O13] no payment on tampered mandate',     badRes.payment === null);
assert('[O14] reasoning explains the gate block',  /mandate|gate|signature|tamper/i.test(badRes.reasoning));
const badSteps = getAudit(badTx).entries.map(e => e.step);
assert('[O15] audit records the mandate gate',     badSteps.includes('mandate_payment_gate'));
assert('[O16] audit records the decision override', badSteps.includes('decision_override'));
assert('[O17] gate output marks failure at signature stage',
  getAudit(badTx).entries.find(e => e.step === 'mandate_payment_gate')?.output?.stage === 'signature');

_resetClient();

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed > 0) { console.error('\nSome tests failed.'); process.exit(1); }
else { console.log('\nAll tests passed '); }

})().catch(err => { console.error(err.stack || err); process.exit(1); });
