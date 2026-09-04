'use strict';

const crypto = require('crypto');

const { buildCart }               = require('../services/cartService');
const { negotiate, applyOffer }   = require('../services/negotiationService');
const { validateUserPolicy,
        validateMerchantPolicy }  = require('../services/policyService');
const { parseIntent }             = require('../services/intentService');
const { appendAudit, createAudit } = require('../services/auditService');
const { createPending, getPending, deletePending } = require('../services/pendingService');
const { createPaymentOrder }      = require('../services/paymentService');
const { mandateFromIntent,
        growthMandateFromIntent,
        gateCartAgainstMandate }  = require('../agents/mandate');
const { classifyGoal }            = require('../services/goalService');
const { generateOptions }         = require('../services/optionsService');
const catalog                     = require('../data/catalog.json');

// ─── pending options store ──────────────────────────────────────────────────────
//
// When the IDEAL goal setup can't be achieved within budget, the pipeline pauses
// and offers the buyer A/B/C alternatives (Problem 3) INSTEAD of silently
// negotiating one cart. Each option carries a concrete, already-priced cart. We
// stash the option set here, keyed by transactionId, until the buyer selects one
// (see selectPurchase) — the same in-memory, possession-proof-keyed pattern as
// pendingService. A selection is consumed exactly once.
//
// @type {Map<string, { options: Array, intent: object, userPolicy: object, merchantPolicy: object, createdAt: string }>}
const pendingOptions = new Map();
const MAX_PENDING_OPTIONS = 1000;

function _resetPendingOptions() { pendingOptions.clear(); }

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * After a negotiation, derive the best available cart.
 *
 * - approved        → use finalCart (already fully resolved)
 * - escalation_needed → use effectiveCart stored directly by negotiate();
 *                       falls back to offer-log reconstruction only for
 *                       legacy results that pre-date this field.
 *
 * I1 fix: negotiate() now stores effectiveCart on the result directly, making
 * this function a trivial lookup rather than a post-hoc reconstruction.
 *
 * @param {{ items:Array, total:number, budget:number }} originalCart
 * @param {object} negotiationResult
 */
function getEffectiveCart(originalCart, negotiationResult) {
  if (negotiationResult.status === 'approved') {
    return negotiationResult.finalCart;
  }
  // Prefer the cart stored directly by negotiate() (I1 fix)
  if (negotiationResult.effectiveCart) {
    return negotiationResult.effectiveCart;
  }
  // Legacy fallback — re-apply offers from the trace
  let cart = originalCart;
  for (const { offer } of negotiationResult.offers ?? []) {
    if (offer.action === 'substitute' && offer.replacement) {
      cart = applyOffer(cart, offer);
    }
  }
  return cart;
}

/**
 * Validate merchant policy against ALL substitute offers that were applied
 * during negotiation, not just the last one.
 *
 * C1 fix: An AI merchant could propose a policy-violating offer in Round 1
 * then a clean offer in Round 2. Checking only the last offer would silently
 * approve a transaction whose effective price already embeds the illegal discount.
 *
 * Returns the worst-case PolicyResult across all rounds.
 *
 * @param {object[]} offers          — negotiationResult.offers array
 * @param {object}   merchantPolicy
 * @returns {PolicyResult}
 */
function validateAllMerchantOffers(offers, merchantPolicy) {
  const substituteOffers = (offers ?? [])
    .filter(o => o.offer?.action === 'substitute');

  if (substituteOffers.length === 0) {
    return validateMerchantPolicy(
      { action: 'no_offer', replacement: null, saving: 0, reason: 'no offer made' },
      merchantPolicy
    );
  }

  // Rank: rejected (0) < escalated (1) < approved (2)
  const rank = { rejected: 0, escalated: 1, approved: 2 };
  return substituteOffers
    .map(({ offer }) => validateMerchantPolicy(offer, merchantPolicy))
    .reduce((worst, r) => rank[r.status] < rank[worst.status] ? r : worst);
}

/**
 * Decide the final transaction outcome.
 *
 * Flat precedence — all three results are evaluated BEFORE returning:
 *   1. rejected  — any policy rejection (user OR merchant) — always wins
 *   2. escalated — negotiation failed OR merchant policy escalated
 *   3. approved  — everything passed
 *
 * "rejected" beats "escalated" unconditionally. An impossible budget that
 * also violates the user's own spending limit is a clear reject, not an
 * escalation requiring manual review.
 *
 * @param {object} negotiationResult
 * @param {PolicyResult} userPolicyResult
 * @param {PolicyResult} merchantPolicyResult
 * @returns {{ decision: string, reasoning: string }}
 */
function decide(negotiationResult, userPolicyResult, merchantPolicyResult) {
  // ── Tier 1: hard rejections (always outrank escalation) ────────────────────
  if (userPolicyResult.status === 'rejected') {
    return {
      decision:  'rejected',
      reasoning: `User policy rejected: ${userPolicyResult.reason}`,
    };
  }
  if (merchantPolicyResult.status === 'rejected') {
    return {
      decision:  'rejected',
      reasoning: `Merchant policy rejected: ${merchantPolicyResult.reason}`,
    };
  }

  // ── Tier 2: escalations (only if no hard rejection above) ──────────────────
  if (negotiationResult.status === 'escalation_needed') {
    return {
      decision:  'escalated',
      reasoning: `Escalated. Negotiation could not close the budget gap of ₹${negotiationResult.gap} within ${negotiationResult.rounds} round(s). Requires manual review.`,
    };
  }
  if (merchantPolicyResult.status === 'escalated') {
    return {
      decision:  'escalated',
      reasoning: `Merchant policy requires escalation: ${merchantPolicyResult.reason}`,
    };
  }

  // ── Tier 3: all clear ──────────────────────────────────────────────────────
  return {
    decision:  'approved',
    reasoning: `Negotiation succeeded in ${negotiationResult.rounds} round(s). All policies approved.`,
  };
}

