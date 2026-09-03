const { Router } = require('express')

/**
 * POST /api/nutrition/recognize
 * Body: { image: "<base64 string>", mediaType: "image/jpeg" (optional) }
 * Returns: [{ food_name, amount_g, kcal, protein_g, fat_g, carbs_g, sugar_g, fiber_g, sat_fat_g }]
 *
 * Uses Gemini vision (GOOGLE_AI_API_KEY). Switched from Claude/ANTHROPIC_API_KEY on 2026-08-07
 * (#872 bug 3): the ONLY ANTHROPIC_API_KEY on this server is a commented-out Claude Code OAuth
 * token (sk-ant-oat01-...) in root .env, not a real API key. Verified live: sent as x-api-key to
 * api.anthropic.com/v1/messages -> HTTP 401 "invalid x-api-key". There was never a working
 * Anthropic credential here, so an env-var-drift fix (just copy it into the service) would still
 * leave photo recognition broken. GOOGLE_AI_API_KEY is already live in root .env and proven for
 * the identical job (Lisa's food-photo recognition, src/gemini-vision.ts in the agent repo) — this
 * route mirrors that file's defensive pattern (finishReason check before the empty-text check,
 * join all response parts, clamped output-token override) instead of reinventing it.
 */

const GEMINI_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-3.8-flash'
// Same floor/clamp rationale as src/gemini-vision.ts (#863, 2026-07-30/08-03): a bad env override
// must degrade to "small but usable", never invert into a hard 400. Default raised 2000->4000
// after a live test hit finishReason=MAX_TOKENS with content.parts=[] on the first real photo —
// gemini-2.5-flash burns thinking tokens against this same budget before it emits the JSON array,
// the exact #863 mechanism.
//
// #1232 (2026-09-03): `thinkingConfig: { thinkingBudget: 0 }` below does NOT remove the root
// cause on gemini-3.8-flash — live-probed 11 ways (Lucas, #1232 Фаза 1): thinkingBudget
// 0/-1/1 are silently IGNORED on this model (thoughtsTokenCount ranged 0-3838 on the same
// photo regardless of the value sent), and the replacement `thinkingLevel` param has no
// off/none value (HTTP 400 on "off"/"NONE"). This is model-specific to 3.8 — gemini-3.5-flash
// and gemini-2.5-flash both honour thinkingBudget:0 correctly (thoughtsTokenCount absent).
// Default raised 4000->8000 (+33% over the worst measured thoughts+candidates ≈ 6000) and a
// same-request fallback model added below (GEMINI_FALLBACK_MODEL) as the actual defense —
// the config below is a floor, not a guarantee.
const MIN_OUTPUT_TOKENS = 512
const MAX_OUTPUT_TOKENS = Math.max(MIN_OUTPUT_TOKENS, Number(process.env.GEMINI_VISION_MAX_TOKENS) || 8000)
// Fallback model used ONLY when the primary model (GEMINI_MODEL, above) hits
// finishReason=MAX_TOKENS. Named separately from GEMINI_MODEL on purpose — a second literal
// baked into the code instead of an env var is exactly the ID-drift class fixed in #1162/#1228.
// Default gemini-3.5-flash: measured (#1232 Фаза 1, run G) to honour thinkingBudget:0 correctly
// on the same heavy photo that broke gemini-3.8-flash. This is a DIFFERENT model, not a retry
// of the same call — retrying gemini-3.8-flash itself for "more tokens" would only truncate
// again (same reasoning as src/gemini-vision.ts's MAX_TOKENS branch, which deliberately never
// re-prompts — see src/gemini-vision.test.ts "does NOT re-prompt on MAX_TOKENS").
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_VISION_FALLBACK_MODEL || 'gemini-3.5-flash'

const PROMPT = `You are a nutrition expert. Analyze this food photo and identify EVERY food item visible on the plate — main dish, side, sauce, drink, bread, garnish. Do not skip any item.

Return a JSON array. Each item MUST have these exact keys:
- food_name: string (in English)
- amount_g: number (estimated weight in grams)
- kcal: number (total calories for this portion)
- protein_g: number
- fat_g: number
- carbs_g: number
- sugar_g: number
- fiber_g: number
- sat_fat_g: number (saturated fat grams; estimate from food composition if unknown)

If you cannot identify any food in the image, return an empty array.`

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      food_name: { type: 'STRING' },
      amount_g: { type: 'NUMBER' },
      kcal: { type: 'NUMBER' },
      protein_g: { type: 'NUMBER' },
      fat_g: { type: 'NUMBER' },
      carbs_g: { type: 'NUMBER' },
      sugar_g: { type: 'NUMBER' },
      fiber_g: { type: 'NUMBER' },
      sat_fat_g: { type: 'NUMBER' },
    },
    required: ['food_name', 'amount_g', 'kcal', 'protein_g', 'fat_g', 'carbs_g', 'sugar_g', 'fiber_g', 'sat_fat_g'],
  },
}

// ── Pure helpers (exported for unit tests — no fetch, no Express req/res) ──

function extractText(candidate) {
  return (candidate?.content?.parts ?? [])
    .map(p => p?.text)
    .filter(Boolean)
    .join('')
}

