/**
 * Unit tests for lib/gemini-text.js (#1487, stage B of #1485, design D1).
 * Same defensive-parsing convention as nutrition_recognize.test.ts's pure
 * helpers: extractText/parseTextResponse never throw on truncated/empty/
 * non-JSON responses; callGemini takes an injectable fetchImpl so no real
 * network call is ever made in tests.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractText, parseTextResponse, callGemini, GEMINI_MODEL, MAX_OUTPUT_TOKENS } = require('../../lib/gemini-text')

describe('extractText — joins all Gemini response parts', () => {
  it('joins multiple text parts into one string', () => {
    const candidate = { content: { parts: [{ text: '{"a":' }, { text: '1}' }] } }
    expect(extractText(candidate)).toBe('{"a":1}')
  })
  it('returns empty string when candidate is undefined', () => {
    expect(extractText(undefined)).toBe('')
  })
  it('returns empty string when parts missing (MAX_TOKENS case)', () => {
    expect(extractText({ finishReason: 'MAX_TOKENS', content: {} })).toBe('')
  })
})

describe('parseTextResponse — end-to-end response parsing', () => {
  it('parses a normal JSON-object response and carries usageMetadata through', () => {
    const data = {
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"continuous":true}' }] } }],
      usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 40, totalTokenCount: 1240 },
    }
    const out = parseTextResponse(data)
    expect(out.json).toEqual({ continuous: true })
    expect(out.usage).toEqual({ promptTokenCount: 1200, candidatesTokenCount: 40, totalTokenCount: 1240 })
    expect(out.finishReason).toBe('STOP')
  })

  it('does not throw when finishReason=MAX_TOKENS and content.parts is empty — json is null', () => {
    const data = { candidates: [{ finishReason: 'MAX_TOKENS', content: {} }] }
    expect(() => parseTextResponse(data)).not.toThrow()
    expect(parseTextResponse(data).json).toBeNull()
  })

  it('json is null on invalid JSON text, never throws', () => {
    const data = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not json' }] } }] }
    expect(parseTextResponse(data).json).toBeNull()
  })

  it('json is null when candidates is missing entirely', () => {
    expect(parseTextResponse({}).json).toBeNull()
  })
})

describe('callGemini — request building + error handling (mocked fetch)', () => {
  it('throws NO_API_KEY when apiKey is missing, before any fetch call', async () => {
    const fetchImpl = jest.fn()
    await expect(callGemini({ apiKey: '', prompt: 'x', fetchImpl })).rejects.toMatchObject({ code: 'NO_API_KEY' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws when prompt is missing', async () => {
    const fetchImpl = jest.fn()
    await expect(callGemini({ apiKey: 'k', prompt: '', fetchImpl })).rejects.toThrow('prompt is required')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends responseMimeType=application/json + the given schema, uses GEMINI_MODEL by default', async () => {
    let capturedUrl: string = ''
    let capturedBody: any = null
    const fetchImpl = jest.fn(async (url: string, opts: { body: string }) => {
      capturedUrl = url
      capturedBody = JSON.parse(opts.body)
      return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"ok":true}' }] } }] }) }
    })
    const schema = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } } }
    const result = await callGemini({ apiKey: 'test-key', prompt: 'say ok', schema, fetchImpl })

    expect(capturedUrl).toContain(GEMINI_MODEL)
    expect(capturedUrl).toContain('key=test-key')
    expect(capturedBody.generationConfig.responseMimeType).toBe('application/json')
    expect(capturedBody.generationConfig.responseSchema).toEqual(schema)
    expect(capturedBody.generationConfig.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS)
    expect(capturedBody.contents[0].parts[0].text).toBe('say ok')
    expect(result.json).toEqual({ ok: true })
  })

  it('uses an explicit model override when given', async () => {
    let capturedUrl
    const fetchImpl = jest.fn(async (url) => {
      capturedUrl = url
      return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }] }) }
    })
    await callGemini({ apiKey: 'k', model: 'gemini-3.5-flash', prompt: 'x', fetchImpl })
    expect(capturedUrl).toContain('gemini-3.5-flash')
  })

  it('throws with status+body on a non-2xx response, never crashes on the .text() read', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }))
    await expect(callGemini({ apiKey: 'k', prompt: 'x', fetchImpl })).rejects.toMatchObject({ status: 429, body: 'rate limited' })
  })
})

export {}