/**
 * Run the full purchase pipeline given a parsed intent.
 * Now async — payment order creation requires a network call.
 *
 * An optional transactionId may be passed in (generated by the route handler
 * after intent parsing). When provided, AuditEntries are appended after each
 * step. When omitted (unit tests without audit context), appendAudit is a
 * graceful no-op.
 *
 * Pipeline:
 *   buildCart → negotiate → validateUserPolicy → validateMerchantPolicy
 *            → decide → [createPaymentOrder if approved]
 *
 * @param {Intent}   intent
 * @param {CatalogProduct[]} cat
 * @param {{ max_spending: number, allowed_categories: string[] }} userPolicy
 * @param {{ max_discount: number, min_margin: number }} merchantPolicy
 * @param {string} [transactionId]   — optional; generated internally if omitted
 * @param {{ deferPayment?: boolean }} [opts]
 *        deferPayment (default false): when true, an approved cart that clears the
 *        signed-mandate gate is NOT charged — it is stashed as pending and the
 *        result carries status 'pending_confirmation'. A later confirmPurchase()
 *        call releases the charge. This is the human-in-the-loop path used by the
 *        web route. Left false, orchestrate() charges inline exactly as before
 *        (every existing test + direct caller is unaffected).
 * @returns {Promise<{ transactionId, decision, status, reasoning, payment, revenue, finalCart, fullTrace }>}
 */
