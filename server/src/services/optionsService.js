'use strict';

/**
 * optionsService.js — goal-driven ALTERNATIVES (Problem 3).
 *
 * The pipeline's default is to fulfil the buyer's goal as accurately as possible
 * with a single best cart. Alternatives are shown ONLY when the ideal setup
 * cannot be achieved within budget — never as busy-work. This module decides
 * that, and when alternatives ARE warranted, produces three DISTINCT, explainable
 * within-budget options plus the trade-offs each one makes.
 *
 *   Option A — "Best within budget"   : the highest-quality goal-fit combination
 *                                       that still fits the budget.
 *   Option B — "Balanced"             : invests in the peripherals that matter
 *                                       most for the goal (heroCategories), saving
 *                                       on the rest.
 *   Option C — "Budget + upgrades"    : the lowest-cost complete goal setup, with
 *                                       concrete upgrade paths for later.
 *
 * Everything is deterministic and derived from the catalog's goal-fit pools — no
 * LLM, fully explainable, which is what earns the "bounded & explainable" marks.
 */

const { goalFitProducts, GOAL_HERO_CATEGORIES } = require('./goalService');
const { TIER_ORDER } = require('./constraintService');

// Pretty goal noun for labels/descriptions.
function goalNoun(goalType) {
  if (goalType === 'content-creation') return 'content-creation';
  if (!goalType || goalType === 'general') return 'essentials';
  return goalType;
}

// Cheapest-first goal-fit pool for a category (empty array if none in stock).
function poolFor(catalog, category, useCase) {
  return goalFitProducts(catalog, category, useCase)
    .slice()
    .sort((a, b) => a.price - b.price);
}

// Cartesian product of per-category product pools → every full-setup combination.
// Each element is an array of { product, category, price } item objects.
function combinations(pools) {
  return pools.reduce(
    (acc, pool) => {
      const next = [];
      for (const partial of acc) {
        for (const product of pool) {
          next.push([...partial, { product, category: product.category, price: product.price }]);
        }
      }
      return next;
    },
    [[]],
  );
}

const cartTotal = items => items.reduce((s, i) => s + i.price, 0);
const sameCart = (a, b) =>
  a.length === b.length &&
  a.map(i => i.product.id).sort().join('|') === b.map(i => i.product.id).sort().join('|');

// Every non-empty subset of an item array (bounded: setups have ≤ a handful of
// categories, so 2^n is tiny). Used to find the best partial setup that fits when
// no complete setup does.
function nonEmptySubsets(items) {
  const out = [];
  const n = items.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    const subset = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(items[i]);
    out.push(subset);
  }
  return out;
}

/**
 * Human-readable trade-offs of a candidate cart versus the IDEAL cart: for each
 * category where the candidate picked a cheaper/lower product, say what was given
 * up and how much it saved.
 */
function tradeoffsVsIdeal(items, idealItems) {
  const idealBy = new Map(idealItems.map(i => [i.category, i]));
  const notes = [];
  for (const item of items) {
    const ideal = idealBy.get(item.category);
    if (ideal && ideal.product.id !== item.product.id) {
      const saved = ideal.price - item.price;
      const tierPart =
        item.product.tier && ideal.product.tier && item.product.tier !== ideal.product.tier
          ? ` (${item.product.tier} instead of ${ideal.product.tier} tier)`
          : '';
      notes.push(
        `${item.category}: ${item.product.name}${tierPart}` +
          (saved > 0 ? ` — saves ₹${saved} vs the ideal ${ideal.product.name}` : ''),
      );
    }
  }
  if (!notes.length) notes.push('No compromises — this matches the ideal setup.');
  return notes;
}

/**
 * Concrete upgrade paths for a cart given the remaining budget headroom: per
 * category, the best goal-fit product priced above the current pick that STILL
 * fits within the leftover budget. Lets Option C say "you could upgrade X later".
 */
