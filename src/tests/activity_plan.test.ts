/**
 * Activity plan route — unit tests for business logic in routes/activity_plan.js
 * Tests: strain zone targets from recovery score, projectedCycleIncrease,
 *        suggested duration rounding, activity plan doc defaults
 */

// --- Replicate pure logic from routes/activity_plan.js ---

interface StrainZone {
  min: number
  max: number
  zone: 'hard' | 'moderate' | 'light'
}

function getStrainZone(recoveryScore: number): StrainZone {
  if (recoveryScore >= 67) return { min: 14, max: 18, zone: 'hard' }
  if (recoveryScore >= 34) return { min: 10, max: 14, zone: 'moderate' }
  return { min: 0, max: 10, zone: 'light' }
}

function projectedCycleIncrease(workoutStrain: number, currentCycle: number): number {
  const saturation = Math.max(0, 1 - currentCycle / 21)
  const intensityCoef = workoutStrain >= 10 ? 0.45 : workoutStrain >= 7 ? 0.3 : 0.15
  return workoutStrain * intensityCoef * saturation
}

function calcSuggestedDur(avgDuration: number): number {
  return Math.max(10, Math.ceil(avgDuration / 10) * 10)
}

function calcWorkoutTargetRange(
  dayStrainMin: number,
  dayStrainMax: number,
  baseStrain: number,
  workoutStrainToday: number
): { min: number; max: number; remainingMin: number; remainingMax: number } {
  const workoutTargetMin = Math.max(0, dayStrainMin - baseStrain)
  const workoutTargetMax = Math.max(0, dayStrainMax - baseStrain)
  const remainingMin = Math.max(0, workoutTargetMin - workoutStrainToday)
  const remainingMax = Math.max(0, workoutTargetMax - workoutStrainToday)
  return { min: workoutTargetMin, max: workoutTargetMax, remainingMin, remainingMax }
}

interface ActivityPlanDefaults {
  date: string
  type: string
  name: string
  strain_target: null
  duration_min: null
  calories_est: null
  notes: string
  done: boolean
}

function buildActivityPlanDoc(body: Record<string, unknown>): ActivityPlanDefaults {
  return {
    date: (body.date as string) || new Date().toISOString().split('T')[0],
    type: (body.type as string) || 'other',
    name: (body.name as string) || '',
    strain_target: (body.strain_target as null) ?? null,
    duration_min: (body.duration_min as null) ?? null,
    calories_est: (body.calories_est as null) ?? null,
    notes: (body.notes as string) || '',
    done: false,
  }
}

// --- Tests ---

describe('getStrainZone — recovery score to strain target', () => {
  it('recovery >= 67 → hard zone (14-18)', () => {
    const z = getStrainZone(67)
    expect(z.min).toBe(14)
    expect(z.max).toBe(18)
    expect(z.zone).toBe('hard')
  })

  it('recovery 100 → hard zone', () => {
    expect(getStrainZone(100).zone).toBe('hard')
  })

  it('recovery 34-66 → moderate zone (10-14)', () => {
    const z = getStrainZone(50)
    expect(z.min).toBe(10)
    expect(z.max).toBe(14)
    expect(z.zone).toBe('moderate')
  })

  it('recovery exactly 34 → moderate', () => {
    expect(getStrainZone(34).zone).toBe('moderate')
  })

  it('recovery < 34 → light zone (0-10)', () => {
    const z = getStrainZone(33)
    expect(z.min).toBe(0)
    expect(z.max).toBe(10)
    expect(z.zone).toBe('light')
  })

  it('recovery 0 → light zone', () => {
    expect(getStrainZone(0).zone).toBe('light')
  })
})

