'use strict';

const { NegotiationSession } = require('../agents/NegotiationSession');

// ─── applyOffer ────────────────────────────────────────────────────────────────
// Kept as a named export for orchestrator.js backward compatibility.
// Used by getEffectiveCart() legacy fallback (reconstructs from offer log).
// With Stage 13, negotiationResult.effectiveCart is set directly, so this
// rarely executes — but must remain for safety.

/**
 * Apply a MerchantOffer (legacy format) to a cart. Immutable.
 * Matches by replacement.category (legacy contract).
 */
function applyOffer(cart, offer) {
  const { replacement } = offer;
  const items = cart.items.map(item =>
    item.category === replacement.category
      ? { product: replacement, category: replacement.category, price: replacement.price }
      : item
  );
  const total = items.reduce((sum, i) => sum + i.price, 0);
  return { ...cart, items, total, over_budget: total > cart.budget };
}

// ─── negotiate ────────────────────────────────────────────────────────────────

/**
 * Run an AI-agent negotiation session.
 *
 * Delegates to NegotiationSession (Stage 13 agentic layer).
 * Returns a result object backward-compatible with orchestrator.js:
 *
 *   approved:
 *     { status, finalCart, offers, rounds, best_offer, gap,
 *       transcript, history, finalAgreement }
 *
 *   escalation_needed:
 *     { status, effectiveCart, best_offer, gap, offers, rounds,
 *       transcript, history, finalAgreement: null }
 *
 * @param {{ items: Array, total: number, budget: number }} cart
 * @param {Intent}           intent
 * @param {CatalogProduct[]} catalog
 * @param {{ mandate?: object, merchantPolicy?: object }} [opts]
 *        Optional Stage 14 wiring. When omitted, the session runs in legacy
 *        mode (spend ceiling = intent.budget, no growth) so every existing
 *        3-argument caller is unaffected.
 * @returns {object}
 */
function negotiate(cart, intent, catalog, opts = {}) {
  const session = new NegotiationSession(intent, cart, catalog, opts);
  return session.run();
}

module.exports = { negotiate, applyOffer };

