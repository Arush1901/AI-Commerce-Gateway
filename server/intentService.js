'use strict';

require('dotenv').config();

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
- "budget" must be a number (no currency symbols). If the user says ₹10000, set budget to 10000.
- "preferences" must map item names to one of: "locked", "medium", or "low".
  - "locked" = must-have / highest priority
  - "medium" = important but negotiable
  - "low"    = nice-to-have
- Every key in preferences must be a product category or specific item (e.g. "headset", "keyboard").
- If a field cannot be inferred, use a sensible default (budget = 0, preferences = {}).
`.trim();

// ─── LLM call ────────────────────────────────────────────────────────────────

async function callGroq(userText) {
  const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
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
  });

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

    return parsed;
  }
}

module.exports = { parseIntent };
