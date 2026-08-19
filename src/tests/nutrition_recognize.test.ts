/**
 * Unit tests for routes/nutrition_recognize.js pure helpers (no network, no Express req/res —
 * same convention as foods.test.ts: replicate/import the pure logic and test it directly).
 *
 * Context (#872 bug 3): this route used to call api.anthropic.com with ANTHROPIC_API_KEY, which
 * on this server is a commented-out Claude Code OAuth token (sk-ant-oat01-...), not a real API
 * key — verified live: HTTP 401 "invalid x-api-key". Switched to Gemini vision (GOOGLE_AI_API_KEY,
 * already live and used for the identical job in the agent repo's src/gemini-vision.ts). These
 * tests cover the defensive parsing pattern carried over from that file (#863 lesson): the
 * finishReason=MAX_TOKENS guard must not crash when content.parts is empty, and multi-part
 * responses must be joined, not truncated to parts[0].
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const buildRouter = require('../../routes/nutrition_recognize')
const { extractText, sanitizeItems, parseGeminiResponse } = buildRouter(() => null)._internal

describe('extractText — joins all Gemini response parts', () => {
  it('joins multiple text parts into one string', () => {
    const candidate = { content: { parts: [{ text: '[{"food_name":' }, { text: '"Banana"}]' }] } }
    expect(extractText(candidate)).toBe('[{"food_name":"Banana"}]')
  })

  it('returns empty string when parts is missing entirely (MAX_TOKENS case)', () => {
    const candidate = { finishReason: 'MAX_TOKENS', content: {} }
    expect(extractText(candidate)).toBe('')
  })

  it('returns empty string when candidate itself is undefined', () => {
    expect(extractText(undefined)).toBe('')
  })

  it('skips falsy parts (no crash on a part with no text field)', () => {
    const candidate = { content: { parts: [{ text: 'a' }, {}, { text: 'b' }] } }
    expect(extractText(candidate)).toBe('ab')
  })
})

describe('sanitizeItems — numeric coercion + safe defaults', () => {
  it('rounds/coerces every numeric field and defaults food_name', () => {
    const out = sanitizeItems([
      { food_name: 'Banana', amount_g: '120.6', kcal: 106.4, protein_g: 1.29, fat_g: 0.36, carbs_g: 27.6, sugar_g: 14.64, fiber_g: 3.12, sat_fat_g: 0.12 },
    ])
    expect(out).toEqual([{
      food_name: 'Banana', amount_g: 121, kcal: 106,
      protein_g: 1.3, fat_g: 0.4, carbs_g: 27.6, sugar_g: 14.6, fiber_g: 3.1, sat_fat_g: 0.1,
    }])
  })

  it('defaults missing numeric fields to 0 and missing name to Unknown', () => {
    const out = sanitizeItems([{}])
    expect(out).toEqual([{
      food_name: 'Unknown', amount_g: 0, kcal: 0,
      protein_g: 0, fat_g: 0, carbs_g: 0, sugar_g: 0, fiber_g: 0, sat_fat_g: 0,
    }])
  })

  it('returns [] for a non-array input instead of throwing', () => {
    expect(sanitizeItems(null)).toEqual([])
    expect(sanitizeItems(undefined)).toEqual([])
    expect(sanitizeItems('not an array')).toEqual([])
  })
})

describe('parseGeminiResponse — end-to-end response parsing', () => {
  it('parses a normal JSON-array response into sanitized items', () => {
    const data = {
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ text: '[{"food_name":"Chicken breast","amount_g":150,"kcal":248,"protein_g":46,"fat_g":5,"carbs_g":0,"sugar_g":0,"fiber_g":0,"sat_fat_g":1.5}]' }] },
      }],
    }
    expect(parseGeminiResponse(data)).toEqual([
      { food_name: 'Chicken breast', amount_g: 150, kcal: 248, protein_g: 46, fat_g: 5, carbs_g: 0, sugar_g: 0, fiber_g: 0, sat_fat_g: 1.5 },
    ])
  })

  // Regression guard for the #863-class defect (src/gemini-vision.ts): MAX_TOKENS can return
  // content.parts=[] entirely — must return [] gracefully, never throw.
  it('does not throw when finishReason=MAX_TOKENS and content.parts is empty', () => {
    const data = { candidates: [{ finishReason: 'MAX_TOKENS', content: {} }] }
    expect(() => parseGeminiResponse(data)).not.toThrow()
    expect(parseGeminiResponse(data)).toEqual([])
  })

  it('returns [] when the model response is not valid JSON', () => {
    const data = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not json' }] } }] }
    expect(parseGeminiResponse(data)).toEqual([])
  })

  it('returns [] when candidates is missing entirely', () => {
    expect(parseGeminiResponse({})).toEqual([])
  })
})

export {};
