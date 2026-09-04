# AI Commerce Gateway

A goal-first agentic commerce gateway that turns a natural-language shopping request into a compliant, bounded, and fully auditable purchase. A merchant-side AI agent grows the basket value where there is headroom and rescues the sale where there is not, while a signed buyer mandate keeps every rupee inside limits the buyer authorized. Every money action is explainable, gated before payment, and recorded in an audit trail.

Built for the **Razorpay AI Buildathon, Track 01 (AI Growth and Agentic Commerce)**.

---

## The problem this solves

Agentic commerce only works if a merchant can let an AI transact on a buyer's behalf without losing control of the money. The bar for Track 01 is that every money action must be explainable, bounded, gated, and audited, with failure handled gracefully.

AI Commerce Gateway meets that bar with four guarantees:

- **Explainable.** Every decision carries human-readable reasoning and a step-by-step audit record.
- **Bounded.** Spending is capped by a signed mandate that the buyer authorizes up front. Any attempt to exceed it is caught.
- **Gated.** No payment is created until the cart passes both the buyer policy gate and the merchant policy gate.
- **Audited.** Each transaction produces an ordered audit trail from intent parsing through the payment decision.

---

## How it works

The buyer describes what they want in plain language and states a budget. The pipeline does the rest:

1. **Intent parsing.** A Groq-hosted LLM extracts a structured intent from the free-text request.
2. **Goal classification.** The intent is deterministically classified into a goal (for example, a gaming setup versus a single item), which derives the relevant product categories, hero categories, and essential add-ons. The buyer never picks categories manually.
3. **Mandate issue.** A spend mandate is HMAC-signed and scoped to the derived categories and the stated budget.
4. **Cart build and negotiation.** A cart is assembled from the catalog. A bounded buyer-merchant negotiation then adjusts it: the merchant agent grows basket value where the budget allows, and falls back to tier downgrades to rescue a sale that would otherwise be lost.
5. **Options branch.** When a complete setup cannot fit the budget, the flow returns up to three distinct options (best-affordable, balanced, and cheapest-complete) for the buyer to choose from, instead of failing.
6. **Policy gates.** The effective cart is checked against the buyer policy and the merchant policy. Decision precedence is rejected, then escalated, then approved.
7. **Two-phase confirmation.** An approved cart enters a pending state. Payment is only created after the buyer explicitly confirms. A consciously chosen over-budget option can be authorized with an explicit acknowledgement rather than being hard-rejected.
8. **Audit.** Every step above is appended to the transaction's audit trail.

The mandate gate distinguishes two kinds of failure. A **signature-stage** failure (tampering or expiry) always refuses, because it is never a legitimate buyer choice. A **containment-stage** failure (over budget or out of category) can be overridden by an explicit human acknowledgement, because the buyer may knowingly choose it.

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Backend | Node.js (>=18), Express 5, CommonJS |
| Frontend | React 18, Vite 5 |
| Intent extraction | Groq LLM (OpenAI-compatible API) |
| Payments | Razorpay orders API |
| Mandate | HMAC-signed spend mandate |

---

## Project structure

```
AI-Commerce-Gateway/
├── package.json            Root scripts (delegate to server and client)
├── LICENSE                 MIT
├── README.md
├── WORKFLOW_REPORT.md      Detailed design and verification report
├── BUILDATHON_PLAN.md      Track 01 strategy notes
├── server/
│   ├── package.json
│   ├── .env.example        Copy to .env and fill in
│   ├── src/
│   │   ├── index.js        Express entry point and routes
│   │   ├── core/           orchestrator.js, schemas.js
│   │   ├── services/       goal, intent, cart, options, negotiation,
│   │   │                   policy, payment, audit, pending, catalog,
│   │   │                   constraint
│   │   ├── agents/         BuyerAgent, MerchantAgent, NegotiationSession,
│   │   │                   mandate, agentSchemas
│   │   └── data/           catalog.json (49 products, 19 categories)
│   └── tests/              13 standalone test suites
└── client/
    ├── package.json
    ├── vite.config.js
    └── src/                App.jsx, main.jsx, index.css
```

