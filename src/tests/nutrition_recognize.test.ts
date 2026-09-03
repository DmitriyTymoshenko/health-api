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
 *
 * #1232 (2026-09-03): gemini-3.8-flash was live-probed to ignore thinkingBudget:0 and can still
 * hit MAX_TOKENS on a heavy photo (Lucas, #1232 Фаза 1, 11 live runs). The route-level tests
 * below (ROUTE-LEVEL: real router via supertest + mocked global.fetch, same convention as
 * foods_search_regex_escape.test.ts) cover the GEMINI_FALLBACK_MODEL retry this file's pure
 * parseGeminiResponse() cannot see on its own — it only parses ONE response, the fallback
 * decision lives in the router handler.
 */

import request from 'supertest'
import express from 'express'

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

// ── ROUTE-LEVEL: real router via supertest + mocked global.fetch (#1232) ──
// GEMINI_MODEL/GEMINI_FALLBACK_MODEL/MAX_OUTPUT_TOKENS are computed at require-time from
// process.env, so each test sets env THEN requires a fresh module instance (jest.resetModules).
describe('POST / — MAX_TOKENS fallback route behaviour (#1232)', () => {
  const ORIGINAL_ENV = process.env
  const ORIGINAL_FETCH = global.fetch

  beforeEach(() => {
    jest.resetModules()
    process.env = {
      ...ORIGINAL_ENV,
      GOOGLE_AI_API_KEY: 'test-key',
      GEMINI_VISION_MODEL: 'gemini-3.8-flash',
      GEMINI_VISION_FALLBACK_MODEL: 'gemini-3.5-flash',
    }
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
    global.fetch = ORIGINAL_FETCH
  })

  function buildApp() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const freshBuildRouter = require('../../routes/nutrition_recognize')
    const app = express()
    app.use(express.json({ limit: '10mb' }))
    app.use('/', freshBuildRouter(() => null))
    return app
  }

  const maxTokensResponse = { candidates: [{ finishReason: 'MAX_TOKENS', content: {} }] }
  const stopResponse = (name: string) => ({
    candidates: [{
      finishReason: 'STOP',
      content: { parts: [{ text: `[{"food_name":"${name}","amount_g":150,"kcal":200,"protein_g":4,"fat_g":0.5,"carbs_g":44,"sugar_g":0,"fiber_g":1,"sat_fat_g":0.1}]` }] },
    }],
  })

  // The scenario this whole task exists for: primary hits the #863 mechanism on gemini-3.8-flash,
  // the fallback model (measured in #1232 Фаза 1 run G to honour thinkingBudget:0) recovers a
  // non-empty array instead of the user seeing an empty result.
  it('retries on GEMINI_FALLBACK_MODEL when the primary hits MAX_TOKENS, and returns a non-empty array', async () => {
    const fetchMock = jest.fn()
      .mockImplementationOnce(async (url: string) => {
        expect(url).toContain('gemini-3.8-flash')
        return { ok: true, json: async () => maxTokensResponse }
      })
      .mockImplementationOnce(async (url: string) => {
        expect(url).toContain('gemini-3.5-flash')
        return { ok: true, json: async () => stopResponse('Rice') }
      })
    global.fetch = fetchMock as unknown as typeof fetch

    const res = await request(buildApp()).post('/').send({ image: 'base64data' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      { food_name: 'Rice', amount_g: 150, kcal: 200, protein_g: 4, fat_g: 0.5, carbs_g: 44, sugar_g: 0, fiber_g: 1, sat_fat_g: 0.1 },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // Best-effort degrade: if the fallback ALSO hits MAX_TOKENS, the request must still return
  // 200 + [] — never crash, never 500 — same shape as the pre-#1232 single-model behaviour.
  it('degrades to an empty array (no crash) when both the primary and fallback hit MAX_TOKENS', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => maxTokensResponse })
    global.fetch = fetchMock as unknown as typeof fetch

    const res = await request(buildApp()).post('/').send({ image: 'base64data' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // No wasted second call when the primary already succeeded — the fallback is ONLY for
  // finishReason=MAX_TOKENS, not a blanket double-call.
  it('does NOT call the fallback model when the primary succeeds (finishReason=STOP)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => stopResponse('Banana') })
    global.fetch = fetchMock as unknown as typeof fetch

    const res = await request(buildApp()).post('/').send({ image: 'base64data' })

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // Guards the "never retry the SAME model" rule (src/gemini-vision.test.ts: "does NOT re-prompt
  // on MAX_TOKENS — asking for more would truncate again"). If GEMINI_VISION_FALLBACK_MODEL is
  // ever misconfigured to equal the primary model, the route must NOT double-call it.
  it('does NOT retry when GEMINI_VISION_FALLBACK_MODEL equals the primary model', async () => {
    process.env.GEMINI_VISION_FALLBACK_MODEL = 'gemini-3.8-flash'
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => maxTokensResponse })
    global.fetch = fetchMock as unknown as typeof fetch

    const res = await request(buildApp()).post('/').send({ image: 'base64data' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // maxOutputTokens must reach the real request body — the drop-in alone proves nothing if the
  // route doesn't read the env var (lesson from this task's own handoff: "drop-in can be written
  // and not picked up without daemon-reload" — this test proves the CODE side of that chain).
  it('sends maxOutputTokens=8000 (new default) in the real request body', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => stopResponse('Banana') })
    global.fetch = fetchMock as unknown as typeof fetch

    await request(buildApp()).post('/').send({ image: 'base64data' })

    const [, options] = fetchMock.mock.calls[0]
    const body = JSON.parse(options.body)
    expect(body.generationConfig.maxOutputTokens).toBe(8000)
  })
})

export {};
