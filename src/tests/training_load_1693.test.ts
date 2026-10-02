// #1693 Е1 — sets/week per muscle group, frequency, deload, load vs recovery
export {}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const trainingLoadRoute = require('../../routes/training_load')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isoWeekNumber, isDeloadWeek, buildWeeklySets, buildLoadRecovery } = require('../../lib/training-load')

const LIB = [
  { name: 'Жим лежачи', muscle_group: 'chest' },
  { name: 'Підтягування', muscle_group: 'back' },
  { name: 'Присідання', muscle_group: 'legs' },
]
const libByName = new Map(LIB.map((e) => [e.name.toLowerCase(), e]))
const ORDER = ['chest', 'back', 'shoulders', 'legs', 'biceps', 'triceps', 'core', 'forearms', 'neck', 'other']
const sets = (n: number, reps = 10) => Array.from({ length: n }, () => ({ reps, weight_kg: 50 }))

describe('training-load lib', () => {
  it('ISO week + deload every 4th week', () => {
    expect(isoWeekNumber('2026-09-28')).toBe(40)
    expect(isDeloadWeek('2026-09-28')).toBe(true) // 40 % 4 === 0
    expect(isDeloadWeek('2026-09-21')).toBe(false)
  })

  it('counts working sets (warm-ups excluded), zero legs warning on a finished week', () => {
    const workouts = [
      { date: '2026-09-22', exercises: [{ name: 'Жим лежачи', sets: [...sets(4), { reps: 10, warmup: true }] }] },
      { date: '2026-09-24', exercises: [{ name: 'Підтягування', sets: sets(3) }] },
    ]
    const r = buildWeeklySets({ workouts90: workouts, libraryByName: libByName, today: '2026-09-27', muscleOrder: ORDER })
    const chest = r.groups.find((g: any) => g.muscle_group === 'chest')
    const legs = r.groups.find((g: any) => g.muscle_group === 'legs')
    expect(chest.sets).toBe(4)
    expect(chest.frequency).toBe(1)
    expect(chest.status).toBe('low')
    expect(legs.sets).toBe(0)
    expect(legs.status).toBe('zero')
    expect(r.warnings.some((w: any) => w.muscle_group === 'legs' && w.kind === 'zero')).toBe(true)
    expect(r.deload.active).toBe(false)
    expect(r.week.complete).toBe(true)
  })

  it('unfinished week early on is pending, not a warning; compares with the SAME span of last week', () => {
    const workouts = [
      { date: '2026-09-21', exercises: [{ name: 'Жим лежачи', sets: sets(5) }] }, // prev Mon
      { date: '2026-09-25', exercises: [{ name: 'Жим лежачи', sets: sets(7) }] }, // prev Fri (outside span)
      { date: '2026-09-28', exercises: [{ name: 'Жим лежачи', sets: sets(3) }] },
    ]
    const r = buildWeeklySets({ workouts90: workouts, libraryByName: libByName, today: '2026-09-29', muscleOrder: ORDER })
    const chest = r.groups.find((g: any) => g.muscle_group === 'chest')
    expect(r.week.complete).toBe(false)
    expect(r.week.elapsed_days).toBe(2)
    expect(chest.status).toBe('pending')
    expect(chest.prev_sets_same_span).toBe(5) // Mon-Tue only
    expect(chest.prev_sets_full_week).toBe(12)
    expect(r.warnings).toHaveLength(0)
  })

  it('deload week lowers targets by 40%', () => {
    const r = buildWeeklySets({ workouts90: [], libraryByName: libByName, today: '2026-10-04', muscleOrder: ORDER })
    expect(r.deload.active).toBe(true)
    const chest = r.groups.find((g: any) => g.muscle_group === 'chest')
    expect(chest.target).toEqual({ min: 6, max: 12, base_min: 10, base_max: 20 })
  })

  it('load/recovery: Z2/Z3+ minutes per week, rest days, recovery 7 vs 28', () => {
    const w = (date: string, z2: number, z3: number) => ({
      date, sport_name: 'functional-fitness', duration_min: 45, score_state: 'SCORED',
      zone_two_ms: z2 * 60000, zone_three_ms: z3 * 60000, zone_four_ms: 0, zone_five_ms: 0,
    })
    const r = buildLoadRecovery({
      today: '2026-10-02',
      whoopWorkouts90: [w('2026-10-01', 90, 0), w('2026-09-30', 0, 90)],
      recovery28: [
        { date: '2026-10-02', recovery_score: 60 },
        { date: '2026-09-10', recovery_score: 40 },
      ],
      workouts90: [{ date: '2026-10-01', exercises: [{ name: 'x', sets: sets(1) }] }],
    })
    expect(r.cardio_zones_per_week.z2_min).toBe(7) // 90 / (90/7) = 7
    expect(r.cardio_zones_per_week.z3plus_min).toBe(7)
    expect(r.strength.whoop_sessions_90d).toBe(2)
    expect(r.strength.logged_sessions_90d).toBe(1)
    expect(r.strength.unlogged_gap_90d).toBe(1)
    expect(r.last_7d.rest_days).toBe(5) // active: 30.09, 01.10
    expect(r.last_7d.avg_recovery).toBe(60)
    expect(r.last_28d.avg_recovery).toBe(50)
    expect(r.recovery_trend).toBe(10)
  })
})

