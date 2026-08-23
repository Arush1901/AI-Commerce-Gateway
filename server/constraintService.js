'use strict';

// ─── Tier adjacency map (explicit data, no AI) ───────────────────────────────
//
// Tiers ordered from highest to lowest: pro → office → lite
// Adjacent means ±1 step on this ladder.
//
// Stored as a plain object so it is easy to extend without touching logic.
// Only downgrade paths are listed — substitutes must reduce cost, not increase it.
//
const TIER_ORDER = ['pro', 'office', 'lite'];

const ADJACENT_TIERS = {
  pro:    ['office'],  // pro   → can downgrade to office
  office: ['lite'],    // office → can downgrade to lite
  lite:   [],          // lite  → no further downgrade available
};
// Upward movement (lite → office, office → pro) is intentionally excluded.

// ─── isLocked ────────────────────────────────────────────────────────────────

/**
 * Returns true when the item is marked "locked" in the buyer's intent.
 * Locked items must not be substituted or removed during negotiation.
 *
 * @param {string} item   - Category or item key (e.g. "headset")
 * @param {Intent} intent - Buyer intent with preferences map
 * @returns {boolean}
 */
function isLocked(item, intent) {
  return intent?.preferences?.[item] === 'locked';
}

// ─── getValidSubstitutes ──────────────────────────────────────────────────────

/**
 * Return all valid substitute products for a given product.
 *
 * Substitution rules (stored above as data, not inferred by AI):
 *   1. Must be the same category as the source product.
 *   2. Must be in an adjacent tier only (±1 step on the TIER_ORDER ladder).
 *   3. Must not be the source product itself.
 *   4. Must be in stock.
 *
 * @param {string}           productId - ID of the product to substitute
 * @param {CatalogProduct[]} catalog   - Full product catalog
 * @returns {CatalogProduct[]}         - Valid substitutes (may be empty)
 */
function getValidSubstitutes(productId, catalog) {
  const source = catalog.find(p => p.id === productId);
  if (!source) return [];

  const allowedTiers = ADJACENT_TIERS[source.tier] ?? [];

  return catalog.filter(p =>
    p.id       !== productId        &&   // not the same product
    p.category === source.category  &&   // same category
    allowedTiers.includes(p.tier)   &&   // adjacent tier
    p.stock    >  0                      // in stock
  );
}

module.exports = { isLocked, getValidSubstitutes, TIER_ORDER, ADJACENT_TIERS };
