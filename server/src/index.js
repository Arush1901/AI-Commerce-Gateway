const express = require('express');
const { purchaseHandler, confirmHandler, cancelHandler, selectHandler, catalogHandler } = require('./core/orchestrator');
const { getAudit }        = require('./services/auditService');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// ─── Purchase pipeline ────────────────────────────────────────────────────────
// Two-phase: POST /api/purchase runs every gate and, on approval, returns
// status:'pending_confirmation' WITHOUT charging. The buyer reviews the exact
// cart on the frontend, then authorizes the charge with .../confirm (or drops
// it with .../cancel). Money only moves on an explicit human "yes".
//
// When the ideal goal setup can't be met within budget, /api/purchase instead
// returns status:'options_required' with A/B/C alternatives; the buyer picks one
// with .../select, which locks that cart and returns pending_confirmation.
app.post('/api/purchase', purchaseHandler);
app.post('/api/purchase/:transactionId/select', selectHandler);
app.post('/api/purchase/:transactionId/confirm', confirmHandler);
app.post('/api/purchase/:transactionId/cancel', cancelHandler);

// ─── Catalog ──────────────────────────────────────────────────────────────────
// Read-only product list the confirmation screen uses to let a buyer add/swap
// items. List prices are for display only; the confirm flow re-derives the real
// charge price server-side (never trusting a client-supplied price).
app.get('/api/catalog', catalogHandler);

// ─── Audit trail (C3: possession-proof auth) ──────────────────────────────────
// The caller must supply the transactionId as proof they received it.
// Supplied via x-audit-token header OR ?token query param.
// Since transactionId is a UUID (128-bit random), guessing is infeasible.
app.get('/api/audit/:transactionId', (req, res) => {
  const token = req.headers['x-audit-token'] ?? req.query.token;
  if (!token || token !== req.params.transactionId) {
    return res.status(401).json({
      error: 'Unauthorized. Supply the transactionId as x-audit-token header or ?token query param.',
    });
  }

  const trail = getAudit(req.params.transactionId);
  if (!trail) return res.status(404).json({ error: 'Audit trail not found' });
  return res.json(trail);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
