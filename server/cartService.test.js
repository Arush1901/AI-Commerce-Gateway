'use strict';

const { buildCart } = require('./cartService');

// ─── assert harness ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(desc, condition, detail = '') {
  if (condition) { console.log(`  ✅  ${desc}`); passed++; }
  else { console.error(`  ❌  ${desc}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── shared catalog fixture ────────────────────────────────────────────────────
const catalog = [
  { id: 'hs-001', name: 'Headset Lite',   category: 'headset',  tier: 'lite',   price: 3000, features: [], stock: 10 },
  { id: 'hs-002', name: 'Headset Office', category: 'headset',  tier: 'office', price: 6000, features: [], stock: 44 }, // best headset
  { id: 'hs-003', name: 'Headset Pro',    category: 'headset',  tier: 'pro',    price: 8500, features: [], stock:  0 }, // OOS — must be skipped
  { id: 'kb-001', name: 'Keyboard Lite',  category: 'keyboard', tier: 'lite',   price: 1999, features: [], stock: 10 },
  { id: 'kb-002', name: 'Keyboard Best',  category: 'keyboard', tier: 'office', price: 3500, features: [], stock: 85 }, // best keyboard
  { id: 'ms-001', name: 'Mouse Lite',     category: 'mouse',    tier: 'lite',   price:  799, features: [], stock: 10 },
  { id: 'ms-002', name: 'Mouse Best',     category: 'mouse',    tier: 'office', price: 2000, features: [], stock: 90 }, // best mouse
];

const intent = {
  goal: 'gaming setup',
  budget: 10000,
  preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' },
};

// ─── Test 1: exact desired output ─────────────────────────────────────────────
console.log('\n🛒 buildCart — unit tests\n');
console.log('Test 1: core output — headset ₹6000 + keyboard ₹3500 + mouse ₹2000 = ₹11500');

const cart = buildCart(intent, catalog);

assert('returns object',                        typeof cart === 'object');
assert('has items array',                       Array.isArray(cart.items));
assert('currency = INR',                        cart.currency === 'INR');
assert('3 items selected',                      cart.items.length === 3,         `got ${cart.items.length}`);
assert('headset  picked at ₹6000',             cart.items.find(i => i.category === 'headset')?.price  === 6000);
assert('keyboard picked at ₹3500',             cart.items.find(i => i.category === 'keyboard')?.price === 3500);
assert('mouse    picked at ₹2000',             cart.items.find(i => i.category === 'mouse')?.price    === 2000);
assert('total = ₹11500',                       cart.total  === 11500,            `got ₹${cart.total}`);
assert('budget echoed on cart',                cart.budget === intent.budget);
assert('over_budget flag = true',              cart.over_budget === true);

// ─── Test 2: OOS products are never picked ────────────────────────────────────
console.log('\nTest 2: out-of-stock skipped, next best chosen');

const oosCheck = catalog.find(p => p.id === 'hs-003'); // stock=0, price=8500
assert('hs-003 has stock=0',                   oosCheck.stock === 0);
// Best in-stock headset should be hs-002 at 6000 (not the OOS hs-003 at 8500)
assert('OOS pro skipped, office picked',       cart.items.find(i => i.category === 'headset')?.product.id === 'hs-002');

// ─── Test 3: total integrity ──────────────────────────────────────────────────
console.log('\nTest 3: total === sum of item prices');

const sumCheck = cart.items.reduce((s, i) => s + i.price, 0);
assert('total matches item sum',               cart.total === sumCheck, `${cart.total} vs ${sumCheck}`);

// ─── Test 4: within-budget sets over_budget = false ──────────────────────────
console.log('\nTest 4: within-budget cart');

const richIntent = { ...intent, budget: 20000 };
const richCart   = buildCart(richIntent, catalog);
assert('total same regardless of budget',      richCart.total === 11500);
assert('over_budget = false when under budget', richCart.over_budget === false);

// ─── Test 5: empty catalog ────────────────────────────────────────────────────
console.log('\nTest 5: empty catalog returns empty cart');

const emptyCart = buildCart(intent, []);
assert('0 items',       emptyCart.items.length === 0);
assert('total = 0',     emptyCart.total === 0);
assert('over_budget = false', emptyCart.over_budget === false);

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed > 0) { console.error('\nSome tests failed.'); process.exit(1); }
else { console.log('\nAll tests passed ✅'); }