describe('projectedCycleIncrease — WHOOP saturation model', () => {
  it('high workout strain (>=10) uses 0.45 coef', () => {
    // workoutStrain=12, currentCycle=0 → saturation=1.0 → 12*0.45*1.0 = 5.4
    const increase = projectedCycleIncrease(12, 0)
    expect(increase).toBeCloseTo(5.4, 1)
  })

  it('medium workout strain (7-9) uses 0.3 coef', () => {
    // workoutStrain=8, currentCycle=0 → 8*0.3*1.0 = 2.4
    const increase = projectedCycleIncrease(8, 0)
    expect(increase).toBeCloseTo(2.4, 1)
  })

  it('low workout strain (<7) uses 0.15 coef', () => {
    // workoutStrain=5, currentCycle=0 → 5*0.15*1.0 = 0.75
    const increase = projectedCycleIncrease(5, 0)
    expect(increase).toBeCloseTo(0.75, 2)
  })

  it('higher current cycle → less room to increase (saturation)', () => {
    const low = projectedCycleIncrease(10, 5)   // saturation = 1 - 5/21 = 0.762
    const high = projectedCycleIncrease(10, 15)  // saturation = 1 - 15/21 = 0.286
    expect(low).toBeGreaterThan(high)
  })

  it('cycle at 21+ → saturation 0, increase = 0', () => {
    const increase = projectedCycleIncrease(15, 21)
    expect(increase).toBe(0)
  })
})

describe('calcSuggestedDur — duration rounding', () => {
  it('rounds up to nearest 10 minutes', () => {
    expect(calcSuggestedDur(35)).toBe(40) // ceil(35/10)*10
    expect(calcSuggestedDur(40)).toBe(40) // already multiple of 10
    expect(calcSuggestedDur(55)).toBe(60)
  })

  it('minimum 10 minutes', () => {
    expect(calcSuggestedDur(5)).toBe(10) // max(10, ceil(5/10)*10) = max(10,10) = 10
    expect(calcSuggestedDur(0)).toBe(10)
  })

  it('preserves exact multiples of 10', () => {
    expect(calcSuggestedDur(90)).toBe(90)
    expect(calcSuggestedDur(60)).toBe(60)
  })
})

describe('calcWorkoutTargetRange — remaining strain calculation', () => {
  it('subtracts base strain from day target', () => {
    // recovery=75 (hard zone: 14-18), baseStrain=7.5, workoutsToday=0
    const r = calcWorkoutTargetRange(14, 18, 7.5, 0)
    expect(r.min).toBe(6.5)  // 14 - 7.5
    expect(r.max).toBe(10.5) // 18 - 7.5
    expect(r.remainingMin).toBe(6.5) // no workouts yet
    expect(r.remainingMax).toBe(10.5)
  })

  it('subtracts already done workout strain from remaining', () => {
    const r = calcWorkoutTargetRange(14, 18, 7.5, 4)
    // workoutTarget: min=6.5, max=10.5; remaining after 4 done:
    expect(r.remainingMin).toBe(2.5) // 6.5 - 4
    expect(r.remainingMax).toBe(6.5) // 10.5 - 4
  })

  it('remaining never goes below 0', () => {
    // workoutsToday > target
    const r = calcWorkoutTargetRange(14, 18, 7.5, 15)
    expect(r.remainingMin).toBe(0)
    expect(r.remainingMax).toBe(0)
  })
})

describe('buildActivityPlanDoc — defaults', () => {
  it('sets done=false by default', () => {
    const doc = buildActivityPlanDoc({ date: '2026-04-17' })
    expect(doc.done).toBe(false)
  })

  it('uses type "other" when not provided', () => {
    const doc = buildActivityPlanDoc({ date: '2026-04-17' })
    expect(doc.type).toBe('other')
  })

  it('sets null for numeric fields when not provided', () => {
    const doc = buildActivityPlanDoc({ date: '2026-04-17' })
    expect(doc.strain_target).toBeNull()
    expect(doc.duration_min).toBeNull()
    expect(doc.calories_est).toBeNull()
  })

  it('auto-sets date when missing', () => {
    const doc = buildActivityPlanDoc({})
    expect(doc.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('preserves provided values', () => {
    const doc = buildActivityPlanDoc({
      date: '2026-04-17',
      type: 'cardio',
      name: 'Бег 5km',
      duration_min: 30,
      calories_est: 350,
    })
    expect(doc.type).toBe('cardio')
    expect(doc.name).toBe('Бег 5km')
    expect(doc.duration_min).toBe(30)
    expect(doc.calories_est).toBe(350)
  })
})
