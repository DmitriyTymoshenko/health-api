/**
 * Body measurements route — unit tests for business logic
 * Tests: doc normalization, date auto-set, limit parsing
 */

// --- Replicate pure logic from routes/body_measurements.js ---

interface BodyMeasurementsDoc {
  date: string
  created_at: Date
  [key: string]: unknown
}

function normalizeMeasurementsDoc(body: Record<string, unknown>): BodyMeasurementsDoc {
  const doc = { ...body }
  if (!doc.date) doc.date = new Date().toISOString().split('T')[0]
  doc.created_at = new Date()
  return doc as BodyMeasurementsDoc
}

function parseLimitParam(limitStr: string | undefined): number {
  return parseInt(limitStr ?? '50') || 50
}

// --- Tests ---

describe('normalizeMeasurementsDoc — doc creation', () => {
  it('preserves existing date', () => {
    const doc = normalizeMeasurementsDoc({ date: '2026-04-10', chest_cm: 105 })
    expect(doc.date).toBe('2026-04-10')
  })

  it('auto-sets date when missing', () => {
    const doc = normalizeMeasurementsDoc({ chest_cm: 105 })
    expect(doc.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('adds created_at timestamp', () => {
    const doc = normalizeMeasurementsDoc({ date: '2026-04-10' })
    expect(doc.created_at).toBeInstanceOf(Date)
  })

  it('preserves measurement fields', () => {
    const doc = normalizeMeasurementsDoc({
      date: '2026-04-10',
      chest_cm: 105,
      waist_cm: 92,
      hips_cm: 104,
      bicep_cm: 38,
      weight_kg: 89.5,
    })
    expect(doc.chest_cm).toBe(105)
    expect(doc.waist_cm).toBe(92)
    expect(doc.hips_cm).toBe(104)
    expect(doc.bicep_cm).toBe(38)
    expect(doc.weight_kg).toBe(89.5)
  })
})

describe('parseLimitParam — limit parsing', () => {
  it('returns 50 when limit not provided', () => {
    expect(parseLimitParam(undefined)).toBe(50)
  })

  it('parses integer from string', () => {
    expect(parseLimitParam('20')).toBe(20)
  })

  it('returns default when invalid string', () => {
    expect(parseLimitParam('abc')).toBe(50)
  })

  it('returns parsed value for valid number', () => {
    expect(parseLimitParam('100')).toBe(100)
  })
})

describe('body measurements — typical values sanity', () => {
  it('waist-to-hip ratio under 0.9 = healthy for men', () => {
    const waist = 92
    const hips = 104
    const ratio = waist / hips
    expect(ratio).toBeLessThan(0.9) // 92/104 = 0.885
  })

  it('BMI calculation from height and weight', () => {
    const weight = 89.5  // kg
    const height = 1.86  // m
    const bmi = weight / (height * height)
    expect(bmi).toBeGreaterThan(18.5)  // not underweight
    expect(bmi).toBeLessThan(40)       // not morbidly obese
    expect(Math.round(bmi * 10) / 10).toBe(25.9) // 89.5 / (1.86²) = 25.87 ≈ 25.9
  })
})