---

## Getting started

### Prerequisites

- Node.js 18 or newer
- A Groq API key ([console.groq.com/keys](https://console.groq.com/keys))
- Razorpay test API keys ([dashboard.razorpay.com/app/keys](https://dashboard.razorpay.com/app/keys))

### 1. Install dependencies

From the repository root:

```bash
npm run install:all
```

This installs both the server and client dependencies. You can also install them separately with `npm --prefix server install` and `npm --prefix client install`.

### 2. Configure environment

Copy the example file and fill in real values:

```bash
cp server/.env.example server/.env
```

The `.env` file is git-ignored and must never be committed. See the environment variables table below.

### 3. Run the server

```bash
npm start
```

The API listens on port 3001 by default.

### 4. Run the client

In a second terminal:

```bash
npm run dev:client
```

The Vite dev server runs on port 3000 and proxies `/api` requests to the server on port 3001.

---

## Environment variables

Set these in `server/.env` (see `server/.env.example`).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GROQ_API_KEY` | Yes | none | Groq API key used for intent extraction. |
| `GROQ_BASE_URL` | No | `https://api.groq.com/openai/v1` | Groq OpenAI-compatible base URL. |
| `GROQ_MODEL` | No | `openai/gpt-oss-120b` | Model used for intent parsing. |
| `RAZORPAY_KEY_ID` | Yes | none | Razorpay key id (use a test key for development). |
| `RAZORPAY_KEY_SECRET` | Yes | none | Razorpay key secret. |
| `MANDATE_SECRET` | No | demo default | Secret used to HMAC-sign the spend mandate. Set a long random string in production. |
| `PORT` | No | `3001` | Port the Express API listens on. |

---

## API reference

Base URL: `http://localhost:3001`

### `GET /api/health`

Health check. Returns service status.

### `POST /api/purchase`

Starts a purchase from a natural-language request. The pipeline derives categories, strategy, and mandate automatically.

Request body:

```json
{
  "userText": "I want a gaming setup for around 20000",
  "userPolicy":     { "max_spending": 20000 },
  "merchantPolicy": { "max_discount": 80, "min_margin": 5 }
}
```

The response `status` is one of:

| Status | Meaning |
|--------|---------|
| `pending_confirmation` | Cart approved and awaiting explicit buyer confirmation. |
| `options_required` | The setup cannot fit the budget; up to three options are returned to choose from. |
| `escalated` | A gate blocked the purchase (for example a tampered or expired mandate). |
| `rejected` | The purchase was refused. |

### `POST /api/purchase/:transactionId/select`

Selects one of the options returned by an `options_required` response. Builds a locked cart and runs it through the gates without re-negotiating. Returns `pending_confirmation`, or `pending_confirmation` flagged over-budget when the chosen option exceeds the budget.

### `POST /api/purchase/:transactionId/confirm`

Confirms a pending purchase and creates the payment order. To authorize a consciously chosen over-budget cart, include `{ "acknowledgeOverBudget": true }`. Returns `paid` on success or `payment_failed` on a payment error. Confirming an over-budget cart without the acknowledgement is refused.

### `POST /api/purchase/:transactionId/cancel`

Cancels a pending purchase. Returns `cancelled`.

### `GET /api/catalog`

Returns the product catalog for browsing.

### `GET /api/audit/:transactionId`

Returns the ordered audit trail for a transaction. Requires an audit token supplied via the `x-audit-token` header or a `?token=` query parameter; returns 401 without it and 404 for an unknown transaction.

---

## Testing

The backend ships 13 standalone test suites with 649 assertions in total. They run deterministically without any external services (the payment client is mocked and the pipeline is drivable with a pre-parsed intent), so a dummy Groq key is enough:

```bash
cd server
GROQ_API_KEY=dummy npm test
```

Individual suites can be run with the `test:*` scripts declared in `server/package.json`, for example `npm run test:orchestrator` or `npm run test:growth`.

---

## License

Released under the MIT License. See [LICENSE](LICENSE).