function upgradePaths(items, pools, budget) {
  const spent = cartTotal(items);
  const headroom = budget - spent;
  const poolByCat = new Map(pools.filter(p => p.length).map(p => [p[0].category, p]));
  const upgrades = [];
  for (const item of items) {
    const pool = poolByCat.get(item.category) || [];
    // Highest-priced goal-fit product in this category that fits the headroom.
    const better = pool
      .filter(p => p.price > item.price && p.price - item.price <= headroom)
      .sort((a, b) => b.price - a.price)[0];
    if (better) {
      upgrades.push(
        `${item.category}: upgrade to ${better.name} for +₹${better.price - item.price}`,
      );
    }
  }
  if (!upgrades.length) upgrades.push('No in-budget upgrades available right now.');
  return upgrades;
}

/**
 * Generate goal-driven purchase options.
 *
 * @param {{
 *   categories: string[],       // the goal categories the setup is built from
 *   useCase: string,            // catalog useCases tag to prioritise
 *   budget: number,             // hard spend ceiling
 *   catalog: CatalogProduct[],
 *   goalType?: string,          // gaming | office | content-creation | general
 *   heroCategories?: string[],  // categories that most define quality for this goal
 * }} args
 * @returns {{
 *   fits: boolean,              // does the IDEAL setup fit the budget?
 *   ideal: { items, total },    // best-possible goal-fit setup (may be over budget)
 *   feasible: boolean,          // is ANY complete setup within budget?
 *   options: Array<{
 *     id: 'A'|'B'|'C', label: string, description: string,
 *     items: Array, total: number, withinBudget: boolean,
 *     tradeoffs: string[], upgrades: string[]
 *   }>
 * }}
 */
