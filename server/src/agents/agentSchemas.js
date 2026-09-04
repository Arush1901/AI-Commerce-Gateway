'use strict';

const BUYER_ACTIONS = Object.freeze([
  'accept', 'reject', 'counter_offer', 'request_alternative', 'escalate',
]);

const MERCHANT_ACTIONS = Object.freeze([
  'offer_substitution', 'offer_discount', 'offer_bundle', 'reject_request', 'final_offer',
]);

function validateBuyerAction(obj) {
  if (!obj || typeof obj !== 'object') return 'BuyerAction must be an object';
  if (!BUYER_ACTIONS.includes(obj.action))
    return `BuyerAction.action must be one of [${BUYER_ACTIONS.join(', ')}] — got "${obj.action}"`;
  if (typeof obj.message !== 'string' || !obj.message.trim())
    return 'BuyerAction.message must be a non-empty string';
  if (obj.requirements != null && typeof obj.requirements !== 'object')
    return 'BuyerAction.requirements must be object or null';
  if (obj.acceptedOffer != null && typeof obj.acceptedOffer !== 'object')
    return 'BuyerAction.acceptedOffer must be object or null';
  return null;
}

function validateMerchantOffer(obj) {
  if (!obj || typeof obj !== 'object') return 'MerchantOffer must be an object';
  if (!MERCHANT_ACTIONS.includes(obj.action))
    return `MerchantOffer.action must be one of [${MERCHANT_ACTIONS.join(', ')}] — got "${obj.action}"`;
  if (typeof obj.message !== 'string' || !obj.message.trim())
    return 'MerchantOffer.message must be a non-empty string';
  if (obj.offer != null && typeof obj.offer !== 'object')
    return 'MerchantOffer.offer must be object or null';
  if (obj.offer) {
    const o = obj.offer;
    // savings is the buyer-side delta and is ALWAYS numeric:
    //   > 0  → buyer pays less (downgrade / rescue)
    //   < 0  → buyer pays more (upsell / cross-sell / bundle → merchant grows)
    if (typeof o.savings !== 'number')
      return 'MerchantOffer.offer.savings must be a number';

    // Two offer shapes are accepted:
    //   • replace-type (substitution, upsell): carries replacementProduct
    //   • add-type    (cross-sell, bundle):    carries a non-empty addedProducts[]
    const isAddType = Array.isArray(o.addedProducts);
    if (isAddType) {
      if (o.addedProducts.length === 0)
        return 'MerchantOffer.offer.addedProducts must be a non-empty array for add-type offers';
      if (!o.addedProducts.every(p => p && typeof p === 'object' && typeof p.price === 'number'))
        return 'MerchantOffer.offer.addedProducts must contain product objects with a numeric price';
    } else if (!o.replacementProduct) {
      return 'MerchantOffer.offer.replacementProduct (or addedProducts[]) is required when offer is present';
    }
  }
  return null;
}

function assertValid(label, obj, validator) {
  const err = validator(obj);
  if (err) throw new Error(`[AgentSchema] Invalid ${label}: ${err}`);
}

module.exports = { BUYER_ACTIONS, MERCHANT_ACTIONS, validateBuyerAction, validateMerchantOffer, assertValid };
