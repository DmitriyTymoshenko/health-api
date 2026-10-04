// @ts-nocheck
// Real production helpers, collected by the standard Jest/deploy gate (#1991).
export {}
;const assert=require('node:assert/strict')
const {getProductOffers,refreshDueProductOffers}=require('../../lib/product-offer-cache')
const {TTL_MS}=require('../../lib/product-offers')
function mockDB(){
 const docs=[]
 const coll={find:()=>({toArray:async()=>docs.map(d=>({...d}))}),updateOne:async(q,u)=>{let d=docs.find(x=>x._id===q._id);if(!d){d={_id:q._id,...u.$setOnInsert};docs.push(d)};Object.assign(d,u.$set);for(const k in u.$unset)delete d[k]},findOneAndUpdate:async(q,u)=>{let d=docs.find(x=>x._id===q._id);if(d.lease_until&&d.lease_until>q.$or[1].lease_until.$lte)return null;Object.assign(d,u.$set);return {...d}}}
 return {docs,collection:n=>n==='supplement_product_offers'?coll:{find:()=>({toArray:async()=>n==='supplement_catalog'?[{id:1,name:'GymBeam Omega 3'}]:[]})}}
}
const html='<script type="application/ld+json">'+JSON.stringify({'@type':'Product',name:'Омега 3 - GymBeam',offers:{'@type':'Offer',name:'Омега 3 - GymBeam 120 капс',price:455,priceCurrency:'UAH',url:'https://gymbeam.ua/omega-3-gymbeam.html#112276',sku:'112276'}})+'</script>'
test('cache-only GET, sequential single-flight, TTL boundary, failure preserves observation',async()=>{
 const db=mockDB();let requests=0;let now=new Date('2026-10-04T10:00:00Z')
 let list=await getProductOffers(db,now);assert.equal(list.items[0].price_status,'unknown');assert.equal(db.docs.length,0)
 const opts={now,cpuReady:async()=>true,fetchHtml:async()=>{requests++;await new Promise(r=>setTimeout(r,5));return html}}
 await Promise.all([refreshDueProductOffers(db,opts),refreshDueProductOffers(db,opts)])
 assert.equal(requests,1);assert.equal(db.docs.length,1)
 await refreshDueProductOffers(db,{...opts,now:new Date(now.getTime()+TTL_MS-1)});assert.equal(requests,1)
 list=await getProductOffers(db,now);assert.equal(list.items[0].offers[0].price,455)
 const next=new Date(now.getTime()+TTL_MS)
 await refreshDueProductOffers(db,{...opts,now:next,fetchHtml:async()=>{requests++;throw Error('down')}})
 list=await getProductOffers(db,next);assert.equal(list.items[0].price_status,'stale');assert.equal(list.items[0].checked_at,now.toISOString());assert.equal(list.items[0].offers[0].price,455)
 await refreshDueProductOffers(db,{...opts,now:next});assert.equal(requests,2)
})
test('CPU gate causes no writes/fetch, lease prevents second worker',async()=>{
 const db=mockDB();const now=new Date();let requests=0
 assert.equal((await refreshDueProductOffers(db,{cpuReady:async()=>false})).status,'deferred_cpu');assert.equal(db.docs.length,0)
 db.docs.push({_id:'catalog:1',catalog_id:1,lease_until:new Date(now.getTime()+60000)})
 await refreshDueProductOffers(db,{now,cpuReady:async()=>true,fetchHtml:async()=>{requests++;return html}});assert.equal(requests,0)
})
test('unknown exact identity never scrapes or fabricates offer',async()=>{
 const db=mockDB();const old=db.collection;db.collection=n=>n==='supplement_catalog'?{find:()=>({toArray:async()=>[{id:1,name:'generic'}]})}:old(n)
 await refreshDueProductOffers(db,{cpuReady:async()=>true,fetchHtml:async()=>{throw Error('must not fetch')}})
 assert.equal(db.docs[0].reason,'no_source');assert.equal(db.docs[0].checked_at,null);assert.deepEqual(db.docs[0].offers,[])
})
