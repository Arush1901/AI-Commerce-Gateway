'use strict';

/**
 * goalService.js — GOAL-FIRST intent understanding.
 *
 * This module answers the question the pipeline must resolve BEFORE it builds a
 * cart, issues a mandate, or negotiates: *what is the buyer actually trying to
 * achieve?* Everything downstream (product selection, mandate categories, the
 * growth/upsell surface, the alternative options) is derived from the answer.
 *
 * It is deterministic and explainable — no LLM, no hidden heuristics. It reads
 * the goal SENTENCE the LLM already extracted plus the CATEGORIES it enumerated,
 * and classifies:
 *
 *   goalType        gaming | office | content-creation | general
 *   useCase         the catalog `useCases` tag to prioritise (same vocabulary)
 *   scope           'single-item'  → the user asked for ONE thing ("a mouse")
 *                   'setup'        → the user wants a coordinated set ("gaming setup")
 *   categories      the product categories the cart is actually built from
 *   allowedCategories  categories + goal-essential add-ons (the mandate whitelist —
 *                   the ONLY source of truth for what's permitted; replaces the old
 *                   manual category multiselect)
 *   essentialAddOns categories the agent MAY attach if budget allows, because they
 *                   genuinely serve the goal (e.g. a mousepad for a gaming mouse) —
 *                   never forced into the baseline
 *   heroCategories  the categories that matter most for this goal, used to bias the
 *                   "balanced" alternative toward the peripherals that count
 *
 * Design rules (map directly to the three problems this solves):
 *   • Problem 1 — the goal drives product choice: `useCase` filters the catalog so a
 *     gaming request prioritises gaming-tagged products, never office ones.
 *   • Problem 2 — ONE source of truth: `allowedCategories` is computed here from the
 *     request, so there is no separate manual category list to conflict with it.
 *   • Problem 3 — goal-driven, not forced: a single-item request stays a single item;
 *     a setup expands ONLY to the categories the goal genuinely needs.
 */

// ─── Goal-type keyword tables (data, not AI) ─────────────────────────────────
// First table to match (in this priority order) wins. Gaming and content beat
// the broad "office/work" words so "gaming setup for work breaks" reads as gaming.

const GOAL_TYPE_KEYWORDS = [
  ['gaming', [
    'gaming', 'gamer', 'game', 'games', 'esport', 'e-sport', 'fps', 'moba',
    'competitive', 'battlestation', 'battle station', 'twitch play', 'aim',
  ]],
  ['content-creation', [
    'content', 'creator', 'creating', 'stream', 'streaming', 'editing', 'editor',
    'video', 'youtube', 'podcast', 'design', 'designer', 'music production',
    'audio production', 'render', 'production',
  ]],
  ['office', [
    'office', 'work', 'productivity', 'productive', 'business', 'professional',
    'wfh', 'work-from-home', 'work from home', 'home-office', 'home office',
    'corporate', 'meeting', 'meetings', 'call', 'calls', 'zoom', 'conferenc',
    'typing', 'coding', 'developer', 'programming', 'study', 'student',
  ]],
];

// ─── Scope keywords: phrases that signal a coordinated SET rather than one item ─
const SETUP_KEYWORDS = [
  'setup', 'set up', 'set-up', 'kit', 'bundle', 'combo', 'station', 'rig',
  'package', 'workstation', 'battlestation', 'everything', 'complete', 'full set',
  'whole set', 'peripherals', 'gear',
];

// ─── Per-goal defaults ────────────────────────────────────────────────────────
// The categories a SETUP for this goal needs when the user didn't enumerate them.
// Only categories that actually exist in the catalog are listed.
const GOAL_DEFAULT_CATEGORIES = {
  gaming:             ['headset', 'keyboard', 'mouse'],
  office:             ['keyboard', 'mouse', 'headset'],
  'content-creation': ['headset', 'keyboard', 'mouse'],
  general:            [],
};

// Categories the agent MAY attach to a SETUP for this goal (never a single item,
// never forced) because they genuinely serve the goal. The mandate whitelists
// them so an in-budget cross-sell is possible; the baseline never includes them.
const GOAL_ESSENTIAL_ADDONS = {
  gaming:             ['mousepad'],
  office:             ['wrist-rest'],
  'content-creation': ['mousepad'],
  general:            [],
};

// The categories that most define quality for this goal — used to bias the
// "balanced" alternative toward better peripherals where they matter.
const GOAL_HERO_CATEGORIES = {
  gaming:             ['mouse', 'keyboard'],
  office:             ['keyboard', 'mouse'],
  'content-creation': ['headset', 'mouse'],
  general:            [],
};

const VALID_USE_CASES = ['gaming', 'office', 'content-creation', 'general'];

// ─── classifyGoalType ─────────────────────────────────────────────────────────

/**
 * Classify the goal SENTENCE into one of the four goal types.
 * @param {string} goalText
 * @returns {'gaming'|'office'|'content-creation'|'general'}
 */
function classifyGoalType(goalText) {
  const text = String(goalText ?? '').toLowerCase();
  for (const [type, keywords] of GOAL_TYPE_KEYWORDS) {
    if (keywords.some(k => text.includes(k))) return type;
  }
  return 'general';
}

