const { pickStrengthWhoop, attachWhoop } = require('../../lib/whoop-link')

describe('#1692 п.4 whoop link', () => {
  it('picks the real functional-fitness workout, ignores short tennis', () => {
    const m = pickStrengthWhoop([
      { sport_name: 'tennis', duration_min: 30, strain: 4 },
      { sport_name: 'functional-fitness', duration_min: 62, strain: 9.1 },
    ])
    expect(m.sport_name).toBe('functional-fitness')
    expect(pickStrengthWhoop([{ sport_name: 'tennis', duration_min: 90, strain: 8 }])).toBeNull()
  })
  it('attaches duration/strain/kcal/recovery without overwriting own duration', async () => {
    const data: any = {
      whoop_workouts: [{ date: '2026-10-01', sport_name: 'functional-fitness', duration_min: 60, strain: 8, calories_burned: 400 }],
      whoop_recovery: [{ date: '2026-10-01', recovery_score: 54 }],
    }
    const db = { collection: (n: string) => ({ find: () => ({ toArray: async () => data[n] }) }) }
    const out = await attachWhoop(db, [{ date: '2026-10-01', name: 'Тренування (лог)' }, { date: '2026-09-01' }])
    expect(out[0].duration_min).toBe(60)
    expect(out[0].whoop).toMatchObject({ strain: 8, calories_burned: 400, recovery_score: 54 })
    expect(out[1].whoop).toBeUndefined()
  })
})
export {}
