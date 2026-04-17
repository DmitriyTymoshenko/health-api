/**
 * Steps route — unit tests for validation logic in routes/steps.js
 */

// Replicate validation logic from routes/steps.js

interface StepsInput {
  date?: string
  steps?: number | string | null
  source?: string
}

interface StepsDoc {
  date: string
  steps: number
  source: string
  synced_at: string
}

function validateAndBuildStepsDoc(body: StepsInput): StepsDoc | { error: string } {
  const { date, steps, source = 'apple_health' } = body
  if (!date || steps == null) return { error: 'date and steps required' }

  return {
    date,
    steps: Math.round(Number(steps)),
    source,
    synced_at: new Date().toISOString(),
  }
}

describe('steps validation', () => {
  it('returns error when date is missing', () => {
    const result = validateAndBuildStepsDoc({ steps: 8000 })
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('date')
  })

  it('returns error when steps is missing', () => {
    const result = validateAndBuildStepsDoc({ date: '2026-04-10' })
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('steps')
  })

  it('returns error when steps is null', () => {
    const result = validateAndBuildStepsDoc({ date: '2026-04-10', steps: null })
    expect(result).toHaveProperty('error')
  })

  it('builds correct doc with valid input', () => {
    const result = validateAndBuildStepsDoc({ date: '2026-04-10', steps: 12500 }) as StepsDoc
    expect(result.date).toBe('2026-04-10')
    expect(result.steps).toBe(12500)
    expect(result.source).toBe('apple_health')
    expect(result.synced_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('rounds float steps to integer', () => {
    const result = validateAndBuildStepsDoc({ date: '2026-04-10', steps: 8432.7 }) as StepsDoc
    expect(result.steps).toBe(8433)
    expect(Number.isInteger(result.steps)).toBe(true)
  })

  it('converts string steps to number', () => {
    const result = validateAndBuildStepsDoc({ date: '2026-04-10', steps: '9800' as unknown as number }) as StepsDoc
    expect(result.steps).toBe(9800)
    expect(typeof result.steps).toBe('number')
  })

  it('uses custom source when provided', () => {
    const result = validateAndBuildStepsDoc({ date: '2026-04-10', steps: 5000, source: 'manual' }) as StepsDoc
    expect(result.source).toBe('manual')
  })

  it('defaults source to apple_health', () => {
    const result = validateAndBuildStepsDoc({ date: '2026-04-10', steps: 7000 }) as StepsDoc
    expect(result.source).toBe('apple_health')
  })
})
