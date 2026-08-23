'use strict';

const { buyerAgent }    = require('./buyerAgent');
const { merchantAgent } = require('./merchantAgent');
const { negotiate, applyOffer } = require('./negotiationService');

// ─── assert harness ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(desc, condition, detail = '') {
  if (condition) { console.log(`  ✅  ${desc}`); passed++; }
  else { console.error(`  ❌  ${desc}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ─── fixtures (same as Stage 5) ───────────────────────────────────────────────
const intent = {
  goal: 'gaming setup',
  budget: 10000,
  preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' },
};

const products = {
  headset:         { id: 'hs-office', name: 'Headset Office',  category: 'headset',  tier: 'office', price: 6000, features: [], stock: 44 },
  keyboard_office: { id: 'kb-office', name: 'Keyboard Office', category: 'keyboard', tier: 'office', price: 3500, features: [], stock: 85 },
  keyboard_lite:   { id: 'kb-lite',   name: 'Keyboard Lite',   category: 'keyboard', tier: 'lite',   price: 1999, features: [], stock: 200 },
  mouse_office:    { id: 'ms-office', name: 'Mouse Office',    category: 'mouse',    tier: 'office', price: 2000, features: [], stock: 90 },
  mouse_lite:      { id: 'ms-lite',   name: 'Mouse Lite',      category: 'mouse',    tier: 'lite',   price:  799, features: [], stock: 300 },
};

const cart = {
  items: [
    { product: products.headset,         category: 'headset',  price: 6000 },
    { product: products.keyboard_office, category: 'keyboard', price: 3500 },
    { product: products.mouse_office,    category: 'mouse',    price: 2000 },
  ],
  total: 11500, budget: 10000, currency: 'INR', over_budget: true,
};

const catalog = Object.values(products);

// ─── Test 1: buyerAgent (unchanged from Stage 5) ─────────────────────────────
console.log('\n🧑 buyerAgent — tests\n');

const request = buyerAgent.request(cart, intent);
assert('action encodes overage',                request.action === 'reduce_cost_by_1500');
assert('budget_limit = intent.budget',          request.budget_limit === 10000);
assert('headset in protected_items',            request.protected_items.includes('headset'));
assert('keyboard NOT protected',                !request.protected_items.includes('keyboard'));

// ─── Test 2: merchantAgent (unchanged from Stage 5) ──────────────────────────
console.log('\n🏪 merchantAgent — tests\n');

const offer = merchantAgent.respond(request, cart, catalog);
assert('action = substitute',                   offer.action === 'substitute');
assert('headset not replaced',                  offer.replacement?.category !== 'headset');
assert('saving > 0',                            offer.saving > 0);
assert('replacement in stock',                  offer.replacement?.stock > 0);

// ─── Test 3: applyOffer ───────────────────────────────────────────────────────
console.log('\napplyOffer — tests\n');

const updatedCart = applyOffer(cart, offer);
assert('original cart not mutated',             cart.total === 11500);
assert('updated cart has new total',            updatedCart.total < cart.total);
assert('replaced item has new price',
  updatedCart.items.find(i => i.category === offer.replacement.category)?.price === offer.replacement.price);
assert('non-replaced items unchanged',
  updatedCart.items.find(i => i.category === 'headset')?.price === 6000);

// ─── Test 4: all-locked → no_offer ───────────────────────────────────────────
console.log('\nAll-locked cart\n');

const allLocked = { goal: 't', budget: 1, preferences: { headset: 'locked', keyboard: 'locked', mouse: 'locked' } };
const r = negotiate(cart, allLocked, catalog);
assert('all locked → escalation_needed',        r.status === 'escalation_needed');
assert('no_offer recorded',                     r.best_offer?.action === 'no_offer');

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed > 0) { console.error('\nSome tests failed.'); process.exit(1); }
else { console.log('\nAll tests passed ✅'); }