const PROGRAM = {
  name: 'P', periodization: { wave_weeks: 4, phases: ['База', 'Білд', 'Пік', 'Deload'], start_date: '2026-09-09' },
  schedule: { A: [1], B: [3] },
  days: [
    { key: 'A', title: 'День A', exercises: [{ name: 'Жим лежачи' }, { name: 'Присідання' }] },
    { key: 'B', title: 'День B', exercises: [{ name: 'Підтягування' }] },
  ],
}

function makeApp() {
  const data: Record<string, any[]> = {
    workouts: [{ date: '2026-09-30', exercises: [{ name: 'Жим лежачи', sets: sets(4) }] }],
    whoop_workouts: [],
    whoop_recovery: [{ date: '2026-10-02', recovery_score: 55 }],
    exercises_library: LIB,
  }
  const db = {
    collection: (n: string) => ({
      find: (f: any) => ({ sort() { return this }, toArray: async () => (data[n] || []).filter((x: any) => !f?.date?.$gte || x.date >= f.date.$gte) }),
      findOne: async () => (n === 'training_programs' ? PROGRAM : null),
    }),
  }
  const app = express()
  app.use('/api/workouts', trainingLoadRoute(() => db))
  return app
}

describe('GET /api/workouts/training-load', () => {
  it('returns weekly sets + load_recovery', async () => {
    const res = await request(makeApp()).get('/api/workouts/training-load?date=2026-10-02')
    expect(res.status).toBe(200)
    expect(res.body.week.from).toBe('2026-09-28')
    expect(res.body.groups.find((g: any) => g.muscle_group === 'chest').sets).toBe(4)
    expect(res.body.load_recovery.last_7d.avg_recovery).toBe(55)
  })
  it('adds PR feed + program adherence + program-driven deload', async () => {
    const res = await request(makeApp()).get('/api/workouts/training-load?date=2026-10-02')
    expect(res.body.deload.source).toBe('program')
    expect(res.body.deload.phase).toBe('Deload') // wave week 4 (30.09–06.10)
    expect(res.body.deload.active).toBe(true)
    expect(Array.isArray(res.body.prs)).toBe(true)
    const pa = res.body.program_adherence
    expect(pa.week_days.map((d: any) => d.weekday_label)).toEqual(['Пн', 'Ср'])
    expect(pa.week_days[0].status).toBe('missed') // Mon 28.09, nothing logged
    expect(pa.week_days[1].status).toBe('done') // Wed 30.09 logged
    expect(pa.week_days[1].exercises_done).toBe(0) // logged Жим лежачи is not in День B
    expect(pa.program_exercises_total).toBe(3)
  })
  it('400 on bad date', async () => {
    const res = await request(makeApp()).get('/api/workouts/training-load?date=nope')
    expect(res.status).toBe(400)
  })
})

describe('pr-feed + adherence lib', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildPrFeed } = require('../../lib/pr-feed')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildProgramAdherence } = require('../../lib/training-load')
  it('emits a PR only when a session beats the earlier best; first session is baseline', () => {
    const w = (date: string, weight: number, reps: number) => ({ date, exercises: [{ name: 'Жим лежачи', sets: [{ weight_kg: weight, reps }] }] })
    const feed = buildPrFeed([w('2026-09-01', 60, 8), w('2026-09-08', 60, 8), w('2026-09-15', 65, 8), w('2026-09-22', 62, 8)], { from: '2026-08-01' })
    expect(feed).toHaveLength(1)
    expect(feed[0]).toMatchObject({ date: '2026-09-15', exercise: 'Жим лежачи', kind: 'e1rm', weight_kg: 65 })
    expect(feed[0].previous).toBeLessThan(feed[0].value)
  })
  it('bodyweight exercise ranks by reps', () => {
    const w = (date: string, reps: number) => ({ date, exercises: [{ name: 'Підтягування', sets: [{ reps }] }] })
    const feed = buildPrFeed([w('2026-09-01', 5), w('2026-09-08', 7)], {})
    expect(feed[0]).toMatchObject({ kind: 'reps', value: 7, previous: 5 })
  })
  it('proposes a schedule on real weekdays (Tue/Thu) only as a suggestion', () => {
    const mk = (date: string) => ({ date, exercises: [{ name: 'Жим лежачи', sets: [{ reps: 8, weight_kg: 50 }] }] })
    const r = buildProgramAdherence({
      program: { ...PROGRAM, schedule: { A: [1], B: [3] } },
      workouts90: [mk('2026-09-22'), mk('2026-09-24'), mk('2026-09-29'), mk('2026-10-01')], // Tue, Thu, Tue, Thu
      whoopWorkouts90: [], today: '2026-10-02', weekFrom: '2026-09-28', weekTo: '2026-10-04',
    })
    expect(r.schedule_proposal.weekdays.map((d: any) => d.label)).toEqual(['Вт', 'Чт'])
    expect(r.sessions_on_schedule_90d).toBe(0)
    expect(r.unscheduled_sessions).toEqual(['2026-09-29', '2026-10-01'])
  })
})
