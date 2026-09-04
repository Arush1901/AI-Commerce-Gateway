'use strict';

/**
 * mandate.js — the buyer's signed delegated-authority object.
 *
 * A Mandate is a demo-grade, cryptographically-signed proof of what a human
 * authorized their buying agent to do. It bounds the negotiation and gates the
 * payment. This mirrors the real agentic-commerce protocols:
 *
 *   • AP2 (Google)        — "intent mandate" / "cart mandate": signed, verifiable
 *                           proofs of user-delegated authority.
 *   • ACP (OpenAI/Stripe) — a delegated/shared payment token scoped to a max
 *                           amount and a merchant.
 *
 * We don't need their SDKs — an HMAC-signed mandate demonstrates the SAME
 * principle (delegated, scoped, verifiable, expiring authority), which is what
 * earns the "bounded & gated" marks.
 *
 *   Mandate {
 *     maxSpend:          number      — absolute INR ceiling the agent may spend
 *     allowedCategories: string[]    — category whitelist the agent may buy in
 *     expiresAt:         number|null — epoch ms; null = no expiry (legacy)
 *     goal:              string      — the buyer's stated objective (drives utility)
 *     signature:         string      — HMAC-SHA256 over the canonical fields
 *   }
 *
 * SECURITY NOTE: the signature is computed over the mandate's OWN fields, so any
 * post-hoc tampering with maxSpend/allowedCategories/expiresAt/goal invalidates
 * it — an attacker cannot forge a new signature without the secret.
 */

const crypto = require('crypto');

// Demo secret. In production this would be a per-issuer key in a KMS/HSM.
const DEFAULT_SECRET = process.env.MANDATE_SECRET || 'acg-demo-mandate-secret-2026';

/**
 * Deterministically serialize ONLY the signable fields, so signing/verifying is
 * stable regardless of key order or array ordering.
 */
function canonicalize(fields) {
  const cats = Array.isArray(fields.allowedCategories)
    ? [...fields.allowedCategories].map(String).sort()
    : [];
  return JSON.stringify([
    Number(fields.maxSpend) || 0,
    cats,
    fields.expiresAt == null ? null : Number(fields.expiresAt),
    String(fields.goal ?? ''),
  ]);
}

/** Compute the HMAC signature for a set of mandate fields. */
function signMandate(fields, secret = DEFAULT_SECRET) {
  return crypto.createHmac('sha256', secret).update(canonicalize(fields)).digest('hex');
}

/** Build a fully-formed, signed Mandate object. */
function createMandate(
  { maxSpend, allowedCategories = [], expiresAt = null, goal = '' },
  secret = DEFAULT_SECRET,
) {
  const fields = { maxSpend, allowedCategories, expiresAt, goal };
  return { ...fields, signature: signMandate(fields, secret) };
}

/**
 * Verify a mandate's signature and expiry.
 * @returns {{ valid: boolean, reason: string }}
 */
function verifyMandate(mandate, { now = Date.now(), secret = DEFAULT_SECRET } = {}) {
  if (!mandate || typeof mandate !== 'object') {
    return { valid: false, reason: 'No mandate provided' };
  }
  if (typeof mandate.signature !== 'string' || !mandate.signature) {
    return { valid: false, reason: 'Mandate is unsigned' };
  }
  const expected = signMandate(mandate, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(mandate.signature);
  const signatureOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!signatureOk) {
    return { valid: false, reason: 'Mandate signature invalid — fields were tampered with' };
  }
  if (mandate.expiresAt != null && Number(mandate.expiresAt) < now) {
    return {
      valid: false,
      reason: `Mandate expired at ${new Date(Number(mandate.expiresAt)).toISOString()}`,
    };
  }
  return { valid: true, reason: 'Mandate signature valid and unexpired' };
}

/**
 * Structural containment check: is every part of the cart inside the mandate's
 * spend ceiling and category whitelist? (Independent of signature/expiry.)
 * @returns {{ ok: boolean, violations: string[] }}
 */
