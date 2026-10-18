const express = require('express')
const request = require('supertest')
const route = require('../../routes/life_profile')
import { makeMockCollection } from './utils/mockLifeMongo'
import { assertMatchesContract } from './utils/validateLifeContract'

function appWithProfile() {
  const profile = { strengths: [{ key: 'learner',name:'Learner' }],source:'vault:profile',version:1 }
  const observations = makeMockCollection([])
  const db = { collection(name:string) {
    if(name==='life_profile') return {findOne:async()=>profile}
    if(name==='life_strength_observations') return observations
    throw new Error('Unexpected collection '+name)
  } }
  const app = express();app.use(express.json());app.use('/api/life',route(()=>db))
  return {app,profile,observations}
}
const BODY={theme_key:'learner',day:'2026-10-17',kind:'counterexample',context:'Оцінював новий спосіб роботи',action:'Вивчив приклад і спробував його',result:'Підхід не підійшов до задачі',feedback:'Потрібен простіший крок'}
describe('separate, user-authored strength observations',()=>{
  it('creates, reads, edits, archives and restores without rewriting the imported profile',async()=>{
    const {app,profile}=appWithProfile()
    const original=JSON.stringify(profile)
    const created=await request(app).post('/api/life/profile/observations').send(BODY)
    expect(created.status).toBe(201);assertMatchesContract('StrengthObservation',created.body)
    const id=created.body._id
    const listed=await request(app).get('/api/life/profile/observations')
    assertMatchesContract('StrengthObservationsResponse',listed.body)
    expect(listed.body.observations).toHaveLength(1)
    await request(app).put('/api/life/profile/observations/'+id).send({result:'Тест дав конкретну межу застосування'})
    expect((await request(app).get('/api/life/profile/observations?theme=learner')).body.observations[0].result).toBe('Тест дав конкретну межу застосування')
    await request(app).put('/api/life/profile/observations/'+id).send({archived:true})
    expect((await request(app).get('/api/life/profile/observations')).body.observations).toHaveLength(0)
    expect((await request(app).get('/api/life/profile/observations?archived=true')).body.observations).toHaveLength(1)
    await request(app).put('/api/life/profile/observations/'+id).send({archived:false})
    expect((await request(app).get('/api/life/profile/observations')).body.observations).toHaveLength(1)
    expect(JSON.stringify(profile)).toBe(original)
  })
  it('rejects vague/missing results, unknown themes, future dates and invented fields',async()=>{
    const {app}=appWithProfile()
    for(const patch of [{result:'  '},{theme_key:'invented'},{day:'2099-01-01'},{source:'gallup'},{confidence:100}]){
      expect((await request(app).post('/api/life/profile/observations').send({...BODY,...patch})).status).toBe(400)
    }
    expect((await request(app).put('/api/life/profile/observations/bad').send({result:'x'})).status).toBe(404)
  })
  it('filters counterexamples exactly like positive examples; no inferred personal score',async()=>{
    const {app}=appWithProfile()
    await request(app).post('/api/life/profile/observations').send(BODY)
    const body=(await request(app).get('/api/life/profile/observations')).body
    expect(body.observations[0].kind).toBe('counterexample')
    expect(body.score).toBeUndefined();expect(body.observations[0].confidence).toBeUndefined()
  })
})
export {}
