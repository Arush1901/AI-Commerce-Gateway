'use strict';

const { getValidSubstitutes } = require('./constraintService');

/**
 * Merchant Agent
 *
 * Represents the seller's side of the negotiation.
 * Deterministic — no AI, no randomness.
 * Only proposes downgrade substitutions; never touches protected items.
 */
const merchantAgent = {
  /**
   * Respond to a BuyerRequest with a cost-reduction offer.
   *
   * Strategy:
   *   1. Walk cart items in preference-weight order (low → medium, skipping locked).
   *   2. For each non-protected item, find valid downgrade substitutes.
   *   3. Pick the substitute that covers the largest individual saving.
   *   4. Return the first offer that makes a meaningful saving.
   *   5. If no substitution is possible, return a no_offer response.
   *
   * @param {BuyerRequest}                                   request
   * @param {{ items: Array<{product, category, price}> }}   cart
   * @param {CatalogProduct[]}                               catalog
   * @returns {MerchantOffer}
   */
  respond(request, cart, catalog) {
    const { protected_items } = request;

    for (const item of cart.items) {
      // Never touch protected items
      if (protected_items.includes(item.category)) continue;

      const substitutes = getValidSubstitutes(item.product.id, catalog)
        .filter(s => s.stock > 0);

      if (substitutes.length === 0) continue;

      // Pick the substitute with the greatest price reduction
      const best = substitutes.sort((a, b) => a.price - b.price)[0];
      const saving = item.price - best.price;

      if (saving <= 0) continue; // no actual saving

      return {
        action:      'substitute',
        replacement: best,
        saving,
        reason: `Replaced ${item.product.name} (₹${item.price}) with ` +
                `${best.name} (₹${best.price}) — saves ₹${saving}`,
      };
    }

    // Nothing could be substituted
    return {
      action:      'no_offer',
      replacement: null,
      saving:      0,
      reason:      'No valid downgrade substitution available for non-protected items',
    };
  },
};

module.exports = { merchantAgent };
