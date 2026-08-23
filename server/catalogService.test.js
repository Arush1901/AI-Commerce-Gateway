'use strict';

const { searchCatalog } = require('./catalogService');

// ─── helpers ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(description, condition) {
  if (condition) {
    console.log(`  ✅  ${description}`);
    passed++;
  } else {
    console.error(`  ❌  ${description}`);
    failed++;
  }
}

// ─── tests ─────────────────────────────────────────────────────────────────

console.log('\n📦 searchCatalog — unit tests\n');

// 1. category filter
console.log('Category filter');
const headsets = searchCatalog({ category: 'headset' });
assert('returns an array', Array.isArray(headsets));
assert('every result is a headset', headsets.every(p => p.category === 'headset'));
assert('no keyboards in result', headsets.every(p => p.category !== 'keyboard'));
assert('no mice in result',      headsets.every(p => p.category !== 'mouse'));
assert('returns at least one product', headsets.length > 0);

console.log('\nmaxPrice filter');
const budget = 1500;
const cheap  = searchCatalog({ maxPrice: budget });
assert('returns an array', Array.isArray(cheap));
assert(`no product price > ${budget}`, cheap.every(p => p.price <= budget));
assert('at least one product returned', cheap.length > 0);

console.log('\nCombined category + maxPrice');
const combined = searchCatalog({ category: 'mouse', maxPrice: 1000 });
assert('all are mice',              combined.every(p => p.category === 'mouse'));
assert('all within budget',         combined.every(p => p.price <= 1000));

console.log('\nEdge cases');
const keyboards = searchCatalog({ category: 'keyboard' });
assert('keyboard-only results', keyboards.every(p => p.category === 'keyboard'));

const allProducts = searchCatalog({});
const fullCatalog  = searchCatalog();
assert('no args returns all products', allProducts.length === fullCatalog.length);
assert('result is independent copy — push does not mutate original',
  (() => {
    const r1 = searchCatalog({ category: 'headset' });
    const len = r1.length;
    r1.push({ fake: true });
    const r2 = searchCatalog({ category: 'headset' });
    return r2.length === len;
  })()
);

const zeroResults = searchCatalog({ maxPrice: 0 });
assert('maxPrice=0 returns empty array', zeroResults.length === 0);

// ─── summary ───────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed > 0) {
  console.error('\nSome tests failed.');
  process.exit(1);
} else {
  console.log('\nAll tests passed ✅');
}
