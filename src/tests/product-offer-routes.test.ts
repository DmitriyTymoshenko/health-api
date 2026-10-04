// @ts-nocheck
// Real production helpers, collected by the standard Jest/deploy gate (#1991).
export {}
;const assert=require('node:assert/strict')
const express=require('express');const request=require('supertest')
const route=require('../../routes/supplement_catalog')
test('GET offers uses persisted cache only without initiating LLM or merchant fetches',async()=>{
 const reads=[]
 const db={collection:n=>{reads.push(n);return {find:()=>({toArray:async()=>n==='supplement_catalog'?[{id:1,name:'Generic',active:true}]:[]})}}}
 const app=express();app.use('/catalog',route(()=>db));
 const res=await request(app).get('/catalog/offers');assert.equal(res.status,200);assert.equal(res.body.items[0].price_status,'unknown');assert.equal(res.body.ttl_hours,24)
 assert.deepEqual(reads.sort(),['supplement_catalog','supplement_knowledge','supplement_product_offers'])
})
test('catalog read failure responds non-2xx sanitized, never empty success',async()=>{
 const app=express();app.use('/catalog',route(()=>{throw Error('internal credential detail')}));
 const res=await request(app).get('/catalog/offers');assert.equal(res.status,503);assert.equal(res.body.error,'Product catalog unavailable');assert.ok(!res.text.includes('credential'))
})