async function orchestrate(intent, cat, userPolicy, merchantPolicy, transactionId, opts = {}) {
  const txId = transactionId ?? crypto.randomUUID();
  const deferPayment = opts.deferPayment === true;
  // A LOCKED cart is a fully-resolved cart the BUYER explicitly chose (a selected
  // A/B/C alternative — see selectPurchase). When present, we do NOT re-run the
  // growth/rescue negotiation: the buyer already made the trade-off, and silently
  // re-optimising their pick would be dishonest. The locked cart flows through the
  // exact same policy + signed-mandate gates and two-phase confirmation as any
  // other cart, so it stays just as bounded, gated, and audited.
  const lockedCart = opts.lockedCart ?? null;

  // I2 — pre-check: budget === 0 means intent was not fully captured.
  // Surface as escalated immediately rather than running a meaningless pipeline.
  if (intent.budget === 0) {
    const earlyResult = {
      transactionId: txId,
      decision:  'escalated',
      status:    'escalated',
      reasoning: 'Intent budget is 0 — no budget was extracted from the user request. Please specify a budget and retry.',
      payment:   null,
      revenue:   null,
      finalCart: null,
      fullTrace: { intent, cart: null, mandate: null, negotiation: null, revenue: null, userPolicyResult: null, merchantPolicyResult: null, decision: 'escalated' },
    };
    appendAudit(txId, { step: 'decision', input: { intent }, output: { decision: 'escalated', reason: 'budget_missing' } });
    return earlyResult;
  }

  // 1. Build initial cart — or use the buyer's locked (explicitly chosen) cart.
  const cart = lockedCart ?? buildCart(intent, cat);
  appendAudit(txId, { step: 'cart_building', input: { intent, locked: !!lockedCart }, output: cart });

  // 1b. Derive the buyer's signed mandate (from an explicit intent.mandate, or
  //     synthesised from the legacy budget + preference categories). This is the
  //     bounded, verifiable authority the whole pipeline negotiates and pays under.
  const mandate = mandateFromIntent(intent);
  appendAudit(txId, {
    step:  'mandate_issued',
    input: { budget: intent.budget, goal: intent.goal },
    output: { maxSpend: mandate.maxSpend, allowedCategories: mandate.allowedCategories,
              expiresAt: mandate.expiresAt, signature: mandate.signature.slice(0, 12) + '…' },
  });

  // 2. Negotiate — rescue (over mandate) OR revenue-growth (under mandate).
  //    The mandate bounds growth; merchantPolicy bounds any bundle discount.
  //    SKIPPED for a locked cart: the buyer's explicit A/B/C choice is final and
  //    must not be silently re-optimised. We record a no-op negotiation so the
  //    audit trail and downstream shape stay identical.
  let negotiationResult;
  if (lockedCart) {
    negotiationResult = {
      status:        'approved',
      rounds:        0,
      offers:        [],
      finalCart:     cart,
      effectiveCart: cart,
      note:          'Buyer-selected option — negotiation skipped, cart locked as chosen.',
    };
    appendAudit(txId, { step: 'negotiation', input: { cart, locked: true }, output: negotiationResult });
  } else {
    negotiationResult = negotiate(cart, intent, cat, { mandate, merchantPolicy });
    appendAudit(txId, { step: 'negotiation', input: { cart, intent, mandate }, output: negotiationResult });
  }

  // 3. Derive the best available cart after negotiation (I1: direct from result)
  const effectiveCart = getEffectiveCart(cart, negotiationResult);

  // 3b. Revenue-uplift metric — the grown (or rescued) cart vs the baseline cart.
  const revenue = {
    baseline:  cart.total,
    final:     effectiveCart.total,
    uplift:    effectiveCart.total - cart.total,
    upliftPct: cart.total ? Math.round((effectiveCart.total - cart.total) / cart.total * 10000) / 100 : 0,
    strategy:  cart.baselineStrategy ?? 'premium',
  };
  appendAudit(txId, { step: 'revenue_uplift', input: { baseline: revenue.baseline, final: revenue.final }, output: revenue });

  // 4. Policy gates
  const userPolicyResult = validateUserPolicy(effectiveCart, userPolicy);
  appendAudit(txId, { step: 'user_policy_validation', input: { cart: effectiveCart, userPolicy }, output: userPolicyResult });

  // C1 — validate ALL applied substitute offers, not just the last one
  const merchantPolicyResult = validateAllMerchantOffers(negotiationResult.offers, merchantPolicy);
  appendAudit(txId, { step: 'merchant_policy_validation', input: { offers: negotiationResult.offers, merchantPolicy }, output: merchantPolicyResult });

  // 5. Decision
  const { decision, reasoning } = decide(
    negotiationResult, userPolicyResult, merchantPolicyResult
  );
  appendAudit(txId, { step: 'decision', input: { negotiationResult, userPolicyResult, merchantPolicyResult }, output: { decision, reasoning } });

  // 6. Payment order — only on approved, and only AFTER the signed-mandate gate.
  //    The gate is the final "money action is bounded & gated" check: it re-verifies
  //    the mandate signature/expiry and that the cart is still contained by it. If it
  //    trips (tampering, or a bug that let an over-mandate cart through), we do NOT
  //    charge — we escalate gracefully instead.
  let payment = null;
  let finalDecision  = decision;
  let finalReasoning = reasoning;
  // status is a finer-grained view than decision, for the two-phase flow:
  //   rejected | escalated | pending_confirmation (approved, awaiting human) | paid
  let status = decision;

  if (decision === 'approved') {
    const gate = gateCartAgainstMandate(effectiveCart, mandate);
    appendAudit(txId, {
      step:  'mandate_payment_gate',
      input: { total: effectiveCart.total, maxSpend: mandate.maxSpend },
      output: gate,
    });

    // A buyer-LOCKED cart that trips the gate only at the CONTAINMENT stage
    // (over the spend ceiling or out-of-category) is not an agent overreach — the
    // human explicitly chose this over-budget option from the A/B/C picker. Rather
    // than hard-escalate, we hold it for explicit confirmation so the buyer can
    // consciously authorize the overage on the confirmation screen (which sends
    // acknowledgeOverBudget:true → the budget_override path in confirmPurchase).
    // The agent still never charges on its own; only the human can cross the bound,
    // and only with a recorded acknowledgment. A SIGNATURE-stage failure (tampering
    // or expiry) is never a buyer choice and still hard-escalates below.
    const lockedOverBudgetOverridable = lockedCart && !gate.ok && gate.stage === 'containment';

    if (!gate.ok && !lockedOverBudgetOverridable) {
      finalDecision  = 'escalated';
      status         = 'escalated';
      finalReasoning = `Payment blocked by signed-mandate gate at the ${gate.stage} stage: ${gate.reason}. Escalated for manual review — no charge was made.`;
      appendAudit(txId, { step: 'decision_override', input: { from: 'approved', reason: gate.reason }, output: { decision: finalDecision } });
    } else if (lockedOverBudgetOverridable && deferPayment) {
      // Over-budget buyer-selected option → stash as pending, flagged over-budget,
      // and route to the confirmation screen for an explicit human acknowledgment.
      createPending(txId, { effectiveCart, mandate, revenue });
      status         = 'pending_confirmation';
      finalReasoning = `You selected an over-budget option (₹${effectiveCart.total} vs your ₹${mandate.maxSpend} budget). ` +
        `No charge has been made — confirm on the next screen with explicit over-budget authorization to proceed, or cancel.`;
      appendAudit(txId, {
        step:  'awaiting_confirmation',
        input: { total: effectiveCart.total, maxSpend: mandate.maxSpend, overBudget: true },
        output: { status: 'pending_confirmation', reason: 'Buyer-selected over-budget option held for explicit over-budget authorization before charge.' },
      });
    } else if (lockedOverBudgetOverridable && !deferPayment) {
      // Inline (non-deferred) callers never one-click charge an over-mandate cart.
      finalDecision  = 'escalated';
      status         = 'escalated';
      finalReasoning = `Payment blocked by signed-mandate gate at the ${gate.stage} stage: ${gate.reason}. A buyer-selected over-budget option requires explicit confirmation — no charge was made.`;
      appendAudit(txId, { step: 'decision_override', input: { from: 'approved', reason: gate.reason }, output: { decision: finalDecision } });
    } else if (deferPayment) {
      // Human-in-the-loop: the cart is approved AND inside a valid signed mandate,
      // but we do NOT charge yet. Stash the resolved cart + mandate and wait for an
      // explicit confirmPurchase(). "Bounded, gated, AND authorized by a human."
      createPending(txId, { effectiveCart, mandate, revenue });
      status         = 'pending_confirmation';
      finalReasoning = `Approved and within the signed mandate (₹${effectiveCart.total} ≤ ₹${mandate.maxSpend}). Awaiting buyer confirmation — no charge has been made yet.`;
      appendAudit(txId, {
        step:  'awaiting_confirmation',
        input: { total: effectiveCart.total, maxSpend: mandate.maxSpend },
        output: { status: 'pending_confirmation', reason: 'Held for explicit buyer confirmation before charge.' },
      });
    } else {
      const paymentOrder = await createPaymentOrder(effectiveCart);
      payment = {
        orderId:  paymentOrder.orderId,
        amount:   paymentOrder.amount,
        currency: paymentOrder.currency,
        keyId:    process.env.RAZORPAY_KEY_ID,
      };
      status = 'paid';
      appendAudit(txId, {
        step:   'payment_order_created',
        input:  { total: effectiveCart.total },
        output: { orderId: payment.orderId, amount: payment.amount, currency: payment.currency },
        // keyId safe to log; secret is never stored
      });
    }
  }

  // 7. Assemble response (structured, not serialised to string)
  const fullTrace = {
    intent,
    cart,
    mandate: { maxSpend: mandate.maxSpend, allowedCategories: mandate.allowedCategories, expiresAt: mandate.expiresAt },
    negotiation:         negotiationResult,
    revenue,
    userPolicyResult,
    merchantPolicyResult,
    decision: finalDecision,
  };

  return {
    transactionId: txId,
    decision:  finalDecision,
    status,
    reasoning: finalReasoning,
    payment,
    revenue,
    finalCart: effectiveCart,
    fullTrace,
  };
}

