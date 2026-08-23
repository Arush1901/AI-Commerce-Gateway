const express = require('express');
const { purchaseHandler } = require('./orchestrator');
const { getAudit }        = require('./auditService');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Purchase pipeline
app.post('/api/purchase', purchaseHandler);

// Audit trail
app.get('/api/audit/:transactionId', (req, res) => {
  const trail = getAudit(req.params.transactionId);
  if (!trail) return res.status(404).json({ error: 'Audit trail not found' });
  return res.json(trail);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
