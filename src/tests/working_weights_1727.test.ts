// #1727 п.2 — «робочі ваги в часі»
export {}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildWorkingWeights } = require('../../lib/working-weights')

const w = (date: string, name: string, sets: any[]) => ({ date, exercises: [{ name, sets }] })

describe('buildWorkingWeights', () => {
  it('takes the heaviest working set per session, skips warm-ups, orders by date', () => {
    const r = buildWorkingWeights([
      w('2026-09-20', 'Жим', [{ weight_kg: 40, reps: 10, warmup: true }, { weight_kg: 60, reps: 8 }]),
      w('2026-09-27', 'Жим', [{ weight_kg: 65, reps: 8 }, { weight_kg: 62.5, reps: 10 }]),
    ])
    expect(r).toHaveLength(1)
    expect(r[0].series.map((p: any) => p.weight_kg)).toEqual([60, 65])
    expect(r[0].delta_kg).toBe(5)
    expect(r[0].max_kg).toBe(65)
  })
  it('drops bodyweight/time exercises and single-session exercises', () => {
    const r = buildWorkingWeights([
      w('2026-09-20', 'Планка', [{ duration_sec: 60, weight_kg: null }]),
      w('2026-09-27', 'Планка', [{ duration_sec: 70, weight_kg: null }]),
      w('2026-09-27', 'Присід', [{ weight_kg: 80, reps: 5 }]),
    ])
    expect(r).toEqual([])
  })
  it('respects from-window and tolerates junk docs', () => {
    const r = buildWorkingWeights([
      null, { date: '2026-01-01' }, { exercises: [] },
      w('2026-01-01', 'Жим', [{ weight_kg: 50, reps: 5 }]),
      w('2026-09-20', 'Жим', [{ weight_kg: 60, reps: 5 }]),
    ], { from: '2026-09-01' })
    expect(r).toEqual([])
  })
})

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveWeightGoal } = require('../../lib/targets-resolver')
describe('resolveWeightGoal — #1727 no phantom deadline for recomp', () => {
  it('recomp + null date → null date (no default 2026-10-15)', () => {
    expect(resolveWeightGoal({ primary_goal: 'recomp', weight_goal_kg: 92, weight_goal_date: null }).weight_goal_date).toBeNull()
  })
  it('weight_loss + null date keeps the legacy default; explicit date always wins', () => {
    expect(resolveWeightGoal({ primary_goal: 'weight_loss', weight_goal_date: null }).weight_goal_date).toBe('2026-10-15')
    expect(resolveWeightGoal({ primary_goal: 'recomp', weight_goal_date: '2026-12-01' }).weight_goal_date).toBe('2026-12-01')
  })
})
