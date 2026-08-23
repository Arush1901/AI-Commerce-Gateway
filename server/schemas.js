/**
 * schemas.js — Stage 0 contract definitions only.
 * No business logic. No imports. Pure shape documentation.
 */

/**
 * Intent
 * Represents the buyer's purchasing goal.
 * @typedef {Object} Intent
 * @property {string} goal
 * @property {number} budget
 * @property {Object.<string, "locked"|"medium"|"low">} preferences
 */

/**
 * CatalogProduct
 * A single product entry in the catalog.
 * @typedef {Object} CatalogProduct
 * @property {string} id
 * @property {string} name
 * @property {string} category
 * @property {string} tier
 * @property {number} price
 * @property {Array}  features
 * @property {number} stock
 */

/**
 * BuyerRequest
 * A request action submitted by the buyer.
 * @typedef {Object} BuyerRequest
 * @property {string} action
 * @property {number} budget_limit
 * @property {Array}  protected_items
 */

/**
 * MerchantOffer
 * A counter-offer or replacement proposed by the merchant.
 * @typedef {Object} MerchantOffer
 * @property {string} action
 * @property {*}      replacement
 * @property {number} saving
 * @property {string} reason
 */

/**
 * PolicyResult
 * Outcome of a policy evaluation.
 * @typedef {Object} PolicyResult
 * @property {"approved"|"rejected"|"escalated"} status
 * @property {string} reason
 */

/**
 * AuditEntry
 * Single record in the audit trail.
 * @typedef {Object} AuditEntry
 * @property {string} step
 * @property {*}      input
 * @property {*}      output
 * @property {string} timestamp
 */

module.exports = {};
