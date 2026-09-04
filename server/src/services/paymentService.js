'use strict';

require('dotenv').config();

const crypto  = require('crypto');
const Razorpay = require('razorpay');

/**
 * Module-level Razorpay client.
 * Lazy-initialised on first use so the module loads even without credentials.
 * Replaceable via _setClient() for unit tests.
 */
let _client = null;

function getClient() {
  if (_client) return _client;

  const key_id     = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret) {
    throw new Error('Razorpay credentials missing: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env');
  }

  _client = new Razorpay({ key_id, key_secret });
  return _client;
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Create a Razorpay test-mode payment order for an approved cart.
 *
 * @param {{ total: number, currency?: string }} finalCart
 * @returns {Promise<{ orderId: string, amount: number, currency: string }>}
 * @throws {Error} if the Razorpay API call fails
 */
async function createPaymentOrder(finalCart) {
  const amountPaise = Math.round(finalCart.total * 100); // INR → paise
  // D2 fix: crypto.randomUUID() is collision-safe and not seeded like Math.random()
  const receipt     = `rcpt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const client = getClient();

  let order;
  try {
    order = await client.orders.create({
      amount:   amountPaise,
      currency: 'INR',
      receipt,
    });
  } catch (err) {
    throw new Error(`Razorpay order creation failed: ${err.message ?? err}`);
  }

  return {
    orderId:  order.id,
    amount:   order.amount,    // paise, as returned by Razorpay
    currency: order.currency,
  };
}

// ─── test helpers (never called in production) ────────────────────────────────

/** Replace the Razorpay client (for unit tests). */
function _setClient(mock) { _client = mock; }

/** Reset to lazy-init real client (call between tests). */
function _resetClient() { _client = null; }

module.exports = { createPaymentOrder, _setClient, _resetClient };
