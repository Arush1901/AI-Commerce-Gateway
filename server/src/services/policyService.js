'use strict';

// ─── validateUserPolicy ───────────────────────────────────────────────────────

/**
 * Validate a cart against a user's spending and category policy.
 *
 * userPolicy shape:
 *   {
 *     max_spending:       number    — absolute INR ceiling for cart total
 *     allowed_categories: string[] — whitelist of permitted product categories
 *   }
 *
 * @param {{ total: number, items: Array<{category: string}> }} cart
 * @param {{ max_spending: number, allowed_categories: string[] }} userPolicy
 * @returns {PolicyResult}  { status: "approved"|"rejected"|"escalated", reason }
 */
function validateUserPolicy(cart, userPolicy) {
  const { max_spending, allowed_categories } = userPolicy;

  // Rule 1: total spend ceiling
  if (cart.total > max_spending) {
    return {
      status: 'rejected',
      reason: `Cart total ₹${cart.total} exceeds user spending limit of ₹${max_spending}`,
    };
  }

  // Rule 2: category whitelist
  if (Array.isArray(allowed_categories)) {
    const blocked = cart.items
      .map(i => i.category)
      .filter(cat => !allowed_categories.includes(cat));

    if (blocked.length > 0) {
      const unique = [...new Set(blocked)];
      return {
        status: 'rejected',
        reason: `Cart contains categories not permitted by user policy: ${unique.join(', ')}`,
      };
    }
  }

  return {
    status: 'approved',
    reason: 'Cart satisfies all user policy constraints',
  };
}

// ─── validateMerchantPolicy ───────────────────────────────────────────────────

/**
 * Validate a merchant's substitution offer against merchant policy rules.
 *
 * merchantPolicy shape:
 *   {
 *     max_discount: number  — maximum discount as a percentage of original price (0–100)
 *     min_margin:   number  — minimum absolute price (INR) the replacement must cost
 *   }
 *
 * Discount % = saving / (replacement.price + saving) × 100
 *
 * Status rules:
 *   - discount% > max_discount          → "rejected"  (clear policy breach)
 *   - replacement.price < min_margin    → "escalated" (borderline pricing, needs review)
 *   - both checks pass                  → "approved"
 *
 * @param {MerchantOffer}  offer
 * @param {{ max_discount: number, min_margin: number }} merchantPolicy
 * @returns {PolicyResult}  { status: "approved"|"rejected"|"escalated", reason }
 */
function validateMerchantPolicy(offer, merchantPolicy) {
  const { max_discount, min_margin } = merchantPolicy;
  const { replacement, saving } = offer;

  // Offers with no substitution pass merchant policy (nothing to validate)
  if (!replacement || saving <= 0) {
    return {
      status: 'approved',
      reason: 'No substitution offered — merchant policy not applicable',
    };
  }

  const originalPrice  = replacement.price + saving;
  const discountPct    = (saving / originalPrice) * 100;

  // Rule 1: discount ceiling
  if (discountPct > max_discount) {
    return {
      status: 'rejected',
      reason: `Merchant discount ${discountPct.toFixed(1)}% exceeds allowed maximum of ${max_discount}%`,
    };
  }

  // Rule 2: minimum margin floor
  if (replacement.price < min_margin) {
    return {
      status: 'escalated',
      reason: `Replacement price ₹${replacement.price} is below merchant minimum margin of ₹${min_margin} — requires manual review`,
    };
  }

  return {
    status: 'approved',
    reason: `Offer approved — discount ${discountPct.toFixed(1)}% within limit, replacement price ₹${replacement.price} above min margin`,
  };
}

module.exports = { validateUserPolicy, validateMerchantPolicy };