// ─── Two-phase confirm / cancel ─────────────────────────────────────────────────

/**
 * reconcileEditedCart — rebuild the exact cart to charge from a buyer's edited
 * selection on the confirmation screen.
 *
 * The buyer sends product IDs ONLY — never prices. Each line's price is resolved
 * server-side, with this authority order:
 *   1. the STASHED cart line carrying that id — reused verbatim. This preserves
 *      any negotiated / bundle-discounted price the pipeline already computed for
 *      this transaction (bundle accessories are stashed at a discounted price with
 *      the list price kept on `listPrice`; re-deriving from catalog would overcharge).
 *   2. the catalog LIST price — for a product freshly added or swapped in.
 * Because the price never comes from the client, a buyer can neither invent a price
 * nor inflate a discount. Unknown ids are collected and reported (→ invalid_cart).
 *
 * @param {Array<{productId:string}>} editItems  buyer's chosen line items (ids only)
 * @param {{ items: Array }} stashedCart          the authoritative pending cart
 * @param {CatalogProduct[]} cat                  catalog for newly added items
 * @returns {{ items: Array, unknown: string[] }}
 */
function reconcileEditedCart(editItems, stashedCart, cat) {
  const stashedById = new Map((stashedCart.items ?? []).map(it => [it.product?.id, it]));
  const items = [];
  const unknown = [];
  for (const raw of editItems) {
    const productId = raw?.productId ?? raw?.id;
    const stashed = stashedById.get(productId);
    if (stashed) {
      // Reuse the negotiated line verbatim (keeps bundle/upsell pricing intact).
      items.push({ product: stashed.product, category: stashed.category, price: stashed.price });
      continue;
    }
    const prod = (cat ?? []).find(p => p.id === productId);
    if (!prod) { unknown.push(String(productId)); continue; }
    // Newly added / swapped-in product → catalog list price, server-derived.
    items.push({ product: prod, category: prod.category, price: prod.price });
  }
  return { items, unknown };
}

/**
 * confirmPurchase — release the charge for a purchase that is awaiting human
 * confirmation (was orchestrated with deferPayment:true and is still pending).
 *
 * Editable confirmation: the buyer may adjust the cart before paying (add / remove /
 * swap line items) by passing `edit.items` — an array of { productId }. The cart is
 * rebuilt from those ids with prices re-derived server-side (see reconcileEditedCart);
 * an unknown id or an empty selection returns { code:'invalid_cart' } and RETAINS the
 * pending record so the buyer can fix it. An actual change appends a `cart_edited`
 * audit step recording the before/after.
 *
 * Over-budget override (human-in-the-loop, bounded): the signed-mandate gate is
 * RE-RUN at confirm time against the EXACT cart to be charged. Its two failure stages
 * are treated differently:
 *   • signature stage (expired / tampered / bad-signature mandate) → ALWAYS refused.
 *     This is tampering, never a buyer choice. Pending is dropped and we escalate.
 *   • containment stage (over the spend ceiling OR out-of-category) → the human
 *     holder's call. Refused UNLESS the buyer passes edit.acknowledgeOverBudget:true,
 *     in which case we log a `budget_override` audit step and proceed. The AGENT
 *     stays hard-bounded by the mandate; only the human can consciously exceed it,
 *     and only with an explicit, recorded acknowledgment.
 *
 * Idempotency / double-charge safety: the pending record is the single source of
 * truth. It is deleted on success, on cancellation, and on a refused gate failure,
 * so a transaction can be charged at most once. A confirm on an unknown/already-
 * settled id returns { ok:false, code:'not_pending' } and moves no money. An
 * invalid_cart (fixable) and a payment_failed (retryable) both RETAIN pending.
 *
 * Payment-provider failure: if the provider throws, we append a payment_failed
 * audit entry and RETAIN the pending record so the buyer can retry.
 *
 * Backward compatible: called with one argument (or with no edit.items), it charges
 * the exact stashed cart just as before — every existing two-phase test is unaffected.
 *
 * @param {string} transactionId
 * @param {{ items?: Array<{productId:string}>, acknowledgeOverBudget?: boolean }} [edit]
 * @param {CatalogProduct[]} [cat]   catalog used to price newly added items
 * @returns {Promise<{ ok, code?, status, decision?, reasoning?, payment?, revenue?, finalCart?, edited?, overridden?, transactionId }>}
 */