function sanitizeItems(items) {
  if (!Array.isArray(items)) return []
  return items.map(item => ({
    food_name: String(item.food_name || 'Unknown'),
    amount_g:  Math.round(Number(item.amount_g) || 0),
    kcal:      Math.round(Number(item.kcal) || 0),
    protein_g: +(Number(item.protein_g || 0).toFixed(1)),
    fat_g:     +(Number(item.fat_g || 0).toFixed(1)),
    carbs_g:   +(Number(item.carbs_g || 0).toFixed(1)),
    sugar_g:   +(Number(item.sugar_g || 0).toFixed(1)),
    fiber_g:   +(Number(item.fiber_g || 0).toFixed(1)),
    sat_fat_g: +(Number(item.sat_fat_g || 0).toFixed(1)),
  }))
}

function parseGeminiResponse(data) {
  const candidate = data?.candidates?.[0]
  const finishReason = candidate?.finishReason

  // Regression guard (same class as #863 in the agent repo, src/gemini-vision.ts): check
  // finishReason BEFORE the empty-text check — MAX_TOKENS can return content.parts=[] entirely,
  // so a guard placed after "if (!text)" would never fire in exactly the case it exists for.
  // The caller (router handler below) is responsible for the GEMINI_FALLBACK_MODEL retry when
  // this fires — this function stays a pure single-response parser (unit-tested directly).
  if (finishReason === 'MAX_TOKENS') {
    console.warn('[nutrition/recognize] Gemini response truncated (MAX_TOKENS) — raise GEMINI_VISION_MAX_TOKENS env')
  }

  const text = extractText(candidate)
  let items = []
  try {
    items = JSON.parse(text || '[]')
  } catch (e) {
    console.error('[nutrition/recognize] JSON parse failed:', e.message, 'finishReason=', finishReason)
    items = []
  }
  return sanitizeItems(items)
}

// Single round-trip against one named model. Extracted so the MAX_TOKENS fallback (handler
// below) re-runs the exact same request-building/error-handling instead of a divergent copy —
// same rationale as src/gemini-vision.ts's callGemini() closure.
async function callGeminiModel(model, apiKey, image, mediaType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  const requestBody = JSON.stringify({
    contents: [{
      parts: [
        { text: PROMPT },
        { inline_data: { mime_type: mediaType, data: image } },
      ],
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      // This is structured extraction against a fixed schema, not reasoning — no chain-of-
      // thought needed in principle. On most models this stops thinking tokens from eating
      // MAX_OUTPUT_TOKENS before the JSON array is emitted (the #863 mechanism) — but #1232
      // found gemini-3.8-flash ignores this parameter entirely (live-probed, see the
      // MAX_OUTPUT_TOKENS comment above). Left set because it costs nothing and still works on
      // the GEMINI_FALLBACK_MODEL below; the raised MAX_OUTPUT_TOKENS ceiling + fallback model
      // are the real defense on 3.8, not this flag.
      thinkingConfig: { thinkingBudget: 0 },
    },
  })

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: requestBody,
    signal: AbortSignal.timeout(30000),
  })

  if (!r.ok) {
    const errText = await r.text()
    const err = new Error(`Gemini API error: ${r.status}`)
    err.status = r.status
    err.body = errText.slice(0, 300)
    throw err
  }

  return r.json()
}

module.exports = function (_getDB) {
  const router = Router()

  router.post('/', async (req, res) => {
    const apiKey = process.env.GOOGLE_AI_API_KEY
    if (!apiKey) {
      return res.status(503).json({
        error: 'GOOGLE_AI_API_KEY not configured',
        hint: 'Set GOOGLE_AI_API_KEY in environment to enable photo recognition',
      })
    }

    const { image, mediaType = 'image/jpeg' } = req.body
    if (!image) return res.status(400).json({ error: 'image (base64) is required' })

    try {
      const data = await callGeminiModel(GEMINI_MODEL, apiKey, image, mediaType)
      let items = parseGeminiResponse(data)
      const primaryFinish = data?.candidates?.[0]?.finishReason

      // #1232: gemini-3.8-flash can still hit MAX_TOKENS (thinking ignores thinkingBudget:0 —
      // see comment above). One fallback call on a DIFFERENT model that is measured to behave
      // (never a retry of the SAME model — that would just truncate again, same reasoning as
      // src/gemini-vision.ts). Best-effort: a failing fallback must degrade to the primary's
      // (likely empty) result, never crash the request.
      if (primaryFinish === 'MAX_TOKENS' && GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL) {
        console.warn(`[nutrition/recognize] primary model ${GEMINI_MODEL} hit MAX_TOKENS — retrying with fallback ${GEMINI_FALLBACK_MODEL}`)
        try {
          const fallbackData = await callGeminiModel(GEMINI_FALLBACK_MODEL, apiKey, image, mediaType)
          const fallbackItems = parseGeminiResponse(fallbackData)
          if (fallbackItems.length > 0) items = fallbackItems
        } catch (fallbackErr) {
          console.error('[nutrition/recognize] fallback model call failed:', fallbackErr.message)
        }
      }

      res.json(items)
    } catch (err) {
      if (err.status) {
        console.error('[nutrition/recognize] Gemini HTTP', err.status, err.body)
        return res.status(502).json({ error: err.message })
      }
      console.error('[nutrition/recognize] error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  router._internal = { extractText, sanitizeItems, parseGeminiResponse, callGeminiModel }
  return router
}
