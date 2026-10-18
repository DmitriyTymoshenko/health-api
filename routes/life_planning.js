const { Router } = require('express')
const { ObjectId } = require('mongodb')
const { validateBody } = require('../lib/life-contracts')
const { todayKyiv, toKyivDay, addDaysToKyivDay, isValidKyivDayFormat } = require('../lib/kyiv-day')
const { weekStart } = require('../lib/life-trackers')
const idOf = v => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v) ? new ObjectId(v) : null
const validDay = day => isValidKyivDayFormat(day) && addDaysToKyivDay(day,0) === day
const fail = (res, error, status = 400) => res.status(status).json({ error })

module.exports = function (getDB) {
  const router = Router()
  // Serialize personal edits and singleton upserts in the existing single API process.
  let tail = Promise.resolve()
  router.use(async (req,res,next) => {
    if (!['POST','PUT'].includes(req.method)) return next()
    const prior=tail; let release; tail=new Promise(r=>{release=r});await prior
    if(res.destroyed){release();return}res.once('finish',release);res.once('close',release);next()
  })
  const safe = fn => async (req,res) => { try { await fn(req,res,getDB()) } catch (e) { res.status(500).json({error:e.message}) } }
  router.get('/plans',safe(async(req,res,db)=>{
    const plans=await db.collection('life_plans').find({}).sort({created_at:1}).toArray()
    res.json({plans})
  }))
  async function planPatch(body, current, db) {
    const set={...body,updated_at:new Date()}
    for(const key of ['title','outcome','why','next_action','practice','evidence'])if(key in set)set[key]=set[key].trim()
    if(('title' in set&&!set.title)||('outcome' in set&&!set.outcome))return {error:'Вкажіть назву та конкретний очікуваний результат'}
    if(set.target_date && !validDay(set.target_date))return {error:'Некоректна дата'}
    const merged={...current,...set}
    if(merged.status==='done'&&!merged.evidence?.trim())return {error:'Запишіть результат або доказ прогресу перед завершенням'}
    if(merged.parent_id){
      const pid=idOf(merged.parent_id)
      const parent=pid&&await db.collection('life_plans').findOne({_id:pid})
      if(merged.kind==='goal'||!parent||parent.kind!=='goal'||parent.status==='archived')return {error:'Проєкт або навичку можна пов’язати з наявною ціллю'}
    }
    if(set.kind==='goal'&&current?.kind!=='goal'&&current?._id){
      // Existing children cannot create a cycle: only goals can be parents.
      set.parent_id=null
    }
    set.completed_at=merged.status==='done'?(current?.completed_at||new Date()):null
    return {set}
  }
  router.post('/plans',validateBody('PlanCreateRequest'),safe(async(req,res,db)=>{
    const defaults={status:'active',priority:2,parent_id:null,why:'',next_action:'',practice:'',evidence:'',target_date:null}
    const patch=await planPatch(req.body,defaults,db);if(patch.error)return fail(res,patch.error)
    const doc={...defaults,...patch.set,created_at:new Date()}
    const r=await db.collection('life_plans').insertOne(doc);res.status(201).json({...doc,_id:r.insertedId})
  }))
  router.put('/plans/:id',validateBody('PlanUpdateRequest'),safe(async(req,res,db)=>{
    const id=idOf(req.params.id),current=id&&await db.collection('life_plans').findOne({_id:id})
    if(!current)return fail(res,'План не знайдено',404)
    if(req.body.kind&&req.body.kind!==current.kind)return fail(res,'Тип плану після створення не змінюється')
    const patch=await planPatch(req.body,current,db);if(patch.error)return fail(res,patch.error)
    res.json(await db.collection('life_plans').findOneAndUpdate({_id:id},{$set:patch.set},{returnDocument:'after'}))
  }))
  router.get('/inbox',safe(async(req,res,db)=>res.json({items:await db.collection('life_inbox').find({}).sort({created_at:-1}).toArray()})))
  router.post('/inbox',validateBody('InboxCreateRequest'),safe(async(req,res,db)=>{
    if(!req.body.text.trim())return fail(res,'Запис порожній')
    const doc={text:req.body.text.trim(),status:'inbox',created_at:new Date()}
    const r=await db.collection('life_inbox').insertOne(doc);res.status(201).json({...doc,_id:r.insertedId})
  }))
  router.put('/inbox/:id',validateBody('InboxUpdateRequest'),safe(async(req,res,db)=>{
    const id=idOf(req.params.id),current=id&&await db.collection('life_inbox').findOne({_id:id})
    if(!current)return fail(res,'Запис не знайдено',404)
    if(current.status==='planned')return fail(res,'Цей запис уже став завданням; змініть завдання у плані дня')
    if('text'in req.body&&!req.body.text.trim())return fail(res,'Запис порожній')
    res.json(await db.collection('life_inbox').findOneAndUpdate({_id:id},{$set:{...req.body,updated_at:new Date()}},{returnDocument:'after'}))
  }))
  router.get('/day-plan',safe(async(req,res,db)=>{
    const day=req.query.day||todayKyiv();if(!validDay(day))return fail(res,'Некоректна дата')
    res.json(await db.collection('life_day_plans').findOne({day})||{day,intention:'',available_minutes:null,energy:null})
  }))
  router.put('/day-plan',validateBody('DayPlanRequest'),safe(async(req,res,db)=>{
    const day=req.body.day||todayKyiv();if(!validDay(day))return fail(res,'Некоректна дата')
    const set={...req.body,day,updated_at:new Date()},defaults={intention:'',available_minutes:null,energy:null}
    for(const k of Object.keys(set))delete defaults[k]
    res.json(await db.collection('life_day_plans').findOneAndUpdate({day},{$set:set,$setOnInsert:defaults},{upsert:true,returnDocument:'after'}))
  }))
  router.get('/preferences',safe(async(req,res,db)=>res.json(await db.collection('life_personal_preferences').findOne({key:'owner'})||{values:'',interests:'',constraints:'',coach_style:'supportive'})))
  router.put('/preferences',validateBody('PersonalPreferencesRequest'),safe(async(req,res,db)=>{
    res.json(await db.collection('life_personal_preferences').findOneAndUpdate({key:'owner'},{$set:{...req.body,key:'owner',updated_at:new Date()}},{upsert:true,returnDocument:'after'}))
  }))
  router.get('/week',safe(async(req,res,db)=>{
    const requested=req.query.start||todayKyiv()
    if(!validDay(requested)||requested>todayKyiv())return fail(res,'Оберіть поточний або минулий тиждень')
    const start=weekStart(requested),end=addDaysToKyivDay(start,6),through=end<todayKyiv()?end:todayKyiv()
    const [scheduled,completed,ratings,checks,review,plans,backlog]=await Promise.all([
      db.collection('life_day_goals').find({day:{$gte:start,$lte:through}}).toArray(),
      db.collection('life_day_goals').find({done:true}).toArray(),
      db.collection('life_day_ratings').find({day:{$gte:start,$lte:through}}).sort({day:1}).toArray(),
      db.collection('life_rule_checks').find({day:{$gte:start,$lte:through}}).toArray(),
      db.collection('life_weekly_reviews').findOne({start}),
      db.collection('life_plans').find({}).toArray(),
      db.collection('life_day_goals').find({done:false}).toArray(),
    ])
    const completedInWeek=completed.filter(g=>g.done_at&&toKyivDay(g.done_at)>=start&&toKyivDay(g.done_at)<=through)
    const energies=ratings.filter(r=>Number.isInteger(r.energy)).map(r=>r.energy)
    const blockers=checks.filter(c=>c.done===false&&!c.two_minute_version&&c.slip_reason?.trim()).map(c=>({day:c.day,text:c.slip_reason}))
    res.json({start,end,through,completed:completedInWeek,scheduled_count:scheduled.length,
      open:scheduled.filter(g=>!g.done),backlog:backlog.filter(g=>g.day<start),ratings,
      energy_average:energies.length?Math.round(energies.reduce((a,b)=>a+b,0)/energies.length*10)/10:null,energy_days:energies.length,
      checkins:{full:checks.filter(c=>c.done===true&&!c.two_minute_version).length,minimal:checks.filter(c=>c.two_minute_version===true).length,skipped:checks.filter(c=>c.done===false&&!c.two_minute_version).length},
      blockers,active_plans:plans.filter(p=>p.status==='active'),
      review:review||{start,wins:'',obstacle:'',stop:'',next_focus:'',saved_at:null}})
  }))
  router.put('/week',validateBody('WeeklyReviewRequest'),safe(async(req,res,db)=>{
    const requested=req.body.start||todayKyiv()
    if(!validDay(requested)||requested>todayKyiv())return fail(res,'Некоректний тиждень')
    const start=weekStart(requested),set={...req.body,start,saved_at:new Date()}
    res.json(await db.collection('life_weekly_reviews').findOneAndUpdate({start},{$set:set},{upsert:true,returnDocument:'after'}))
  }))
  return router
}
