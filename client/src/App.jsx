import { useState, useCallback, useEffect, useMemo } from 'react'
import './index.css'

// ─── constants ────────────────────────────────────────────────────
const STEP_META = {
  intent_parsing:             { label: 'Intent Parsing' },
  goal_classification:        { label: 'Goal Classification' },
  options_generated:          { label: 'Options Generated' },
  option_selected:            { label: 'Option Selected' },
  cart_building:              { label: 'Cart Building' },
  mandate_issued:             { label: 'Mandate Issued' },
  negotiation:                { label: 'Negotiation' },
  revenue_uplift:             { label: 'Revenue Uplift' },
  user_policy_validation:     { label: 'User Policy' },
  merchant_policy_validation: { label: 'Merchant Policy' },
  decision:                   { label: 'Decision' },
  mandate_payment_gate:       { label: 'Mandate Payment Gate' },
  decision_override:          { label: 'Decision Override' },
  awaiting_confirmation:      { label: 'Awaiting Confirmation' },
  cart_edited:                { label: 'Cart Edited' },
  budget_override:            { label: 'Over-Budget Override' },
  purchase_confirmed:         { label: 'Buyer Confirmed' },
  purchase_cancelled:         { label: 'Buyer Cancelled' },
  payment_failed:             { label: 'Payment Failed' },
  payment_order_created:      { label: 'Payment Order' },
}

const DECISION_META = {
  approved:         { label: 'Approved',  cls: 'approved'  },
  rejected:         { label: 'Rejected',  cls: 'rejected'  },
  escalated:        { label: 'Escalated', cls: 'escalated' },
  options_required: { label: 'Choose an Option', cls: 'escalated' },
}

const INR = v => `₹${Number(v ?? 0).toLocaleString('en-IN')}`

// ─── Demo scenarios ──────────────────────────────────────────────
// Each preset fills the whole form so a single click reproduces a story.
const SCENARIOS = {
  gaming: {
    label: 'Gaming Setup',
    hint: 'Goal-driven gaming setup — AI picks gaming-tagged products and relevant categories',
    userText:    'Build me a gaming setup under ₹20,000. Headset is most important.',
    maxSpending: '20000',
    maxDiscount: '60',
    minMargin:   '100',
  },
  office: {
    label: 'Office Setup',
    hint: 'Office-focused peripherals — AI picks office-tagged products only',
    userText:    'I need a productive home-office setup with a headset, keyboard and mouse. Budget ₹15,000.',
    maxSpending: '15000',
    maxDiscount: '60',
    minMargin:   '100',
  },
  single: {
    label: 'Single Item',
    hint: 'Single-item request — AI does NOT expand into other categories',
    userText:    'I need a good gaming mouse, budget ₹6,000.',
    maxSpending: '6000',
    maxDiscount: '80',
    minMargin:   '100',
  },
}



// ─── RevenueHero ─────────────────────────────────────────────────
// The headline "Merchant Growth" metric: baseline → negotiated total,
// framed against the mandate ceiling. Adapts to growth vs rescue.
function RevenueHero({ revenue, ceiling }) {
  if (!revenue) return null
  const { baseline, final, uplift, upliftPct, strategy } = revenue
  const grew    = uplift > 0
  const rescued = uplift < 0
  const max     = Math.max(ceiling ?? 0, baseline, final) || 1

  const basePct  = Math.min(100, (Math.min(baseline, final) / max) * 100)
  const deltaPct = Math.min(100 - basePct, (Math.abs(uplift) / max) * 100)
  const ceilPct  = ceiling ? Math.min(100, (ceiling / max) * 100) : null

  const headline = grew ? 'Revenue Uplift' : rescued ? 'Cart Rescued to Fit Budget' : 'No Net Change'
  const cls      = grew ? 'grow' : rescued ? 'rescue' : 'flat'

  return (
    <div className={`revenue-hero ${cls}`}>
      <div className="revenue-hero-head">
        <div>
          <div className="revenue-hero-label">{headline}</div>
          <div className="revenue-hero-value">
            {grew ? '+' : rescued ? '−' : ''}{INR(Math.abs(uplift))}
            {(grew || rescued) && <span className="revenue-hero-pct"> ({grew ? '+' : '−'}{Math.abs(upliftPct)}%)</span>}
          </div>
        </div>
        <div className="revenue-hero-strategy">
          <span className="pill info">{strategy}</span>
        </div>
      </div>

      {/* baseline → final bar under the mandate ceiling */}
      <div className="revenue-bar" title={ceiling ? `Mandate ceiling ${INR(ceiling)}` : ''}>
        <div className="revenue-bar-base" style={{ width: `${basePct}%` }} />
        <div className={`revenue-bar-delta ${cls}`} style={{ width: `${deltaPct}%` }} />
        {ceilPct != null && <div className="revenue-bar-ceiling" style={{ left: `${ceilPct}%` }} />}
      </div>

      <div className="revenue-legend">
        <span><b>Baseline</b> {INR(baseline)}</span>
        <span className="arrow">→</span>
        <span><b>Negotiated</b> {INR(final)}</span>
        {ceiling != null && <span className="revenue-legend-ceiling">Mandate ceiling {INR(ceiling)}</span>}
      </div>
    </div>
  )
}

// ─── MandateCard ─────────────────────────────────────────────────
// The signed, bounded, verifiable authority the whole pipeline runs under.
function MandateCard({ mandate, signature }) {
  if (!mandate) return null
  const expiry = mandate.expiresAt == null
    ? 'No expiry (demo)'
    : new Date(Number(mandate.expiresAt)).toLocaleString()
  return (
    <div className="mandate-card">
      <div className="mandate-head">
        <span className="mandate-title">Signed Buyer Mandate</span>
        <span className="pill approved">HMAC-signed</span>
      </div>
      <div className="mandate-body">
        <div className="mandate-row">
          <span className="mandate-key">Spend ceiling</span>
          <span className="mandate-val strong">{INR(mandate.maxSpend)}</span>
        </div>
        <div className="mandate-row">
          <span className="mandate-key">Allowed categories</span>
          <span className="mandate-val">
            <span className="chip-row">
              {mandate.allowedCategories?.map(c => <span key={c} className="chip">{c}</span>)}
            </span>
          </span>
        </div>
        <div className="mandate-row">
          <span className="mandate-key">Expires</span>
          <span className="mandate-val">{expiry}</span>
        </div>
        {signature && (
          <div className="mandate-row">
            <span className="mandate-key">Signature</span>
            <span className="mandate-val mono sig">{signature}</span>
          </div>
        )}
      </div>
      <div className="mandate-foot">
        Delegated, scoped, verifiable authority — the same principle as AP2 intent/cart
        mandates and ACP delegated payment tokens. Re-verified at the payment gate.
      </div>
    </div>
  )
}

// ─── TranscriptChat ──────────────────────────────────────────────
// Renders the round-by-round buyer ↔ merchant conversation as a chat.
function parseTranscriptLine(line) {
  const m = line.match(/^\[Round (\d+)\]\s*(Buyer|Merchant):\s*([\s\S]*)$/)
  if (!m) return null
  return { round: Number(m[1]), speaker: m[2], text: m[3].trim() }
}

