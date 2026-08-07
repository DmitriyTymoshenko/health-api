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

const GEMINI_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash'
// Same floor/clamp rationale as src/gemini-vision.ts (#863, 2026-07-30/08-03): a bad env override
// must degrade to "small but usable", never invert into a hard 400. Default raised 2000->4000
// after a live test hit finishReason=MAX_TOKENS with content.parts=[] on the first real photo —
// gemini-2.5-flash burns thinking tokens against this same budget before it emits the JSON array,
// the exact #863 mechanism. thinkingBudget: 0 below removes the root cause (this call needs no
// chain-of-thought, only structured extraction); the raised floor stays as defense in depth.
const MIN_OUTPUT_TOKENS = 512
const MAX_OUTPUT_TOKENS = Math.max(MIN_OUTPUT_TOKENS, Number(process.env.GEMINI_VISION_MAX_TOKENS) || 4000)

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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`
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
        // thought needed. Disabling it stops thinking tokens from eating MAX_OUTPUT_TOKENS
        // before the model emits the JSON array (root cause of the MAX_TOKENS hit above).
        thinkingConfig: { thinkingBudget: 0 },
      },
    })

    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
        signal: AbortSignal.timeout(30000),
      })

      if (!r.ok) {
        const errText = await r.text()
        console.error('[nutrition/recognize] Gemini HTTP', r.status, errText.slice(0, 300))
        return res.status(502).json({ error: `Gemini API error: ${r.status}` })
      }

      const data = await r.json()
      res.json(parseGeminiResponse(data))
    } catch (err) {
      console.error('[nutrition/recognize] error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  router._internal = { extractText, sanitizeItems, parseGeminiResponse }
  return router
}
