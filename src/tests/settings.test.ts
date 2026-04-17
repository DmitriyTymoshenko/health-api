/**
 * Settings route — unit tests for business logic in routes/settings.js
 * Tests: DEFAULT_SETTINGS structure, weight_milestones, avg TDEE calculation,
 *        deficit_goal impact on weight loss projection
 */

// --- Replicate pure logic from routes/settings.js ---

const DEFAULT_SETTINGS = {
  key: 'default',
  daily_deficit_goal: 500,
  weight_start: 102.5,
  weight_goal_near: 100,
  weight_milestones: [
    { date: '2026-03-31', target: 101.5, label: 'Березень' },
    { date: '2026-04-30', target: 99.5,  label: 'Квітень' },
    { date: '2026-05-31', target: 97.5,  label: 'Травень' },
    { date: '2026-06-30', target: 95.0,  label: 'Червень 🎯' },
    { date: '2026-09-30', target: 92.5,  label: 'Вересень' },
    { date: '2026-12-31', target: 90.0,  label: 'Грудень 🏆' },
  ],
  name: 'Дмитро',
  height_cm: 186,
  birth_year: 1995,
}

function calcAvgTdee(values: number[]): number | null {
  if (!values.length) return null
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length)
}

// Projected weekly weight loss from caloric deficit: deficit*7 / 7700 kg/week
function projectedWeeklyLoss(deficitKcalPerDay: number): number {
  return Math.round((deficitKcalPerDay * 7 / 7700) * 100) / 100
}

// How many weeks to reach target weight from current
function weeksToTarget(currentWeight: number, targetWeight: number, weeklyLoss: number): number | null {
  if (weeklyLoss <= 0) return null
  const deficit = currentWeight - targetWeight
  if (deficit <= 0) return 0
  return Math.ceil(deficit / weeklyLoss)
}

// --- Tests ---

describe('DEFAULT_SETTINGS — structure validation', () => {
  it('has required keys', () => {
    expect(DEFAULT_SETTINGS).toHaveProperty('daily_deficit_goal')
    expect(DEFAULT_SETTINGS).toHaveProperty('weight_start')
    expect(DEFAULT_SETTINGS).toHaveProperty('weight_goal_near')
    expect(DEFAULT_SETTINGS).toHaveProperty('weight_milestones')
    expect(DEFAULT_SETTINGS).toHaveProperty('height_cm')
    expect(DEFAULT_SETTINGS).toHaveProperty('birth_year')
  })

  it('default deficit is 500 kcal/day', () => {
    expect(DEFAULT_SETTINGS.daily_deficit_goal).toBe(500)
  })

  it('height is realistic', () => {
    expect(DEFAULT_SETTINGS.height_cm).toBe(186)
    expect(DEFAULT_SETTINGS.height_cm).toBeGreaterThan(150)
    expect(DEFAULT_SETTINGS.height_cm).toBeLessThan(220)
  })

  it('weight milestones are sorted by date ascending', () => {
    const ms = DEFAULT_SETTINGS.weight_milestones
    for (let i = 1; i < ms.length; i++) {
      expect(ms[i].date > ms[i-1].date).toBe(true)
    }
  })

  it('weight milestones are decreasing (losing weight)', () => {
    const ms = DEFAULT_SETTINGS.weight_milestones
    for (let i = 1; i < ms.length; i++) {
      expect(ms[i].target).toBeLessThan(ms[i-1].target)
    }
  })

  it('final milestone target < weight_start', () => {
    const finalTarget = DEFAULT_SETTINGS.weight_milestones[DEFAULT_SETTINGS.weight_milestones.length - 1].target
    expect(finalTarget).toBeLessThan(DEFAULT_SETTINGS.weight_start)
  })
})

describe('calcAvgTdee — average TDEE calculation', () => {
  it('calculates average correctly', () => {
    expect(calcAvgTdee([2800, 3000, 2900])).toBe(2900)
  })

  it('returns null for empty array', () => {
    expect(calcAvgTdee([])).toBeNull()
  })

  it('rounds to integer', () => {
    const result = calcAvgTdee([2800, 2850])
    expect(Number.isInteger(result!)).toBe(true)
    expect(result).toBe(2825)
  })

  it('handles single value', () => {
    expect(calcAvgTdee([3000])).toBe(3000)
  })
})

describe('projectedWeeklyLoss — from caloric deficit', () => {
  it('500 kcal/day deficit → ~0.45 kg/week', () => {
    // 500 * 7 / 7700 = 0.4545... ≈ 0.45
    expect(projectedWeeklyLoss(500)).toBe(0.45)
  })

  it('1000 kcal/day → ~0.91 kg/week', () => {
    expect(projectedWeeklyLoss(1000)).toBe(0.91)
  })

  it('higher deficit → faster loss', () => {
    expect(projectedWeeklyLoss(1000)).toBeGreaterThan(projectedWeeklyLoss(500))
  })

  it('0 deficit → 0 loss', () => {
    expect(projectedWeeklyLoss(0)).toBe(0)
  })
})

describe('weeksToTarget — goal timeline', () => {
  it('calculates weeks from current to target weight', () => {
    // 102.5 → 100.0 = 2.5 kg / 0.45 kg/week ≈ 6 weeks
    const weeks = weeksToTarget(102.5, 100.0, projectedWeeklyLoss(500))
    expect(weeks).toBeGreaterThan(5)
    expect(weeks).toBeLessThan(10)
  })

  it('returns 0 when already at target', () => {
    expect(weeksToTarget(90, 90, 0.45)).toBe(0)
  })

  it('returns 0 when below target', () => {
    expect(weeksToTarget(89, 90, 0.45)).toBe(0)
  })

  it('returns null when weeklyLoss is 0 or negative', () => {
    expect(weeksToTarget(100, 90, 0)).toBeNull()
    expect(weeksToTarget(100, 90, -0.5)).toBeNull()
  })
})
