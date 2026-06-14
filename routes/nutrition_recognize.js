const { Router } = require('express')
const https = require('https')

/**
 * POST /api/nutrition/recognize
 * Body: { image: "<base64 string>", mediaType: "image/jpeg" (optional) }
 * Returns: [{ food_name, amount_g, kcal, protein_g, fat_g, carbs_g, sugar_g, fiber_g }]
 *
 * Uses Claude claude-3-5-haiku-20241022 vision. Requires ANTHROPIC_API_KEY env var.
 */

module.exports = function (_getDB) {
  const router = Router()

  router.post('/', async (req, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return res.status(503).json({
        error: 'ANTHROPIC_API_KEY not configured',
        hint: 'Set ANTHROPIC_API_KEY in environment to enable photo recognition',
      })
    }

    const { image, mediaType = 'image/jpeg' } = req.body
    if (!image) return res.status(400).json({ error: 'image (base64) is required' })

    const prompt = `You are a nutrition expert. Analyze this food photo and identify all food items visible.
For each item provide a JSON array with objects having these exact keys:
- food_name: string (in English)
- amount_g: number (estimated weight in grams)
- kcal: number (total calories for this portion)
- protein_g: number
- fat_g: number
- carbs_g: number
- sugar_g: number
- fiber_g: number

Return ONLY a valid JSON array, no markdown, no explanation. Example:
[{"food_name":"Chicken breast","amount_g":150,"kcal":248,"protein_g":46,"fat_g":5,"carbs_g":0,"sugar_g":0,"fiber_g":0}]

If you cannot identify food in the image, return an empty array: []`

    const requestBody = JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: image },
          },
          { type: 'text', text: prompt },
        ],
      }],
    })

    try {
      const result = await new Promise((resolve, reject) => {
        const opts = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(requestBody),
          },
        }
        const req2 = https.request(opts, (r) => {
          let data = ''
          r.on('data', c => data += c)
          r.on('end', () => {
            try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
          })
        })
        req2.on('error', reject)
        req2.setTimeout(30000, () => { req2.destroy(); reject(new Error('Claude API timeout')) })
        req2.write(requestBody)
        req2.end()
      })

      if (result.error) {
        return res.status(502).json({ error: result.error.message || 'Claude API error' })
      }

      const text = result?.content?.[0]?.text || '[]'
      let items
      try {
        // Strip markdown code fences if present
        const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
        items = JSON.parse(cleaned)
        if (!Array.isArray(items)) items = []
      } catch {
        items = []
      }

      // Sanitize numbers
      const safe = items.map(item => ({
        food_name: String(item.food_name || 'Unknown'),
        amount_g:  Math.round(Number(item.amount_g) || 0),
        kcal:      Math.round(Number(item.kcal) || 0),
        protein_g: +(Number(item.protein_g || 0).toFixed(1)),
        fat_g:     +(Number(item.fat_g || 0).toFixed(1)),
        carbs_g:   +(Number(item.carbs_g || 0).toFixed(1)),
        sugar_g:   +(Number(item.sugar_g || 0).toFixed(1)),
        fiber_g:   +(Number(item.fiber_g || 0).toFixed(1)),
      }))

      res.json(safe)
    } catch (err) {
      console.error('[nutrition/recognize] error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
