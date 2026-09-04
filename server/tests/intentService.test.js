'use strict';

/**
 * Stage 11 — Intent multi-item extraction tests.
 *
 * Tests that parseIntent produces a complete Intent with all mentioned categories.
 * Uses a mock Groq API to avoid real LLM calls.
 */

// Mock the fetch API before requiring intentService
const originalFetch = global.fetch;

// ─── assert harness ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(desc, condition, detail = '') {
  if (condition) { console.log(`   ${desc}`); passed++; }
  else { console.error(`   ${desc}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ─── Groq mock factory ────────────────────────────────────────────────────────
function mockGroq(responseJSON) {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(responseJSON) } }]
    }),
    text: async () => '',
  });
}

function restoreFetch() { global.fetch = originalFetch; }

// ─── tests ────────────────────────────────────────────────────────────────────

(async () => {

// ──────────────────────────────────────────────────────────────────────────────
// Case 1: LLM correctly returns all 3 categories for canonical prompt
// ──────────────────────────────────────────────────────────────────────────────
console.log('\nCase 1: canonical prompt → multi-category intent\n');

mockGroq({
  goal: 'gaming setup with headset keyboard and mouse',
  budget: 10000,
  preferences: { headset: 'locked', keyboard: 'medium', mouse: 'medium' },
});

const { parseIntent } = require('../src/services/intentService');

const intent1 = await parseIntent('Gaming setup under ₹10000. Headset matters most.');

assert('[C1] intent is object',              typeof intent1 === 'object');
assert('[C1] has goal',                      typeof intent1.goal === 'string' && intent1.goal.length > 0);
assert('[C1] budget = 10000',               intent1.budget === 10000, `got ${intent1.budget}`);
assert('[C1] preferences has headset',       'headset'  in intent1.preferences);
assert('[C1] preferences has keyboard',      'keyboard' in intent1.preferences, JSON.stringify(intent1.preferences));
assert('[C1] preferences has mouse',         'mouse'    in intent1.preferences, JSON.stringify(intent1.preferences));
assert('[C1] headset = locked',              intent1.preferences.headset  === 'locked');
assert('[C1] keyboard ∈ {medium,low}',      ['medium','low'].includes(intent1.preferences.keyboard));
assert('[C1] mouse ∈ {medium,low}',         ['medium','low'].includes(intent1.preferences.mouse));
assert('[C1] no extra junk keys',
  Object.keys(intent1.preferences).every(k => ['headset','keyboard','mouse'].includes(k)));

restoreFetch();

// ──────────────────────────────────────────────────────────────────────────────
// Case 2: single-item prompt → only that item (no fabrication)
// ──────────────────────────────────────────────────────────────────────────────
console.log('\nCase 2: single-item prompt → no fabricated extras\n');

mockGroq({
  goal: 'buy a gaming headset',
  budget: 5000,
  preferences: { headset: 'locked' },
});

// Re-require to pick up fresh mock (module is cached, fetch is replaced)
const intent2 = await parseIntent('Just a gaming headset under ₹5000.');

assert('[C2] headset present',              'headset' in intent2.preferences);
assert('[C2] budget = 5000',               intent2.budget === 5000);
// Must not fabricate items not mentioned
assert('[C2] keyboard NOT added',           !('keyboard' in intent2.preferences));
assert('[C2] mouse NOT added',              !('mouse' in intent2.preferences));

restoreFetch();

// ──────────────────────────────────────────────────────────────────────────────
// Case 3: LLM returns bad JSON → retry → succeed
// ──────────────────────────────────────────────────────────────────────────────
console.log('\nCase 3: LLM bad JSON on attempt 1 → retry produces valid result\n');

let callCount = 0;
global.fetch = async () => {
  callCount++;
  const content = callCount === 1
    ? '```invalid json here```'       // attempt 1 fails
    : JSON.stringify({ goal: 'gaming', budget: 8000, preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } });
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  };
};

const intent3 = await parseIntent('anything');

assert('[C3] retried and succeeded',        callCount === 2, `calls made: ${callCount}`);
assert('[C3] valid intent returned',        intent3.budget === 8000);
assert('[C3] all 3 preferences present',
  ['headset','keyboard','mouse'].every(k => k in intent3.preferences));

restoreFetch();

// ──────────────────────────────────────────────────────────────────────────────
// Case 4: system prompt contains CRITICAL multi-item rule
// (The goal-item fallback has moved to goalService.classifyGoal, tested by
//  goalService.test.js. The LLM prompt must still enforce complete extraction.)
// ──────────────────────────────────────────────────────────────────────────────
console.log('\nCase 4: system prompt enforces all-items-extraction rule\n');

const fs    = require('fs');
const path  = require('path');
const src   = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'intentService.js'), 'utf8');

assert('[C4] CRITICAL rule present in prompt', src.includes('CRITICAL'));
assert('[C4] prompt says never omit items',    src.includes('Never omit') || src.includes('never omit'));
assert('[C4] prompt has medium default',       src.includes('"medium"'));
assert('[C4] prompt no longer anchors 10000',  !src.includes('10000'));

// Goal-item fallback has moved to goalService.classifyGoal() — verify it's gone
// from intentService (no duplication)
assert('[C4] GOAL_ITEMS map removed',          !src.includes('GOAL_ITEMS'));
assert('[C4] applyGoalFallback removed',       !src.includes('applyGoalFallback'));

restoreFetch();

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed > 0) { console.error('\nSome tests failed.'); process.exit(1); }
else { console.log('\nAll tests passed '); }

})().catch(err => { console.error(err); process.exit(1); });

