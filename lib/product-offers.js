'use strict'
const https = require('node:https')
const dns = require('node:dns').promises
const net = require('node:net')
const crypto = require('node:crypto')
const TTL_MS = 24 * 60 * 60 * 1000
const ALLOWED_HOSTS = new Set(['gymbeam.ua', 'gymbeam.com', 'www.nowfoods.com', 'nowfoods.com', 'vplab.com', 'www.vplab.com', 'naturesway.com', 'amixnutrition.co.uk', 'nutrend.com.ua', 'appliednutrition.uk'])
// Exact catalog-name mappings identify candidate products, never the user's current pack.
const SOURCES = {
  'gymbeam omega 3': { url: 'https://gymbeam.ua/omega-3-gymbeam.html', product_name: 'Омега 3 - GymBeam' },
  'gymbeam vitamin d3': { url: 'https://gymbeam.ua/vitamin-d3-2000-iu-gymbeam.html', product_name: 'Вітамін D3 2000 МО - GymBeam' },
}
function safeUrl(value) {
  try {
    const u = new URL(value)
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !ALLOWED_HOSTS.has(u.hostname)) return null
    if (/\/(?:search|catalogsearch|cart|checkout)(?:\/|$)/i.test(u.pathname) || [...u.searchParams.keys()].some(k => /^(q|query|search)$/i.test(k))) return null
    return u.href
  } catch { return null }
}
function publicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false // IPv6 deliberately unsupported, including mapped addresses.
  const [a,b,c] = ip.split('.').map(Number)
  return !(a===0 || a===10 || a===127 || a>=224 || (a===100&&b>=64&&b<=127) || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&(b===168||b===0||b===2)) || (a===198&&(b===18||b===19||b===51&&c===100)) || (a===203&&b===0&&c===113))
}
async function fetchPublicHtml(value, { lookup = dns.lookup, request = https.get, timeoutMs = 8000, maxBytes = 2*1024*1024 } = {}) {
  const safe = safeUrl(value)
  if (!safe) throw new Error('source_not_allowed')
  let req, timer, expired=false
  const job = (async () => {
    const url = new URL(safe)
    const addresses = await lookup(url.hostname, { all: true, family: 4 })
    if (expired) throw new Error('source_timeout')
    if (!addresses.length || addresses.some(a => !publicIPv4(a.address))) throw new Error('non_public_address')
    return new Promise((resolve,reject) => {
      // Pin the validated address; no second DNS lookup/rebinding. HTTPS keeps host/TLS validation.
      req = request(url, { agent: false, headers: { 'User-Agent': 'HealthCatalog/1.0', Accept: 'text/html', 'Accept-Encoding': 'identity' }, lookup: (_host,opts,cb) => opts.all ? cb(null,[{address:addresses[0].address,family:4}]) : cb(null,addresses[0].address,4) }, res => {
        if (res.statusCode !== 200) { req.destroy(); reject(new Error('source_http_error')); return } // no redirects
        if (!/^text\/html\b/i.test(res.headers['content-type'] || '')) { req.destroy(); reject(new Error('not_html')); return }
        let bytes=0; const chunks=[]
        res.on('data', chunk => { bytes+=chunk.length; if(bytes>maxBytes) { req.destroy(); reject(new Error('source_too_large')) } else chunks.push(chunk) })
        res.on('error', reject)
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      })
      req.on('error', reject)
    })
  })()
  // Deadline includes DNS, headers and body; a late DNS answer must not initiate a request.
  const deadline = new Promise((_,reject) => { timer=setTimeout(()=>{expired=true; req?.destroy();reject(new Error('source_timeout'))},timeoutMs) })
  try { return await Promise.race([job,deadline]) } finally { clearTimeout(timer); if(expired) job.catch(()=>{}) }
}
const norm = x => String(x || '').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim()
const isType = (x,t) => [x?.['@type']].flat().some(v=>v===t||v===`https://schema.org/${t}`||v===`http://schema.org/${t}`)
function jsonld(html) {
  const docs=[]
  for(const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try { docs.push(JSON.parse(m[1])) } catch { /* malformed blocks are unknown, never guessed */ }
  }
  return docs
}
function products(docs) {
  const out=[]
  function visit(x,depth=0) { if(depth>20||!x||typeof x!=='object') return; if(Array.isArray(x)) return x.forEach(v=>visit(v,depth+1)); if(isType(x,'Product')) out.push(x); if(x['@graph']) visit(x['@graph'],depth+1); if(x.mainEntity) visit(x.mainEntity,depth+1) }
  visit(docs); return out
}
function leafOffers(x,depth=0) {
  if(depth>10||!x) return []
  if(Array.isArray(x)) return x.flatMap(v=>leafOffers(v,depth+1))
  if(isType(x,'AggregateOffer')) return leafOffers(x.offers,depth+1) // NEVER lowPrice/highPrice
  return isType(x,'Offer') ? [x] : []
}
function parseOffers(html, source, now = new Date()) {
  const rows=[]
  for(const p of products(jsonld(html))) {
    if(!source.product_name || norm(p.name)!==norm(source.product_name)) continue
    const offers=leafOffers(p.offers)
    for(const o of offers) {
      const item = o.itemOffered || {}
      const name = o.name || item.name || (offers.length===1 ? p.name : null)
      const packMatch = String(name || '').match(/\b\d+(?:[.,]\d+)?\s*(?:капс(?:ул[аи]?)?|capsules?|caps|табл(?:ет(?:ок|ки))?|tablets?|softgels?|г|g|ml|мл)(?=\s|$|[.,])/iu)
      const pack = packMatch?.[0] || (offers.length===1 && typeof p.size==='string' ? p.size : null)
      const form = /капс|caps|softgel/i.test(pack || '') ? 'капсули' : /табл|tablet/i.test(pack || '') ? 'таблетки' : (source.form || null)
      const url=safeUrl(o.url || p.url || source.url)
      // Offsite and different-page URLs are not evidence for the page just fetched.
      if(!url || new URL(url).origin!==new URL(source.url).origin || new URL(url).pathname!==new URL(source.url).pathname || !name || !pack || !form) continue
      if(source.sku && String(o.sku || item.sku || p.sku)!==String(source.sku)) continue
      if(source.pack && norm(pack)!==norm(source.pack)) continue
      const raw=o.price; const currency=String(o.priceCurrency || '')
      if(!/^(?:\d+)(?:\.\d{1,4})?$/.test(String(raw)) || !/^[A-Z]{3}$/.test(currency)) continue
      const price=Number(raw)
      if(!Number.isFinite(price)||price<=0) continue
      const validUntil=o.priceValidUntil ? Date.parse(o.priceValidUntil) : null
      if(o.priceValidUntil && (!Number.isFinite(validUntil)||validUntil<now.getTime())) continue
      rows.push({ merchant:new URL(url).hostname, product_name:name, form, pack, sku:String(o.sku || item.sku || p.sku || ''), price, currency, price_uah:currency==='UAH'?price:null, checked_at:now.toISOString(), source_url:source.url, url, source_kind:'public_product_jsonld', availability:o.availability || null, price_valid_until:o.priceValidUntil || null })
    }
  }
  return rows.slice(0,20)
}
function sourcesFor(item, knowledge={}) {
  const mapped=SOURCES[norm(item.name)]
  const custom=Array.isArray(knowledge.product_sources)?knowledge.product_sources.slice(0,3):[]
  const sources=custom.length?custom:mapped?[mapped]:knowledge.purchase_url?[{url:knowledge.purchase_url}]:[]
  return sources.filter(s=>s&&typeof s==='object'&&safeUrl(s.url)).map(s=>({url:safeUrl(s.url),product_name:s.product_name||null,form:s.form||null,pack:s.pack||null,sku:s.sku||null}))
}
function sourceKey(sources) { return crypto.createHash('sha256').update(JSON.stringify(sources)).digest('hex') }
function present(doc, now=new Date()) {
  const age=now.getTime()-Date.parse(doc?.checked_at)
  const stale=!Number.isFinite(age)||age<0||age>=TTL_MS
  return {...doc, price_status:doc?.offers?.length?(stale||doc.error?'stale':'fresh'):'unknown', offers:(doc?.offers||[]).map(o=>({...o, price_status:stale||doc.error||o.price_valid_until&&Date.parse(o.price_valid_until)<now.getTime()?'stale':'fresh'}))}
}
module.exports={TTL_MS,ALLOWED_HOSTS,SOURCES,safeUrl,publicIPv4,fetchPublicHtml,jsonld,parseOffers,sourcesFor,sourceKey,present}
