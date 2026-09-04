'use strict';

const { BuyerAgent }        = require('./BuyerAgent');
const { MerchantAgent }     = require('./MerchantAgent');
const { mandateFromIntent } = require('./mandate');

const MAX_ROUNDS = 5;

/**
 * NegotiationSession — orchestrates a multi-round buyer ↔ merchant negotiation.
 *
 * TWO objectives, chosen by the cart's position relative to the spend ceiling
 * (mandate.maxSpend when a mandate is supplied, else intent.budget):
 *
 *   • cart OVER ceiling  → _runRescue()  — downgrade to close the gap.
 *                          Byte-for-byte the Stage 13 behaviour; every existing
 *                          negotiation/ orchestrator test exercises this path.
 *
 *   • cart UNDER ceiling → _runGrowth()  — MAXIMISE merchant revenue within the
 *                          buyer's mandate via upsell / cross-sell / bundle.
 *                          When no growth move fits (as in every current test
 *                          fixture — locked/entry-only carts with no upgrades or
 *                          complements) this returns the exact same "approved,
 *                          0 rounds" result the within-budget path returned before.
 *
 * Returns a result object that is:
 *   - Backward-compatible with orchestrator.js (status, finalCart, effectiveCart,
 *     best_offer, gap, offers[], rounds)
 *   - Extended with Stage 13 fields (transcript[], history[], finalAgreement)
 *
 * The `offers` array uses the LEGACY format. RESCUE offers carry action
 * 'substitute' (consumed by orchestrator's applyOffer / validateAllMerchantOffers);
 * GROWTH offers carry action 'grow' so the merchant-policy discount check
 * correctly ignores them (a bundle's discount is already bounded at proposal time).
 */
class NegotiationSession {
  constructor(intent, initialCart, catalog, opts = {}) {
    this.intent         = intent;
    this.catalog        = catalog;
    this.mandate        = opts.mandate ?? null;
    this.merchantPolicy = opts.merchantPolicy ?? null;
    this.buyer          = new BuyerAgent(intent, this.mandate);
    this.merchant       = new MerchantAgent(catalog, { merchantPolicy: this.merchantPolicy });
    this.currentCart    = initialCart;
    this.history        = [];     // NegotiationHistoryEntry[]
    this.transcript     = [];     // string[] — human-readable conversation log
    this.legacyOffers   = [];     // { round, offer: LegacyOffer }[] — compat with orchestrator
  }

  /** Spend ceiling that decides rescue vs growth (mandate wins over bare budget). */
  _spendCeiling() {
    if (this.mandate && typeof this.mandate.maxSpend === 'number') return this.mandate.maxSpend;
    return this.intent.budget;
  }

