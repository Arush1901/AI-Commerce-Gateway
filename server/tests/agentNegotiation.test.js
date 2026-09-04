'use strict';

/**
 * agentNegotiation.test.js — Stage 13 agent framework unit tests.
 *
 * Tests BuyerAgent, MerchantAgent, NegotiationSession, and agentSchemas
 * in isolation and integrated. All use deterministic catalog fixtures.
 */

let passed = 0, failed = 0;
function assert(desc, cond, detail = '') {
  if (cond) { console.log(`   ${desc}`); passed++; }
  else       { console.error(`   ${desc}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ─── catalog fixture ──────────────────────────────────────────────────────────
const catalog = [
  { id: 'hs-pro',    name: 'Headset Pro',      category: 'headset',  tier: 'pro',    price: 9000, features: [], stock: 10 },
  { id: 'hs-office', name: 'Headset Office',   category: 'headset',  tier: 'office', price: 6000, features: [], stock: 44 },
  { id: 'hs-lite',   name: 'Headset Lite',     category: 'headset',  tier: 'lite',   price: 2999, features: [], stock: 20 },
  { id: 'kb-office', name: 'Keyboard Office',  category: 'keyboard', tier: 'office', price: 3500, features: [], stock: 85 },
  { id: 'kb-lite',   name: 'Keyboard Lite',    category: 'keyboard', tier: 'lite',   price: 1999, features: [], stock: 200 },
  { id: 'ms-office', name: 'Mouse Office',     category: 'mouse',    tier: 'office', price: 2000, features: [], stock: 90 },
  { id: 'ms-lite',   name: 'Mouse Lite',       category: 'mouse',    tier: 'lite',   price:  799, features: [], stock: 300 },
];

const makeCart = (budget, items) => ({
  items, budget, currency: 'INR',
  total: items.reduce((s, i) => s + i.price, 0),
  over_budget: items.reduce((s, i) => s + i.price, 0) > budget,
});

const cartWithinBudget = makeCart(12000, [
  { product: catalog[1], category: 'headset',  price: 6000 },
  { product: catalog[3], category: 'keyboard', price: 3500 },
  { product: catalog[5], category: 'mouse',    price: 2000 },
]);
const cartOverBudget = makeCart(8000, [
  { product: catalog[1], category: 'headset',  price: 6000 },
  { product: catalog[3], category: 'keyboard', price: 3500 },
  { product: catalog[5], category: 'mouse',    price: 2000 },
]);
const impossibleCart = makeCart(1000, [
  { product: catalog[1], category: 'headset',  price: 6000 },
  { product: catalog[3], category: 'keyboard', price: 3500 },
  { product: catalog[5], category: 'mouse',    price: 2000 },
]);

// ─── imports ──────────────────────────────────────────────────────────────────
const { validateBuyerAction, validateMerchantOffer, BUYER_ACTIONS, MERCHANT_ACTIONS } =
  require('../src/agents/agentSchemas');
const { BuyerAgent }        = require('../src/agents/BuyerAgent');
const { MerchantAgent }     = require('../src/agents/MerchantAgent');
const { NegotiationSession } = require('../src/agents/NegotiationSession');

(async () => {

// ═══════════════════════════════════════════════════════════════════════════════
// agentSchemas
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nagentSchemas — validation layer\n');

assert('[Schema-1] BUYER_ACTIONS has 5 entries',     BUYER_ACTIONS.length === 5);
assert('[Schema-2] MERCHANT_ACTIONS has 5 entries',  MERCHANT_ACTIONS.length === 5);

assert('[Schema-3] valid BuyerAction passes',
  validateBuyerAction({ action: 'accept', message: 'ok', requirements: null, acceptedOffer: null }) === null);

assert('[Schema-4] BuyerAction — bad action rejected',
  validateBuyerAction({ action: 'approve', message: 'ok', requirements: null, acceptedOffer: null }) !== null);

assert('[Schema-5] BuyerAction — empty message rejected',
  validateBuyerAction({ action: 'accept', message: '', requirements: null, acceptedOffer: null }) !== null);

assert('[Schema-6] valid MerchantOffer passes',
  validateMerchantOffer({ action: 'reject_request', message: 'no offer', offer: null }) === null);

assert('[Schema-7] MerchantOffer — bad action rejected',
  validateMerchantOffer({ action: 'substitute', message: 'x', offer: null }) !== null);

assert('[Schema-8] MerchantOffer — offer without replacementProduct rejected',
  validateMerchantOffer({ action: 'offer_substitution', message: 'x', offer: { savings: 100 } }) !== null);

// ═══════════════════════════════════════════════════════════════════════════════
// BuyerAgent
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nBuyerAgent\n');

const intentLocked = { goal: 'gaming', budget: 8000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } };
const intentOpen   = { goal: 'gaming', budget: 8000, preferences: { headset: 'medium', keyboard: 'medium', mouse: 'low' } };

const buyer = new BuyerAgent(intentLocked);

// C1 — accepts when already within budget.
// cartWithinBudget totals ₹11,500, so the buyer's own budget must cover it.
// intentLocked.budget is ₹8,000 (used by C2–C4 below), which would leave the
// cart ₹3,500 over budget — so C1 uses a dedicated ₹12,000 buyer, matching the
// budget the C9 NegotiationSession test pairs with this same cart fixture.
const buyerWithinBudget = new BuyerAgent(
  { goal: 'gaming', budget: 12000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } }
);
const openingWithin = buyerWithinBudget.openingStatement(cartWithinBudget);
assert('[BuyerAgent-C1] accept when within budget',  openingWithin.action === 'accept');
assert('[BuyerAgent-C1] message is string',          typeof openingWithin.message === 'string');

// C2 — counter_offer when over budget
const openingOver = buyer.openingStatement(cartOverBudget);
assert('[BuyerAgent-C2] counter_offer when over budget',    openingOver.action === 'counter_offer');
assert('[BuyerAgent-C2] requirements.maxTotal = budget',    openingOver.requirements.maxTotal === 8000);
assert('[BuyerAgent-C2] lockedItems includes headset',      openingOver.requirements.lockedItems.includes('headset'));
assert('[BuyerAgent-C2] requiredReduction = 3500',          openingOver.requirements.requiredReduction === 3500);

// C3 — rejects offer that touches locked item
const lockViolatingOffer = {
  action: 'offer_substitution',
  message: 'Replace headset.',
  offer: {
    originalProductId: 'hs-office', replacementProductId: 'hs-lite',
    originalProduct: catalog[1], replacementProduct: catalog[2],
    savings: 3001, reason: 'test',
  },
};
// Cart after applying this offer would still not meet budget; but lock violation is checked first
const cartAfterLockViolation = makeCart(8000, [
  { product: catalog[2], category: 'headset',  price: 2999 }, // hs-lite applied
  { product: catalog[3], category: 'keyboard', price: 3500 },
  { product: catalog[5], category: 'mouse',    price: 2000 },
]);
const evalLock = buyer.evaluate(lockViolatingOffer, cartAfterLockViolation, false);
assert('[BuyerAgent-C3] rejects lock violation',     evalLock.action === 'reject');
assert('[BuyerAgent-C3] message mentions locked item', evalLock.message.toLowerCase().includes('lock'));

// C4 — escalates when merchant has no offer (reject_request)
const noOfferMsg = { action: 'reject_request', message: 'nothing available', offer: null };
const evalNoOffer = buyer.evaluate(noOfferMsg, cartOverBudget, false);
assert('[BuyerAgent-C4] escalates on reject_request',  evalNoOffer.action === 'escalate');

// C5 — accepts when cart meets budget after offer
const validOffer = {
  action: 'offer_substitution',
  message: 'Replace keyboard.',
  offer: {
    originalProductId: 'kb-office', replacementProductId: 'kb-lite',
    originalProduct: catalog[3], replacementProduct: catalog[4],
    savings: 1501, reason: 'test',
  },
};
const cartMeetsBudget = makeCart(8000, [
  { product: catalog[1], category: 'headset',  price: 6000 },
  { product: catalog[4], category: 'keyboard', price: 1999 }, // kb-lite
  { product: catalog[5], category: 'mouse',    price: 2000 }, // still? wait 6000+1999+2000=9999 > 8000
]);
// Actually total = 6000+1999+2000=9999. Not within 8000. Let me use a different budget:
// Let's say budget=10000 for this sub-test
const buyerOpen = new BuyerAgent({ goal: 'g', budget: 10000, preferences: { headset: 'locked' } });
const cartMetBudget = makeCart(10000, [
  { product: catalog[1], category: 'headset',  price: 6000 },
  { product: catalog[4], category: 'keyboard', price: 1999 },
  { product: catalog[5], category: 'mouse',    price: 2000 },
]); // total=9999 within 10000
const evalAccept = buyerOpen.evaluate(validOffer, cartMetBudget, false);
assert('[BuyerAgent-C5] accepts when budget met',      evalAccept.action === 'accept');
assert('[BuyerAgent-C5] acceptedOffer is set',         evalAccept.acceptedOffer !== null);

// ═══════════════════════════════════════════════════════════════════════════════
// MerchantAgent
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nMerchantAgent\n');

const intentM = { goal: 'gaming', budget: 8000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } };
const buyerActionOpen = {
  action: 'counter_offer',
  message: 'Need reduction.',
  requirements: { maxTotal: 8000, lockedItems: ['headset'], requiredReduction: 3500 },
  acceptedOffer: null,
};

// C6 — skips locked items and offers keyboard substitution
const merchant1 = new MerchantAgent(catalog);
const resp1 = merchant1.respond(buyerActionOpen, cartOverBudget, []);
assert('[MerchantAgent-C6] action = offer_substitution',        resp1.action === 'offer_substitution');
assert('[MerchantAgent-C6] offer has replacementProduct',       resp1.offer?.replacementProduct != null);
assert('[MerchantAgent-C6] savings > 0',                        resp1.offer?.savings > 0);
assert('[MerchantAgent-C6] does not substitute headset',
  resp1.offer?.originalProduct?.category !== 'headset');

// C7 — skips already-substituted category in round 2
const merchant2 = new MerchantAgent(catalog);
merchant2.respond(buyerActionOpen, cartOverBudget, []);                  // round 1 → keyboard substituted
const cartR2 = makeCart(8000, [
  { product: catalog[1], category: 'headset',  price: 6000 },
  { product: catalog[4], category: 'keyboard', price: 1999 }, // kb-lite already applied
  { product: catalog[5], category: 'mouse',    price: 2000 },
]);
const resp2 = merchant2.respond(buyerActionOpen, cartR2, [{}]);          // round 2 — keyboard blocked
assert('[MerchantAgent-C7] second offer is NOT keyboard',
  resp2.offer?.originalProduct?.category !== 'keyboard', resp2.offer?.originalProduct?.category);
assert('[MerchantAgent-C7] second action is still offer_substitution or reject',
  ['offer_substitution','reject_request','final_offer'].includes(resp2.action));

// C8 — returns reject_request when nothing can be substituted
const fullLockedBuyerAction = {
  action: 'counter_offer', message: 'all locked',
  requirements: { maxTotal: 0, lockedItems: ['headset','keyboard','mouse'], requiredReduction: 9999 },
  acceptedOffer: null,
};
const merchant3 = new MerchantAgent(catalog);
const resp3 = merchant3.respond(fullLockedBuyerAction, cartOverBudget, []);
assert('[MerchantAgent-C8] reject_request when all locked',  resp3.action === 'reject_request');
assert('[MerchantAgent-C8] offer is null',                   resp3.offer === null);

// ═══════════════════════════════════════════════════════════════════════════════
// NegotiationSession
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nNegotiationSession\n');

// C9 — approved immediately when cart is within budget
const sess9 = new NegotiationSession(
  { goal: 'gaming', budget: 12000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } },
  cartWithinBudget, catalog
);
const r9 = sess9.run();
assert('[Session-C9] approved immediately when within budget',  r9.status === 'approved');
assert('[Session-C9] rounds = 0',                               r9.rounds === 0);
assert('[Session-C9] transcript is array',                      Array.isArray(r9.transcript));
assert('[Session-C9] history is empty array',                   Array.isArray(r9.history) && r9.history.length === 0);
assert('[Session-C9] finalAgreement not null',                  r9.finalAgreement !== null);

// C10 — approved after 1 round
const sess10 = new NegotiationSession(
  { goal: 'gaming', budget: 10000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } },
  cartOverBudget, catalog   // cartOverBudget total=11500 > budget=10000 but keyboard sub gives ₹9999
);
const r10 = sess10.run();
assert('[Session-C10] approved after substitution',  r10.status === 'approved');
assert('[Session-C10] rounds = 1',                   r10.rounds === 1, `got ${r10.rounds}`);
assert('[Session-C10] history has 1 entry',          r10.history.length === 1);
assert('[Session-C10] transcript has ≥ 3 lines',     r10.transcript.length >= 3);
assert('[Session-C10] finalCart.total ≤ 10000',      r10.finalCart.total <= 10000, `got ${r10.finalCart.total}`);
assert('[Session-C10] offers[0].offer.action = substitute', r10.offers[0]?.offer?.action === 'substitute');
assert('[Session-C10] finalAgreement.acceptedOffer set',    r10.finalAgreement?.acceptedOffer != null);

// C11 — escalation after exhausting all substitutions
const sess11 = new NegotiationSession(
  { goal: 'gaming', budget: 1000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } },
  impossibleCart, catalog
);
const r11 = sess11.run();
assert('[Session-C11] escalation when budget impossible',  r11.status === 'escalation_needed');
assert('[Session-C11] gap > 0',                           r11.gap > 0, `gap=${r11.gap}`);
assert('[Session-C11] effectiveCart present',             r11.effectiveCart != null);
assert('[Session-C11] effectiveCart.total < original',    r11.effectiveCart.total < impossibleCart.total);
assert('[Session-C11] rounds = 2 (keyboard + mouse subs)',r11.rounds === 2, `got ${r11.rounds}`);
assert('[Session-C11] history.length = 3',               r11.history.length === 3, `got ${r11.history.length}`);
assert('[Session-C11] finalAgreement = null',             r11.finalAgreement === null);
assert('[Session-C11] transcript non-empty',              r11.transcript.length > 0);
assert('[Session-C11] history[0] has round/buyer/merchant',
  r11.history[0]?.round === 1 && r11.history[0]?.buyer != null && r11.history[0]?.merchant != null);

// C12 — result is backward-compatible with orchestrator shape
assert('[Session-C12] r11 has status',           typeof r11.status === 'string');
assert('[Session-C12] r11 has offers array',     Array.isArray(r11.offers));
assert('[Session-C12] r11 has rounds number',    typeof r11.rounds === 'number');
assert('[Session-C12] r11 has best_offer',       'best_offer' in r11);
assert('[Session-C12] r11 has gap',              'gap' in r11);
assert('[Session-C12] r10 has finalCart',        'finalCart' in r10);
assert('[Session-C12] r11 has effectiveCart',    'effectiveCart' in r11);
assert('[Session-C12] JSON serializable',
  (() => { try { JSON.stringify(r11); return true; } catch { return false; } })());

// C13 — one-substitution-per-item guard still enforced
const cats = r11.offers.map(({offer}) => offer.replacement.category);
const uniqueCats = new Set(cats);
assert('[Session-C13] no category substituted twice', cats.length === uniqueCats.size,
  `cats: ${cats.join(',')}`);

// C14 — transcript format is "[Round N] Speaker: message"
for (const line of r11.transcript) {
  assert('[Session-C14] transcript line matches pattern',
    /^\[Round \d+\] (Buyer|Merchant): .+/.test(line), line);
  break; // just check first line
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed > 0) { console.error('\nSome tests failed.'); process.exit(1); }
else { console.log('\nAll tests passed '); }

})().catch(err => { console.error(err.stack); process.exit(1); });
