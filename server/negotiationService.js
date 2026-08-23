'use strict';

const { buyerAgent }    = require('./buyerAgent');
const { merchantAgent } = require('./merchantAgent');

const MAX_ROUNDS = 2;

// ─── applyOffer ───────────────────────────────────────────────────────────────

/**
 * Apply a MerchantOffer to the current cart, producing a new cart.
 * Never mutates the original cart.
 *
 * @param {{ items: Array, total: number, budget: number, currency: string }} cart
 * @param {MerchantOffer} offer
 * @returns {typeof cart}
 */
function applyOffer(cart, offer) {
  const { replacement } = offer;

  const items = cart.items.map(item =>
    item.category === replacement.category
      ? { product: replacement, category: replacement.category, price: replacement.price }
      : item
  );

  const total = items.reduce((sum, i) => sum + i.price, 0);

  return {
    ...cart,
    items,
    total,
    over_budget: total > cart.budget,
  };
}

// ─── negotiate ────────────────────────────────────────────────────────────────

/**
 * Run up to MAX_ROUNDS (2) of buyer → merchant negotiation.
 *
 * Each round:
 *   1. Buyer issues a request (budget gap + protected items).
 *   2. Merchant finds the best valid downgrade substitution.
 *   3. If an offer is made, apply it to produce an updated cart.
 *   4. If cart.total ≤ intent.budget, return "approved".
 *   5. Otherwise, continue to the next round.
 *
 * After MAX_ROUNDS, if still over budget, return "escalation_needed".
 *
 * @param {{ items: Array, total: number, budget: number }} cart
 * @param {Intent}           intent
 * @param {CatalogProduct[]} catalog
 * @returns {{ status: string, finalCart?: object, offers: Array, rounds: number }
 *          |{ status: string, best_offer: object|null, gap: number }}
 */
function negotiate(cart, intent, catalog) {
  let currentCart = cart;
  const offers    = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // Already within budget before this round starts
    if (!currentCart.over_budget) {
      return {
        status:    'approved',
        finalCart: currentCart,
        offers,
        rounds:    round - 1,
      };
    }

    const request = buyerAgent.request(currentCart, intent);
    const offer   = merchantAgent.respond(request, currentCart, catalog);

    offers.push({ round, offer });

    if (offer.action === 'no_offer') break; // merchant has nothing left to offer

    currentCart = applyOffer(currentCart, offer);

    if (!currentCart.over_budget) {
      return {
        status:    'approved',
        finalCart: currentCart,
        offers,
        rounds:    round,
      };
    }
  }

  // Exhausted all rounds — escalate
  return {
    status:     'escalation_needed',
    best_offer: offers[offers.length - 1]?.offer ?? null,
    gap:        currentCart.total - intent.budget,
    offers,
    rounds:     offers.length,
  };
}

module.exports = { negotiate, applyOffer };
