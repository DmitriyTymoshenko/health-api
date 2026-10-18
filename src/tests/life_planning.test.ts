const express=require('express'),request=require('supertest')
const {ObjectId}=require('mongodb')
const route=require('../../routes/life_planning'),goalsRoute=require('../../routes/life_day_goals')
const {todayKyiv,addDaysToKyivDay}=require('../../lib/kyiv-day'),{weekStart}=require('../../lib/life-trackers')
import { makeMockCollection } from './utils/mockLifeMongo'
import { assertMatchesContract } from './utils/validateLifeContract'
function setup(seed:Record<string,any[]>={}){
 const collections:Record<string,any>={};const db={collection:(name:string)=>collections[name]||(collections[name]=makeMockCollection(seed[name]||[]))}
 const app=express();app.use(express.json());app.use('/api/life',route(()=>db));app.use('/api/life',goalsRoute(()=>db));return {app,db}
}
const PLAN={title:'Навчитись застосовувати',kind:'skill',outcome:'Самостійно виконати практичну задачу',next_action:'Зробити один приклад',practice:'Практика з перевіркою результату'}
describe('personal planning lifecycle',()=>{
 it('creates a real result-based plan, schedules one idempotent next action, records evidence and restores from archive',async()=>{
  const {app}=setup();const created=await request(app).post('/api/life/plans').send(PLAN);expect(created.status).toBe(201)
  const id=created.body._id
  const body={text:PLAN.next_action,project_id:id,estimate_minutes:30}
  const first=await request(app).post('/api/life/day-goals').send(body),second=await request(app).post('/api/life/day-goals').send(body)
  expect(first.status).toBe(201);assertMatchesContract('DayGoal',first.body)
  expect(second.body._id).toBe(first.body._id);expect(first.body.project_title).toBe(PLAN.title)
  expect((await request(app).put('/api/life/plans/'+id).send({status:'done'})).status).toBe(400)
  expect((await request(app).put('/api/life/plans/'+id).send({status:'done',evidence:'Показав робочий результат'})).body.completed_at).toBeTruthy()
  await request(app).put('/api/life/plans/'+id).send({status:'archived'})
  expect((await request(app).put('/api/life/plans/'+id).send({status:'active'})).body.evidence).toBe('Показав робочий результат')
 })
 it('rejects bad links, types, impossible dates, blank outcomes and false completion',async()=>{
  const {app}=setup()
  for(const patch of [{outcome:' '},{target_date:'2026-02-30'},{priority:4},{unknown:true},{parent_id:String(new ObjectId())},{status:'done'}])expect((await request(app).post('/api/life/plans').send({...PLAN,...patch})).status).toBe(400)
  const goal=(await request(app).post('/api/life/plans').send({...PLAN,kind:'goal'})).body
  expect((await request(app).post('/api/life/plans').send({...PLAN,parent_id:goal._id})).status).toBe(201)
  expect((await request(app).put('/api/life/plans/'+goal._id).send({kind:'project'})).status).toBe(400)
 })
 it('converts captured text once, including concurrent requests, while preserving the original',async()=>{
  const {app,db}=setup();const capture=(await request(app).post('/api/life/inbox').send({text:'Думка для розбору'})).body
  const body={text:capture.text,inbox_id:capture._id}
  const replies=await Promise.all([request(app).post('/api/life/day-goals').send(body),request(app).post('/api/life/day-goals').send(body)])
  expect(replies.every(r=>r.status===201)).toBe(true);expect(replies[0].body._id).toBe(replies[1].body._id)
  expect(db.collection('life_day_goals')._docs()).toHaveLength(1)
  expect(db.collection('life_inbox')._docs()[0].status).toBe('planned')
  expect(db.collection('life_inbox')._docs()[0].text).toBe(capture.text)
 })
 it('keeps zero capacity, missing energy and partial edits distinct; saves personal preferences separately',async()=>{
  const {app,db}=setup();let res=await request(app).put('/api/life/day-plan').send({available_minutes:0,intention:'Відновитися'})
  expect(res.body.available_minutes).toBe(0);expect(res.body.energy).toBeNull()
  res=await request(app).put('/api/life/day-plan').send({energy:2});expect(res.body.intention).toBe('Відновитися')
  for(const data of [{energy:0},{available_minutes:1500},{day:'2026-13-01'}])expect((await request(app).put('/api/life/day-plan').send(data)).status).toBe(400)
  await request(app).put('/api/life/preferences').send({values:'Час із сім’єю'})
  expect((await request(app).get('/api/life/preferences')).body.values).toBe('Час із сім’єю');expect(db.collection('life_profile')._docs()).toHaveLength(0)
 })
 it('weekly facts use Kyiv completion dates, count missing energy as unknown and keep minimums distinct',async()=>{
  const start=weekStart(todayKyiv()),previous=addDaysToKyivDay(start,-1)
  const {app}=setup({life_day_goals:[{_id:new ObjectId(),text:'Перенесене',day:previous,done:true,done_at:new Date(start+'T08:00:00Z')},{_id:new ObjectId(),text:'Без доказу дати',day:start,done:true,done_at:null}],life_day_ratings:[{day:start,energy:2},{day:addDaysToKyivDay(start,1),energy:null}],life_rule_checks:[{day:start,done:true,two_minute_version:true},{day:start,done:true,two_minute_version:false},{day:start,done:false,two_minute_version:false,slip_reason:'Брак часу'}]})
  const res=await request(app).get('/api/life/week').query({start});expect(res.status).toBe(200)
  expect(res.body.completed.map((g:any)=>g.text)).toEqual(['Перенесене']);expect(res.body.energy_average).toBe(2);expect(res.body.energy_days).toBe(1)
  expect(res.body.checkins).toEqual({full:1,minimal:1,skipped:1});expect(res.body.blockers[0].text).toBe('Брак часу')
  await request(app).put('/api/life/week').send({start,wins:'Результат',next_focus:'Одна зміна'})
  expect((await request(app).get('/api/life/week').query({start})).body.review.next_focus).toBe('Одна зміна')
  expect((await request(app).get('/api/life/week?start=2099-01-01')).status).toBe(400)
 })
 it('repeated completion saves do not rewrite the original completion time',async()=>{
  const date=new Date('2026-10-01T10:00:00Z'),id=new ObjectId()
  const {app}=setup({life_day_goals:[{_id:id,day:'2026-10-01',text:'a',done:true,done_at:date}]})
  expect((await request(app).put('/api/life/day-goals/'+id).send({done:true})).body.done_at).toBe(date.toISOString())
 })
})
export {}
