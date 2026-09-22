'use strict'

// #1487 (stage B of #1485, design D1): text-only Gemini JSON helper, used by
// scripts/fill-supplement-knowledge-1485.js to ask "is this supplement safe
// continuously, or does it need a cycle, per the Koliada corpus" and get a
// declarative JSON answer back — validated deterministically afterwards by
// lib/koliada-validate.js (lesson: an LLM fills a declarative contract, the
// contract is checked in code, never trust the model's own grounding claim).
//
// WHY a NEW helper instead of reusing routes/nutrition_recognize.js's Gemini
// call: that file is vision-specific (inline_data image part, its own
// RESPONSE_SCHEMA/PROMPT baked in, its own MAX_TOKENS fallback-model dance
// tuned for gemini-3.8-flash's thinking-token bug, #1232). This helper is
// text-only, schema is caller-supplied, and the default model
// (gemini-2.5-flash) already respects `thinkingConfig.thinkingBudget: 0`
// correctly per #1232's own measurement — no fallback-model dance needed
// here, but the same finishReason/JSON-parse defensive pattern is kept
// because it costs nothing and the class of bug (MAX_TOKENS, empty parts,
// non-JSON text) is not model-specific.
//
// Owner rule (D1): no new env/secret. `GOOGLE_AI_API_KEY` is already live in
// this service's environment (used by nutrition_recognize.js) — reused
// as-is. `GEMINI_TEXT_MODEL` is an OPTIONAL env override with a hardcoded
// default; health-api's systemd drop-in does NOT need a new file for this
// (lesson personas/lucas.md #1230: a new env var needs a drop-in ONLY if the
// caller actually sets one — a pure code-default needs nothing).

const GEMINI_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash'
const MIN_OUTPUT_TOKENS = 256
const MAX_OUTPUT_TOKENS = Math.max(MIN_OUTPUT_TOKENS, Number(process.env.GEMINI_TEXT_MAX_TOKENS) || 4096)
const TIMEOUT_MS = Math.max(1000, Number(process.env.GEMINI_TEXT_TIMEOUT_MS) || 30000)

// ── Pure helpers (exported for unit tests — no fetch) ──

function extractText(candidate) {
  return (candidate?.content?.parts ?? [])
    .map(p => p?.text)
    .filter(Boolean)
    .join('')
}

// Parses ONE Gemini generateContent response into { json, usage, finishReason }.
// `json` is `null` (never throws) when the response is empty, truncated, or
// not valid JSON — the caller decides what a null result means for its own
// contract (e.g. the fill-script logs an exception row and moves on).
function parseTextResponse(data) {
  const candidate = data?.candidates?.[0]
  const finishReason = candidate?.finishReason
  const usage = data?.usageMetadata || null

  if (finishReason === 'MAX_TOKENS') {
    console.warn('[gemini-text] response truncated (MAX_TOKENS) — raise GEMINI_TEXT_MAX_TOKENS env')
  }

  const text = extractText(candidate)
  let json = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch (e) {
      console.error('[gemini-text] JSON parse failed:', e.message, 'finishReason=', finishReason)
      json = null
    }
  }
  return { json, usage, finishReason }
}

// Single round-trip. `fetchImpl` is injectable for tests (default: global fetch).
async function callGemini({ apiKey, model = GEMINI_MODEL, prompt, schema, maxOutputTokens = MAX_OUTPUT_TOKENS, temperature = 0.2, fetchImpl = fetch }) {
  if (!apiKey) {
    const err = new Error('GOOGLE_AI_API_KEY not configured')
    err.code = 'NO_API_KEY'
    throw err
  }
  if (!prompt) throw new Error('prompt is required')

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  const generationConfig = {
    temperature,
    maxOutputTokens,
    responseMimeType: 'application/json',
    // #1232: thinkingBudget:0 is silently ignored on gemini-3.8-flash but
    // correctly honoured on gemini-2.5-flash (this helper's default) and
    // gemini-3.5-flash — kept here because it costs nothing and helps on
    // every model that DOES respect it.
    thinkingConfig: { thinkingBudget: 0 },
  }
  if (schema) generationConfig.responseSchema = schema

  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig,
  })

  const r = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: requestBody,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!r.ok) {
    const errText = await r.text()
    const err = new Error(`Gemini API error: ${r.status}`)
    err.status = r.status
    err.body = errText.slice(0, 300)
    throw err
  }

  const data = await r.json()
  return parseTextResponse(data)
}

module.exports = {
  GEMINI_MODEL,
  MAX_OUTPUT_TOKENS,
  extractText,
  parseTextResponse,
  callGemini,
}