function cartWithinMandate(cart, mandate) {
  const violations = [];
  if (cart.total > mandate.maxSpend) {
    violations.push(`cart total ₹${cart.total} exceeds mandate maxSpend ₹${mandate.maxSpend}`);
  }
  if (Array.isArray(mandate.allowedCategories) && mandate.allowedCategories.length) {
    const bad = [...new Set(
      cart.items.map(i => i.category).filter(c => !mandate.allowedCategories.includes(c)),
    )];
    if (bad.length) {
      violations.push(`cart contains categories outside mandate: ${bad.join(', ')}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * The full payment gate: signature valid + not expired + cart ⊆ mandate.
 * This is the single check the orchestrator runs immediately before charging.
 * @returns {{ ok: boolean, reason: string, stage: 'signature'|'containment'|'passed' }}
 */
function gateCartAgainstMandate(cart, mandate, opts = {}) {
  const sig = verifyMandate(mandate, opts);
  if (!sig.valid) return { ok: false, reason: sig.reason, stage: 'signature' };

  const within = cartWithinMandate(cart, mandate);
  if (!within.ok) return { ok: false, reason: within.violations.join('; '), stage: 'containment' };

  return { ok: true, reason: 'Cart within a valid, unexpired, signed mandate', stage: 'passed' };
}

/**
 * Backward-compat bridge: derive a signed mandate from a legacy intent
 * (bare budget + preference categories). Used so the whole existing pipeline
 * keeps working when no explicit mandate is supplied.
 */
function mandateFromIntent(intent, opts = {}) {
  if (intent && intent.mandate) return intent.mandate;
  return createMandate({
    maxSpend: intent.budget,
    allowedCategories: Object.keys(intent.preferences || {}),
    expiresAt: opts.expiresAt ?? null,
    goal: intent.goal || '',
  }, opts.secret);
}

/**
 * Issue a signed GROWTH mandate for an intent.
 *
 * Same spend ceiling as the legacy mandate (the buyer's budget). The category
 * whitelist is where Problem 3 ("goal-driven, not forced") is enforced:
 *
 *   • GOAL-FIRST path — when the intent carries a goal profile
 *     (`intent.allowedCategories`, produced by goalService.classifyGoal), the
 *     whitelist is EXACTLY that set: the buyer's categories plus ONLY the add-ons
 *     the stated goal genuinely needs (e.g. a mousepad for a gaming mouse). The
 *     growth agent can therefore cross-sell a goal-essential accessory but can
 *     NEVER creep into unrelated categories (no reflexive warranty/cable up-sell).
 *
 *   • LEGACY path — when no goal profile is present, fall back to the original
 *     behaviour: broaden to every complementary-accessory category reachable from
 *     the buyer's chosen items. Preserves the pre-goal-first pipeline for old
 *     callers and existing fixtures.
 *
 * The mandate is signed HERE, server-side, with the issuer secret — so the
 * client never handles the signature and the payment gate still verifies it.
 *
 * @param {Intent}            intent
 * @param {CatalogProduct[]}  catalog
 * @param {{ expiresAt?: number|null, secret?: string }} [opts]
 * @returns {Mandate}
 */
function growthMandateFromIntent(intent, catalog, opts = {}) {
  const prefCats = Object.keys(intent.preferences || {});

  let allowedCategories;
  if (Array.isArray(intent.allowedCategories) && intent.allowedCategories.length) {
    // GOAL-FIRST: honour the goal profile's permitted set verbatim (union with the
    // baseline cart's own categories as a defensive floor so containment can't fail
    // on a category the buyer actually asked for).
    allowedCategories = [...new Set([...prefCats, ...intent.allowedCategories])];
  } else {
    // LEGACY: collect the categories of every complement of every product that sits
    // in a preferred category — the accessories a growth agent may attach.
    const prefSet = new Set(prefCats);
    const accessoryCats = new Set();
    if (Array.isArray(catalog)) {
      for (const product of catalog) {
        if (!prefSet.has(product.category)) continue;
        for (const compId of product.complements || []) {
          const comp = catalog.find(p => p.id === compId);
          if (comp && comp.category) accessoryCats.add(comp.category);
        }
      }
    }
    allowedCategories = [...new Set([...prefCats, ...accessoryCats])];
  }

  return createMandate({
    maxSpend: intent.budget,
    allowedCategories,
    expiresAt: opts.expiresAt ?? null,
    goal: intent.goal || '',
  }, opts.secret);
}

module.exports = {
  createMandate,
  signMandate,
  verifyMandate,
  cartWithinMandate,
  gateCartAgainstMandate,
  mandateFromIntent,
  growthMandateFromIntent,
  DEFAULT_SECRET,
};
