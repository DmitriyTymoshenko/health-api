/**
 * Weight analysis — unit tests for business logic in routes/weight.js
 *
 * NOTE: routes/weight.js has a known bug in status calculation:
 *   actual comparisons use `<` where `>` is needed for negative planned values.
 *   Result: 'on_track' is unreachable, 'too_fast' fires for slow/no loss.
 *   Bug report: DSG-67. Tests below cover plateau + insufficient_data which
 *   work correctly, plus the plateau detection logic.
 */

// --- Replicate weight analysis logic from routes/weight.js ---

interface WeightEntry {
  date: string
  weight_kg: number
}

type AnalysisResult =
  | { status: 'insufficient_data'; message?: string }
  | {
      status: string
      actual_per_week: number
      planned_per_week: number
      plateau: boolean
      days_analyzed: number
    }

function analyzeWeightTrend(
  entries: WeightEntry[],
  todayEntry: WeightEntry | null,
  deficitGoal: number = 500
): AnalysisResult {
  if (entries.length < 2) return { status: 'insufficient_data' }

  const latest = todayEntry || entries[0]

  const oldest7 = entries.find(e => {
    const diff = (new Date(latest.date).getTime() - new Date(e.date).getTime()) / 86400000
    return diff >= 6
  }) || entries[entries.length - 1]

  const daysDiff = Math.round(
    (new Date(latest.date).getTime() - new Date(oldest7.date).getTime()) / 86400000
  ) || 1

  if (daysDiff < 4) return { status: 'insufficient_data', message: `Only ${daysDiff} days` }

  const actualChange = parseFloat((latest.weight_kg - oldest7.weight_kg).toFixed(1))
  const actualPerWeek = parseFloat((actualChange / daysDiff * 7).toFixed(2))
  const plannedPerWeek = parseFloat(((deficitGoal * 7) / 7700).toFixed(2)) * -1

  const last5 = entries.slice(0, 5)
  const plateau =
    last5.length >= 5 &&
    Math.abs(last5[0].weight_kg - last5[4].weight_kg) < 0.2

  let status: string
  if (plateau) {
    status = 'plateau'
  } else if (actualPerWeek < plannedPerWeek * 0.3) {
    status = 'behind'
  } else if (actualPerWeek < plannedPerWeek * 1.3) {
    status = 'on_track'
  } else {
    status = 'too_fast'
  }

  return {
    status,
    actual_per_week: actualPerWeek,
    planned_per_week: plannedPerWeek,
    plateau,
    days_analyzed: daysDiff,
  }
}

// --- Tests ---

describe('analyzeWeightTrend — insufficient data', () => {
  it('returns insufficient_data for empty entries', () => {
    const result = analyzeWeightTrend([], null)
    expect(result.status).toBe('insufficient_data')
  })

  it('returns insufficient_data for single entry', () => {
    const result = analyzeWeightTrend([{ date: '2026-04-01', weight_kg: 90 }], null)
    expect(result.status).toBe('insufficient_data')
  })

  it('returns insufficient_data when span is only 3 days', () => {
    const entries: WeightEntry[] = [
      { date: '2026-04-03', weight_kg: 89.8 },
      { date: '2026-04-02', weight_kg: 90.0 },
      { date: '2026-04-01', weight_kg: 90.1 },
    ]
    const result = analyzeWeightTrend(entries, null)
    expect(result.status).toBe('insufficient_data')
  })

  it('proceeds normally when span is >= 4 days', () => {
    const entries: WeightEntry[] = [
      { date: '2026-04-10', weight_kg: 89.5 },
      { date: '2026-04-09', weight_kg: 89.7 },
      { date: '2026-04-04', weight_kg: 90.0 }, // 6 days from latest → oldest7
    ]
    const result = analyzeWeightTrend(entries, null)
    expect(result.status).not.toBe('insufficient_data')
  })
})

