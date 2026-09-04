'use strict';

/**
 * goalService.test.js — Tests for the goal-first intent classification.
 *
 * Verifies that classifyGoal() correctly determines goalType, scope, useCase,
 * categories, and allowedCategories from the parsed intent — the single source
 * of truth for the entire pipeline.
 */

const {
  classifyGoal,
  classifyGoalType,
  classifyScope,
  goalFitProducts,
  rankedGoalPool,
} = require('../src/services/goalService');

let passed = 0;
let failed = 0;
function assert(desc, condition, detail = '') {
  if (condition) { console.log(`   ${desc}`); passed++; }
  else { console.error(`   ${desc}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// classifyGoalType
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nclassifyGoalType\n');

assert('gaming keyword → gaming',                    classifyGoalType('Build me a gaming setup') === 'gaming');
assert('gamer keyword → gaming',                     classifyGoalType('I am a competitive gamer') === 'gaming');
assert('esport keyword → gaming',                    classifyGoalType('Need esport peripherals') === 'gaming');
assert('fps keyword → gaming',                       classifyGoalType('fps gaming mouse') === 'gaming');
assert('office keyword → office',                    classifyGoalType('need an office keyboard') === 'office');
assert('work keyword → office',                      classifyGoalType('work from home setup') === 'office');
assert('productivity → office',                      classifyGoalType('productive home setup') === 'office');
assert('coding → office',                            classifyGoalType('coding keyboard for developer') === 'office');
assert('streaming → content-creation',               classifyGoalType('streaming setup for twitch') === 'content-creation');
assert('content creator → content-creation',         classifyGoalType('content creator peripherals') === 'content-creation');
assert('video editing → content-creation',           classifyGoalType('video editing headset') === 'content-creation');
assert('unrelated text → general',                   classifyGoalType('buy a mouse') === 'general');
assert('empty string → general',                     classifyGoalType('') === 'general');
assert('gaming beats office', classifyGoalType('gaming setup for work breaks') === 'gaming',
  'gaming should take priority over work');

// ═══════════════════════════════════════════════════════════════════════════════
// classifyScope
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nclassifyScope\n');

assert('setup keyword → setup',                      classifyScope('gaming setup', []) === 'setup');
assert('kit keyword → setup',                        classifyScope('peripherals kit', []) === 'setup');
assert('bundle keyword → setup',                     classifyScope('gaming bundle', []) === 'setup');
assert('rig keyword → setup',                        classifyScope('my new PC rig', []) === 'setup');
assert('single product → single-item',               classifyScope('gaming mouse', []) === 'single-item');
assert('single product one cat → single-item',       classifyScope('gaming mouse', ['mouse']) === 'single-item');
assert('two categories → setup',                     classifyScope('mouse and keyboard', ['mouse', 'keyboard']) === 'setup');
assert('three categories → setup',                   classifyScope('gear', ['headset', 'keyboard', 'mouse']) === 'setup');
assert('no text no cats → single-item',              classifyScope('', []) === 'single-item');

// ═══════════════════════════════════════════════════════════════════════════════
// classifyGoal — full integration
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nclassifyGoal — full integration\n');

// Gaming setup with preferences enumerated
const g1 = classifyGoal({ goal: 'gaming setup under 20k', preferences: { headset: 'locked', keyboard: 'medium', mouse: 'low' } });
assert('[G1] goalType = gaming',                     g1.goalType === 'gaming');
assert('[G1] useCase = gaming',                      g1.useCase === 'gaming');
assert('[G1] scope = setup',                         g1.scope === 'setup');
assert('[G1] categories = the 3 preferences',        g1.categories.length === 3);
assert('[G1] categories includes headset',           g1.categories.includes('headset'));
assert('[G1] categories includes keyboard',          g1.categories.includes('keyboard'));
assert('[G1] categories includes mouse',             g1.categories.includes('mouse'));
assert('[G1] allowedCategories includes mousepad (gaming add-on)', g1.allowedCategories.includes('mousepad'));
assert('[G1] essentialAddOns = mousepad',             g1.essentialAddOns.length === 1 && g1.essentialAddOns[0] === 'mousepad');

// Vague gaming setup — no preferences enumerated
const g2 = classifyGoal({ goal: 'gaming setup', preferences: {} });
assert('[G2] goalType = gaming',                     g2.goalType === 'gaming');
assert('[G2] scope = setup',                         g2.scope === 'setup');
assert('[G2] categories defaulted to gaming set',    g2.categories.length === 3);
assert('[G2] default has headset,keyboard,mouse',
  g2.categories.includes('headset') && g2.categories.includes('keyboard') && g2.categories.includes('mouse'));

// Single item request
const g3 = classifyGoal({ goal: 'I need a gaming mouse', preferences: { mouse: 'medium' } });
assert('[G3] goalType = gaming',                     g3.goalType === 'gaming');
assert('[G3] scope = single-item',                   g3.scope === 'single-item');
assert('[G3] categories = just mouse',               g3.categories.length === 1 && g3.categories[0] === 'mouse');
assert('[G3] no essentialAddOns for single-item',    g3.essentialAddOns.length === 0);
assert('[G3] allowedCategories = just mouse',        g3.allowedCategories.length === 1 && g3.allowedCategories[0] === 'mouse');

// Office setup
const g4 = classifyGoal({ goal: 'office work setup', preferences: { keyboard: 'medium', mouse: 'low' } });
assert('[G4] goalType = office',                     g4.goalType === 'office');
assert('[G4] scope = setup',                         g4.scope === 'setup');
assert('[G4] categories includes keyboard & mouse',  g4.categories.includes('keyboard') && g4.categories.includes('mouse'));
assert('[G4] essentialAddOns = wrist-rest',           g4.essentialAddOns.includes('wrist-rest'));

// Content creation
const g5 = classifyGoal({ goal: 'streaming and content creation setup', preferences: { headset: 'locked' } });
assert('[G5] goalType = content-creation',           g5.goalType === 'content-creation');
assert('[G5] scope = setup',                         g5.scope === 'setup');

// General / unknown
const g6 = classifyGoal({ goal: 'buy something nice', preferences: {} });
assert('[G6] goalType = general',                    g6.goalType === 'general');
assert('[G6] scope = single-item (no setup keyword)', g6.scope === 'single-item');
assert('[G6] empty categories (general + no prefs)', g6.categories.length === 0);

// Edge: multiple preferences but single-item scope (no setup keyword)
const g7 = classifyGoal({ goal: 'I want a mouse and keyboard', preferences: { mouse: 'medium', keyboard: 'medium' } });
assert('[G7] two cats + no setup keyword → setup (from cat count)', g7.scope === 'setup');
assert('[G7] categories = both',                     g7.categories.length === 2);

// ═══════════════════════════════════════════════════════════════════════════════
// goalFitProducts
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\ngoalFitProducts\n');

const testCatalog = [
  { id: 'a', category: 'mouse', useCases: ['gaming'],  price: 5000, stock: 10 },
  { id: 'b', category: 'mouse', useCases: ['office'],  price: 2000, stock: 10 },
  { id: 'c', category: 'mouse', useCases: ['general'], price: 800,  stock: 10 },
  { id: 'd', category: 'mouse', useCases: ['gaming', 'general'], price: 3000, stock: 10 },
  { id: 'e', category: 'mouse',                        price: 1500, stock: 10 }, // no useCases field
  { id: 'f', category: 'mouse', useCases: ['gaming'],  price: 4000, stock: 0 },  // out of stock
];

const gfGaming = goalFitProducts(testCatalog, 'mouse', 'gaming');
assert('[GF1] gaming filter: returns gaming-tagged only', gfGaming.length === 2);
assert('[GF1] includes id a',                         gfGaming.some(p => p.id === 'a'));
assert('[GF1] includes id d (dual-tagged)',           gfGaming.some(p => p.id === 'd'));
assert('[GF1] excludes out-of-stock f',               !gfGaming.some(p => p.id === 'f'));

const gfOffice = goalFitProducts(testCatalog, 'mouse', 'office');
assert('[GF2] office filter: returns office-tagged only', gfOffice.length === 1 && gfOffice[0].id === 'b');

const gfGeneral = goalFitProducts(testCatalog, 'mouse', 'general');
assert('[GF3] general filter: returns general-tagged',
  gfGeneral.some(p => p.id === 'c') && gfGeneral.some(p => p.id === 'd'));

// ═══════════════════════════════════════════════════════════════════════════════
// rankedGoalPool
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nrankedGoalPool\n');

const pool = rankedGoalPool(testCatalog, 'mouse', 'gaming');
assert('[RP1] pool is non-empty',                    pool.length > 0);
assert('[RP1] gaming products score=2',              pool.find(p => p.id === 'a')?.goalScore === 2);
assert('[RP1] general products score=1',             pool.find(p => p.id === 'c')?.goalScore === 1);
assert('[RP1] dual-tagged (gaming+general) score=2', pool.find(p => p.id === 'd')?.goalScore === 2);

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
if (failed > 0) { console.error('\nSome tests failed.'); process.exit(1); }
else { console.log('\nAll tests passed '); }
