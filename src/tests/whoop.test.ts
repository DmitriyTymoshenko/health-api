/**
 * WHOOP route — unit tests for business logic in routes/whoop.js
 * Tests: recommended_strain thresholds, avg, delta, avgNutritionPerDay,
 *        avgWaterPerDay, splitWeek, toDateStr
 */

// --- Replicate pure logic from routes/whoop.js ---

interface DayRecord {
  date: string
  [key: string]: unknown
}

function toDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function getRecommendedStrain(recovScore: number): {
  min: number; max: number; label: string; color: string
} | null {
  if (recovScore >= 67) return { min: 14, max: 18, label: 'Інтенсивне тренування', color: '#6BCB77' }
  if (recovScore >= 34) return { min: 10, max: 14, label: 'Помірне навантаження', color: '#FFD93D' }
  return { min: 0, max: 10, label: 'День відновлення', color: '#FF6B6B' }
}

function avg(arr: DayRecord[], field: string): number | null {
  const vals = arr.map(d => d[field] as number).filter(v => v != null && v > 0)
  if (!vals.length) return null
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10
}

function delta(curr: number | null, prev: number | null): number | null {
  if (prev == null || prev === 0 || curr == null) return null
  return Math.round((curr - prev) / Math.abs(prev) * 1000) / 10
}

interface NutritionEntry {
  date: string
  kcal?: number
  protein_g?: number
  carbs_g?: number
  fat_g?: number
}

function avgNutritionPerDay(entries: NutritionEntry[]): {
  kcal: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null
} {
  const byDay: Record<string, { kcal: number; protein_g: number; carbs_g: number; fat_g: number }> = {}
  entries.forEach(e => {
    if (!byDay[e.date]) byDay[e.date] = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }
    byDay[e.date].kcal += e.kcal || 0
    byDay[e.date].protein_g += e.protein_g || 0
    byDay[e.date].carbs_g += e.carbs_g || 0
    byDay[e.date].fat_g += e.fat_g || 0
  })
  const days = Object.values(byDay)
  if (!days.length) return { kcal: null, protein_g: null, carbs_g: null, fat_g: null }
  return {
    kcal: Math.round(days.reduce((s, d) => s + d.kcal, 0) / days.length),
    protein_g: Math.round(days.reduce((s, d) => s + d.protein_g, 0) / days.length),
    carbs_g: Math.round(days.reduce((s, d) => s + d.carbs_g, 0) / days.length),
    fat_g: Math.round(days.reduce((s, d) => s + d.fat_g, 0) / days.length),
  }
}

interface WaterEntry {
  date: string
  amount_ml?: number
}

function avgWaterPerDay(entries: WaterEntry[]): number | null {
  const byDay: Record<string, number> = {}
  entries.forEach(e => {
    if (!byDay[e.date]) byDay[e.date] = 0
    byDay[e.date] += e.amount_ml || 0
  })
  const vals = Object.values(byDay)
  if (!vals.length) return null
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
}

function splitWeek(arr: DayRecord[], thisMondayStr: string, todayStr: string, lastMondayStr: string, lastSundayStr: string) {
  const last = arr.filter(d => d.date >= lastMondayStr && d.date <= lastSundayStr)
  const curr = arr.filter(d => d.date >= thisMondayStr && d.date <= todayStr)
  return { last, curr }
}

// --- Tests ---

describe('recommended_strain — recovery thresholds', () => {
  it('recovery >= 67 → Інтенсивне (strain 14-18, green)', () => {
    const result = getRecommendedStrain(67)
    expect(result!.min).toBe(14)
    expect(result!.max).toBe(18)
    expect(result!.label).toBe('Інтенсивне тренування')
    expect(result!.color).toBe('#6BCB77')
  })

  it('recovery 100 → still Інтенсивне', () => {
    const result = getRecommendedStrain(100)
    expect(result!.min).toBe(14)
    expect(result!.max).toBe(18)
  })

  it('recovery 34-66 → Помірне (strain 10-14, yellow)', () => {
    const result = getRecommendedStrain(50)
    expect(result!.min).toBe(10)
    expect(result!.max).toBe(14)
    expect(result!.label).toBe('Помірне навантаження')
    expect(result!.color).toBe('#FFD93D')
  })

  it('recovery exactly 34 → Помірне', () => {
    const result = getRecommendedStrain(34)
    expect(result!.min).toBe(10)
    expect(result!.max).toBe(14)
  })

  it('recovery < 34 → День відновлення (strain 0-10, red)', () => {
    const result = getRecommendedStrain(33)
    expect(result!.min).toBe(0)
    expect(result!.max).toBe(10)
    expect(result!.label).toBe('День відновлення')
    expect(result!.color).toBe('#FF6B6B')
  })

  it('recovery 0 → День відновлення', () => {
    const result = getRecommendedStrain(0)
    expect(result!.min).toBe(0)
    expect(result!.max).toBe(10)
  })
})