async function confirmPurchase(transactionId, edit = {}, cat = catalog) {
  const pending = getPending(transactionId);
  if (!pending) {
    return { ok: false, code: 'not_pending', status: 'not_pending', transactionId,
      reasoning: 'No purchase is awaiting confirmation for this transaction (already confirmed, cancelled, or unknown).' };
  }

  const { mandate, revenue } = pending;
  let chargeCart = pending.effectiveCart;
  let edited = false;

  // ── Optional buyer edit: swap / add / remove line items ────────────────────
  // Rebuilt from product IDs only; prices are re-derived server-side (stashed line
  // first, then catalog list price) so the client can never supply or inflate one.
  if (Array.isArray(edit.items)) {
    if (edit.items.length === 0) {
      return { ok: false, code: 'invalid_cart', status: 'invalid_cart', transactionId,
        reasoning: 'Cart cannot be empty — add at least one item, or cancel the purchase. No charge was made.' };
    }
    const { items, unknown } = reconcileEditedCart(edit.items, pending.effectiveCart, cat);
    if (unknown.length) {
      // Retain pending so the buyer can correct the selection and confirm again.
      return { ok: false, code: 'invalid_cart', status: 'invalid_cart', transactionId,
        reasoning: `Unknown product(s) in edited cart: ${unknown.join(', ')}. No charge was made.` };
    }
    const total = items.reduce((s, i) => s + i.price, 0);
    const before = pending.effectiveCart;
    const sameItems = items.length === before.items.length &&
      items.every((it, i) => it.product?.id === before.items[i]?.product?.id);
    edited = !sameItems;
    chargeCart = { ...before, items, total, over_budget: total > mandate.maxSpend };

    if (edited) {
      appendAudit(transactionId, {
        step:   'cart_edited',
        input:  { from: { total: before.total, items: before.items.map(i => i.product?.id) } },
        output: { to:   { total: chargeCart.total, items: chargeCart.items.map(i => i.product?.id) } },
      });
    }
  }

  // Re-verify the signed mandate at charge time (defense-in-depth), now against the
  // EXACT cart to be charged (possibly edited).
  const gate = gateCartAgainstMandate(chargeCart, mandate);
  appendAudit(transactionId, {
    step:  'mandate_payment_gate',
    input: { total: chargeCart.total, maxSpend: mandate.maxSpend, phase: 'confirm', edited },
    output: gate,
  });

  let overridden = false;
  if (!gate.ok) {
    // A broken/expired SIGNATURE is tampering, never a buyer choice → always refuse.
    // A CONTAINMENT breach (over ceiling / out-of-category) is the human's call:
    // allowed only with an explicit acknowledgment, and always audited.
    const canOverride = gate.stage === 'containment' && edit.acknowledgeOverBudget === true;
    if (canOverride) {
      overridden = true;
      appendAudit(transactionId, {
        step:   'budget_override',
        input:  { total: chargeCart.total, maxSpend: mandate.maxSpend, violation: gate.reason },
        output: { acknowledgedBy: 'buyer', authorized: true },
      });
    } else {
      deletePending(transactionId); // refuse + drop; no retry on an unauthorized breach
      const reasoning = `Payment blocked by signed-mandate gate at the ${gate.stage} stage on confirmation: ${gate.reason}. ` +
        (gate.stage === 'containment'
          ? 'Escalated — confirm again with explicit over-budget authorization to proceed, or cancel. No charge was made.'
          : 'Escalated for manual review — no charge was made.');
      appendAudit(transactionId, { step: 'decision_override', input: { from: 'pending_confirmation', reason: gate.reason }, output: { decision: 'escalated' } });
      return { ok: false, code: 'gate_failed', status: 'escalated', decision: 'escalated', reasoning, transactionId };
    }
  }

  // Buyer authorized → attempt the actual charge.
  appendAudit(transactionId, {
    step:  'purchase_confirmed',
    input: { total: chargeCart.total },
    output: { confirmedBy: 'buyer', total: chargeCart.total, edited, overridden },
  });

  let paymentOrder;
  try {
    paymentOrder = await createPaymentOrder(chargeCart);
  } catch (err) {
    // Provider failed — keep the pending record so the buyer can retry.
    appendAudit(transactionId, {
      step:  'payment_failed',
      input: { total: chargeCart.total },
      output: { error: err.message },
    });
    return { ok: false, code: 'payment_failed', status: 'payment_failed',
      reasoning: `Payment provider error: ${err.message}. No charge was made — you can retry.`, transactionId };
  }

  const payment = {
    orderId:  paymentOrder.orderId,
    amount:   paymentOrder.amount,
    currency: paymentOrder.currency,
    keyId:    process.env.RAZORPAY_KEY_ID,
  };
  appendAudit(transactionId, {
    step:   'payment_order_created',
    input:  { total: chargeCart.total },
    output: { orderId: payment.orderId, amount: payment.amount, currency: payment.currency },
  });

  deletePending(transactionId); // settled — can never be charged again

  // If the buyer edited the cart, recompute the uplift metric so the UI reflects
  // what was actually charged. The baseline (pre-negotiation cart) never changes.
  let finalRevenue = revenue;
  if (edited && revenue) {
    const baseline = revenue.baseline ?? chargeCart.total;
    finalRevenue = {
      ...revenue,
      final:     chargeCart.total,
      uplift:    chargeCart.total - baseline,
      upliftPct: baseline ? Math.round((chargeCart.total - baseline) / baseline * 10000) / 100 : 0,
    };
  }

  return { ok: true, status: 'paid', decision: 'approved', payment, revenue: finalRevenue,
    finalCart: chargeCart, edited, overridden, transactionId,
    reasoning: overridden
      ? 'Buyer confirmed with explicit over-budget authorization (recorded as a human override). Payment order created.'
      : 'Buyer confirmed. Payment order created.' };
}

