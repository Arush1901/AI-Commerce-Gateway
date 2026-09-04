'use strict';

const { isLocked, getValidSubstitutes, ADJACENT_TIERS } = require('../src/services/constraintService');

// ─── assert harness ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(desc, condition, detail = '') {
  if (condition) { console.log(`   ${desc}`); passed++; }
  else { console.error(`   ${desc}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── shared fixtures ───────────────────────────────────────────────────────────
const intent = {
  goal: 'gaming setup',
  budget: 10000,
  preferences: {
    headset:  'locked',
    keyboard: 'medium',
    mouse:    'low',
  },
};

const catalog = [
  // headsets
  { id: 'hs-pro',    name: 'Headset Pro',    category: 'headset',  tier: 'pro',    price: 8500, features: [], stock: 10 },
  { id: 'hs-office', name: 'Headset Office', category: 'headset',  tier: 'office', price: 6000, features: [], stock: 44 },
  { id: 'hs-lite',   name: 'Headset Lite',   category: 'headset',  tier: 'lite',   price: 2999, features: [], stock: 0  }, // OOS
  // keyboards
  { id: 'kb-pro',    name: 'Keyboard Pro',   category: 'keyboard', tier: 'pro',    price: 9999, features: [], stock: 27 },
  { id: 'kb-office', name: 'Keyboard Office',category: 'keyboard', tier: 'office', price: 3500, features: [], stock: 85 },
  { id: 'kb-lite',   name: 'Keyboard Lite',  category: 'keyboard', tier: 'lite',   price: 1999, features: [], stock: 200},
  // mice
  { id: 'ms-pro',    name: 'Mouse Pro',      category: 'mouse',    tier: 'pro',    price: 8999, features: [], stock: 22 },
  { id: 'ms-office', name: 'Mouse Office',   category: 'mouse',    tier: 'office', price: 2000, features: [], stock: 90 },
  { id: 'ms-lite',   name: 'Mouse Lite',     category: 'mouse',    tier: 'lite',   price:  799, features: [], stock: 300},
];

// ─── Test 1: isLocked ─────────────────────────────────────────────────────────
console.log('\nisLocked — tests\n');

assert('headset (locked) → true',          isLocked('headset',  intent) === true);
assert('keyboard (medium) → false',        isLocked('keyboard', intent) === false);
assert('mouse (low) → false',              isLocked('mouse',    intent) === false);
assert('unknown item → false',             isLocked('monitor',  intent) === false);
assert('null intent → false',              isLocked('headset',  null)   === false);
assert('missing preferences → false',      isLocked('headset',  {})     === false);

// ─── Test 2: ADJACENT_TIERS data structure ────────────────────────────────────
console.log('\nTier adjacency data\n');

assert('pro   adj = [office]',             JSON.stringify(ADJACENT_TIERS['pro'])    === JSON.stringify(['office']));
assert('office adj = [lite] only',         JSON.stringify(ADJACENT_TIERS['office']) === JSON.stringify(['lite']));
assert('lite  adj = [] (no downgrade)',     JSON.stringify(ADJACENT_TIERS['lite'])   === JSON.stringify([]));

// ─── Test 3: getValidSubstitutes — pro mouse ──────────────────────────────────
console.log('\ngetValidSubstitutes — pro mouse\n');

const mouseSubs = getValidSubstitutes('ms-pro', catalog);

assert('returns an array',                 Array.isArray(mouseSubs));
assert('office mouse included (downgrade)', mouseSubs.some(p => p.id === 'ms-office'));
assert('lite mouse NOT included (non-adjacent skipped 1)', !mouseSubs.some(p => p.id === 'ms-lite'));
assert('pro mouse itself NOT included',   !mouseSubs.some(p => p.id === 'ms-pro'));
assert('no cross-category: headsets excluded',   !mouseSubs.some(p => p.category === 'headset'));
assert('no cross-category: keyboards excluded',  !mouseSubs.some(p => p.category === 'keyboard'));
assert('all results same category (mouse)',       mouseSubs.every(p => p.category === 'mouse'));
assert('all results in stock',                    mouseSubs.every(p => p.stock > 0));

// ─── Test 4: pro headset substitutes ─────────────────────────────────────────
console.log('\ngetValidSubstitutes — pro headset\n');

const headsetSubs = getValidSubstitutes('hs-pro', catalog);

assert('office headset included',          headsetSubs.some(p => p.id === 'hs-office'));
// hs-lite has stock=0 so must be excluded
assert('OOS lite headset excluded',        !headsetSubs.some(p => p.id === 'hs-lite'));
assert('lite headset excluded (OOS)',      headsetSubs.every(p => p.stock > 0));

// ─── Test 5: office keyboard can only go down to lite ────────────────────────
console.log('\ngetValidSubstitutes — office keyboard (downgrade-only)\n');

const kbSubs = getValidSubstitutes('kb-office', catalog);

assert('lite keyboard included (downgrade)',      kbSubs.some(p => p.id === 'kb-lite'));
assert('pro keyboard NOT included (no upgrade)',  !kbSubs.some(p => p.id === 'kb-pro'));
assert('office keyboard itself excluded',        !kbSubs.some(p => p.id === 'kb-office'));
assert('no cross-category results',               kbSubs.every(p => p.category === 'keyboard'));

// ─── Test 6: lite tier has no substitutes ────────────────────────────────────
console.log('\ngetValidSubstitutes — lite mouse (no downgrade available)\n');

const liteSubs = getValidSubstitutes('ms-lite', catalog);
assert('lite mouse → empty array',               liteSubs.length === 0);

// ─── Test 7: office mouse → lite mouse only (not pro) ────────────────────────
console.log('\ngetValidSubstitutes — office mouse\n');

const officeMouseSubs = getValidSubstitutes('ms-office', catalog);
assert('lite mouse included (downgrade)',         officeMouseSubs.some(p => p.id === 'ms-lite'));
assert('pro mouse NOT included (no upgrade)',     !officeMouseSubs.some(p => p.id === 'ms-pro'));
assert('all in stock',                            officeMouseSubs.every(p => p.stock > 0));

// ─── Test 8: unknown productId ───────────────────────────────────────────────
console.log('\ngetValidSubstitutes — unknown product\n');

const noSubs = getValidSubstitutes('does-not-exist', catalog);
assert('unknown id → empty array',               noSubs.length === 0);

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed > 0) { console.error('\nSome tests failed.'); process.exit(1); }
else { console.log('\nAll tests passed '); }