describe('avg — field average across records', () => {
  const records: DayRecord[] = [
    { date: '2026-04-07', recovery_score: 70 },
    { date: '2026-04-08', recovery_score: 60 },
    { date: '2026-04-09', recovery_score: 80 },
  ]

  it('calculates average correctly', () => {
    const result = avg(records, 'recovery_score')
    expect(result).toBe(70) // (70+60+80)/3 = 70.0
  })

  it('returns null for empty array', () => {
    expect(avg([], 'recovery_score')).toBeNull()
  })

  it('filters out null/zero values', () => {
    const withNulls: DayRecord[] = [
      { date: '2026-04-07', hrv: null as unknown as number },
      { date: '2026-04-08', hrv: 60 },
      { date: '2026-04-09', hrv: 0 },
      { date: '2026-04-10', hrv: 80 },
    ]
    const result = avg(withNulls, 'hrv')
    expect(result).toBe(70) // (60+80)/2 = 70
  })

  it('rounds to 1 decimal place', () => {
    const records2: DayRecord[] = [
      { date: '2026-04-07', value: 1 },
      { date: '2026-04-08', value: 2 },
      { date: '2026-04-09', value: 2 },
    ]
    const result = avg(records2, 'value')
    expect(result).toBe(1.7) // (1+2+2)/3 = 1.666... → 1.7
  })
})

describe('delta — percentage change between current and previous', () => {
  it('calculates positive delta (improvement)', () => {
    // (70 - 60) / 60 * 100 = 16.7%
    expect(delta(70, 60)).toBe(16.7)
  })

  it('calculates negative delta (decline)', () => {
    // (50 - 60) / 60 * 100 = -16.7%
    expect(delta(50, 60)).toBe(-16.7)
  })

  it('returns null when prev is null', () => {
    expect(delta(70, null)).toBeNull()
  })

  it('returns null when prev is 0 (division by zero)', () => {
    expect(delta(70, 0)).toBeNull()
  })

  it('returns null when curr is null', () => {
    expect(delta(null, 60)).toBeNull()
  })

  it('returns 0 for equal values', () => {
    expect(delta(60, 60)).toBe(0)
  })
})

describe('avgNutritionPerDay', () => {
  it('averages daily nutrition across multiple days', () => {
    const entries: NutritionEntry[] = [
      { date: '2026-04-07', kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 70 },
      { date: '2026-04-07', kcal: 500, protein_g: 30, carbs_g: 50, fat_g: 20 },  // same day
      { date: '2026-04-08', kcal: 1800, protein_g: 140, carbs_g: 180, fat_g: 65 },
    ]
    const result = avgNutritionPerDay(entries)
    // Day 1: 2500 kcal, Day 2: 1800 kcal → avg = (2500+1800)/2 = 2150
    expect(result.kcal).toBe(2150)
    // Day 1: 180g protein, Day 2: 140g → avg = 160
    expect(result.protein_g).toBe(160)
  })

  it('returns nulls for empty array', () => {
    const result = avgNutritionPerDay([])
    expect(result.kcal).toBeNull()
    expect(result.protein_g).toBeNull()
    expect(result.carbs_g).toBeNull()
    expect(result.fat_g).toBeNull()
  })

  it('aggregates multiple meals per day correctly', () => {
    const entries: NutritionEntry[] = [
      { date: '2026-04-07', kcal: 500, protein_g: 40, carbs_g: 60, fat_g: 10 },
      { date: '2026-04-07', kcal: 700, protein_g: 50, carbs_g: 80, fat_g: 20 },
      { date: '2026-04-07', kcal: 300, protein_g: 20, carbs_g: 40, fat_g: 8 },
    ]
    const result = avgNutritionPerDay(entries)
    // All one day: total = 1500 kcal
    expect(result.kcal).toBe(1500)
    expect(result.protein_g).toBe(110)
  })
})

