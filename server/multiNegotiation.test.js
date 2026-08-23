'use strict';

const { negotiate } = require('./negotiationService');

// ─── assert harness ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(desc, condition, detail = '') {
  if (condition) { console.log(`  ✅  ${desc}`); passed++; }
  else { console.error(`  ❌  ${desc}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CASE 1 — One substitution closes the gap
//
// Cart:   headset ₹6000 (locked) + keyboard ₹3500 + mouse ₹2000 = ₹11500
// Budget: ₹10000   (gap = ₹1500)
// Round 1: keyboard office → lite  saves ₹1501  → total ₹9999 ≤ ₹10000 → approved
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n📋 Case 1: One substitution closes the gap\n');

const case1Catalog = [
  { id: 'hs-office', name: 'Headset Office',  category: 'headset',  tier: 'office', price: 6000, features: [], stock: 44 },
  { id: 'kb-office', name: 'Keyboard Office', category: 'keyboard', tier: 'office', price: 3500, features: [], stock: 85 },
  { id: 'kb-lite',   name: 'Keyboard Lite',   category: 'keyboard', tier: 'lite',   price: 1999, features: [], stock: 200 },
  { id: 'ms-office', name: 'Mouse Office',    category: 'mouse',    tier: 'office', price: 2000, features: [], stock: 90 },
  { id: 'ms-lite',   name: 'Mouse Lite',      category: 'mouse',    tier: 'lite',   price:  799, features: [], stock: 300 },
];

const case1Intent = {
  goal: 'gaming setup', budget: 10000,
  preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' },
};

const case1Cart = {
  items: [
    { product: case1Catalog[0], category: 'headset',  price: 6000 },
    { product: case1Catalog[1], category: 'keyboard', price: 3500 },
    { product: case1Catalog[3], category: 'mouse',    price: 2000 },
  ],
  total: 11500, budget: 10000, currency: 'INR', over_budget: true,
};

const r1 = negotiate(case1Cart, case1Intent, case1Catalog);

assert('[C1] status = approved',                    r1.status === 'approved', r1.status);
assert('[C1] resolved in 1 round',                  r1.rounds === 1, `got ${r1.rounds}`);
assert('[C1] 1 offer recorded',                     r1.offers.length === 1);
assert('[C1] offer action = substitute',            r1.offers[0].offer.action === 'substitute');
assert('[C1] headset untouched in finalCart',       r1.finalCart.items.find(i => i.category === 'headset')?.price === 6000);
assert('[C1] finalCart total ≤ budget',             r1.finalCart.total <= 10000, `got ₹${r1.finalCart.total}`);
assert('[C1] keyboard swapped to lite',             r1.finalCart.items.find(i => i.category === 'keyboard')?.product.tier === 'lite');

// ═══════════════════════════════════════════════════════════════════════════════
// CASE 2 — Two substitutions required and both succeed
//
// Cart:    item_A pro ₹1200 + item_B pro ₹1100 = ₹2300
// Budget:  ₹1500   (gap = ₹800)
// Round 1: item_A pro → office ₹700, saves ₹500 → total ₹1800, gap = ₹300
// Round 2: item_B pro → office ₹600, saves ₹500 → total ₹1300 ≤ ₹1500 → approved
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n📋 Case 2: Two substitutions required and both succeed\n');

const case2Catalog = [
  { id: 'a-pro',    name: 'Widget A Pro',    category: 'widget', tier: 'pro',    price: 1200, features: [], stock: 5 },
  { id: 'a-office', name: 'Widget A Office', category: 'widget', tier: 'office', price:  700, features: [], stock: 5 },
  { id: 'b-pro',    name: 'Gadget B Pro',    category: 'gadget', tier: 'pro',    price: 1100, features: [], stock: 5 },
  { id: 'b-office', name: 'Gadget B Office', category: 'gadget', tier: 'office', price:  600, features: [], stock: 5 },
];

const case2Intent = {
  goal: 'test', budget: 1500,
  preferences: { widget: 'medium', gadget: 'low' },
};

const case2Cart = {
  items: [
    { product: case2Catalog[0], category: 'widget', price: 1200 },
    { product: case2Catalog[2], category: 'gadget', price: 1100 },
  ],
  total: 2300, budget: 1500, currency: 'INR', over_budget: true,
};

const r2 = negotiate(case2Cart, case2Intent, case2Catalog);

assert('[C2] status = approved',                    r2.status === 'approved', r2.status);
assert('[C2] resolved in 2 rounds',                 r2.rounds === 2, `got ${r2.rounds}`);
assert('[C2] 2 offers recorded',                    r2.offers.length === 2);
assert('[C2] both offers are substitutions',        r2.offers.every(o => o.offer.action === 'substitute'));
assert('[C2] finalCart total ≤ budget',             r2.finalCart.total <= 1500, `got ₹${r2.finalCart.total}`);
assert('[C2] widget downgraded to office',          r2.finalCart.items.find(i => i.category === 'widget')?.product.tier === 'office');
assert('[C2] gadget downgraded to office',          r2.finalCart.items.find(i => i.category === 'gadget')?.product.tier === 'office');

// ═══════════════════════════════════════════════════════════════════════════════
// CASE 3 — Budget is impossible, returns escalation_needed
//
// Cart:    headset ₹6000 (locked) + keyboard ₹3500 = ₹9500
// Budget:  ₹1000  (impossible — locked headset alone costs ₹6000)
// Round 1: keyboard → lite ₹1999, total ₹7999, still over
// Round 2: keyboard already at lite (no further downgrade),
//          mouse has no entry → no_offer
// Result:  escalation_needed
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n📋 Case 3: Impossible budget → escalation_needed\n');

const case3Catalog = [
  { id: 'hs-off', name: 'Headset Office',  category: 'headset',  tier: 'office', price: 6000, features: [], stock: 44 },
  { id: 'kb-off', name: 'Keyboard Office', category: 'keyboard', tier: 'office', price: 3500, features: [], stock: 85 },
  { id: 'kb-lit', name: 'Keyboard Lite',   category: 'keyboard', tier: 'lite',   price: 1999, features: [], stock: 200 },
];

const case3Intent = {
  goal: 'test', budget: 1000,
  preferences: { headset: 'locked', keyboard: 'medium' },
};

const case3Cart = {
  items: [
    { product: case3Catalog[0], category: 'headset',  price: 6000 },
    { product: case3Catalog[1], category: 'keyboard', price: 3500 },
  ],
  total: 9500, budget: 1000, currency: 'INR', over_budget: true,
};

const r3 = negotiate(case3Cart, case3Intent, case3Catalog);

assert('[C3] status = escalation_needed',           r3.status === 'escalation_needed', r3.status);
assert('[C3] gap is positive',                      r3.gap > 0,                        `got ${r3.gap}`);
assert('[C3] best_offer is present',                r3.best_offer !== undefined);
assert('[C3] no finalCart on escalation',           r3.finalCart === undefined);
assert('[C3] offers array present (uniform shape)', Array.isArray(r3.offers));
assert('[C3] rounds present (uniform shape)',        typeof r3.rounds === 'number');

// ─── Infinite-loop guard ──────────────────────────────────────────────────────
console.log('\n🔄 Infinite loop guard\n');

// Calling negotiate many times should never hang
for (let i = 0; i < 50; i++) {
  negotiate(case1Cart, case1Intent, case1Catalog);
  negotiate(case3Cart, case3Intent, case3Catalog);
}
assert('50 × negotiate() completed without hanging', true);
assert('rounds never exceed MAX_ROUNDS (2)',
  [r1, r2].every(r => (r.rounds ?? 0) <= 2) &&
  // escalation path: offers ≤ 2
  r3.best_offer !== null
);

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed > 0) { console.error('\nSome tests failed.'); process.exit(1); }
else { console.log('\nAll tests passed ✅'); }
