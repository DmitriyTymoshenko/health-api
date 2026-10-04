export {}
const { buildPrFeed } = require('../../lib/pr-feed')
const { buildWorkingWeights } = require('../../lib/working-weights')
const name = 'Mixed load exercise'
const bw = (weight: number) => ({ weight_kg: weight, reps: 10, weight_source: 'bodyweight' })
const logged = (weight: number) => ({ weight_kg: weight, reps: 10 })
const workout = (date: string, sets: any[]) => ({date, exercises:[{name,sets}]})
const library = [{name,equipment:'machine'}]
function sample(reverse = false) {
  const mixed = [bw(60),logged(100)]
  return [workout('2026-09-01',[bw(60)]),workout('2026-09-02',reverse?mixed.reverse():mixed),workout('2026-09-03',[bw(65)])]
}
describe('Banach13487 source-partition regression',()=>{
  it.each([false,true])('partitions before canonical PR selection, reversed=%s', reverse=>{
    const docs=sample(reverse); const before=JSON.stringify(docs)
    const prs=buildPrFeed(docs,{library})
    expect(prs).toEqual([expect.objectContaining({date:'2026-09-03',kind:'best_set',weight_source:'bodyweight',previous:600,value:650,weight_kg:65})])
    expect(JSON.stringify(docs)).toBe(before)
  })
  it('retains the lower bodyweight source on the mixed session in its trend',()=>{
    const rows=buildWorkingWeights(sample(),{library})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({weight_source:'bodyweight',sessions:3,first_kg:60,last_kg:65})
    expect(rows[0].series.map((p:any)=>[p.date,p.weight_kg])).toEqual([['2026-09-01',60],['2026-09-02',60],['2026-09-03',65]])
  })
  it('each source retains its own baseline, canonical kind and trend on mixed sessions',()=>{
    const docs=sample();docs.push(workout('2026-09-04',[bw(70),logged(110),{...logged(300),warmup:true}]))
    const freeLibrary=[{name,equipment:'barbell'}]
    const prs=buildPrFeed(docs,{library:freeLibrary})
    expect(prs.filter((p:any)=>p.weight_source==='bodyweight').map((p:any)=>[p.kind,p.previous,p.value])).toEqual([['best_set',650,700],['best_set',600,650]])
    expect(prs.filter((p:any)=>p.weight_source==='logged')).toEqual([expect.objectContaining({date:'2026-09-04',kind:'e1rm',previous:133.3,value:146.7,weight_kg:110})])
    const rows=buildWorkingWeights(docs,{library:freeLibrary})
    expect(rows.find((r:any)=>r.weight_source==='bodyweight').series.map((p:any)=>p.weight_kg)).toEqual([60,60,65,70])
    expect(rows.find((r:any)=>r.weight_source==='logged').series.map((p:any)=>p.weight_kg)).toEqual([100,110])
  })
})
