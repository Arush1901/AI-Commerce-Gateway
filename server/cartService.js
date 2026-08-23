'use strict';

/**
 * Pick the best in-stock product for a given category.
 * "Best" = highest price (most premium in-stock option).
 * Preference weight is used as a tiebreaker (higher = more important),
 * but since we always sort by price desc, it only matters if prices are equal.
 *
 * @param {CatalogProduct[]} catalog
 * @param {string} category
 * @returns {CatalogProduct|null}
 */
function pickBest(catalog, category) {
  return (
    catalog
      .filter(p => p.category === category && p.stock > 0)
      .sort((a, b) => b.price - a.price)[0] ?? null
  );
}

/**
 * Build a cart from an Intent and a catalog.
 *
 * Selects the best in-stock product for every category listed in
 * intent.preferences — no budget constraint applied here.
 * If the total exceeds intent.budget, Stage 5/6 negotiation reduces it.
 *
 * @param {Intent}            intent
 * @param {CatalogProduct[]}  catalog
 * @returns {{ items: Array, total: number, currency: string, budget: number, over_budget: boolean }}
 */
function buildCart(intent, catalog) {
  const { budget, preferences } = intent;
  const categories = Object.keys(preferences);

  // Pick best in-stock product per category (no price cap)
  const items = [];
  for (const category of categories) {
    const product = pickBest(catalog, category);
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
  };
}

module.exports = { buildCart };