/**
 * cancelPurchase — buyer declined a pending confirmation. Drops the stashed
 * charge and records it in the audit trail. No money moves, ever.
 *
 * @param {string} transactionId
 * @returns {{ ok, code?, status, transactionId }}
 */
function cancelPurchase(transactionId) {
  const pending = getPending(transactionId);
  if (!pending) {
    return { ok: false, code: 'not_pending', status: 'not_pending', transactionId };
  }
  deletePending(transactionId);
  appendAudit(transactionId, {
    step:   'purchase_cancelled',
    input:  { total: pending.effectiveCart.total },
    output: { cancelledBy: 'buyer' },
  });
  return { ok: true, status: 'cancelled', transactionId };
}

// ─── Goal-driven alternatives (Problem 3) ───────────────────────────────────────

/**
 * Project an option's line items into the client-facing display shape (mirrors the
 * finalCart item shape the confirmation UI already renders: { product, category,
 * price }). Only safe, public product fields are exposed.
 */
function serializeOptionItems(items) {
  return (items ?? []).map(i => ({
    product: {
      id:       i.product.id,
      name:     i.product.name,
      category: i.product.category,
      tier:     i.product.tier,
      price:    i.product.price,
      features: i.product.features ?? [],
    },
    category: i.category,
    price:    i.price,
  }));
}

/**
 * Build the `options_required` response envelope the frontend renders as an A/B/C
 * picker. It intentionally mirrors the normal pipeline response (transactionId,
 * decision, status, reasoning, fullTrace) so the client can treat it uniformly,
 * plus an `options` array and the `ideal` cart for context.
 */
function buildOptionsResponse(txId, intent, optionSet) {
  const idealTotal = optionSet.ideal.total;
  const reasoning = optionSet.feasible
    ? `The ideal setup costs ₹${idealTotal}, which is over your ₹${intent.budget} budget. ` +
      `Here are ${optionSet.options.length} way(s) to hit your goal within budget — pick one to continue. Nothing has been charged.`
    : `Even the most affordable complete setup exceeds your ₹${intent.budget} budget. ` +
      `You can proceed with the closest complete setup (over budget, needs your authorization) or a core setup that fits — pick one, or raise your budget. Nothing has been charged.`;

  return {
    transactionId: txId,
    decision:  'options_required',
    status:    'options_required',
    reasoning,
    feasible:  optionSet.feasible,
    ideal:     { items: serializeOptionItems(optionSet.ideal.items), total: idealTotal },
    options:   optionSet.options.map(o => ({
      id:          o.id,
      label:       o.label,
      description: o.description,
      items:       serializeOptionItems(o.items),
      total:       o.total,
      withinBudget: o.withinBudget,
      tradeoffs:   o.tradeoffs,
      upgrades:    o.upgrades,
    })),
    payment:   null,
    revenue:   null,
    finalCart: null,
    fullTrace: {
      intent,
      options: { ideal: optionSet.ideal, feasible: optionSet.feasible, count: optionSet.options.length },
    },
  };
}

/**
 * Decide whether to present goal-driven alternatives, and if so stash them.
 *
 * Triggers ONLY when the request is a coordinated SETUP whose IDEAL (best goal-fit)
 * configuration can't be achieved within budget. A single-item request never
 * triggers this — its affordable variant is handled directly by the negotiation
 * pipeline (buildCart's goal-fit baseline + rescue), never expanded into options.
 *
 * @returns {object|null}  an `options_required` response to send, or null to mean
 *                         "no alternatives needed — proceed with orchestrate()".
 */
function prepareOptions(intent, userPolicy, merchantPolicy, transactionId, cat = catalog) {
  if (intent.scope !== 'setup') return null;

  const optionSet = generateOptions({
    categories:     intent.categories,
    useCase:        intent.useCase,
    budget:         intent.budget,
    catalog:        cat,
    goalType:       intent.goalType,
    heroCategories: intent.heroCategories,
  });

  // Ideal fits, or (defensively) nothing to offer → let the normal pipeline run.
  if (optionSet.fits || !optionSet.options.length) return null;

  appendAudit(transactionId, {
    step:  'options_generated',
    input: { idealTotal: optionSet.ideal.total, budget: intent.budget, feasible: optionSet.feasible },
    output: { count: optionSet.options.length, ids: optionSet.options.map(o => o.id) },
  });

  if (pendingOptions.size >= MAX_PENDING_OPTIONS) {
    pendingOptions.delete(pendingOptions.keys().next().value);
  }
  pendingOptions.set(transactionId, {
    options: optionSet.options,
    intent,
    userPolicy,
    merchantPolicy,
    createdAt: new Date().toISOString(),
  });

  return buildOptionsResponse(transactionId, intent, optionSet);
}

/**
 * selectPurchase — the buyer picked one of the A/B/C alternatives. Resolve that
 * option's concrete cart, LOCK it (no re-negotiation — see orchestrate's lockedCart
 * branch), and run it through the exact same policy + signed-mandate gates and
 * two-phase confirmation as any other cart.
 *
 * Outcomes:
 *   • a within-budget option → pending_confirmation (buyer confirms → paid)
 *   • the over-budget "closest complete setup" (infeasible case) → the mandate gate
 *     blocks the charge and it escalates gracefully — no money moves. This is the
 *     bounded-failure showcase: the agent will not exceed its mandate on its own.
 *
 * The option set is consumed on the first successful selection so a transaction
 * can't be double-started.
 *
 * @param {string} transactionId
 * @param {string} optionId          'A' | 'B' | 'C'
 * @param {CatalogProduct[]} [cat]
 * @returns {Promise<object>}  the orchestrate() result, or an error envelope.
 */