/**
 * Decide whether the request is for a single item or a coordinated setup.
 * @param {string} goalText
 * @param {string[]} categories   categories the LLM enumerated
 * @returns {'single-item'|'setup'}
 */
function classifyScope(goalText, categories) {
  const text = String(goalText ?? '').toLowerCase();
  if (SETUP_KEYWORDS.some(k => text.includes(k))) return 'setup';
  // Two or more distinct categories named ⇒ the buyer already described a set.
  if (Array.isArray(categories) && categories.length >= 2) return 'setup';
  return 'single-item';
}

// ─── goalFitProducts ──────────────────────────────────────────────────────────

/**
 * Return the goal-fit candidate products for a category, prioritising the goal's
 * own use-case and falling back gracefully so a cart can always be built:
 *   1. products tagged with the exact useCase        (the true goal-fit set)
 *   2. else products tagged 'general'                 (universally suitable)
 *   3. else every in-stock product in the category    (last-resort fallback)
 *
 * Untagged catalogs (e.g. older unit-test fixtures with no `useCases` field) fall
 * straight through to (3), preserving legacy behaviour.
 *
 * @param {CatalogProduct[]} catalog
 * @param {string} category
 * @param {string} useCase
 * @returns {CatalogProduct[]}
 */
function goalFitProducts(catalog, category, useCase) {
  const inCat = (catalog ?? []).filter(p => p.category === category && p.stock > 0);
  if (!useCase || useCase === 'general') {
    const general = inCat.filter(p => Array.isArray(p.useCases) && p.useCases.includes('general'));
    return general.length ? general : inCat;
  }
  const strict = inCat.filter(p => Array.isArray(p.useCases) && p.useCases.includes(useCase));
  if (strict.length) return strict;
  const general = inCat.filter(p => Array.isArray(p.useCases) && p.useCases.includes('general'));
  if (general.length) return general;
  return inCat;
}

/**
 * The broader ranked pool used when generating alternatives: goal-fit products
 * PLUS general ones, each scored so goal-tagged items rank above general items.
 * Lets the "budget" option reach a cheap general item while the "best" option
 * still prefers a true goal-fit product.
 *
 * @returns {Array<CatalogProduct & { goalScore: number }>}
 */
function rankedGoalPool(catalog, category, useCase) {
  const inCat = (catalog ?? []).filter(p => p.category === category && p.stock > 0);
  const scored = inCat.map(p => {
    const tags = Array.isArray(p.useCases) ? p.useCases : [];
    let goalScore = 0;
    if (useCase && useCase !== 'general' && tags.includes(useCase)) goalScore = 2;
    else if (tags.includes('general')) goalScore = 1;
    return { ...p, goalScore };
  });
  // Keep goal-fit + general; if nothing scored (untagged fixture), keep all.
  const kept = scored.filter(p => p.goalScore > 0);
  return kept.length ? kept : scored;
}

// ─── classifyGoal (main) ──────────────────────────────────────────────────────

/**
 * Turn a parsed Intent into a full goal profile. This is the single source of
 * truth the rest of the pipeline builds on.
 *
 * @param {{ goal?: string, preferences?: Record<string,string> }} intent
 * @returns {{
 *   goalType: string, useCase: string, scope: 'single-item'|'setup',
 *   categories: string[], allowedCategories: string[],
 *   essentialAddOns: string[], heroCategories: string[]
 * }}
 */
function classifyGoal(intent) {
  const goalText = intent?.goal ?? '';
  const prefCats = Object.keys(intent?.preferences ?? {});

  const goalType = classifyGoalType(goalText);
  const useCase  = goalType; // goalType vocabulary == catalog useCases vocabulary
  const scope    = classifyScope(goalText, prefCats);

  // Categories the cart is built from:
  //   • the buyer enumerated some → honour EXACTLY those (don't invent extras)
  //   • the buyer was vague ("gaming setup") with none enumerated → use the goal's
  //     default set so a setup is still viable
  let categories = prefCats.slice();
  if (categories.length === 0 && scope === 'setup') {
    categories = (GOAL_DEFAULT_CATEGORIES[goalType] ?? []).slice();
  }
  // A single-item request is exactly one category — never widen it.
  if (scope === 'single-item' && categories.length > 1) {
    categories = categories.slice(0, 1);
  }

  // Goal-essential add-ons apply ONLY to setups (a lone item is never expanded).
  const essentialAddOns = scope === 'setup'
    ? (GOAL_ESSENTIAL_ADDONS[goalType] ?? []).filter(c => !categories.includes(c))
    : [];

  // The mandate whitelist = the goal categories + their essential add-ons. This
  // is the ONE permitted-category list; there is no separate manual selection.
  const allowedCategories = [...new Set([...categories, ...essentialAddOns])];

  const heroCategories = (GOAL_HERO_CATEGORIES[goalType] ?? []).filter(c => categories.includes(c));

  return { goalType, useCase, scope, categories, allowedCategories, essentialAddOns, heroCategories };
}

module.exports = {
  classifyGoal,
  classifyGoalType,
  classifyScope,
  goalFitProducts,
  rankedGoalPool,
  GOAL_DEFAULT_CATEGORIES,
  GOAL_ESSENTIAL_ADDONS,
  GOAL_HERO_CATEGORIES,
  VALID_USE_CASES,
};