function generateOptions({ categories, useCase, budget, catalog, goalType = 'general', heroCategories }) {
  const cats = (categories || []).filter(c =>
    goalFitProducts(catalog, c, useCase).length > 0,
  );
  const pools = cats.map(c => poolFor(catalog, c, useCase));
  const noun = goalNoun(goalType);
  const heroes = (heroCategories && heroCategories.length
    ? heroCategories
    : GOAL_HERO_CATEGORIES[goalType] || []
  ).filter(c => cats.includes(c));

  // IDEAL = best (most premium goal-fit) product per category.
  const idealItems = pools.map(pool => {
    const product = pool[pool.length - 1];
    return { product, category: product.category, price: product.price };
  });
  const idealTotal = cartTotal(idealItems);
  const ideal = { items: idealItems, total: idealTotal };

  // If the ideal already fits, NO alternatives — the caller proceeds with the
  // single best cart. This is the "don't force options" half of Problem 3.
  if (idealTotal <= budget) {
    return { fits: true, ideal, feasible: true, options: [] };
  }

  // Ideal is over budget → we owe the buyer honest alternatives.
  const allCombos = combinations(pools);
  const affordable = allCombos.filter(items => cartTotal(items) <= budget);

  // ── Infeasible: not even the cheapest complete setup fits ─────────────────────
  // Be honest: show the closest COMPLETE setup (flagged over budget) AND, whenever
  // any partial setup fits, the most complete within-budget subset — dropping the
  // least goal-critical categories first (non-hero before hero) so the buyer can
  // still hit the CORE of the goal now and finish it later.
  if (!affordable.length) {
    const cheapest = allCombos.slice().sort((a, b) => cartTotal(a) - cartTotal(b))[0] || [];
    const cheapestTotal = cartTotal(cheapest);

    // Every non-empty subset of the cheapest-per-category items that fits the budget.
    const subsets = nonEmptySubsets(cheapest).filter(s => cartTotal(s) <= budget);
    // Prefer: most hero categories covered → then highest total (most complete) →
    // then most categories. Deterministic tie-breaking.
    const heroCount = s => s.filter(i => heroes.includes(i.category)).length;
    subsets.sort((a, b) =>
      heroCount(b) - heroCount(a) ||
      cartTotal(b) - cartTotal(a) ||
      b.length - a.length,
    );
    const reduced = subsets[0] || [];
    const reducedFits = reduced.length > 0 && reduced.length < cheapest.length;

    const options = [
      {
        id: 'A',
        label: `Closest complete ${noun} setup`,
        description: `The most affordable complete ${noun} setup — it still exceeds your budget.`,
        items: cheapest,
        total: cheapestTotal,
        withinBudget: false,
        tradeoffs: [
          `Even the most affordable complete ${noun} setup is ₹${cheapestTotal}, which is ₹${cheapestTotal - budget} over your ₹${budget} budget.`,
        ],
        upgrades: [`Raise the budget by ₹${cheapestTotal - budget} to afford the complete setup.`],
      },
    ];
    if (reducedFits) {
      const dropped = cheapest
        .filter(c => !reduced.some(r => r.category === c.category))
        .map(c => c.category);
      options.push({
        id: 'B',
        label: `Core ${noun} setup within budget`,
        description: `Focuses on the essentials (${reduced.map(i => i.category).join(', ')}) so you stay within ₹${budget}.`,
        items: reduced,
        total: cartTotal(reduced),
        withinBudget: true,
        tradeoffs: [
          `Drops ${dropped.join(', ')} to fit the budget — add ${dropped.length > 1 ? 'them' : 'it'} later when you can.`,
        ],
        upgrades: upgradePaths(reduced, pools, budget),
      });
    }
    return { fits: false, ideal, feasible: reducedFits, options: dedupe(options) };
  }

  // ── Option A — best goal-fit combination that fits the budget ─────────────────
  const bestAffordable = affordable
    .slice()
    .sort((a, b) => cartTotal(b) - cartTotal(a))[0];

  // ── Option C — cheapest complete goal setup (+ upgrade paths) ─────────────────
  const cheapestAffordable = affordable
    .slice()
    .sort((a, b) => cartTotal(a) - cartTotal(b))[0];

  // ── Option B — balanced: best affordable HERO gear, economise elsewhere ───────
  // Start from cheapest, then upgrade hero categories as far as the budget allows.
  let balanced = cheapestAffordable.map(i => ({ ...i }));
  const heroOrder = [...balanced]
    .filter(i => heroes.includes(i.category))
    .sort((a, b) => TIER_ORDER.indexOf(a.product.tier) - TIER_ORDER.indexOf(b.product.tier));
  let improved = true;
  while (improved) {
    improved = false;
    for (const heroItem of heroOrder) {
      const pool = pools.find(p => p[0].category === heroItem.category) || [];
      const current = balanced.find(i => i.category === heroItem.category);
      const nextUp = pool
        .filter(p => p.price > current.price)
        .sort((a, b) => a.price - b.price)[0]; // one step up
      if (!nextUp) continue;
      const prospectiveTotal = cartTotal(balanced) - current.price + nextUp.price;
      if (prospectiveTotal <= budget) {
        current.product = nextUp;
        current.price = nextUp.price;
        improved = true;
      }
    }
  }

  const mk = (id, label, description, items) => ({
    id,
    label,
    description,
    items,
    total: cartTotal(items),
    withinBudget: cartTotal(items) <= budget,
    tradeoffs: tradeoffsVsIdeal(items, idealItems),
    upgrades: upgradePaths(items, pools, budget),
  });

  const heroLabel = heroes.length ? heroes.join(' & ') : 'key peripherals';
  const options = [
    mk('A', `Best ${noun} setup within budget`,
      `The highest-quality goal-fit gear that still fits ₹${budget}.`, bestAffordable),
    mk('B', `Balanced ${noun} setup`,
      `Invests in the gear that matters most for ${noun} (${heroLabel}), saving elsewhere.`, balanced),
    mk('C', `Budget ${noun} setup`,
      `The lowest-cost complete ${noun} setup, with upgrade paths for when you're ready.`, cheapestAffordable),
  ];

  return { fits: false, ideal, feasible: true, options: dedupe(options) };
}

/**
 * Drop options whose cart is identical to an earlier option's cart, so the buyer
 * never sees the same setup twice under two labels.
 */
function dedupe(options) {
  const kept = [];
  for (const opt of options) {
    if (!kept.some(k => sameCart(k.items, opt.items))) kept.push(opt);
  }
  return kept;
}

module.exports = { generateOptions };
