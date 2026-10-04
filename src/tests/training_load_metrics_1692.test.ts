// @ts-nocheck
export {}
const express = require('express')
const request = require('supertest')
const route = require('../../routes/training_load')
const { assertKyivDayBounds } = require('./utils/kyivDayBounds')
const { buildPRs, deriveWorkoutMetrics } = require('../../lib/workout-metrics')
const w = (date, name, sets) => ({ date, exercises: [{ name, sets }] })
const set = (weight_kg, reps, extra = {}) => ({ weight_kg, reps, ...extra })

function fixture(workouts, library = [], weights = []) {
  const reads = []; const writes = jest.fn(() => { throw Error('read-only fixture') })
  const db = { collection(name) {
    const data = { workouts, exercises_library: library, weight_log: weights }[name] || []
    return {
      find(filter = {}) {
        reads.push({ name, filter })
        let rows = data.filter(d => (!filter.date?.$lte || d.date <= filter.date.$lte) &&
          (!filter.date?.$gte || d.date >= filter.date.$gte) && (!filter.name?.$in || filter.name.$in.includes(d.name)))
        return { sort(order) { if (order.date) rows = [...rows].sort((a,b) => a.date.localeCompare(b.date) * order.date); return this },
          limit(n) { rows = rows.slice(0,n); return this }, toArray: async () => rows }
      },
      findOne: async () => null, insertOne: writes, updateOne: writes, deleteOne: writes,
    }
  } }
  const app = express(); app.use('/api/workouts', route(() => db))
  return { db, reads, writes, get: async () => {
    const r = await request(app).get('/api/workouts/training-load?date=2026-10-04')
    expect(r.status).toBe(200); return r.body
  } }
}

describe('training-load canonical semantics #1692', () => {
  it.each(['machine', 'cable', undefined])('%s uses best set, not e1RM or heaviest set', async equipment => {
    const name = 'Розводка в тренажері'
    const docs = [w('2026-06-01',name,[set(80,10)]), w('2026-09-21',name,[set(100,8),set(93,10)])]
    const lib = [{ name, equipment }]; const f = fixture(docs,lib); const r = await f.get()
    const canonical = buildPRs(await deriveWorkoutMetrics(f.db,docs),lib)[name]
    expect(r.prs).toEqual([expect.objectContaining({ kind:'best_set', value:canonical.max_1rm.value, previous:800, weight_kg:93, reps:10 })])
  })
  it('free-weight e1RM uses all-history baseline and excludes warm-ups', async () => {
    const name='Жим лежачи'; const r=await fixture([
      w('2026-06-01',name,[set(60,10)]),w('2026-09-21',name,[set(65,10),set(200,10,{warmup:true})]),
    ],[{name,equipment:'barbell'}]).get()
    expect(r.prs[0]).toMatchObject({kind:'e1rm',previous:80,value:86.7,weight_kg:65})
  })
  it('duration has seconds PR and working-set count; cardio has no repetition/load PR or weight trend', async () => {
    const docs=['2026-09-28','2026-10-01'].flatMap((d,i)=>[
      w(d,'Планка (сек)',[set(94.4,60+i*10,{weight_source:'bodyweight'})]),
      w(d,'Timed hold',[{duration_seconds:30+i*10}]),
      w(d,'Mountain climbers',[set(94.4,30+i*10,{weight_source:'bodyweight'})]),
    ])
    const r=await fixture(docs,[{name:'Планка (сек)',muscle_group:'core'},{name:'Timed hold',muscle_group:'core'}]).get()
    expect(r.prs).toHaveLength(2)
    expect(r.prs.find(p=>p.exercise==='Планка (сек)')).toMatchObject({kind:'duration',value:70,previous:60,weight_kg:null})
    expect(r.prs.find(p=>p.exercise==='Timed hold')).toMatchObject({kind:'duration',value:40,previous:30})
    expect(r.working_weights).toEqual([])
    expect(r.groups.find(g=>g.muscle_group==='core').sets).toBe(4)
  })
  it('uses dated bodyweight exactly once, preserves raw history and all writes are forbidden', async () => {
    const name='Відтискання широкий хват'; const docs=[w('2026-09-15',name,[set(94.4,10,{weight_source:'bodyweight'})]),w('2026-09-21',name,[set(60.4,12,{weight_source:'bodyweight'})])]
    const before=JSON.stringify(docs)
    const f=fixture(docs,[{name,equipment:'dumbbell'}],[{date:'2026-09-11',weight_kg:94.4},{date:'2026-09-20',weight_kg:90},{date:'2026-10-02',weight_kg:100}])
    const r=await f.get()
    expect(r.prs[0]).toMatchObject({kind:'best_set',previous:604,value:691,weight_kg:57.6})
    expect(r.working_weights[0].series.map(p=>p.weight_kg)).toEqual([60.4,57.6])
    expect(r.working_weights[0].weight_source).toBe('bodyweight')
    expect(JSON.stringify(docs)).toBe(before); expect(f.writes).not.toHaveBeenCalled()
  })
  it('missing dated bodyweight stays unknown: reps-only record, no invented load trend', async () => {
    const name='Відтискання'; const r=await fixture([w('2026-09-15',name,[set(94.4,10,{weight_source:'bodyweight'})]),w('2026-09-21',name,[set(94.4,12,{weight_source:'bodyweight'})])],[],[{date:'2026-10-01',weight_kg:100}]).get()
    expect(r.prs[0]).toMatchObject({kind:'reps',value:12,weight_kg:null})
    expect(r.working_weights).toEqual([])
  })
  it('preserves dumbbell kg/lb-converted loads without guessing one vs pair; unresolved units are not kg', async () => {
    const name='Жим гантелей'; const unknown='Гантелі невідома одиниця'
    const docs=[w('2026-09-15',name,[set(20,10,{weight_input:20,weight_unit:'kg'})]),w('2026-09-21',name,[set(24.95,10,{weight_input:55,weight_unit:'lb'})]),w('2026-09-15',unknown,[set(null,10,{weight_input:50,weight_unit:null})]),w('2026-09-21',unknown,[set(null,10,{weight_input:60,weight_unit:null})])]
    const before=JSON.stringify(docs); const r=await fixture(docs,[{name,equipment:'dumbbell'},{name:unknown,equipment:'dumbbell'}]).get()
    expect(r.working_weights).toHaveLength(1)
    expect(r.working_weights[0]).toMatchObject({first_kg:20,last_kg:24.95,equipment:'dumbbell'})
    expect(r.prs[0]).toMatchObject({kind:'e1rm',weight_kg:24.95,equipment:'dumbbell'})
    expect(JSON.stringify(docs)).toBe(before)
  })
  it('a missing-load session does not reset the previous weighted best', async () => {
    const name='Machine';const r=await fixture([w('2026-09-01',name,[set(100,10)]),w('2026-09-08',name,[set(null,12)]),w('2026-09-15',name,[set(90,10)]),w('2026-09-21',name,[set(110,10)])],[{name,equipment:'machine'}]).get()
    expect(r.prs.filter(p=>p.kind==='best_set')).toEqual([expect.objectContaining({previous:1000,value:1100})])
  })
  it('keeps Kyiv period bounds and raw logs unchanged with incomplete coverage', async () => {
    const r=await fixture([]).get()
    assertKyivDayBounds(r.week,{expectedFrom:'2026-09-28',expectedTo:'2026-10-04'})
    assertKyivDayBounds(r.prev_span,{expectedFrom:'2026-09-21',expectedTo:'2026-09-27'})
    expect(r.groups.find(g=>g.muscle_group==='legs')).toMatchObject({sets:0,last_trained:null})
  })
})
