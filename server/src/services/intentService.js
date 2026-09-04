'use strict';

require('dotenv').config();

const GROQ_TIMEOUT_MS = 10_000; // 10 s — prevents hung requests stalling the pipeline (D3)

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_BASE_URL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set in .env');

// ─── Intent schema (mirrored from schemas.js for the prompt) ─────────────────

const INTENT_SCHEMA = `
{
  "goal": "string — one-line description of what the buyer wants",
  "budget": "number — total budget in INR (rupees)",
  "preferences": {
    "<item>": "locked | medium | low"
  }
}
`.trim();

const SYSTEM_PROMPT = `
You are a structured data extractor. The user will describe a shopping intent in natural language.
Your ONLY job is to extract and return a JSON object that exactly matches this schema:

${INTENT_SCHEMA}

Rules:
- Return RAW JSON only. No markdown fences, no explanation, no extra text.
- "goal" must be a concise English sentence describing what they want to buy.
- "budget" must be a number (no currency symbols). If the user says ₹7,340, set budget to 7340.
  If no budget is stated, set budget to 0. Do NOT invent or guess a budget number.
- "preferences" must map item names to one of: "locked", "medium", or "low".
  - "locked" = must-have, non-negotiable, most important, essential
  - "medium" = important but substitutable if needed
  - "low"    = nice-to-have, least important
- CRITICAL: Add EVERY product or item the user mentions to preferences.
  If the user mentions headset, keyboard, and mouse — all three MUST appear in preferences.
  Never omit a mentioned item. If priority is not stated, assign "medium".
- Every key in preferences must be a single product category (e.g. "headset", "keyboard", "mouse").
- Only omit budget if completely unmentioned (default 0). Never omit mentioned products from preferences.
`.trim();

// ─── LLM call ────────────────────────────────────────────────────────────────

async function callGroq(userText) {
  // D3 fix: abort after GROQ_TIMEOUT_MS to prevent indefinite pipeline stall
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userText },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Groq API timed out after ${GROQ_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content ?? '';
  return raw.trim();
}

// ─── Validation ───────────────────────────────────────────────────────────────

const VALID_PREFERENCE_VALUES = new Set(['locked', 'medium', 'low']);

function validateIntent(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return 'root must be an object';
  }
  if (typeof obj.goal !== 'string' || obj.goal.trim() === '') {
    return '"goal" must be a non-empty string';
  }
  if (typeof obj.budget !== 'number' || isNaN(obj.budget)) {
    return '"budget" must be a number';
  }
  if (typeof obj.preferences !== 'object' || obj.preferences === null || Array.isArray(obj.preferences)) {
    return '"preferences" must be an object';
  }
  for (const [key, val] of Object.entries(obj.preferences)) {
    if (!VALID_PREFERENCE_VALUES.has(val)) {
      return `preferences["${key}"] = "${val}" — must be "locked", "medium", or "low"`;
    }
  }
  return null; // valid
}

function parseJSON(raw) {
  // Strip accidental markdown fences if the model adds them despite instructions
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(cleaned);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a natural-language shopping request into a validated Intent object.
 *
 * Returns the raw LLM-parsed intent (goal, budget, preferences).  Goal-to-
 * category expansion (e.g. "gaming setup" → headset + keyboard + mouse) is now
 * handled by goalService.classifyGoal(), which is scope-aware (single-item
 * requests stay narrow, setups expand to the goal's canonical categories).
 *
 * @param {string} userText - Raw user input
 * @returns {Promise<Intent>}
 * @throws {Error} if both attempts fail validation
 */
async function parseIntent(userText) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callGroq(userText);

    let parsed;
    try {
      parsed = parseJSON(raw);
    } catch (e) {
      if (attempt === 2) throw new Error(`JSON parse failed after retry: ${e.message}\nRaw: ${raw}`);
      continue; // retry
    }

    const error = validateIntent(parsed);
    if (error) {
      if (attempt === 2) throw new Error(`Intent validation failed after retry: ${error}\nParsed: ${JSON.stringify(parsed)}`);
      continue; // retry
    }

    // Budget guard: if LLM still returns a non-zero number for a budget-free
    // prompt (anchoring artefact), leave it — we prefer the LLM's interpretation.
    // If it returned 0, honour that.  Never coerce a stated number to 0.
    return parsed;
  }
  // Safety net — should never be reached given the throws inside the loop
  throw new Error('parseIntent: exhausted retries without resolving');
}

module.exports = { parseIntent };
