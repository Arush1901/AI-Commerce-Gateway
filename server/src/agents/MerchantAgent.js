'use strict';

const { getValidSubstitutes, getValidUpgrades } = require('../services/constraintService');
const { validateMerchantOffer, assertValid } = require('./agentSchemas');

// Default bundle discount (%). Bounded further by merchantPolicy.max_discount
// when one is supplied — "discount capped by policy → automatically gated."
const DEFAULT_BUNDLE_DISCOUNT_PCT = 12;

/**
 * MerchantAgent — deterministic seller-side negotiation logic.
 *
 * TWO objectives, chosen by the buyer's position relative to their mandate:
 *
 *   • RESCUE  (buyer OVER budget)  → respond(): downgrade the cart the minimum
 *     needed to close the gap. A completed sale beats an abandoned cart.
 *     ── unchanged from Stage 13; this is the fallback / conversion-recovery path.
 *
 *   • GROWTH  (buyer UNDER budget) → proposeGrowth(): MAXIMISE merchant revenue
 *     within the buyer's mandate via upsell / cross-sell / bundle. This is the
 *     revenue-growth objective that makes the merchant "sellable to AI buyers".
 *
 * Golden rule: "LLM proposes, rules dispose." Move GENERATION could be swapped
 * for an LLM; the accept/bound decisions stay deterministic here and in the
 * buyer/mandate/policy layers so every money action stays explainable.
 */
