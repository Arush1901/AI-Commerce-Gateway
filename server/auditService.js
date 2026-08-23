'use strict';

/**
 * auditService.js — Stage 9 in-memory audit trail.
 *
 * Implements the AuditEntry contract from Stage 0 schemas.js:
 *   { step, input, output, timestamp }
 *
 * Storage: plain Map — no database, no SQLite, no Redis.
 * Reset between test runs by calling _reset() (test-only helper).
 */

// ─── in-memory store ──────────────────────────────────────────────────────────

/** @type {Map<string, AuditEntry[]>} */
const store = new Map();

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Initialise an empty audit trail for a transaction.
 * Must be called before appendAudit().
 *
 * @param {string} transactionId
 */
function createAudit(transactionId) {
  store.set(transactionId, []);
}

/**
 * Append one AuditEntry to an existing trail.
 * Silently no-ops if the transactionId is unknown (keeps orchestrate() safe
 * when called without audit context, e.g. unit tests).
 *
 * @param {string} transactionId
 * @param {{ step: string, input: *, output: * }} entry  — timestamp is auto-set
 */
function appendAudit(transactionId, entry) {
  const trail = store.get(transactionId);
  if (!trail) return; // no-op — no audit context for this transaction

  trail.push({
    step:      entry.step,
    input:     entry.input,
    output:    entry.output,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Retrieve the full audit trail for a transaction.
 *
 * @param {string} transactionId
 * @returns {{ transactionId: string, entries: AuditEntry[] } | null}
 */
function getAudit(transactionId) {
  const trail = store.get(transactionId);
  if (trail === undefined) return null;
  return { transactionId, entries: trail };
}

/**
 * Clear all stored audits.
 * For use in tests only — not exposed on the HTTP layer.
 */
function _reset() {
  store.clear();
}

module.exports = { createAudit, appendAudit, getAudit, _reset };
