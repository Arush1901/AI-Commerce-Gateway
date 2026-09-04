'use strict';

const { validateBuyerAction, assertValid } = require('./agentSchemas');
const { cartWithinMandate } = require('./mandate');

/**
 * BuyerAgent — deterministic buyer-side negotiation logic.
 *
 * Objective: maximise goal-fit utility SUBJECT TO the mandate.
 *   • RESCUE path (over budget): openingStatement()/evaluate() push the merchant
 *     to cut the cart down to the budget. (Unchanged from Stage 13.)
 *   • GROWTH path (under budget): evaluateGrowth() accepts revenue-growing offers
 *     that stay inside the mandate and add value, and DECLINES any offer that
 *     would breach the mandate (spend ceiling or category whitelist) — this is
 *     the hard guardrail that makes the failure case graceful.
 */
class BuyerAgent {
  constructor(intent, mandate = null) {
    this.intent = intent;
    this.mandate = mandate;
    this.lockedItems = Object.entries(intent.preferences ?? {})
      .filter(([, v]) => v === 'locked')
      .map(([k]) => k);
  }

  /** Produce opening statement before Round 1. */
  openingStatement(cart) {
    const overBy = cart.total - this.intent.budget;
    if (overBy <= 0) {
      return this._make('accept',
        `Cart total ₹${cart.total} is within my budget of ₹${this.intent.budget}. No negotiation needed.`,
        null, null);
    }
    const lockedMsg = this.lockedItems.length
      ? ` Items that cannot be changed: ${this.lockedItems.join(', ')}.`
      : '';
    return this._make('counter_offer',
      `My budget is ₹${this.intent.budget}. Current total is ₹${cart.total} (₹${overBy} over).${lockedMsg} I need a price reduction of at least ₹${overBy}.`,
      { maxTotal: this.intent.budget, lockedItems: this.lockedItems, requiredReduction: overBy },
      null);
  }

  /**
   * Evaluate a merchant offer and respond (RESCUE path — over budget).
   * @param {object} merchantOffer
   * @param {{ total: number }} currentCart  — AFTER offer applied
   * @param {boolean} isLastRound
   */
  evaluate(merchantOffer, currentCart, isLastRound = false) {
    if (merchantOffer.action === 'reject_request') {
      return this._make('escalate', 'Merchant has no valid offers. Escalating for manual review.', null, null);
    }
    if (merchantOffer.action === 'final_offer' && !merchantOffer.offer) {
      return this._make('escalate', 'Merchant has no further substitutions. Escalating.', null, null);
    }
    if (!merchantOffer.offer) {
      if (isLastRound) return this._make('escalate', 'Round limit reached — no agreement found.', null, null);
      return this._make('reject', 'No concrete offer was provided. Please make a specific proposal.', null, null);
    }

    const violatedLock = this._lockViolation(merchantOffer.offer);
    if (violatedLock) {
      return this._make('reject',
        `Cannot accept — the offer affects locked item "${violatedLock}". Please propose an alternative that does not involve: ${this.lockedItems.join(', ')}.`,
        null, null);
    }

    if (currentCart.total <= this.intent.budget) {
      return this._make('accept',
        `Offer accepted. Cart is now ₹${currentCart.total}, within my budget of ₹${this.intent.budget}.`,
        null, merchantOffer.offer);
    }

    const remaining = currentCart.total - this.intent.budget;
    if (isLastRound || merchantOffer.action === 'final_offer') {
      return this._make('escalate', `Still ₹${remaining} over budget after merchant offer. Escalating.`, null, null);
    }
    return this._make('counter_offer',
      `Good progress — cart is now ₹${currentCart.total}, but still ₹${remaining} over my budget. I need further reductions.`,
      { maxTotal: this.intent.budget, lockedItems: this.lockedItems, requiredReduction: remaining },
      null);
  }

  /**
   * Evaluate a revenue-GROWTH offer against the mandate + goal utility.
   *
   * @param {object} merchantOffer                 the growth proposal
   * @param {{ total:number, items:Array }} prospectiveCart  cart IF the offer is applied
   * @param {object} mandate                       signed buyer mandate (spend + categories)
   * @returns {object} BuyerAction — accept | counter_offer(decline)
   */
  evaluateGrowth(merchantOffer, prospectiveCart, mandate = this.mandate) {
    // No concrete offer → nothing to grow; accept the current position.
    if (!merchantOffer || !merchantOffer.offer) {
      return this._make('accept',
        'No further offers. I\'ll proceed with my current selection.', null, null);
    }

    const offer = merchantOffer.offer;

    // HARD GUARDRAIL: the offer must keep the cart inside the mandate.
    const within = mandate ? cartWithinMandate(prospectiveCart, mandate) : { ok: true, violations: [] };
    if (!within.ok) {
      return this._make('counter_offer',
        `I can't accept that — it would breach my mandate (${within.violations.join('; ')}). ` +
        `Please keep the total within ₹${mandate.maxSpend} and my allowed categories.`,
        { maxTotal: mandate?.maxSpend ?? null, reason: 'mandate_breach' },
        null);
    }

    // Value test: the merchant only surfaces goal-aligned growth; accept it.
    if (offer.goalAligned !== false) {
      const delta = offer.revenueDelta ?? Math.abs(offer.savings ?? 0);
      return this._make('accept',
        `Accepted — that adds value and stays within my mandate. New total ₹${prospectiveCart.total} ` +
        `(₹${mandate ? mandate.maxSpend - prospectiveCart.total : '—'} still spare). Worth the extra ₹${delta}.`,
        null, offer);
    }

    // Otherwise decline this specific offer but stay at the table.
    return this._make('counter_offer',
      'That doesn\'t improve my setup enough to justify the spend. Do you have something more relevant?',
      { maxTotal: mandate?.maxSpend ?? null, reason: 'low_utility' },
      null);
  }

  _lockViolation(offer) {
    if (!offer.originalProduct) return null;
    const cat = offer.originalProduct.category;
    return this.lockedItems.includes(cat) ? cat : null;
  }

  _make(action, message, requirements, acceptedOffer) {
    const obj = { action, message, requirements: requirements ?? null, acceptedOffer: acceptedOffer ?? null };
    assertValid('BuyerAction', obj, validateBuyerAction);
    return obj;
  }
}

module.exports = { BuyerAgent };
