const express = require('express')
const request = require('supertest')
const workoutsRoute = require('../../routes/workouts')
const { fillBodyweightSets } = require('../../lib/bodyweight-fill')
const push = 'Відтискання широкий хват (груди)'
// Exact set shape in the failing live 2026-09-15 session (QA comment #11195).
const legacy = { date: '2026-09-15', exercises: [{ name: push, sets: Array.from({length:3}, () => ({reps:15,weight_kg:94.4,weight_source:'bodyweight'})) }] }
function appFor(docs: any[], library: any[] = [], weights: any[] = [{date:'2026-09-15',weight_kg:94.4}]) {
  const writes = jest.fn()
  const db = {collection(name:string) {
    const data = name === 'workouts' ? docs : name === 'exercises_library' ? library : name === 'weight_log' ? weights : []
    return {
      find(filter:any = {}) {
        let rows = data.filter((w:any) => (!filter['exercises.name'] || w.exercises?.some((e:any)=>e.name===filter['exercises.name'])) && (!filter.date?.$lte || w.date <= filter.date.$lte) && (!filter.date?.$gte || w.date >= filter.date.$gte))
        const cursor = {sort(order:any) {if(order.date) rows=[...rows].sort((a,b)=>a.date.localeCompare(b.date)*order.date);return this},skip(){return this},limit(n:number){rows=rows.slice(0,n);return this},async toArray(){return rows}}
        return cursor
      },
      async findOne(f:any) {return data.find((d:any)=>typeof f.name==='string'?d.name===f.name:f.name?.$regex?.test(d.name))||null},
      async insertOne(doc:any) {writes(doc); docs.push(doc);return {insertedId:'new'}},
      updateOne: writes, deleteOne: writes,
    }
  }}
  const app=express();app.use(express.json());app.use('/api/workouts',workoutsRoute(()=>db));return {app,writes}
}
describe('#1692 raw-derived workout correctness',()=>{
  it('autofills the actual Ukrainian push-up alias; dips/pull-ups keep full BW',()=>{
    const names=[push,'Відтискання вузький хват (трицепс)','Віджимання на брусах','Підтягування']
    expect(fillBodyweightSets(names.map(name=>({name,sets:[{reps:15}]})),94.4).exercises.map((e:any)=>e.sets[0].weight_kg)).toEqual([60.4,60.4,94.4,94.4])
  })
  it('GET PR repairs 94.4/4248 to 60.4/2718 without mutating historical sets',async()=>{
    const docs=JSON.parse(JSON.stringify([legacy]));const before=JSON.stringify(docs);const {app,writes}=appFor(docs)
    const res=await request(app).get('/api/workouts/prs').query({exercise:push})
    expect(res.status).toBe(200);expect(res.body.prs[0]).toMatchObject({max_weight:{value:60.4},max_volume:{value:2718},max_reps:{value:15,weight:60.4},max_1rm_kind:'best_set',max_1rm:{value:906}})
    expect(JSON.stringify(docs)).toBe(before);expect(writes).not.toHaveBeenCalled()
  })
  it.each(['/progress','/exercise-history'])('%s derives the same historical volume',async(path)=>{
    const {app}=appFor([legacy]);const r=await request(app).get('/api/workouts'+path).query({name:push})
    expect(r.status).toBe(200);expect(r.body[0][path==='/progress'?'total_volume':'volume']).toBe(2718)
  })
  it('volume and trend endpoints use corrected historical sets',async()=>{
    const {app}=appFor([legacy],[{name:push,muscle_group:'chest'}])
    const v=await request(app).get('/api/workouts/volume-by-muscle').query({period:'month',date:'2026-09-15'})
    expect(v.status).toBe(200);expect(v.body.total_kg).toBe(2718)
    const t=await request(app).get('/api/workouts/exercise-trends');expect(t.status).toBe(200);expect(t.body.exercises[0].last.total_volume).toBe(2718)
  })
  it('already-corrected sets do not receive 0.64 twice; future BW is excluded',async()=>{
    const docs=JSON.parse(JSON.stringify([legacy]));docs[0].exercises[0].sets.forEach((s:any)=>s.weight_kg=60.4)
    const {app}=appFor(docs,[],[{date:'2026-09-15',weight_kg:94.4},{date:'2026-09-16',weight_kg:100}])
    const r=await request(app).get('/api/workouts/prs');expect(r.body.prs[0].max_weight.value).toBe(60.4)
  })
  it('explicit dumbbell, cable, lb-converted, and weighted push-up loads stay as logged',async()=>{
    const values=[['Жим гантелей',32],['Тяга блока',24.95],[push,20]]
    const {app}=appFor([{date:'2026-09-15',exercises:values.map(([name,weight_kg])=>({name,sets:[{weight_kg,reps:10}]}))}],[{name:'Жим гантелей',equipment:'dumbbell'}])
    const r=await request(app).get('/api/workouts/prs');expect(r.status).toBe(200)
    for(const [name,w] of values) expect(r.body.prs.find((p:any)=>p.exercise===name).max_weight.value).toBe(w)
  })
  it('seconds/cardio never become tonnage or repetition PRs; leg raises remain repetitions',async()=>{
    const names=['Планка (сек)','Mountain climbers (на ногу)','Підйом ніг лежачи']
    const {app}=appFor([{date:'2026-09-15',exercises:names.map(name=>({name,sets:[{reps:60,weight_kg:94.4,weight_source:'bodyweight'}]}))}])
    const r=await request(app).get('/api/workouts/prs');expect(r.status).toBe(200)
    for(const p of r.body.prs) expect(p.max_volume.value).toBe(0)
    expect(r.body.prs[0]).toMatchObject({metric_kind:'duration',max_duration_seconds:{value:60},max_reps:{value:0}})
    expect(r.body.prs[1]).toMatchObject({metric_kind:'cardio',max_reps:{value:0}})
    expect(r.body.prs[2]).toMatchObject({metric_kind:'repetitions',max_reps:{value:60}})
  })
  it('POST machine PR uses the same best-set scale as GET',async()=>{
    const name='Machine press';const {app}=appFor([{date:'2026-09-14',exercises:[{name,sets:[{weight_kg:50,reps:10}]}]}],[{name,equipment:'machine'}])
    const r=await request(app).post('/api/workouts').send({date:'2026-09-15',exercises:[{name,sets:[{weight_kg:60,reps:10}]}]})
    expect(r.status).toBe(201);expect(r.body.new_prs[0].records).toContainEqual(expect.objectContaining({type:'max_1rm',value:600,previous:500,kind:'best_set'}))
  })
  it('missing historical BW stays unknown and keeps the repetition record',async()=>{
    const {app}=appFor([legacy],[],[])
    const r=await request(app).get('/api/workouts/prs')
    expect(r.status).toBe(200)
    expect(r.body.prs[0]).toMatchObject({max_weight:{value:0,date:null},max_volume:{value:0,date:null},max_reps:{value:15}})
  })
  it.each(['/','/recent'])('%s preserves raw editable sets and exposes corrected metric view',async(path)=>{
    const docs=JSON.parse(JSON.stringify([legacy]));const before=JSON.stringify(docs);const {app,writes}=appFor(docs)
    const r=await request(app).get('/api/workouts'+path)
    expect(r.status).toBe(200)
    expect(r.body[0].exercises[0].sets[0].weight_kg).toBe(94.4)
    expect(r.body[0].exercises[0].metrics.sets[0].weight_kg).toBe(60.4)
    expect(JSON.stringify(docs)).toBe(before);expect(writes).not.toHaveBeenCalled()
  })
  it('history preserves duration as seconds, never silently relabels it repetitions',async()=>{
    const name='Планка (сек)';const {app}=appFor([{date:'2026-09-15',exercises:[{name,sets:[{reps:60,weight_kg:94.4,weight_source:'bodyweight'}]}]}])
    const r=await request(app).get('/api/workouts/exercise-history').query({name})
    expect(r.status).toBe(200)
    expect(r.body[0]).toMatchObject({metric_kind:'duration',total_duration_seconds:60,total_reps:0,volume:0})
  })
  it('POST first free-weight PR reports e1RM; repeating it creates no new PR',async()=>{
    const name='Barbell press';const {app}=appFor([],[{name,equipment:'barbell'}])
    const doc={date:'2026-09-15',exercises:[{name,sets:[{weight_kg:60,reps:10}]}]}
    const first=await request(app).post('/api/workouts').send(doc)
    expect(first.status).toBe(201)
    expect(first.body.new_prs[0].records).toContainEqual(expect.objectContaining({type:'max_1rm',value:80,kind:'e1rm'}))
    const second=await request(app).post('/api/workouts').send(doc)
    expect(second.status).toBe(201);expect(second.body.new_prs).toBeUndefined()
  })
  it('explicit unresolved inputs and zero load are never replaced with BW',async()=>{
    const sets=[{reps:10,weight_input:20,weight_unit:null,weight_kg:null},{reps:10,weight_kg:0}]
    expect(fillBodyweightSets([{name:push,sets}],94.4).exercises[0].sets).toEqual(sets)
    const {app}=appFor([{date:'2026-09-15',exercises:[{name:push,sets}]}])
    const r=await request(app).get('/api/workouts/prs');expect(r.body.prs[0].max_volume.value).toBe(0)
  })
  it('POST timed exercise only reports a duration record, never zero/fake load PRs',async()=>{
    const name='Планка (сек)';const {app}=appFor([],[{name,equipment:'bodyweight'}])
    const r=await request(app).post('/api/workouts').send({date:'2026-09-15',exercises:[{name,sets:[{reps:60}]}]})
    expect(r.status).toBe(201)
    expect(r.body.new_prs[0].records).toEqual([{type:'max_duration_seconds',value:60,previous:0}])
  })

})
export {}