  run() {
    if (this.currentCart.total > this._spendCeiling()) {
      return this._runRescue();
    }
    return this._runGrowth();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RESCUE PATH (cart over ceiling) — unchanged Stage 13 downgrade loop
  // ══════════════════════════════════════════════════════════════════════════

  _runRescue() {
    // Buyer opens conversation
    let buyerAction = this.buyer.openingStatement(this.currentCart);
    this._log('Buyer', 1, buyerAction.message);

    for (let round = 1; round <= MAX_ROUNDS; round++) {

      if (buyerAction.action === 'accept')  return this._approved(round - 1, buyerAction.acceptedOffer);
      if (buyerAction.action === 'escalate') return this._escalated(round - 1);

      // ── Merchant turn ────────────────────────────────────────────────────────
      const merchantOffer = this.merchant.respond(buyerAction, this.currentCart, this.history);
      this._log('Merchant', round, merchantOffer.message);

      // Apply concrete offer to cart
      if (merchantOffer.offer?.replacementProduct) {
        this.currentCart = _applyAgentOffer(this.currentCart, merchantOffer.offer);
        this.legacyOffers.push({ round, offer: _toLegacyOffer(merchantOffer.offer) });
      }

      // Record this round
      this.history.push({ round, buyer: buyerAction, merchant: merchantOffer });

      // ── Buyer evaluates ──────────────────────────────────────────────────────
      const isLastRound = round >= MAX_ROUNDS;
      buyerAction = this.buyer.evaluate(merchantOffer, this.currentCart, isLastRound);
      this._log('Buyer', round, buyerAction.message);
    }

    return this._escalated(MAX_ROUNDS);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GROWTH PATH (cart under ceiling) — grow revenue within the mandate
  // ══════════════════════════════════════════════════════════════════════════

  _runGrowth() {
    // Use the supplied mandate, or synthesise one from the intent so the buyer
    // still has an explicit spend/category boundary to enforce.
    const mandate = this.mandate ?? mandateFromIntent(this.intent);
    const locked  = this.buyer.lockedItems;
    let acceptedOffer = null;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const merchantOffer = this.merchant.proposeGrowth(this.currentCart, mandate, locked);

      // No (more) growth moves that fit the mandate.
      if (!merchantOffer.offer) {
        // Round 1 with nothing to grow ⇒ the cart is already optimal.
        // Return the exact legacy "approved, 0 rounds, no history" result.
        if (round === 1) break;
        this._log('Merchant', round, merchantOffer.message);
        break;
      }

      // Opening context on the first real proposal (demo-friendly; never runs
      // in the existing test fixtures, which surface zero growth candidates).
      if (round === 1) {
        this._log('Buyer', 1,
          `Goal "${this.intent.goal}"; mandate ceiling ₹${mandate.maxSpend}. Current spend ` +
          `₹${this.currentCart.total} leaves ₹${mandate.maxSpend - this.currentCart.total} of headroom — ` +
          `I'll consider upgrades that add value and stay in bounds.`);
      }

      this._log('Merchant', round, merchantOffer.message);

      // Cart IF the offer were applied, then the buyer judges it against the mandate.
      const prospective = _applyGrowthOffer(this.currentCart, merchantOffer.offer);
      const buyerAction = this.buyer.evaluateGrowth(merchantOffer, prospective, mandate);
      this._log('Buyer', round, buyerAction.message);

      this.history.push({ round, buyer: buyerAction, merchant: merchantOffer });

      if (buyerAction.action === 'accept') {
        this.currentCart = prospective;
        this.merchant.commitMove(merchantOffer.offer);
        this.legacyOffers.push({ round, offer: _toGrowthLegacyOffer(merchantOffer.offer) });
        acceptedOffer = buyerAction.acceptedOffer ?? merchantOffer.offer;
      } else {
        // Declined — over-mandate breach or too little utility. GRACEFUL FALLBACK:
        // record the rejection so this exact move is never re-proposed, and let
        // the merchant fall back to its next-best fitting move next round.
        this.merchant.rejectMove(merchantOffer.offer);
      }
    }

    // Growth always "succeeds": worst case nothing was added and we approve the
    // original cart (identical to the legacy within-budget path).
    return this._approved(this.history.length, acceptedOffer);
  }

  // ─── result builders ──────────────────────────────────────────────────────────

  _approved(conversationRound, acceptedOffer) {
    const rounds = this.legacyOffers.length;
    return {
      status:         'approved',
      finalCart:      this.currentCart,
      offers:         this.legacyOffers,
      rounds,
      best_offer:     this.legacyOffers[rounds - 1]?.offer ?? null,
      gap:            0,
      // Stage 13 fields
      transcript:     this.transcript,
      history:        this.history,
      finalAgreement: { round: conversationRound, acceptedOffer: acceptedOffer ?? null, finalCart: this.currentCart },
    };
  }

  _escalated(conversationRound) {
    const rounds = this.legacyOffers.length;
    return {
      status:         'escalation_needed',
      effectiveCart:  this.currentCart,
      best_offer:     this.legacyOffers[rounds - 1]?.offer ?? null,
      gap:            this.currentCart.total - this.intent.budget,
      offers:         this.legacyOffers,
      rounds,
      // Stage 13 fields
      transcript:     this.transcript,
      history:        this.history,
      finalAgreement: null,
    };
  }

  _log(speaker, round, message) {
    this.transcript.push(`[Round ${round}] ${speaker}: ${message}`);
  }
}

// ─── pure helpers (no circular deps — not re-exported from negotiationService) ──

/**
 * Apply an agent-format RESCUE offer to a cart, matching by originalProductId.
 * Returns a new cart, never mutates the original.
 */
function _applyAgentOffer(cart, agentOffer) {
  const { originalProductId, replacementProduct } = agentOffer;
  const items = cart.items.map(item =>
    item.product.id === originalProductId
      ? { product: replacementProduct, category: replacementProduct.category, price: replacementProduct.price }
      : item
  );
  const total = items.reduce((sum, i) => sum + i.price, 0);
  return { ...cart, items, total, over_budget: total > cart.budget };
}

/**
 * Apply an agent-format GROWTH offer to a cart. Immutable.
 *   • upsell            → swap the upgraded product in place (by originalProductId)
 *   • cross_sell/bundle → append the added accessory product(s)
 */
function _applyGrowthOffer(cart, offer) {
  let items;
  if (offer.kind === 'upsell') {
    items = cart.items.map(item =>
      item.product.id === offer.originalProductId
        ? { product: offer.replacementProduct, category: offer.replacementProduct.category, price: offer.replacementProduct.price }
        : item
    );
  } else {
    const added = (offer.addedProducts ?? []).map(p => ({ product: p, category: p.category, price: p.price }));
    items = [...cart.items, ...added];
  }
  const total = items.reduce((sum, i) => sum + i.price, 0);
  return { ...cart, items, total, over_budget: total > cart.budget };
}

/**
 * Convert an agent-format RESCUE offer to the legacy format expected by
 * orchestrator.js (applyOffer + validateAllMerchantOffers).
 */
function _toLegacyOffer(agentOffer) {
  return {
    action:      'substitute',
    original:    agentOffer.originalProduct,
    replacement: agentOffer.replacementProduct,
    saving:      agentOffer.savings,
    reason:      agentOffer.reason,
  };
}

/**
 * Convert an agent-format GROWTH offer to a legacy trace record. The action is
 * deliberately 'grow' (NOT 'substitute') so orchestrator's substitute-only
 * merchant-policy discount check ignores it and getEffectiveCart never
 * double-applies it — the grown cart is already carried on finalCart.
 */
function _toGrowthLegacyOffer(offer) {
  return {
    action:       'grow',
    kind:         offer.kind,                       // upsell | cross_sell | bundle
    original:     offer.originalProduct ?? null,
    replacement:  offer.replacementProduct ?? null,
    added:        offer.addedProducts ?? null,
    saving:       offer.savings ?? 0,               // ≤ 0 (buyer pays more)
    revenueDelta: offer.revenueDelta ?? 0,          // ≥ 0 (merchant gains)
    discountPct:  offer.discountPct ?? 0,
    reason:       offer.reason ?? '',
  };
}

module.exports = { NegotiationSession, MAX_ROUNDS };
