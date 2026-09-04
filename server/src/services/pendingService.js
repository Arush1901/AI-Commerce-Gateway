'use strict';

/**
 * pendingService.js — in-memory store of purchases that have PASSED every gate
 * but are held awaiting an explicit human "Confirm" before any money moves.
 *
 * This is the human-in-the-loop half of the "bounded & gated" story: the
 * pipeline decides + verifies the signed mandate, then PAUSES here instead of
 * charging. The buyer reviews the exact products/price on the frontend and only
 * a confirm call (see orchestrator.confirmPurchase) releases the charge.
 *
 * A pending record carries everything confirmPurchase needs to charge EXACTLY
 * what the buyer was shown — the resolved cart and the signed mandate (so the
 * payment gate can be re-verified at charge time, defense-in-depth):
 *
 *   { effectiveCart, mandate, revenue, createdAt }
 *
 * Same design as auditService: a plain Map, FIFO-capped, reset in tests via
 * _reset(). No DB. Keyed by transactionId (a 128-bit UUID), which the caller
 * must also present as possession proof to confirm/cancel.
 */

/** @type {Map<string, { effectiveCart: object, mandate: object, revenue: object, createdAt: string }>} */
const store = new Map();

/** Cap concurrent pending charges; evict oldest (FIFO) when exceeded. */
const MAX_PENDING = 1000;

/**
 * Stash a purchase awaiting confirmation.
 * @param {string} transactionId
 * @param {{ effectiveCart: object, mandate: object, revenue?: object }} record
 */
function createPending(transactionId, record) {
  if (store.size >= MAX_PENDING) {
    const oldestKey = store.keys().next().value;
    store.delete(oldestKey);
  }
  store.set(transactionId, {
    effectiveCart: record.effectiveCart,
    mandate:       record.mandate,
    revenue:       record.revenue ?? null,
    createdAt:     new Date().toISOString(),
  });
}

/**
 * Retrieve a pending record (or null if none — already confirmed/cancelled/unknown).
 * @param {string} transactionId
 * @returns {{ effectiveCart, mandate, revenue, createdAt } | null}
 */
function getPending(transactionId) {
  return store.get(transactionId) ?? null;
}

/**
 * Remove a pending record. Called after a successful charge, a cancellation, or
 * a confirm-time gate failure — so a transaction can never be charged twice.
 * @param {string} transactionId
 * @returns {boolean} true if a record was removed
 */
function deletePending(transactionId) {
  return store.delete(transactionId);
}

/** Clear all pending records. For use in tests only. */
function _reset() {
  store.clear();
}

module.exports = { createPending, getPending, deletePending, _reset };