async function selectPurchase(transactionId, optionId, cat = catalog) {
  const pending = pendingOptions.get(transactionId);
  if (!pending) {
    return { ok: false, code: 'not_pending_options', status: 'not_pending', transactionId,
      reasoning: 'No options are awaiting selection for this transaction (already selected, expired, or unknown).' };
  }

  const option = pending.options.find(o => o.id === optionId);
  if (!option) {
    return { ok: false, code: 'invalid_option', status: 'invalid_option', transactionId,
      reasoning: `Unknown option '${optionId}'. Choose one of: ${pending.options.map(o => o.id).join(', ')}.` };
  }

  // Consume the option set — a selection starts the two-phase flow exactly once.
  pendingOptions.delete(transactionId);

  const items = option.items.map(i => ({ product: i.product, category: i.category, price: i.price }));
  const total = items.reduce((s, i) => s + i.price, 0);
  const lockedCart = {
    items,
    total,
    currency:         'INR',
    budget:           pending.intent.budget,
    over_budget:      total > pending.intent.budget,
    baselineStrategy: 'user-selected',
  };

  appendAudit(transactionId, {
    step:  'option_selected',
    input: { optionId, available: pending.options.map(o => o.id) },
    output: { id: option.id, label: option.label, total, withinBudget: option.withinBudget },
  });

  // deferPayment:true — a selected in-budget option still pauses for the explicit
  // human confirmation before any charge (same two-phase flow as a direct purchase).
  return orchestrate(pending.intent, cat, pending.userPolicy, pending.merchantPolicy, transactionId, {
    deferPayment: true,
    lockedCart,
  });
}

// ─── Express route handler ────────────────────────────────────────────────────

/**
 * POST /api/purchase
 *
 * Body:
 *   {
 *     userText:       string,
 *     userPolicy:     { max_spending },
 *     merchantPolicy: { max_discount, min_margin }
 *   }
 *
 * The user's natural-language request is the ONLY source of intent.
 * Categories, scope, goal type, and allowed categories are ALL derived
 * server-side by the goal-first pipeline (parseIntent → classifyGoal).
 */
/**
 * I3 — Validate userPolicy and merchantPolicy shapes before the pipeline runs.
 * Malformed policy objects (e.g. max_spending: "hello") cause silent arithmetic
 * corruption inside policyService. Reject with 400 at the boundary.
 *
 * allowed_categories is no longer client-sent — it is derived from the goal
 * profile and injected server-side so there is ONE source of truth.
 *
 * @returns {string|null}  Error message, or null if valid.
 */
function validatePolicyShapes(userPolicy, merchantPolicy) {
  if (!userPolicy || typeof userPolicy !== 'object') return 'userPolicy must be an object';
  if (typeof userPolicy.max_spending !== 'number' || userPolicy.max_spending < 0)
    return 'userPolicy.max_spending must be a non-negative number';
  // allowed_categories is now server-derived; accept but don't require from client

  if (!merchantPolicy || typeof merchantPolicy !== 'object') return 'merchantPolicy must be an object';
  if (typeof merchantPolicy.max_discount !== 'number' ||
      merchantPolicy.max_discount < 0 || merchantPolicy.max_discount > 100)
    return 'merchantPolicy.max_discount must be a number between 0 and 100';
  if (typeof merchantPolicy.min_margin !== 'number' || merchantPolicy.min_margin < 0)
    return 'merchantPolicy.min_margin must be a non-negative number';

  return null; // valid
}