class MerchantAgent {
  constructor(catalog, opts = {}) {
    this.catalog = catalog;
    this.merchantPolicy = opts.merchantPolicy ?? null;

    // RESCUE state (one downgrade per category)
    this.substitutedCats = new Set();

    // GROWTH state
    this.grownCats        = new Set();  // categories already upsold (one upsell each)
    this.attachedIds      = new Set();  // accessory ids already added (cross-sell/bundle)
    this.bundledAnchorIds = new Set();  // anchor items already bundled (one bundle each)
    this.rejectedMoveKeys = new Set();  // moves the buyer declined — never re-propose
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RESCUE PATH (buyer over budget) — unchanged downgrade behaviour
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Respond to a buyer action with a downgrade offer (rescue path).
   * @param {object} buyerAction
   * @param {{ items: Array }} cart
   * @param {object[]} history
   */
  respond(buyerAction, cart, history) {
    const lockedItems = buyerAction.requirements?.lockedItems ?? [];
    const candidate   = this._findCandidate(cart, lockedItems);

    if (!candidate) {
      const isFirstAttempt = history.length === 0;
      const offer = {
        action:  isFirstAttempt ? 'reject_request' : 'final_offer',
        message: isFirstAttempt
          ? 'I have no valid substitution options available for your cart.'
          : 'This is my final position — no further substitutions available.',
        offer: null,
      };
      assertValid('MerchantOffer', offer, validateMerchantOffer);
      return offer;
    }

    const { cartItem, replacement } = candidate;
    const saving = cartItem.price - replacement.price;
    this.substitutedCats.add(cartItem.category);

    const offer = {
      action: 'offer_substitution',
      message:
        `I can replace the ${cartItem.product.name} (₹${cartItem.price}) with ` +
        `${replacement.name} (₹${replacement.price}), saving you ₹${saving}. ` +
        `${replacement.name} is a reliable ${replacement.tier}-tier option in the same ${replacement.category} category.`,
      offer: {
        originalProductId:    cartItem.product.id,
        replacementProductId: replacement.id,
        originalProduct:      cartItem.product,
        replacementProduct:   replacement,
        savings:              saving,
        reason:
          `Substitute ${cartItem.product.tier} → ${replacement.tier} (${replacement.category}), saves ₹${saving}`,
      },
    };
    assertValid('MerchantOffer', offer, validateMerchantOffer);
    return offer;
  }

  _findCandidate(cart, lockedItems) {
    for (const cartItem of cart.items) {
      const cat = cartItem.category ?? cartItem.product?.category;
      if (!cat) continue;
      if (lockedItems.includes(cat)) continue;
      if (this.substitutedCats.has(cat)) continue;

      const subs = getValidSubstitutes(cartItem.product.id, this.catalog)
        .filter(s => s.stock > 0);
      if (!subs.length) continue;

      const replacement = subs.sort((a, b) => a.price - b.price)[0];
      if (cartItem.price - replacement.price <= 0) continue;

      return { cartItem, replacement };
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GROWTH PATH (buyer under budget) — maximise revenue within the mandate
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Propose the single highest-revenue growth move available, ranked across
   * upsell / cross-sell / bundle candidates. The merchant proposes ambitiously
   * (by revenue); the BUYER + MANDATE decide what is in-bounds — so an
   * over-mandate proposal is possible and will be declined (the failure beat),
   * after which the next-best fitting move is proposed.
   *
   * @param {{ items: Array, total: number }} cart   current cart
   * @param {object}   mandate                        signed buyer mandate
   * @param {string[]} lockedCategories               categories that may not change
   * @returns {MerchantOffer}  offer_substitution | offer_bundle | final_offer(null)
   */
  proposeGrowth(cart, mandate, lockedCategories = []) {
    const candidates = this._growthCandidates(cart, mandate, lockedCategories)
      .filter(c => !this.rejectedMoveKeys.has(c.moveKey))
      .sort((a, b) => b.revenueDelta - a.revenueDelta);

    if (candidates.length === 0) {
      const offer = {
        action:  'final_offer',
        message: 'No further revenue-growing options that fit your mandate — happy to proceed with the current selection.',
        offer:   null,
      };
      assertValid('MerchantOffer', offer, validateMerchantOffer);
      return offer;
    }

    const best  = candidates[0];
    const offer = this._toMerchantOffer(best);
    assertValid('MerchantOffer', offer, validateMerchantOffer);
    return offer;
  }

  /** Build every candidate growth move from the current cart. */
  _growthCandidates(cart, mandate, lockedCategories) {
    const out = [];
    const allowed = Array.isArray(mandate?.allowedCategories) ? mandate.allowedCategories : null;
    const inCartIds = new Set(cart.items.map(i => i.product.id));

    for (const item of cart.items) {
      const cat = item.category ?? item.product?.category;
      if (!cat) continue;

      // ── Upsell: one tier up, same category (skip locked / already-grown) ──
      if (!lockedCategories.includes(cat) && !this.grownCats.has(cat)) {
        const upgrades = getValidUpgrades(item.product.id, this.catalog);
        for (const up of upgrades) {
          out.push({
            kind: 'upsell',
            moveKey: `upsell:${cat}:${up.id}`,
            category: cat,
            originalProduct: item.product,
            replacementProduct: up,
            revenueDelta: up.price - item.price,
          });
        }
      }

      // ── Cross-sell & bundle: complementary accessories for this item ──
      const complementIds = Array.isArray(item.product.complements) ? item.product.complements : [];
      const complements = complementIds
        .map(id => this.catalog.find(p => p.id === id))
        .filter(p => p && p.stock > 0 && !this.attachedIds.has(p.id) && !inCartIds.has(p.id))
        .filter(p => !allowed || allowed.includes(p.category)); // respect mandate categories

      // Single-item cross-sells
      for (const acc of complements) {
        out.push({
          kind: 'cross_sell',
          moveKey: `cross:${acc.id}`,
          anchorProduct: item.product,
          accessory: acc,
          revenueDelta: acc.price,
        });
      }

      // One bundle per anchor: 2+ complements at a bounded discount
      if (!this.bundledAnchorIds.has(item.product.id) && complements.length >= 2) {
        const discountPct = this._bundleDiscountPct();
        const listTotal = complements.reduce((s, p) => s + p.price, 0);
        const bundledTotal = Math.round(listTotal * (1 - discountPct / 100));
        out.push({
          kind: 'bundle',
          moveKey: `bundle:${item.product.id}`,
          anchorProduct: item.product,
          accessories: complements,
          discountPct,
          listTotal,
          bundledTotal,
          revenueDelta: bundledTotal,
        });
      }
    }
    return out;
  }

  /** Bundle discount, bounded by merchant policy if present. */
  _bundleDiscountPct() {
    const cap = typeof this.merchantPolicy?.max_discount === 'number'
      ? this.merchantPolicy.max_discount
      : 100;
    return Math.min(DEFAULT_BUNDLE_DISCOUNT_PCT, cap);
  }

  /** Convert a ranked candidate into a schema-valid MerchantOffer. */
  _toMerchantOffer(c) {
    if (c.kind === 'upsell') {
      const delta = c.replacementProduct.price - c.originalProduct.price;
      return {
        action: 'offer_substitution',
        message:
          `You have mandate headroom — I'd upgrade your ${c.originalProduct.name} (₹${c.originalProduct.price}) ` +
          `to the ${c.replacementProduct.name} (₹${c.replacementProduct.price}), a better ${c.replacementProduct.tier}-tier ` +
          `${c.category} for +₹${delta}.`,
        offer: {
          kind: 'upsell',
          moveKey: c.moveKey,
          originalProductId: c.originalProduct.id,
          replacementProductId: c.replacementProduct.id,
          originalProduct: c.originalProduct,
          replacementProduct: c.replacementProduct,
          savings: -delta,          // buyer pays more
          revenueDelta: delta,      // merchant gains
          goalAligned: true,
          reason: `Upsell ${c.originalProduct.tier}→${c.replacementProduct.tier} (${c.category}); +₹${delta} revenue`,
        },
      };
    }

    if (c.kind === 'cross_sell') {
      const acc = { ...c.accessory };
      return {
        action: 'offer_bundle',
        message:
          `Add a ${acc.name} (₹${acc.price}) to go with your ${c.anchorProduct.name} — a common pairing that ` +
          `rounds out the setup.`,
        offer: {
          kind: 'cross_sell',
          moveKey: c.moveKey,
          anchorProductId: c.anchorProduct.id,
          addedProducts: [acc],
          savings: -acc.price,      // buyer pays more
          revenueDelta: acc.price,
          discountPct: 0,
          goalAligned: true,
          reason: `Cross-sell ${acc.name} (complements ${c.anchorProduct.name}); +₹${acc.price} revenue`,
        },
      };
    }

    // bundle
    const factor = 1 - c.discountPct / 100;
    const added = c.accessories.map(p => ({ ...p, listPrice: p.price, price: Math.round(p.price * factor) }));
    const names = added.map(p => p.name).join(' + ');
    return {
      action: 'offer_bundle',
      message:
        `Bundle deal: add ${names} with your ${c.anchorProduct.name} for ₹${c.bundledTotal} ` +
        `(${c.discountPct}% off the ₹${c.listTotal} list). Bounded by merchant policy.`,
      offer: {
        kind: 'bundle',
        moveKey: c.moveKey,
        anchorProductId: c.anchorProduct.id,
        addedProducts: added,
        savings: -c.bundledTotal,   // buyer pays the discounted bundle total more
        revenueDelta: c.bundledTotal,
        discountPct: c.discountPct,
        listTotal: c.listTotal,
        reason: `Bundle ${names} at ${c.discountPct}% off; +₹${c.bundledTotal} revenue (list ₹${c.listTotal})`,
      },
    };
  }

  /** Mark a growth move as accepted → don't regenerate it. */
  commitMove(offer) {
    if (!offer) return;
    if (offer.kind === 'upsell') {
      const cat = offer.replacementProduct?.category ?? offer.originalProduct?.category;
      if (cat) this.grownCats.add(cat);
    } else if (offer.kind === 'cross_sell') {
      for (const p of offer.addedProducts ?? []) this.attachedIds.add(p.id);
    } else if (offer.kind === 'bundle') {
      if (offer.anchorProductId) this.bundledAnchorIds.add(offer.anchorProductId);
      for (const p of offer.addedProducts ?? []) this.attachedIds.add(p.id);
    }
  }

  /** Mark a growth move as declined → never re-propose that exact move. */
  rejectMove(offer) {
    if (offer?.moveKey) this.rejectedMoveKeys.add(offer.moveKey);
  }
}

module.exports = { MerchantAgent };