describe('analyzeWeightTrend — plateau detection', () => {
  it('detects plateau when last 5 entries differ by <0.2kg (first vs last)', () => {
    const entries: WeightEntry[] = [
      { date: '2026-04-10', weight_kg: 90.05 },
      { date: '2026-04-09', weight_kg: 90.10 },
      { date: '2026-04-08', weight_kg: 89.95 },
      { date: '2026-04-07', weight_kg: 90.08 },
      { date: '2026-04-06', weight_kg: 90.02 }, // |90.05 - 90.02| = 0.03 < 0.2 → plateau
      { date: '2026-04-01', weight_kg: 91.0 },  // needed for 6+ day span
    ]
    const result = analyzeWeightTrend(entries, null) as { status: string; plateau: boolean }
    expect(result.status).toBe('plateau')
    expect(result.plateau).toBe(true)
  })

  it('does NOT detect plateau when first vs last of 5 differ by >=0.2kg', () => {
    const entries: WeightEntry[] = [
      { date: '2026-04-10', weight_kg: 90.0 },
      { date: '2026-04-09', weight_kg: 90.4 },
      { date: '2026-04-08', weight_kg: 90.2 },
      { date: '2026-04-07', weight_kg: 90.6 },
      { date: '2026-04-06', weight_kg: 90.3 }, // |90.0 - 90.3| = 0.3 >= 0.2 → no plateau
      { date: '2026-04-01', weight_kg: 91.0 },
    ]
    const result = analyzeWeightTrend(entries, null) as { status: string; plateau: boolean }
    expect(result.status).not.toBe('plateau')
    expect(result.plateau).toBe(false)
  })

  it('does NOT detect plateau with fewer than 5 entries', () => {
    const entries: WeightEntry[] = [
      { date: '2026-04-10', weight_kg: 90.0 },
      { date: '2026-04-09', weight_kg: 90.1 },
      { date: '2026-04-08', weight_kg: 90.05 },
      { date: '2026-04-01', weight_kg: 91.0 }, // only 4 entries in last5
    ]
    const result = analyzeWeightTrend(entries, null) as { status: string; plateau: boolean }
    expect(result.plateau).toBe(false)
  })
})

describe('analyzeWeightTrend — todayEntry override', () => {
  it('uses todayEntry as latest when provided', () => {
    const entries: WeightEntry[] = [
      { date: '2026-04-09', weight_kg: 90.5 },
      { date: '2026-04-08', weight_kg: 90.7 },
      { date: '2026-04-04', weight_kg: 91.2 }, // 6 days from todayEntry
    ]
    const todayEntry: WeightEntry = { date: '2026-04-10', weight_kg: 89.8 }
    const result = analyzeWeightTrend(entries, todayEntry)
    // With todayEntry: latest = 89.8 (2026-04-10), span from 2026-04-04 = 6 days
    expect(result.status).not.toBe('insufficient_data')
    const r = result as { actual_per_week: number }
    // actualChange = 89.8 - 91.2 = -1.4 (losing weight with todayEntry)
    expect(r.actual_per_week).toBeLessThan(0)
  })

  it('falls back to entries[0] when todayEntry is null', () => {
    const entries: WeightEntry[] = [
      { date: '2026-04-09', weight_kg: 90.0 },
      { date: '2026-04-08', weight_kg: 90.2 },
      { date: '2026-04-03', weight_kg: 91.0 }, // 6 days from entries[0]
    ]
    const result = analyzeWeightTrend(entries, null)
    expect(result.status).not.toBe('insufficient_data')
  })
})

describe('analyzeWeightTrend — planned_per_week is always negative', () => {
  it('plannedPerWeek = -(deficit * 7 / 7700)', () => {
    const entries: WeightEntry[] = [
      { date: '2026-04-10', weight_kg: 89.5 },
      { date: '2026-04-09', weight_kg: 89.7 },
      { date: '2026-04-04', weight_kg: 90.0 },
    ]
    const result = analyzeWeightTrend(entries, null, 500) as { planned_per_week: number }
    // -(500 * 7 / 7700) = -0.45
    expect(result.planned_per_week).toBeCloseTo(-0.45, 1)
    expect(result.planned_per_week).toBeLessThan(0)
  })

  it('higher deficit = faster planned loss', () => {
    const entries: WeightEntry[] = [
      { date: '2026-04-10', weight_kg: 89.5 },
      { date: '2026-04-04', weight_kg: 90.0 },
    ]
    const r500 = analyzeWeightTrend(entries, null, 500) as { planned_per_week: number }
    const r1000 = analyzeWeightTrend(entries, null, 1000) as { planned_per_week: number }
    expect(r1000.planned_per_week).toBeLessThan(r500.planned_per_week)
  })
})