async function purchaseHandler(req, res) {
  const { userText, userPolicy, merchantPolicy } = req.body ?? {};

  if (!userText || typeof userText !== 'string') {
    return res.status(400).json({ error: 'userText is required and must be a string' });
  }

  // I3 — reject malformed policy shapes before any processing
  const policyError = validatePolicyShapes(userPolicy, merchantPolicy);
  if (policyError) {
    return res.status(400).json({ error: policyError });
  }

  try {
    const txId = crypto.randomUUID();
    createAudit(txId);

    // ── Step 1: Parse the natural-language request into a structured intent ──
    const intent = await parseIntent(userText);
    appendAudit(txId, { step: 'intent_parsing', input: { userText }, output: intent });

    // ── Step 2: Goal-first classification — THE single source of truth ───────
    // Determines goalType (gaming/office/content-creation/general), scope
    // (single-item vs setup), categories to build the cart from, and the
    // allowed category whitelist for the mandate. No manual selection.
    const goalProfile = classifyGoal(intent);
    Object.assign(intent, goalProfile);
    appendAudit(txId, { step: 'goal_classification', input: { goal: intent.goal, preferencesFromLLM: Object.keys(intent.preferences ?? {}) }, output: goalProfile });

    // ── Step 3: Auto-derive the grow/rescue strategy ─────────────────────────
    // 'goalfit' baseline (cheapest-first) gives headroom for revenue-growth.
    // The NegotiationSession auto-selects rescue (over-budget) vs growth
    // (under-budget) — no manual toggle needed.
    intent.baselineStrategy = 'goalfit';
    intent.mandate = growthMandateFromIntent(intent, catalog);

    // ── Step 4: Auto-derive userPolicy.allowed_categories from goal profile ──
    // The client sends max_spending only. The permitted categories come from
    // the goal profile so there is ONE source of truth (no manual checkboxes).
    const enrichedUserPolicy = {
      ...userPolicy,
      allowed_categories: Array.isArray(userPolicy.allowed_categories) && userPolicy.allowed_categories.length
        ? userPolicy.allowed_categories   // backward compat if explicitly sent
        : goalProfile.allowedCategories,
    };

    // ── Step 5: Goal-driven ALTERNATIVES (Problem 3) ─────────────────────────
    // For a coordinated SETUP whose IDEAL configuration can't be met within
    // budget, pause and offer the buyer A/B/C alternatives to choose from,
    // rather than silently negotiating one cart. Returns null when the ideal
    // fits (or for a single-item request) — then the normal pipeline runs.
    const optionsResponse = prepareOptions(intent, enrichedUserPolicy, merchantPolicy, txId, catalog);
    if (optionsResponse) {
      return res.json(optionsResponse);
    }

    // deferPayment:true — the web flow is two-phase. orchestrate() runs every
    // gate and, on approval, stashes the cart as pending WITHOUT charging. The
    // buyer reviews the exact products/price/mandate on the frontend and an
    // explicit POST …/confirm releases the charge. "Money only moves on a human yes."
    const result = await orchestrate(intent, catalog, enrichedUserPolicy, merchantPolicy, txId, { deferPayment: true });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── Confirm / cancel route handlers ────────────────────────────────────────────

/**
 * Shared possession-proof auth for confirm/cancel, mirroring the audit route:
 * the caller must present the transactionId (a 128-bit UUID) they were given,
 * as x-audit-token header or ?token query param. Returns true if authorized;
 * otherwise writes a 401 and returns false.
 */
function authorizeTxn(req, res) {
  const token = req.headers['x-audit-token'] ?? req.query.token;
  if (!token || token !== req.params.transactionId) {
    res.status(401).json({
      error: 'Unauthorized. Supply the transactionId as x-audit-token header or ?token query param.',
    });
    return false;
  }
  return true;
}

/**
 * POST /api/purchase/:transactionId/confirm
 * Releases the charge for a pending, human-approved purchase.
 *
 * Optional JSON body (all fields optional — an empty body charges the stashed cart):
 *   {
 *     items: [{ productId }],        // buyer-edited line items (add/remove/swap)
 *     acknowledgeOverBudget: bool    // explicit authorization to exceed the mandate
 *   }
 * Prices are always re-derived server-side; the client never supplies a price.
 *
 *   200 { ok:true,  status:'paid', payment, finalCart, edited, overridden } — charged
 *   200 { ok:false, status:'escalated' }            — confirm-time gate failure (refused)
 *   400 { ok:false, code:'invalid_cart' }           — empty / unknown product (pending kept)
 *   409 { ok:false, code:'not_pending' }            — nothing to confirm
 *   502 { ok:false, code:'payment_failed' }         — provider error (retryable)
 */
async function confirmHandler(req, res) {
  if (!authorizeTxn(req, res)) return;
  const body = req.body ?? {};
  const edit = {
    items: Array.isArray(body.items) ? body.items : undefined,
    acknowledgeOverBudget: body.acknowledgeOverBudget === true,
  };
  try {
    const result = await confirmPurchase(req.params.transactionId, edit);
    if (result.ok) return res.json(result);
    if (result.code === 'not_pending')    return res.status(409).json(result);
    if (result.code === 'invalid_cart')   return res.status(400).json(result);
    if (result.code === 'payment_failed') return res.status(502).json(result);
    // gate_failed → escalated, no charge: a valid 200 outcome (handled gracefully)
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/catalog — the public product list the confirmation screen uses to let a
 * buyer add / swap items. Read-only projection over the catalog (no internal fields).
 * Prices here are LIST prices for display; the confirm flow re-derives the actual
 * charge price server-side (stashed negotiated price first, then this list price).
 */
function catalogHandler(_req, res) {
  const products = catalog.map(({ id, name, category, tier, price, features, stock }) =>
    ({ id, name, category, tier, price, features, stock }));
  return res.json({ products, currency: 'INR' });
}

/**
 * POST /api/purchase/:transactionId/cancel
 * Buyer declined a pending confirmation.
 *   200 { ok:true, status:'cancelled' }
 *   409 { ok:false, code:'not_pending' }
 */
function cancelHandler(req, res) {
  if (!authorizeTxn(req, res)) return;
  const result = cancelPurchase(req.params.transactionId);
  if (result.ok) return res.json(result);
  return res.status(409).json(result);
}

/**
 * POST /api/purchase/:transactionId/select
 * The buyer picked one of the A/B/C alternatives offered by an `options_required`
 * response. Locks that option's cart and runs it through the pipeline.
 *
 * Body: { optionId: 'A' | 'B' | 'C' }
 *
 *   200 { status:'pending_confirmation', finalCart, ... } — in-budget pick, awaiting confirm
 *   200 { status:'escalated' }                            — over-budget pick blocked by gate (no charge)
 *   200 { status:'rejected' }                             — pick violates user policy
 *   400 { code:'invalid_option' }                         — unknown optionId
 *   409 { code:'not_pending_options' }                    — nothing awaiting selection
 */
async function selectHandler(req, res) {
  if (!authorizeTxn(req, res)) return;
  const optionId = (req.body?.optionId ?? '').toString().trim();
  if (!optionId) {
    return res.status(400).json({ error: 'optionId is required (A, B or C)' });
  }
  try {
    const result = await selectPurchase(req.params.transactionId, optionId);
    if (result.code === 'not_pending_options') return res.status(409).json(result);
    if (result.code === 'invalid_option')      return res.status(400).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

module.exports = {
  orchestrate,
  purchaseHandler,
  prepareOptions,
  selectPurchase,
  confirmPurchase,
  cancelPurchase,
  confirmHandler,
  cancelHandler,
  selectHandler,
  catalogHandler,
  _resetPendingOptions,
};