function TranscriptChat({ transcript }) {
  const lines = (transcript ?? []).map(parseTranscriptLine).filter(Boolean)
  if (lines.length === 0) return null

  return (
    <div className="transcript">
      {lines.map((ln, i) => {
        const isBuyer   = ln.speaker === 'Buyer'
        const declined  = /can'?t accept|breach|exceed|doesn'?t improve|more relevant/i.test(ln.text)
        const accepted  = /^accepted/i.test(ln.text)
        const newRound  = i === 0 || lines[i - 1].round !== ln.round
        return (
          <div key={i}>
            {newRound && <div className="transcript-round">Round {ln.round}</div>}
            <div className={`bubble-row ${isBuyer ? 'left' : 'right'}`}>
              <div className={`bubble ${isBuyer ? 'buyer' : 'merchant'} ${isBuyer && declined ? 'declined' : ''} ${isBuyer && accepted ? 'accepted' : ''}`}>
                <div className="bubble-who">{isBuyer ? 'Buyer' : 'Merchant'}</div>
                <div className="bubble-text">{ln.text}</div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── CartComparison ──────────────────────────────────────────────
// Direction-aware: shows upgrades (price change), added items (new), and
// the baseline→final total in either growth or rescue direction.
function CartComparison({ baseline, final }) {
  const cart = final ?? baseline
  if (!cart) return null
  const baseItems = baseline?.items ?? []
  const delta = (final?.total ?? 0) - (baseline?.total ?? 0)
  const grew  = delta > 0

  const findBase = item =>
    baseItems.find(b => b.product?.id === item.product?.id) ||
    baseItems.find(b => b.category === item.category)

  return (
    <div className="kv">
      <div className="cart-items">
        {cart.items.map((item, i) => {
          const base    = findBase(item)
          const isNew   = !base
          const changed = base && base.price !== item.price
          return (
            <div key={i} className="cart-item">
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap' }}>
                  <span>{item.product?.name ?? item.category}</span>
                  {item.product?.tier && <span className="pill info" style={{ fontSize: '.65rem' }}>{item.product.tier}</span>}
                  {isNew   && <span className="pill approved"  style={{ fontSize: '.65rem' }}>added</span>}
                  {changed && <span className="pill info"      style={{ fontSize: '.65rem' }}>{item.price > base.price ? 'upgraded' : 'substituted'}</span>}
                </div>
                <div className="cart-item-cat">{item.category}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <strong>{INR(item.price)}</strong>
                {changed && <div style={{ fontSize: '.7rem', color: 'var(--muted)', textDecoration: 'line-through' }}>{INR(base.price)}</div>}
              </div>
            </div>
          )
        })}
      </div>
      <div style={{ padding: '.5rem .75rem 0', borderTop: '1px solid var(--border)', marginTop: '.4rem' }}>
        {baseline && delta !== 0 && (
          <div className="cart-total" style={{ marginBottom: '.25rem' }}>
            <span style={{ color: 'var(--muted)', fontSize: '.8rem' }}>Baseline total</span>
            <span style={{ color: 'var(--muted)', fontSize: '.85rem' }}>{INR(baseline.total)}</span>
          </div>
        )}
        <div className="cart-total">
          <span style={{ fontWeight: 700 }}>Final total</span>
          <span style={{ color: cart.over_budget ? 'var(--escalated)' : 'var(--approved)', fontWeight: 700 }}>
            {INR(cart.total)}
          </span>
        </div>
        {delta !== 0 && (
          <div className="cart-total" style={{ color: grew ? 'var(--accent)' : 'var(--approved)', fontSize: '.82rem' }}>
            <span>{grew ? 'Revenue added' : 'Savings'}</span>
            <span>{grew ? '+' : '−'}{INR(Math.abs(delta))}</span>
          </div>
        )}
        <div className="cart-total" style={{ color: 'var(--muted)', fontSize: '.8rem' }}>
          <span>Budget</span><span>{INR(cart.budget)}</span>
        </div>
      </div>
    </div>
  )
}

// ─── ConfirmationCard ────────────────────────────────────────────
// Human-in-the-loop checkpoint, now EDITABLE. The pipeline has APPROVED the cart
// and it clears the signed mandate — but nothing is charged until the buyer reviews
// and authorizes. The buyer can swap, remove, or add any catalog product from the
// dropdowns. Prices are ALWAYS re-derived server-side (the negotiated line price if
// the item was already in this transaction, else the catalog list price) — the
// client only ever sends product IDs, never a price.
//
// Over-budget / out-of-mandate: the buyer is warned inline but NOT blocked. To
// proceed past the mandate ceiling (or an out-of-category pick) they must tick an
// explicit acknowledgment; the server records it as a `budget_override` in the
// audit trail. The agent stays hard-bounded — only the human can consciously exceed.
function ConfirmationCard({ baseline, finalCart, catalog, mandate, onConfirm, onCancel, busy, error }) {
  // NOTE: all hooks must run unconditionally (Rules of Hooks) — the `!finalCart`
  // guard therefore lives below them, and the hook bodies are null-safe.

  // Price authority mirrors the server's reconcileEditedCart exactly:
  //   1) a line already in this transaction → its negotiated (possibly discounted) price
  //   2) otherwise → the catalog list price
  const stashedById = useMemo(
    () => new Map((finalCart?.items ?? []).map(it => [it.product?.id, it])),
    [finalCart],
  )
  const catalogById = useMemo(
    () => new Map((catalog ?? []).map(p => [p.id, p])),
    [catalog],
  )

  // Catalog grouped by category for the <optgroup>s in the pickers.
  const grouped = useMemo(() => {
    const g = {}
    for (const p of catalog ?? []) (g[p.category] ??= []).push(p)
    for (const cat of Object.keys(g)) g[cat].sort((a, b) => a.price - b.price)
    return g
  }, [catalog])

  // Resolve a product id → a full line { id, product, category, price, source }.
  const resolve = useCallback((id) => {
    const s = stashedById.get(id)
    if (s) return { id, product: s.product, category: s.category, price: s.price, source: 'negotiated' }
    const c = catalogById.get(id)
    if (c) return { id, product: c, category: c.category, price: c.price, source: 'list' }
    return null
  }, [stashedById, catalogById])

  // Editable cart = an ordered list of product ids (seeded from the approved cart).
  const [lines, setLines] = useState(() => (finalCart?.items ?? []).map(it => it.product?.id).filter(Boolean))
  const [addSel, setAddSel] = useState('')
  const [ack, setAck] = useState(false)

  if (!finalCart) return null

  // Any structural change invalidates a prior over-budget acknowledgment.
  const mutate = (fn) => { setLines(fn); setAck(false) }
  const swapAt   = (i, id) => mutate(prev => prev.map((v, idx) => (idx === i ? id : v)))
  const removeAt = (i)     => mutate(prev => prev.filter((_, idx) => idx !== i))
  const addItem  = ()      => { if (!addSel) return; mutate(prev => [...prev, addSel]); setAddSel('') }

  const resolved = lines.map(resolve).filter(Boolean)
  const total    = resolved.reduce((s, l) => s + l.price, 0)

  const ceiling    = mandate?.maxSpend ?? finalCart.budget
  const allowedCats = Array.isArray(mandate?.allowedCategories) ? mandate.allowedCategories : null
  const overBudget = ceiling != null && total > ceiling
  const badCats    = allowedCats
    ? [...new Set(resolved.filter(l => !allowedCats.includes(l.category)).map(l => l.category))]
    : []
  const outOfCat   = badCats.length > 0
  const needsAck   = overBudget || outOfCat
  const baseItems  = baseline?.items ?? []
  const originalIds = new Set((finalCart.items ?? []).map(it => it.product?.id))
  const empty      = lines.length === 0
  const canConfirm = !busy && !empty && (!needsAck || ack)

  const findBase = (line) =>
    baseItems.find(b => b.product?.id === line.id) ||
    baseItems.find(b => b.category === line.category)

  const doConfirm = () => onConfirm({
    items: lines.map(id => ({ productId: id })),
    acknowledgeOverBudget: needsAck && ack,
  })

  return (
    <div className="confirmation-card" id="confirmation-panel">
      <div className="confirm-head">
        <h3>Review, edit &amp; authorize your purchase</h3>
        <span className="pill info">Awaiting your confirmation</span>
      </div>
      <p className="confirm-sub">
        Nothing has been charged yet. Swap, remove, or add any product below — prices
        come straight from the catalog. Payment only goes through when you press
        <b> Confirm &amp; Pay</b>.
      </p>

      <div className="confirm-items">
        {resolved.map((line, i) => {
          const base    = findBase(line)
          const inOrig  = originalIds.has(line.id)
          const isNew   = !inOrig
          const changed = base && base.price !== line.price
          const feats   = line.product?.features ?? []
          const badCat  = allowedCats && !allowedCats.includes(line.category)
          return (
            <div key={`${line.id}-${i}`} className="confirm-item">
              <div className="confirm-item-main">
                <div className="confirm-item-name">
                  <span className="confirm-item-title">{line.product?.name ?? line.category}</span>
                  {line.product?.tier && <span className="pill info tier-pill">{line.product.tier}</span>}
                  {isNew   && <span className="pill approved tier-pill">added</span>}
                  {changed && <span className="pill info tier-pill">{line.price > base.price ? 'upgraded' : 'substituted'}</span>}
                  {badCat  && <span className="pill escalated tier-pill">outside mandate</span>}
                </div>
                <div className="confirm-item-cat">{line.category}</div>
                {feats.length > 0 && (
                  <div className="confirm-item-feats">
                    {feats.slice(0, 6).map(f => <span key={f} className="feat-chip">{f}</span>)}
                  </div>
                )}
                {/* per-line product picker (swap to ANY catalog product) */}
                <div className="confirm-item-edit">
                  <select
                    className="line-select"
                    value={line.id}
                    disabled={busy}
                    aria-label={`Change ${line.category} product`}
                    onChange={e => swapAt(i, e.target.value)}
                  >
                    {/* keep the currently-selected id valid even if catalog is still loading */}
                    {!catalogById.has(line.id) && (
                      <option value={line.id}>{line.product?.name ?? line.id} — {INR(line.price)}</option>
                    )}
                    {Object.entries(grouped).map(([cat, prods]) => (
                      <optgroup key={cat} label={cat}>
                        {prods.map(p => (
                          <option key={p.id} value={p.id}>
                            {p.name} — {INR(stashedById.get(p.id)?.price ?? p.price)}
                            {allowedCats && !allowedCats.includes(p.category) ? '  outside mandate' : ''}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="line-remove"
                    disabled={busy}
                    aria-label={`Remove ${line.product?.name ?? line.category}`}
                    onClick={() => removeAt(i)}
                  >×</button>
                </div>
              </div>
              <div className="confirm-item-price">
                <strong>{INR(line.price)}</strong>
                {changed && <div className="confirm-item-was">{INR(base.price)}</div>}
              </div>
            </div>
          )
        })}
        {empty && (
          <div className="confirm-empty">Your cart is empty — add a product below, or cancel.</div>
        )}
      </div>

      {/* add-a-product row */}
      <div className="confirm-add">
        <select
          className="line-select"
          value={addSel}
          disabled={busy || !catalog?.length}
          aria-label="Add a product"
          onChange={e => setAddSel(e.target.value)}
        >
          <option value="">+ Add a product…</option>
          {Object.entries(grouped).map(([cat, prods]) => (
            <optgroup key={cat} label={cat}>
              {prods.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} — {INR(stashedById.get(p.id)?.price ?? p.price)}
                  {allowedCats && !allowedCats.includes(p.category) ? '  outside mandate' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button type="button" className="btn btn-ghost add-btn" disabled={busy || !addSel} onClick={addItem}>
          Add
        </button>
      </div>

      <div className="confirm-totals">
        {baseline && (
          <div className="confirm-total-row muted">
            <span>Baseline cart</span><span>{INR(baseline.total)}</span>
          </div>
        )}
        <div className="confirm-total-row grand">
          <span>Total to pay</span>
          <span style={overBudget ? { color: 'var(--escalated)' } : undefined}>{INR(total)}</span>
        </div>
        <div className="confirm-total-row muted">
          <span>Signed-mandate ceiling</span>
          <span>
            {INR(ceiling)}{' '}
            {!needsAck
              ? <span className="pill approved tier-pill">within </span>
              : <span className="pill escalated tier-pill">over </span>}
          </span>
        </div>
      </div>

      {needsAck && (
        <div className="confirm-warn">
          <div className="confirm-warn-title">This selection is outside your signed mandate</div>
          <ul className="confirm-warn-list">
            {overBudget && (
              <li>Total <b>{INR(total)}</b> exceeds your ceiling <b>{INR(ceiling)}</b> by <b>{INR(total - ceiling)}</b>.</li>
            )}
            {outOfCat && (
              <li>Includes categor{badCats.length > 1 ? 'ies' : 'y'} outside the mandate: <b>{badCats.join(', ')}</b>.</li>
            )}
          </ul>
          <label className="confirm-ack">
            <input type="checkbox" checked={ack} disabled={busy} onChange={e => setAck(e.target.checked)} />
            <span>I authorize this purchase even though it goes beyond my agent&apos;s mandate. Record this as my override.</span>
          </label>
        </div>
      )}

      <div className="confirm-mandate">
        Authorized under your signed mandate — ceiling {INR(ceiling)}
        {allowedCats?.length ? <> · categories {allowedCats.join(', ')}</> : null}
      </div>

      {error && <div className="confirm-error">{error}</div>}

      <div className="confirm-actions">
        <button type="button" className="btn btn-primary" id="confirm-btn" disabled={!canConfirm} onClick={doConfirm}>
          {busy
            ? <><div className="spinner" /> Processing…</>
            : needsAck
              ? `Authorize over-budget & Pay ${INR(total)}`
              : `Confirm & Pay ${INR(total)}`}
        </button>
        <button type="button" className="btn btn-ghost" id="cancel-btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ─── OptionsPicker ───────────────────────────────────────────────
// Problem 3 made interactive: when the buyer's IDEAL goal setup can't be met
// within budget, the pipeline returns A/B/C alternatives instead of silently
// forcing one. Each card is fully explainable — its total vs budget, the exact
// items, the trade-offs it makes against the ideal, and concrete upgrade paths.
// Picking one LOCKS that cart (no silent re-optimisation) and flows it through
// the same confirm-&-pay checkpoint as any other purchase. Nothing is charged
// here; an over-budget pick still has to clear the signed-mandate gate.
function OptionsPicker({ options, ideal, feasible, budget, onSelect, busy, error, selectedId }) {
  if (!Array.isArray(options) || options.length === 0) return null
  return (
    <div className="options-picker" id="options-panel">
      <div className="options-head">
        <h3>Choose how to proceed</h3>
        <span className="pill info">Nothing charged yet</span>
      </div>
      <p className="options-sub">
        Your ideal setup ({INR(ideal?.total)}) is over your {INR(budget)} budget.{' '}
        {feasible
          ? 'Here are the ways to hit your goal within budget — pick one to continue.'
          : 'No complete setup fits your budget — pick the closest complete setup (needs your authorization) or a core setup that fits.'}
      </p>

      <div className="options-grid">
        {options.map(opt => {
          const picking = busy && selectedId === opt.id
          return (
            <div
              key={opt.id}
              className={`option-card ${opt.withinBudget ? '' : 'over'} ${selectedId === opt.id ? 'selected' : ''}`}
            >
              <div className="option-card-head">
                <span className="option-badge">{opt.id}</span>
                <div className="option-titles">
                  <div className="option-label">{opt.label}</div>
                  <div className="option-desc">{opt.description}</div>
                </div>
              </div>

              <div className="option-total-row">
                <span className="option-total">{INR(opt.total)}</span>
                {opt.withinBudget
                  ? <span className="pill approved tier-pill">within budget </span>
                  : <span className="pill escalated tier-pill">over budget </span>}
              </div>

              <div className="option-items">
                {(opt.items ?? []).map((it, i) => (
                  <div key={i} className="option-item">
                    <div className="option-item-main">
                      <span className="option-item-name">{it.product?.name ?? it.category}</span>
                      {it.product?.tier && <span className="pill info tier-pill">{it.product.tier}</span>}
                    </div>
                    <span className="option-item-cat">{it.category}</span>
                    <span className="option-item-price">{INR(it.price)}</span>
                  </div>
                ))}
              </div>

              {opt.tradeoffs?.length > 0 && (
                <ul className="option-notes tradeoffs">
                  {opt.tradeoffs.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              )}

              {opt.upgrades?.length > 0 && (
                <details className="option-upgrades">
                  <summary>Upgrade paths</summary>
                  <ul className="option-notes upgrades">
                    {opt.upgrades.map((u, i) => <li key={i}>{u}</li>)}
                  </ul>
                </details>
              )}

              <button
                type="button"
                id={`select-${opt.id}`}
                className={`btn ${opt.withinBudget ? 'btn-primary' : 'btn-ghost'} option-select-btn`}
                disabled={busy}
                onClick={() => onSelect(opt.id)}
              >
                {picking
                  ? <><div className="spinner" /> Selecting…</>
                  : opt.withinBudget
                    ? `Choose ${opt.id} · Pay up to ${INR(opt.total)}`
                    : `Choose ${opt.id} — authorize over budget`}
              </button>
            </div>
          )
        })}
      </div>

      {error && <div className="confirm-error">{error}</div>}

      <div className="options-foot">
        Picking an option locks that exact cart and takes you to the confirm-&amp;-pay
        checkpoint. An over-budget pick is still stopped by the signed-mandate gate unless you authorize it.
      </div>
    </div>
  )
}

// ─── NegotiationStep ─────────────────────────────────────────────
// Growth-aware: renders 'grow' moves (upsell/cross-sell/bundle, +₹ revenue)
// and legacy 'substitute' moves (−₹ savings).
function NegotiationStep({ neg }) {
  const statusCls = neg.status === 'approved' ? 'approved' : 'escalated'
  const KIND = {
    upsell:     { label: 'Upsell' },
    cross_sell: { label: 'Cross-sell' },
    bundle:     { label: 'Bundle' },
    substitute: { label: 'Downgrade' },
  }

  return (
    <div className="kv">
      <div className="kv-row">
        <span className="kv-key">Status</span>
        <span className="kv-val"><span className={`pill ${statusCls}`}>{neg.status}</span></span>
      </div>
      <div className="kv-row">
        <span className="kv-key">Accepted moves</span>
        <span className="kv-val">{neg.offers?.length ?? 0} over {neg.history?.length ?? neg.rounds ?? 0} round(s)</span>
      </div>

      {neg.offers?.map(({ round, offer }) => {
        const kind = offer.kind ?? offer.action ?? 'substitute'
        const meta = KIND[kind] ?? { label: kind }
        const gain = offer.revenueDelta ?? 0
        const save = offer.saving ?? 0
        return (
          <div key={round} className="neg-move">
            <div className="neg-move-head">
              <span className="pill info" style={{ fontSize: '.65rem' }}>{meta.label}</span>
              <span className="neg-move-round">Round {round}</span>
            </div>
            <div className="neg-move-reason">{offer.reason}</div>
            {gain > 0 && <div className="neg-move-amt grow">+{INR(gain)} revenue</div>}
            {save > 0 && <div className="neg-move-amt save">−{INR(save)} to buyer</div>}
          </div>
        )
      })}

      {neg.gap > 0 && (
        <div className="kv-row" style={{ marginTop: '.5rem' }}>
          <span className="kv-key">Gap remaining</span>
          <span className="kv-val" style={{ color: 'var(--escalated)' }}>{INR(neg.gap)}</span>
        </div>
      )}
    </div>
  )
}

// ─── PolicyStep ──────────────────────────────────────────────────
function PolicyStep({ result }) {
  const cls = result.status === 'approved' ? 'approved' : result.status === 'rejected' ? 'rejected' : 'escalated'
  return (
    <div className="kv">
      <div className="kv-row">
        <span className="kv-key">Status</span>
        <span className="kv-val"><span className={`pill ${cls}`}>{result.status}</span></span>
      </div>
      <div className="kv-row">
        <span className="kv-key">Reason</span>
        <span className="kv-val">{result.reason}</span>
      </div>
    </div>
  )
}

// ─── DecisionStep ────────────────────────────────────────────────
function DecisionStep({ output }) {
  const cls = output.decision === 'approved' ? 'approved' : output.decision === 'rejected' ? 'rejected' : 'escalated'
  return (
    <div className="kv">
      <div className="kv-row">
        <span className="kv-key">Verdict</span>
        <span className="kv-val"><span className={`pill ${cls}`}>{output.decision}</span></span>
      </div>
      {output.reasoning && (
        <div className="kv-row">
          <span className="kv-key">Reasoning</span>
          <span className="kv-val">{output.reasoning}</span>
        </div>
      )}
      {output.reason && !output.reasoning && (
        <div className="kv-row">
          <span className="kv-key">Reason</span>
          <span className="kv-val">{output.reason}</span>
        </div>
      )}
    </div>
  )
}

// ─── IntentStep ──────────────────────────────────────────────────
function IntentStep({ output }) {
  return (
    <div className="kv">
      <div className="kv-row">
        <span className="kv-key">Goal</span>
        <span className="kv-val">{output.goal}</span>
      </div>
      <div className="kv-row">
        <span className="kv-key">Budget</span>
        <span className="kv-val">{INR(output.budget)}</span>
      </div>
      {Object.entries(output.preferences ?? {}).map(([k, v]) => (
        <div key={k} className="kv-row">
          <span className="kv-key">{k}</span>
          <span className="kv-val"><span className="pill info">{v}</span></span>
        </div>
      ))}
    </div>
  )
}

// ─── GoalClassificationStep ──────────────────────────────────────
function GoalClassificationStep({ output }) {
  const SCOPE_ICON = { 'single-item': '', setup: '' }
  const GOAL_ICON  = { gaming: '', office: '', 'content-creation': '', general: '' }
  return (
    <div className="kv">
      <div className="kv-row">
        <span className="kv-key">Goal type</span>
        <span className="kv-val"><span className="pill info">{GOAL_ICON[output.goalType] ?? ''} {output.goalType}</span></span>
      </div>
      <div className="kv-row">
        <span className="kv-key">Scope</span>
        <span className="kv-val"><span className="pill info">{SCOPE_ICON[output.scope] ?? ''} {output.scope}</span></span>
      </div>
      <div className="kv-row">
        <span className="kv-key">Use case filter</span>
        <span className="kv-val">{output.useCase}</span>
      </div>
      <div className="kv-row">
        <span className="kv-key">Cart categories</span>
        <span className="kv-val">
          <span className="chip-row">
            {output.categories?.map(c => <span key={c} className="chip">{c}</span>)}
          </span>
        </span>
      </div>
      <div className="kv-row">
        <span className="kv-key">Mandate whitelist</span>
        <span className="kv-val">
          <span className="chip-row">
            {output.allowedCategories?.map(c => <span key={c} className="chip">{c}</span>)}
          </span>
        </span>
      </div>
      {output.essentialAddOns?.length > 0 && (
        <div className="kv-row">
          <span className="kv-key">Goal add-ons (optional)</span>
          <span className="kv-val">
            <span className="chip-row">
              {output.essentialAddOns.map(c => <span key={c} className="chip">{c}</span>)}
            </span>
          </span>
        </div>
      )}
    </div>
  )
}

// ─── MandateIssuedStep ───────────────────────────────────────────
function MandateIssuedStep({ output }) {
  return (
    <div className="kv">
      <div className="kv-row">
        <span className="kv-key">Spend ceiling</span>
        <span className="kv-val">{INR(output.maxSpend)}</span>
      </div>
      <div className="kv-row">
        <span className="kv-key">Categories</span>
        <span className="kv-val">
          <span className="chip-row">
            {output.allowedCategories?.map(c => <span key={c} className="chip">{c}</span>)}
          </span>
        </span>
      </div>
      <div className="kv-row">
        <span className="kv-key">Signature</span>
        <span className="kv-val mono sig">{output.signature}</span>
      </div>
    </div>
  )
}

// ─── RevenueUpliftStep ───────────────────────────────────────────
function RevenueUpliftStep({ output }) {
  const grew = output.uplift > 0
  return (
    <div className="kv">
      <div className="kv-row"><span className="kv-key">Baseline</span><span className="kv-val">{INR(output.baseline)}</span></div>
      <div className="kv-row"><span className="kv-key">Negotiated</span><span className="kv-val">{INR(output.final)}</span></div>
      <div className="kv-row">
        <span className="kv-key">{grew ? 'Uplift' : 'Change'}</span>
        <span className="kv-val" style={{ color: grew ? 'var(--accent)' : 'var(--approved)', fontWeight: 700 }}>
          {grew ? '+' : ''}{INR(output.uplift)} ({grew ? '+' : ''}{output.upliftPct}%)
        </span>
      </div>
    </div>
  )
}

// ─── GateStep ────────────────────────────────────────────────────
function GateStep({ output }) {
  const cls = output.ok ? 'approved' : 'escalated'
  return (
    <div className="kv">
      <div className="kv-row">
        <span className="kv-key">Result</span>
        <span className="kv-val"><span className={`pill ${cls}`}>{output.ok ? 'passed' : 'blocked'}</span></span>
      </div>
      <div className="kv-row"><span className="kv-key">Stage</span><span className="kv-val mono">{output.stage}</span></div>
      <div className="kv-row"><span className="kv-key">Detail</span><span className="kv-val">{output.reason}</span></div>
    </div>
  )
}

// ─── OverrideStep ────────────────────────────────────────────────
function OverrideStep({ input, output }) {
  return (
    <div className="kv">
      <div className="kv-row">
        <span className="kv-key">Override</span>
        <span className="kv-val">
          <span className="pill approved">{input?.from}</span>
          <span style={{ margin: '0 .4rem', color: 'var(--muted)' }}>→</span>
          <span className="pill escalated">{output?.decision}</span>
        </span>
      </div>
      <div className="kv-row"><span className="kv-key">Reason</span><span className="kv-val">{input?.reason}</span></div>
    </div>
  )
}

// ─── PaymentAuditStep ────────────────────────────────────────────
function PaymentAuditStep({ output }) {
  return (
    <div className="kv">
      <div className="kv-row"><span className="kv-key">Order ID</span><span className="kv-val mono">{output.orderId}</span></div>
      <div className="kv-row"><span className="kv-key">Amount</span><span className="kv-val">{output.amount} paise ({INR(output.amount / 100)})</span></div>
      <div className="kv-row"><span className="kv-key">Currency</span><span className="kv-val">{output.currency}</span></div>
    </div>
  )
}

// ─── StepContent dispatcher ──────────────────────────────────────
function StepContent({ step, input, output, fullTrace }) {
  switch (step) {
    case 'intent_parsing':
      return <IntentStep output={output} />
    case 'goal_classification':
      return <GoalClassificationStep output={output} />
    case 'options_generated':
      return (
        <div className="kv">
          <div className="kv-row"><span className="kv-key">Ideal setup</span><span className="kv-val">{INR(input?.idealTotal)} vs budget {INR(input?.budget)}</span></div>
          <div className="kv-row"><span className="kv-key">Feasible in budget</span><span className="kv-val"><span className={`pill ${input?.feasible ? 'approved' : 'escalated'}`}>{input?.feasible ? 'yes — a core fits' : 'no complete setup fits'}</span></span></div>
          <div className="kv-row"><span className="kv-key">Options offered</span><span className="kv-val">{output?.count} ({(output?.ids ?? []).join(', ')})</span></div>
        </div>
      )
    case 'option_selected':
      return (
        <div className="kv">
          <div className="kv-row"><span className="kv-key">Buyer picked</span><span className="kv-val"><span className="pill info">Option {output?.id}</span> {output?.label}</span></div>
          <div className="kv-row"><span className="kv-key">Locked total</span><span className="kv-val">{INR(output?.total)} {output?.withinBudget ? <span className="pill approved tier-pill">within budget</span> : <span className="pill escalated tier-pill">over budget</span>}</span></div>
          <div className="kv-row"><span className="kv-key">Offered</span><span className="kv-val mono">{(input?.available ?? []).join(', ')}</span></div>
        </div>
      )
    case 'cart_building':
      return <CartComparison baseline={output} final={fullTrace?.negotiation?.finalCart} />
    case 'mandate_issued':
      return <MandateIssuedStep output={output} />
    case 'negotiation':
      return <NegotiationStep neg={output} />
    case 'revenue_uplift':
      return <RevenueUpliftStep output={output} />
    case 'user_policy_validation':
    case 'merchant_policy_validation':
      return <PolicyStep result={output} />
    case 'decision':
      return <DecisionStep output={output} />
    case 'mandate_payment_gate':
      return <GateStep output={output} />
    case 'decision_override':
      return <OverrideStep input={input} output={output} />
    case 'awaiting_confirmation':
      return (
        <div className="kv">
          <div className="kv-row"><span className="kv-key">Status</span><span className="kv-val"><span className="pill info">held for buyer confirmation</span></span></div>
          <div className="kv-row"><span className="kv-key">Total</span><span className="kv-val">{INR(input?.total)}</span></div>
          <div className="kv-row"><span className="kv-key">Detail</span><span className="kv-val">{output?.reason}</span></div>
        </div>
      )
    case 'cart_edited': {
      const from = input?.from ?? {}
      const to   = output?.to ?? {}
      const delta = (to.total ?? 0) - (from.total ?? 0)
      return (
        <div className="kv">
          <div className="kv-row"><span className="kv-key">Edited by</span><span className="kv-val"><span className="pill info">buyer</span></span></div>
          <div className="kv-row"><span className="kv-key">Items before</span><span className="kv-val mono">{(from.items ?? []).join(', ') || '—'}</span></div>
          <div className="kv-row"><span className="kv-key">Items after</span><span className="kv-val mono">{(to.items ?? []).join(', ') || '—'}</span></div>
          <div className="kv-row"><span className="kv-key">Total</span><span className="kv-val">{INR(from.total)} → <b>{INR(to.total)}</b>{delta !== 0 && <span style={{ color: delta > 0 ? 'var(--escalated)' : 'var(--approved)' }}> ({delta > 0 ? '+' : ''}{INR(delta)})</span>}</span></div>
        </div>
      )
    }
    case 'budget_override':
      return (
        <div className="kv">
          <div className="kv-row"><span className="kv-key">Result</span><span className="kv-val"><span className="pill escalated">human override — recorded</span></span></div>
          <div className="kv-row"><span className="kv-key">Acknowledged by</span><span className="kv-val"><span className="pill approved">{output?.acknowledgedBy ?? 'buyer'}</span></span></div>
          <div className="kv-row"><span className="kv-key">Total</span><span className="kv-val">{INR(input?.total)} vs ceiling {INR(input?.maxSpend)}</span></div>
          <div className="kv-row"><span className="kv-key">Violation</span><span className="kv-val" style={{ color: 'var(--escalated)' }}>{input?.violation}</span></div>
        </div>
      )
    case 'purchase_confirmed':
      return (
        <div className="kv">
          <div className="kv-row"><span className="kv-key">Confirmed by</span><span className="kv-val"><span className="pill approved">{output?.confirmedBy ?? 'buyer'}</span></span></div>
          <div className="kv-row"><span className="kv-key">Total</span><span className="kv-val">{INR(output?.total)}</span></div>
        </div>
      )
    case 'purchase_cancelled':
      return (
        <div className="kv">
          <div className="kv-row"><span className="kv-key">Cancelled by</span><span className="kv-val"><span className="pill escalated">{output?.cancelledBy ?? 'buyer'}</span></span></div>
          <div className="kv-row"><span className="kv-key">Charge</span><span className="kv-val">none — no money moved</span></div>
        </div>
      )
    case 'payment_failed':
      return (
        <div className="kv">
          <div className="kv-row"><span className="kv-key">Result</span><span className="kv-val"><span className="pill escalated">provider error</span></span></div>
          <div className="kv-row"><span className="kv-key">Error</span><span className="kv-val" style={{ color: 'var(--escalated)' }}>{output?.error}</span></div>
        </div>
      )
    case 'payment_order_created':
      return <PaymentAuditStep output={output} />
    default:
      return <pre style={{ fontSize: '.75rem', color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>{JSON.stringify(output, null, 2)}</pre>
  }
}

// ─── PipelineTimeline ────────────────────────────────────────────
function PipelineTimeline({ entries, fullTrace }) {
  return (
    <div className="pipeline">
      {entries.map((entry, i) => {
        const meta   = STEP_META[entry.step] ?? { label: entry.step }
        const isLast = i === entries.length - 1
        const isPmt  = entry.step === 'payment_order_created'
        const isGate = entry.step === 'mandate_payment_gate' || entry.step === 'decision_override' || entry.step === 'payment_failed' || entry.step === 'budget_override'
        const isConfirm = entry.step === 'awaiting_confirmation' || entry.step === 'purchase_confirmed' || entry.step === 'cart_edited'
        const isCancel  = entry.step === 'purchase_cancelled'
        const isOptions = entry.step === 'options_generated' || entry.step === 'option_selected'
        return (
          <div key={i} className="pipeline-step">
            <div className="step-connector">
              <div className={`step-dot done ${isPmt ? 'payment' : ''} ${isGate ? 'gate' : ''} ${isConfirm ? 'confirm' : ''} ${isCancel ? 'cancel' : ''} ${isOptions ? 'options' : ''}`} />
              {!isLast && <div className="step-line" />}
            </div>
            <div className="step-body" style={{ animationDelay: `${i * 60}ms` }}>
              <div className="step-header">
                <span className="step-name">{meta.label}</span>
                <span className="step-ts">{new Date(entry.timestamp).toLocaleTimeString()}</span>
              </div>
              <div className="step-content">
                <StepContent step={entry.step} input={entry.input} output={entry.output} fullTrace={fullTrace} />
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── main App ────────────────────────────────────────────────────
export default function App() {
  const [userText,    setUserText]    = useState('')
  const [maxSpending, setMaxSpending] = useState('20000')
  const [maxDiscount, setMaxDiscount] = useState('60')
  const [minMargin,   setMinMargin]   = useState('100')

  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const [result,  setResult]  = useState(null)
  const [audit,   setAudit]   = useState(null)
  const [confirming,   setConfirming]   = useState(false)  // confirm/cancel request in flight
  const [confirmError, setConfirmError] = useState(null)   // retryable error (e.g. payment provider down)
  const [selecting,      setSelecting]      = useState(false) // A/B/C option-select request in flight
  const [selectError,    setSelectError]    = useState(null)  // retryable option-select error
  const [pendingOptionId, setPendingOptionId] = useState(null) // which option card is being selected (for its spinner)
  const [catalog,      setCatalog]      = useState([])     // full product catalog for the editable confirm card

  // Load the catalog once so the confirmation card's product pickers can offer
  // every product + its real price. Prices are still re-derived server-side at
  // charge time — this is only to populate the dropdowns.
  useEffect(() => {
    let alive = true
    fetch('/api/catalog')
      .then(r => (r.ok ? r.json() : { products: [] }))
      .then(d => { if (alive) setCatalog(d.products ?? []) })
      .catch(() => { /* pickers simply stay empty; confirm still works with the approved cart */ })
    return () => { alive = false }
  }, [])

  const loadScenario = useCallback((key) => {
    const s = SCENARIOS[key]
    setUserText(s.userText)
    setMaxSpending(s.maxSpending)
    setMaxDiscount(s.maxDiscount)
    setMinMargin(s.minMargin)
    setResult(null); setAudit(null); setError(null); setConfirmError(null); setSelectError(null); setPendingOptionId(null)
  }, [])



  // /api/audit uses possession-proof auth (C3): present the txId back as a token.
  const loadAudit = useCallback(async (txId) => {
    if (!txId) return
    const ar = await fetch(`/api/audit/${txId}`, { headers: { 'x-audit-token': txId } })
    if (ar.ok) setAudit(await ar.json())
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true); setError(null); setResult(null); setAudit(null); setConfirmError(null); setSelectError(null); setPendingOptionId(null)
    try {
      const res = await fetch('/api/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userText,
          userPolicy:     { max_spending: Number(maxSpending) },
          merchantPolicy: { max_discount: Number(maxDiscount), min_margin: Number(minMargin) },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Server error')
      setResult(data)
      await loadAudit(data.transactionId)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Phase 2 of the purchase: the buyer either confirms (release the charge) or
  // cancels. Both are possession-proof authed with the txId, and both refetch the
  // audit trail so the new steps (edit / override / confirm / cancel / payment)
  // appear immediately.
  //
  // For confirm, `payload` carries the (possibly edited) cart as product IDs plus
  // an over-budget acknowledgment: { items: [{ productId }], acknowledgeOverBudget }.
  // The server re-prices every line from the negotiated cart or the catalog — the
  // client never sends a price — and re-runs the signed-mandate gate before charging.
  async function postAction(action, payload) {
    const txId = result?.transactionId
    if (!txId || confirming) return
    setConfirming(true); setConfirmError(null)
    try {
      const opts = { method: 'POST', headers: { 'x-audit-token': txId } }
      if (action === 'confirm' && payload) {
        opts.headers['Content-Type'] = 'application/json'
        opts.body = JSON.stringify(payload)
      }
      const res  = await fetch(`/api/purchase/${txId}/${action}`, opts)
      const data = await res.json()
      await loadAudit(txId)

      if (action === 'confirm') {
        if (data.ok && data.status === 'paid') {
          setResult(prev => ({ ...prev, status: 'paid', decision: data.decision ?? prev.decision,
            payment: data.payment, reasoning: data.reasoning ?? prev.reasoning,
            finalCart: data.finalCart ?? prev.finalCart, revenue: data.revenue ?? prev.revenue,
            edited: data.edited ?? false, overridden: data.overridden ?? false }))
        } else if (data.status === 'escalated') {
          // confirm-time mandate gate refused — graceful, no charge
          setResult(prev => ({ ...prev, status: 'escalated', decision: 'escalated',
            reasoning: data.reasoning ?? prev.reasoning }))
        } else if (data.code === 'invalid_cart') {
          // bad edit (empty cart or unknown product) — stays pending so the buyer can fix it
          setConfirmError(data.reasoning ?? data.error ?? 'That cart can’t be charged — please adjust your selection.')
        } else if (data.code === 'payment_failed') {
          // provider error — stays pending so the buyer can retry
          setConfirmError(data.reasoning ?? 'Payment failed — please try again.')
        } else if (data.code === 'not_pending') {
          setConfirmError('This purchase is no longer awaiting confirmation.')
        } else {
          setConfirmError(data.error ?? 'Could not confirm the purchase.')
        }
      } else { // cancel
        if (data.ok) {
          setResult(prev => ({ ...prev, status: 'cancelled' }))
        } else {
          setConfirmError('Nothing to cancel — this purchase is no longer pending.')
        }
      }
    } catch (err) {
      setConfirmError(err.message)
    } finally {
      setConfirming(false)
    }
  }

  // Problem 3 selection: the buyer picked one of the A/B/C alternatives. POST it
  // (possession-proof authed with the txId) to .../select. The server locks that
  // exact cart — no silent re-optimisation — and runs it through the SAME pipeline
  // (policy gates + signed-mandate gate + two-phase confirm) as any purchase, then
  // returns a normal pipeline result. We swap it in so the existing branches take
  // over: a within-budget pick → pending_confirmation (the confirm card); the
  // over-budget "closest complete setup" → escalated (the mandate-gate block card).
  // Nothing is charged by selecting.
  async function selectOption(optionId) {
    const txId = result?.transactionId
    if (!txId || selecting) return
    setSelecting(true); setSelectError(null); setPendingOptionId(optionId)
    try {
      const res = await fetch(`/api/purchase/${txId}/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-audit-token': txId },
        body: JSON.stringify({ optionId }),
      })
      const data = await res.json()
      await loadAudit(txId)

      if (res.ok && (data.status === 'pending_confirmation' || data.status === 'escalated' ||
                     data.status === 'rejected' || data.payment)) {
        // Replace the options envelope with the selected option's full pipeline
        // outcome; the decision banner + status branches re-render from it.
        setResult(data)
      } else if (data.code === 'invalid_option') {
        setSelectError(data.reasoning ?? 'That option is not available — pick one of the listed options.')
      } else if (data.code === 'not_pending_options') {
        setSelectError('These options are no longer available — run the request again to get fresh options.')
      } else {
        setSelectError(data.reasoning ?? data.error ?? 'Could not select that option.')
      }
    } catch (err) {
      setSelectError(err.message)
    } finally {
      setSelecting(false)
    }
  }

  const dm        = result ? DECISION_META[result.decision] : null
  const mandate   = result?.fullTrace?.mandate ?? null
  const mandateSig = audit?.entries?.find(e => e.step === 'mandate_issued')?.output?.signature ?? null
  const transcript = result?.fullTrace?.negotiation?.transcript ?? null
  const gateBlocked = result?.decision === 'escalated' &&
    audit?.entries?.some(e => e.step === 'decision_override')

  return (
    <div className="app">

      {/* ── Header ────────────────────────────────────────────── */}
      <header className="header">
        <h1>AI Commerce <span>Gateway</span></h1>
        <p>A buyer agent negotiates under a signed mandate; the merchant agent grows revenue within it — every money action bounded, gated, and audited.</p>
      </header>

      {/* ── Demo scenarios ────────────────────────────────────── */}
      <div className="scenario-bar">
        {Object.entries(SCENARIOS).map(([key, s], i) => (
          <button
            key={key}
            type="button"
            id={i === 0 ? 'demo-btn' : `demo-${key}`}
            className="scenario-btn"
            onClick={() => loadScenario(key)}
            title={s.hint}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* ── Purchase Form ──────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">Purchase Request</div>
        <form onSubmit={handleSubmit} id="purchase-form">
          <div className="form-group">
            <label htmlFor="user-text">Describe what you want to buy</label>
            <textarea
              id="user-text"
              value={userText}
              onChange={e => setUserText(e.target.value)}
              placeholder="e.g. Build me a gaming setup under ₹20,000. Headset is most important."
              required
            />
            <div className="field-hint">
              Just describe your goal in natural language. The AI will determine the right
              categories, scope, and product selection — no manual configuration needed.
            </div>
          </div>

          <div className="form-row">
            <div>
              <div className="card-title" style={{ marginBottom: '.75rem' }}>User Policy</div>
              <div className="form-group">
                <label htmlFor="max-spending">Max Spending (₹)</label>
                <input id="max-spending" type="number" value={maxSpending} onChange={e => setMaxSpending(e.target.value)} min="0" />
              </div>
            </div>

            <div>
              <div className="card-title" style={{ marginBottom: '.75rem' }}>Merchant Policy</div>
              <div className="form-group">
                <label htmlFor="max-discount">Max Discount (%)</label>
                <input id="max-discount" type="number" value={maxDiscount} onChange={e => setMaxDiscount(e.target.value)} min="0" max="100" />
              </div>
              <div className="form-group">
                <label htmlFor="min-margin">Min Margin (₹)</label>
                <input id="min-margin" type="number" value={minMargin} onChange={e => setMinMargin(e.target.value)} min="0" />
              </div>
            </div>
          </div>

          <button type="submit" className="btn btn-primary btn-full" disabled={loading} id="submit-btn">
            {loading ? <><div className="spinner" /> Processing…</> : 'Run Purchase Pipeline'}
          </button>
        </form>
      </div>

      {/* ── Error ─────────────────────────────────────────────── */}
      {error && <div className="error-box" style={{ marginTop: '1.25rem' }}>{error}</div>}

      {/* ── Results ───────────────────────────────────────────── */}
      {result && (
        <>
          {/* Decision banner */}
          <div style={{ marginTop: '2rem' }}>
            <div className={`decision-banner ${dm?.cls ?? 'escalated'}`}>
              <div>
                <div className="decision-label">{result.status === 'options_required' ? 'Action Needed' : 'Final Decision'}</div>
                <div className="decision-verdict">{dm?.label ?? result.decision}</div>
                <div className="decision-reasoning">{result.reasoning}</div>
              </div>
            </div>
          </div>

          {/* Headline: revenue uplift + signed mandate side by side.
              Skipped for options_required — no cart is locked yet, so there is no
              revenue metric or issued mandate to show until the buyer picks. */}
          {result.status !== 'options_required' && (
            <div className="result-grid">
              <RevenueHero revenue={result.revenue} ceiling={mandate?.maxSpend} />
              <MandateCard mandate={mandate} signature={mandateSig} />
            </div>
          )}

          {/* txId */}
          <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '.75rem', color: 'var(--muted)' }}>Transaction ID</span>
            <span className="txid" id="transaction-id">{result.transactionId}</span>
          </div>

          {/* Options picker / Confirmation checkpoint / Payment / Cancelled / Gate-blocked */}
          {result.status === 'options_required' ? (
            <>
              <div className="section-title" style={{ marginTop: '1.75rem' }}>Choose an Option</div>
              <OptionsPicker
                options={result.options}
                ideal={result.ideal}
                feasible={result.feasible}
                budget={result.fullTrace?.intent?.budget}
                onSelect={selectOption}
                busy={selecting}
                error={selectError}
                selectedId={pendingOptionId}
              />
            </>
          ) : result.status === 'pending_confirmation' ? (
            <>
              <div className="section-title" style={{ marginTop: '1.75rem' }}>Confirm Purchase</div>
              <ConfirmationCard
                key={result.transactionId}
                baseline={result.fullTrace?.cart}
                finalCart={result.finalCart}
                catalog={catalog}
                mandate={mandate}
                onConfirm={(payload) => postAction('confirm', payload)}
                onCancel={() => postAction('cancel')}
                busy={confirming}
                error={confirmError}
              />
            </>
          ) : result.payment ? (
            <>
              <div className="section-title" style={{ marginTop: '1.75rem' }}>Payment Order</div>
              <div className="payment-card" id="payment-panel">
                <h3>Razorpay Order Created — Confirmed &amp; Gate Passed</h3>
                <div className="kv">
                  <div className="kv-row"><span className="kv-key">Order ID</span><span className="kv-val mono" id="payment-order-id">{result.payment.orderId}</span></div>
                  <div className="kv-row"><span className="kv-key">Amount</span><span className="kv-val">{result.payment.amount} paise ({INR(result.payment.amount / 100)})</span></div>
                  <div className="kv-row"><span className="kv-key">Currency</span><span className="kv-val">{result.payment.currency}</span></div>
                  <div className="kv-row"><span className="kv-key">Status</span><span className="kv-val"><span className="pill approved">Payment Ready</span></span></div>
                </div>
              </div>
            </>
          ) : result.status === 'cancelled' ? (
            <>
              <div className="section-title" style={{ marginTop: '1.75rem' }}>Purchase Cancelled</div>
              <div className="gate-block-card" id="cancelled-panel">
                <h3>Cancelled — No Charge</h3>
                <p>You cancelled this purchase before authorizing payment. No money was moved, and the cancellation is recorded in the audit trail below.</p>
              </div>
            </>
          ) : gateBlocked ? (
            <>
              <div className="section-title" style={{ marginTop: '1.75rem' }}>Payment Blocked</div>
              <div className="gate-block-card">
                <h3>No Charge — Mandate Gate Refused</h3>
                <p>{result.reasoning}</p>
              </div>
            </>
          ) : null}

          {/* Negotiation transcript */}
          {transcript && transcript.length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: '2rem' }}>Negotiation Transcript</div>
              <div className="card">
                <TranscriptChat transcript={transcript} />
              </div>
            </>
          )}

          {/* Pipeline Trace */}
          {audit && (
            <>
              <div className="section-title" style={{ marginTop: '2rem' }}>
                Audit Trail ({audit.entries.length} steps)
              </div>
              <PipelineTimeline entries={audit.entries} fullTrace={result.fullTrace} />
            </>
          )}
        </>
      )}
    </div>
  )
}