describe('avgWaterPerDay', () => {
  it('averages daily water intake across multiple days', () => {
    const entries: WaterEntry[] = [
      { date: '2026-04-07', amount_ml: 1000 },
      { date: '2026-04-07', amount_ml: 500 },  // same day: total 1500
      { date: '2026-04-08', amount_ml: 2000 },
    ]
    const result = avgWaterPerDay(entries)
    // Day1: 1500, Day2: 2000 → avg = 1750
    expect(result).toBe(1750)
  })

  it('returns null for empty array', () => {
    expect(avgWaterPerDay([])).toBeNull()
  })

  it('handles single day', () => {
    const entries: WaterEntry[] = [
      { date: '2026-04-07', amount_ml: 500 },
      { date: '2026-04-07', amount_ml: 300 },
    ]
    expect(avgWaterPerDay(entries)).toBe(800)
  })
})

describe('splitWeek — week data splitting', () => {
  const records: DayRecord[] = [
    { date: '2026-04-06' },  // last Mon
    { date: '2026-04-07' },  // last Tue
    { date: '2026-04-12' },  // last Sun
    { date: '2026-04-13' },  // this Mon
    { date: '2026-04-14' },  // this Tue
    { date: '2026-04-17' },  // today (Thu)
  ]

  it('splits records into last and current week', () => {
    const result = splitWeek(records, '2026-04-13', '2026-04-17', '2026-04-06', '2026-04-12')
    expect(result.last.length).toBe(3)  // Mon, Tue, Sun of last week
    expect(result.curr.length).toBe(3)  // Mon, Tue, Thu of current week
  })

  it('last week dates are within Mon-Sun range', () => {
    const result = splitWeek(records, '2026-04-13', '2026-04-17', '2026-04-06', '2026-04-12')
    for (const r of result.last) {
      expect(r.date >= '2026-04-06').toBe(true)
      expect(r.date <= '2026-04-12').toBe(true)
    }
  })

  it('current week dates are from this Monday to today', () => {
    const result = splitWeek(records, '2026-04-13', '2026-04-17', '2026-04-06', '2026-04-12')
    for (const r of result.curr) {
      expect(r.date >= '2026-04-13').toBe(true)
      expect(r.date <= '2026-04-17').toBe(true)
    }
  })

  it('returns empty arrays when no matching records', () => {
    const result = splitWeek([], '2026-04-13', '2026-04-17', '2026-04-06', '2026-04-12')
    expect(result.last.length).toBe(0)
    expect(result.curr.length).toBe(0)
  })
})

describe('whoop/summary — null fallback logic', () => {
  // Replicate the fallback selection logic from routes/whoop.js GET /summary
  function getEffectiveRecord(
    today: { [key: string]: unknown } | null,
    scoreField: string,
    fallback: { [key: string]: unknown } | null
  ): { data: { [key: string]: unknown } | null; isFallback: boolean } {
    if (today && today[scoreField] !== null && today[scoreField] !== undefined) {
      return { data: today, isFallback: false }
    }
    return { data: fallback, isFallback: fallback !== null }
  }

  it('uses today data when recovery_score is present', () => {
    const today = { date: '2026-05-01', recovery_score: 78, hrv_rmssd: 62 }
    const fallback = { date: '2026-04-30', recovery_score: 70, hrv_rmssd: 55 }
    const result = getEffectiveRecord(today, 'recovery_score', fallback)
    expect(result.data!.recovery_score).toBe(78)
    expect(result.isFallback).toBe(false)
  })

  it('uses fallback record when today recovery_score is null (PENDING_SLEEP)', () => {
    const today = { date: '2026-05-01', recovery_score: null }
    const fallback = { date: '2026-04-30', recovery_score: 78, hrv_rmssd: 62 }
    const result = getEffectiveRecord(today, 'recovery_score', fallback)
    expect(result.data!.recovery_score).toBe(78)
    expect(result.isFallback).toBe(true)
  })

  it('returns null when both today and fallback are unavailable', () => {
    const result = getEffectiveRecord(null, 'recovery_score', null)
    expect(result.data).toBeNull()
    expect(result.isFallback).toBe(false)
  })
})

describe('toDateStr — date formatting', () => {
  it('formats date as YYYY-MM-DD', () => {
    const d = new Date('2026-04-17T00:00:00')
    expect(toDateStr(d)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('zero-pads month and day', () => {
    const d = new Date(2026, 0, 5) // Jan 5
    expect(toDateStr(d)).toBe('2026-01-05')
  })
})
