/**
 * Streak calculation — unit tests for calcStreak logic in routes/goals.js
 */

// Replicate calcStreak logic from goals.js
function calcStreak(days: string[], checkFn: (day: string) => boolean): { current: number; best: number } {
  let current = 0
  let best = 0
  let counting = true

  for (const day of days) {
    if (checkFn(day)) {
      if (counting) current++
      best = Math.max(best, counting ? current : 0)
    } else {
      if (counting && current > 0) {
        best = Math.max(best, current)
      }
      counting = false
    }
  }

  // Recalculate best by scanning all consecutive runs
  let run = 0
  for (const day of days.slice().reverse()) {
    if (checkFn(day)) {
      run++
      best = Math.max(best, run)
    } else {
      run = 0
    }
  }

  return { current, best }
}

// Helper: generate days array from most recent to oldest (like goals.js)
function generateDays(count: number, fromDate: string): string[] {
  const days: string[] = []
  const base = new Date(fromDate)
  for (let i = 0; i < count; i++) {
    const d = new Date(base)
    d.setDate(d.getDate() - i)
    days.push(d.toISOString().split('T')[0])
  }
  return days
}

describe('calcStreak — basic behavior', () => {
  const days = generateDays(7, '2026-04-10')
  // days = ['2026-04-10', '2026-04-09', ..., '2026-04-04']

  it('current=0, best=0 when nothing met', () => {
    const result = calcStreak(days, () => false)
    expect(result.current).toBe(0)
    expect(result.best).toBe(0)
  })

  it('current=7, best=7 when all days met', () => {
    const result = calcStreak(days, () => true)
    expect(result.current).toBe(7)
    expect(result.best).toBe(7)
  })

  it('current=0 when streak broken today (first day fails)', () => {
    const met = new Set(['2026-04-09', '2026-04-08', '2026-04-07'])
    const result = calcStreak(days, d => met.has(d))
    expect(result.current).toBe(0)
    expect(result.best).toBe(3)
  })

  it('current streak counts consecutive from today', () => {
    const met = new Set(['2026-04-10', '2026-04-09', '2026-04-08'])
    const result = calcStreak(days, d => met.has(d))
    expect(result.current).toBe(3)
    expect(result.best).toBe(3)
  })
})

describe('calcStreak — best streak', () => {
  it('finds best streak even if not current', () => {
    const days = generateDays(10, '2026-04-10')
    // Meet 5 days in a row starting from Apr 6
    const met = new Set(['2026-04-06', '2026-04-05', '2026-04-04', '2026-04-03', '2026-04-02'])
    const result = calcStreak(days, d => met.has(d))
    expect(result.current).toBe(0)
    expect(result.best).toBe(5)
  })

  it('best=1 when only isolated days met', () => {
    const days = generateDays(6, '2026-04-10')
    const met = new Set(['2026-04-10', '2026-04-08', '2026-04-06'])
    const result = calcStreak(days, d => met.has(d))
    expect(result.best).toBe(1)
  })
})

describe('calcStreak — edge cases', () => {
  it('returns 0/0 for empty days array', () => {
    const result = calcStreak([], () => true)
    expect(result.current).toBe(0)
    expect(result.best).toBe(0)
  })

  it('handles single day met', () => {
    const days = ['2026-04-10']
    const result = calcStreak(days, () => true)
    expect(result.current).toBe(1)
    expect(result.best).toBe(1)
  })

  it('handles single day not met', () => {
    const days = ['2026-04-10']
    const result = calcStreak(days, () => false)
    expect(result.current).toBe(0)
    expect(result.best).toBe(0)
  })
})
