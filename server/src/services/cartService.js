'use strict';

const { goalFitProducts } = require('./goalService');

/**
 * The candidate products for a category. When the intent carries a `useCase`
 * (the goal-first pipeline), the pool is restricted to GOAL-FIT products so a
 * gaming request only ever considers gaming-suitable gear (Problem 1). When no
 * useCase is present (legacy callers / older test fixtures), every in-stock
 * product in the category is a candidate — byte-for-byte the original behaviour.
 *
 * @param {CatalogProduct[]} catalog
 * @param {string} category
 * @param {string} [useCase]
 * @returns {CatalogProduct[]}
 */
function candidatePool(catalog, category, useCase) {
  if (useCase) return goalFitProducts(catalog, category, useCase);
  return catalog.filter(p => p.category === category && p.stock > 0);
}

/**
 * Pick the best candidate for a given category.
 * "Best" = highest price (most premium in-stock option) within the candidate pool.
 *
 * @param {CatalogProduct[]} catalog
 * @param {string} category
 * @param {string} [useCase]
 * @returns {CatalogProduct|null}
 */
function pickBest(catalog, category, useCase) {
  return (
    candidatePool(catalog, category, useCase)
      .slice()
      .sort((a, b) => b.price - a.price)[0] ?? null
  );
}

/**
 * Pick the cheapest candidate for a given category — the entry-level option.
 * Used by the 'goalfit' baseline so the buyer starts lean and the merchant has
 * genuine tier-up HEADROOM to grow revenue into (upsell).
 *
 * @param {CatalogProduct[]} catalog
 * @param {string} category
 * @param {string} [useCase]
 * @returns {CatalogProduct|null}
 */
function pickEntry(catalog, category, useCase) {
  return (
    candidatePool(catalog, category, useCase)
      .slice()
      .sort((a, b) => a.price - b.price)[0] ?? null
  );
}

/**
 * Build a cart from an Intent and a catalog.
 *
 * Baseline strategy (intent.baselineStrategy, default 'premium'):
 *   • 'premium' — highest-price in-stock product per category. This is the
 *     historical behaviour; every existing test relies on it, so it stays the
 *     default whenever no strategy is specified.
 *   • 'goalfit' — cheapest in-stock product per category. Produces an
 *     UNDER-budget baseline with tier-up headroom so the revenue-GROWTH path
 *     (upsell / cross-sell / bundle) has something to work with. The revenue
 *     uplift is then measured against THIS lean baseline.
 *
 * No budget constraint is applied here; negotiation adjusts afterward
 * (RESCUE downgrades if over budget, GROWTH upsells if under).
 *
 * @param {Intent}            intent
 * @param {CatalogProduct[]}  catalog
 * @returns {{ items: Array, total: number, currency: string, budget: number, over_budget: boolean, baselineStrategy: string }}
 */
function buildCart(intent, catalog) {
  const { budget, preferences, useCase } = intent;
  // Goal-first pipeline: use the scope-aware categories array from classifyGoal().
  // Legacy callers (tests without goal enrichment): fall back to Object.keys(preferences).
  const categories = Array.isArray(intent.categories) && intent.categories.length
    ? intent.categories
    : Object.keys(preferences);
  const strategy = intent.baselineStrategy === 'goalfit' ? 'goalfit' : 'premium';
  const pick = strategy === 'goalfit' ? pickEntry : pickBest;

  const items = [];
  for (const category of categories) {
    const product = pick(catalog, category, useCase);
    if (product) {
      items.push({ product, category, price: product.price });
    }
  }

  const total = items.reduce((sum, item) => sum + item.price, 0);

  return {
    items,
    total,
    currency: 'INR',
    budget,
    over_budget: total > budget,
    baselineStrategy: strategy,
  };
}

module.exports = { buildCart };
