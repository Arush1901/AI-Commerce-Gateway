'use strict';

const { isLocked } = require('./constraintService');

/**
 * Buyer Agent
 *
 * Represents the buyer's side of the negotiation.
 * Deterministic — no AI, no randomness.
 */
const buyerAgent = {
  /**
   * Build a BuyerRequest from the current cart and buyer intent.
   *
   * @param {{ items: Array, total: number, budget: number }} cart
   * @param {Intent} intent
   * @returns {BuyerRequest}
   */
  request(cart, intent) {
    const overage = cart.total - intent.budget;

    // Collect categories the buyer has marked as locked
    const protected_items = Object.keys(intent.preferences).filter(
      category => isLocked(category, intent)
    );

    return {
      action: overage > 0
        ? `reduce_cost_by_${overage}`          // e.g. "reduce_cost_by_1500"
        : 'no_action_needed',
      budget_limit: intent.budget,
      protected_items,
    };
  },
};

module.exports = { buyerAgent };
