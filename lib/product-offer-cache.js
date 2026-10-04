'use strict'
const os = require('node:os')
const fs = require('node:fs/promises')
const { TTL_MS, fetchPublicHtml, parseOffers, sourcesFor, sourceKey, present } = require('./product-offers')
const flights = new WeakMap()
async function cpuReady() {
  const sample=async()=> (await fs.readFile('/proc/stat','utf8')).split('\n')[0].trim().split(/\s+/).slice(1,9).map(Number)
  try {
    const a=await sample(); await new Promise(r=>setTimeout(r,200)); const b=await sample()
    const d=b.map((n,i)=>n-a[i]); const total=d.reduce((a,b)=>a+b,0)
    return os.loadavg()[0]<=6 && total>0 && 100*d[7]/total<25
  } catch { return false }
}
async function getProductOffers(db, now=new Date()) {
  const [items,knowledge,cache]=await Promise.all([
    db.collection('supplement_catalog').find({}).toArray(),
    db.collection('supplement_knowledge').find({}).toArray(),
    db.collection('supplement_product_offers').find({}).toArray(),
  ])
  return { ttl_hours:24, cadence:'hourly_due_only', items:items.filter(item=>item.active!==false).map(item=>{
    const sources=sourcesFor(item,knowledge.find(k=>k.catalog_id===item.id))
    const key=sourceKey(sources)
    const doc=cache.find(c=>c.catalog_id===item.id && c.source_key===key)
    return present({catalog_id:item.id,sources,offers:[],checked_at:null,last_attempt_at:null,reason:sources.length?'not_checked':'no_source',...doc},now)
  }) }
}
// Call from the existing server.js 60-minute health tick, including initial 30s tick.
// Sequential, max 12 sources/tick, 8s/source; DB lease prevents duplicate workers.
// Both successful and unsuccessful attempts are cached for 24h. GET is cache-only.
async function refreshDueProductOffers(db, options={}) {
  if(flights.has(db)) return flights.get(db)
  const run=(async()=>{
    const now=options.now || new Date()
    if(!await (options.cpuReady || cpuReady)()) return {status:'deferred_cpu',checked:0}
    const fetchHtml=options.fetchHtml || fetchPublicHtml
    const cache=db.collection('supplement_product_offers')
    const list=await getProductOffers(db,now)
    let checked=0,budget=12
    for(const entry of list.items) {
      // Reserve the complete item before taking its lease. Skipped sources never
      // acquire a 24h attempt timestamp; next tick resumes after cached items.
      const required=entry.sources.filter(source=>source.product_name).length
      if(required>budget) continue
      const attemptAge=now.getTime()-Date.parse(entry.last_attempt_at)
      if(Number.isFinite(attemptAge) && attemptAge>=0 && attemptAge<TTL_MS) continue
      // Deterministic _id means no additional index/migration is required.
      const id=`catalog:${entry.catalog_id}`
      try { await cache.updateOne({_id:id},{$setOnInsert:{catalog_id:entry.catalog_id}},{upsert:true}) } catch(err) { if(err.code!==11000) throw err }
      const lease=await cache.findOneAndUpdate({_id:id,$or:[{lease_until:{$exists:false}},{lease_until:{$lte:now}}]},{$set:{lease_until:new Date(now.getTime()+120000)}},{returnDocument:'after'})
      if(!lease) continue
      // Recheck persisted TTL after acquiring lease (other processes may have refreshed).
      const leaseAge=now.getTime()-Date.parse(lease.last_attempt_at)
      if(lease.source_key===sourceKey(entry.sources) && Number.isFinite(leaseAge)&&leaseAge>=0&&leaseAge<TTL_MS) { await cache.updateOne({_id:id},{$unset:{lease_until:''}});continue }
      const offers=[]; let error=null; let observed=false; let reason=entry.sources.length?'no_exact_offer':'no_source'
      try {
        for(const source of entry.sources) {
          if(!source.product_name) { reason='identity_unknown';continue }
          budget--
          try { const html=await fetchHtml(source.url); observed=true; offers.push(...parseOffers(html,source,now)) }
          catch { error='source_unavailable' }
        }
        // Failed fetches preserve last observation and its ORIGINAL timestamp, visibly stale.
        const retained=error&&!offers.length&&lease.source_key===sourceKey(entry.sources)&&lease.offers?.length
        await cache.updateOne({_id:id},{$set:{catalog_id:entry.catalog_id,source_key:sourceKey(entry.sources),sources:entry.sources,offers:retained?lease.offers:offers,checked_at:retained?lease.checked_at:observed?now.toISOString():null,last_attempt_at:now.toISOString(),reason:offers.length?'offers_found':reason,error},$unset:{lease_until:''}})
        checked++
      } catch(err) { await cache.updateOne({_id:id},{$unset:{lease_until:''}}); throw err }
    }
    return {status:'complete',checked}
  })()
  flights.set(db,run)
  try {return await run} finally {flights.delete(db)}
}
module.exports={getProductOffers,refreshDueProductOffers,cpuReady}
