// @ts-nocheck
export {}
const assert=require('node:assert/strict')
const {parseOffers,sourcesFor,SOURCES}=require('../../lib/product-offers')
const fixtures=require('./product-coverage-1992.fixtures.json')
const keys={ash:'nutrend ashwagandha',iso:'isodrinx tabs (nutrend)',zma:'vplab zma',eaa:'applied nutrition amino fuel eaa',beta:'beta-alanine',vitc:'vitamin c 500mg'}
const html=f=>`<script type="application/ld+json">${JSON.stringify(f.products)}</script>${f.extra}`
const clone=k=>structuredClone(fixtures[k])
for(const [k,name]of Object.entries(keys))test(`firsthand ${k} fixture has exact offer form/package/currency with no inferred UAH`,()=>{
 const source=sourcesFor({name})[0],rows=parseOffers(html(fixtures[k]),source)
 assert.ok(rows.length);for(const row of rows){assert.ok(row.pack&&row.form&&row.sku&&row.checked_at);assert.equal(row.price_uah,row.currency==='UAH'?row.price:null);assert.equal(row.source_url,source.url)}
})
test('Shopify 390g and 91g join on ID plus SKU, never inherit product-wide 390g',()=>{
 const rows=parseOffers(html(fixtures.eaa),SOURCES[keys.eaa]);assert.equal(rows.length,12)
 assert.equal(rows.find(r=>r.sku==='AFCL').pack,'390g');assert.equal(rows.find(r=>r.sku==='AF91CL').pack,'91g')
 assert.equal(rows.find(r=>r.sku==='AFCL').price,23.95);assert.equal(rows.find(r=>r.sku==='AF91CL').price,7.95)
})
test('Shopify missing/changed metadata or mismatched ID/SKU/price/handle never borrows another variant',()=>{
 let f=clone('eaa');f.extra='';assert.deepEqual(parseOffers(html(f),SOURCES[keys.eaa]),[])
 for(const field of ['sku','url','price']){
  f=clone('eaa');f.products[0].offers[0][field]=field==='price'?1:field==='url'?f.url+'?variant=56956304654711':'OTHER'
  const rows=parseOffers(html(f),SOURCES[keys.eaa]);assert.equal(rows.length,11);assert.ok(!rows.some(r=>r.sku==='AFCL'))
 }
 f=clone('eaa');f.extra=f.extra.replace('amino-fuel-390g','wrong-handle');assert.deepEqual(parseOffers(html(f),SOURCES[keys.eaa]),[])
})
test('package proof fails closed when missing, another product, or mixed packages',()=>{
 for(const key of ['ash','iso']){
  const source=SOURCES[keys[key]];let f=clone(key);f.extra='';assert.deepEqual(parseOffers(html(f),source),[])
  f=clone(key);f.extra=f.extra.replace('data-product_id="'+source.sku+'"','data-product_id="999"');assert.deepEqual(parseOffers(html(f),source),[])
  f=clone(key);f.extra=f.extra.replace(source.woo_pack,'other-package');assert.deepEqual(parseOffers(html(f),source),[])
 }
 const f=clone('zma');f.products[0].description='No package size';assert.deepEqual(parseOffers(html(f),SOURCES[keys.zma]),[])
})
test('generic brands are labelled candidates, never written into regimen or silently matched',()=>{
 for(const k of ['beta','vitc']){
  const source=SOURCES[keys[k]],item={id:1,name:keys[k],active:true};const copy={...item}
  const rows=parseOffers(html(fixtures[k]),sourcesFor(item)[0]);assert.deepEqual(item,copy)
  for(const row of rows){assert.equal(row.identity_status,'purchase_candidate');assert.match(row.product_name,/бренд не визначений/)}
 }
})
test('price is read from latest merchant Offer, never from mapping or saved fixture constant',()=>{
 const f=clone('ash');f.products[0].offers[0].price='701.25';assert.equal(parseOffers(html(f),SOURCES[keys.ash])[0].price,701.25)
})
test('new mappings preserve exact product identity and reject unsafe merchant variant URLs',()=>{
 for(const k of ['ash','iso','zma','eaa']){
  const f=clone(k);f.products[0].name='Other product';assert.deepEqual(parseOffers(html(f),SOURCES[keys[k]]),[])
 }
 const f=clone('eaa');f.products[0].offers[0].url='https://127.0.0.1/?variant=55476790460791'
 assert.equal(parseOffers(html(f),SOURCES[keys.eaa]).length,11)
})
test('only real current catalog identity keys expanded; QA rows do not acquire a mapping',()=>{
 assert.equal(Object.keys(SOURCES).length,8)
 assert.deepEqual(sourcesFor({name:'QA-1485',active:false}),[])
 assert.deepEqual(sourcesFor({name:'QA-1493-lisa-session',active:false}),[])
})

const {getProductOffers,refreshDueProductOffers}=require('../../lib/product-offer-cache')
function mockDB(){
 const docs=[]
 const coll={find:()=>({toArray:async()=>docs.map(d=>({...d}))}),updateOne:async(q,u)=>{let d=docs.find(x=>x._id===q._id);if(!d){d={_id:q._id,...u.$setOnInsert};docs.push(d)};Object.assign(d,u.$set);for(const k in u.$unset)delete d[k]},findOneAndUpdate:async(q,u)=>{let d=docs.find(x=>x._id===q._id);if(d.lease_until&&d.lease_until>q.$or[1].lease_until.$lte)return null;Object.assign(d,u.$set);return {...d}}}
 return {docs,collection:n=>n==='supplement_product_offers'?coll:{find:()=>({toArray:async()=>n==='supplement_catalog'?[{id:1,name:'GymBeam Omega 3'}]:[]})}}
}

test('budget skips complete multisource item without advancing TTL; next run fairly resumes without repeated fetches',async()=>{
 const db=mockDB(), original=db.collection
 const items=Array.from({length:14},(_,i)=>({id:i+1,name:'custom '+i,active:i!==13}))
 const knowledge=items.map(item=>({catalog_id:item.id,product_sources:Array.from({length:item.id===12?3:1},(_,j)=>({url:'https://gymbeam.ua/omega-3-gymbeam.html',product_name:'Омега 3 - GymBeam',sku:String(j)}))}))
 db.collection=n=>n==='supplement_catalog'?{find:()=>({toArray:async()=>items})}:n==='supplement_knowledge'?{find:()=>({toArray:async()=>knowledge})}:original(n)
 const now=new Date('2026-10-04T10:00:00Z');let calls=0
 const opts={now,cpuReady:async()=>true,fetchHtml:async()=>{calls++;return '<html></html>'}}
 await refreshDueProductOffers(db,opts)
 assert.equal(calls,12);assert.ok(!db.docs.some(d=>d.catalog_id===12));assert.ok(!db.docs.some(d=>d.catalog_id===14))
 const first=db.docs.find(d=>d.catalog_id===1).last_attempt_at
 await refreshDueProductOffers(db,{...opts,now:new Date(now.getTime()+60000)})
 assert.equal(calls,15);assert.equal(db.docs.find(d=>d.catalog_id===1).last_attempt_at,first)
 assert.ok(db.docs.find(d=>d.catalog_id===12).last_attempt_at)
 await refreshDueProductOffers(db,opts);assert.equal(calls,15)
 const view=await getProductOffers(db,now);assert.equal(view.items.length,13);assert.ok(!view.items.some(d=>d.catalog_id===14));assert.equal(items.length,14)
})
