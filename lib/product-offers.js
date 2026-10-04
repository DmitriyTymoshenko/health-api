'use strict'
const https = require('node:https')
const dns = require('node:dns').promises
const net = require('node:net')
const crypto = require('node:crypto')
const TTL_MS = 24 * 60 * 60 * 1000
const ALLOWED_HOSTS = new Set(['gymbeam.ua', 'gymbeam.com', 'www.nowfoods.com', 'nowfoods.com', 'vplab.com', 'www.vplab.com', 'naturesway.com', 'amixnutrition.co.uk', 'nutrend.com.ua', 'appliednutrition.uk'])
// Exact catalog-name mappings identify candidate products, never the user's current pack.
const SOURCES = {
  // Verified public product identities on 2026-10-04; prices always come from fresh JSON-LD.
  'vplab zma': { url:'https://vplab.com/products/vplab-zma', product_name:'ZMA FOR DEEP RECOVERY', sku:'VP55701', pack:'90 capsules', pack_evidence:'90 easy-to-swallow capsules' },
  'nutrend ashwagandha': { url:'https://nutrend.com.ua/product/ashwagandha/', product_name:'Aшваганда (Ashwagandha)', sku:'5225', pack:'60 капсул', woo_pack:'60-kapsul' },
  'isodrinx tabs (nutrend)': { url:'https://nutrend.com.ua/product/isodrinx-tabs/', product_name:'Isodrinx Tabs', sku:'811', pack:'12 таблеток', woo_pack:'12-tab' },
  'applied nutrition amino fuel eaa': { url:'https://appliednutrition.uk/products/amino-fuel-390g', product_name:'Amino Fuel EAA', form:'порошок', variant_mode:'shopify_meta' },
  // Brand is unknown in the owner's regimen: these are explicitly labelled shopping candidates.
  'beta-alanine': { url:'https://gymbeam.ua/beta-alanine-gymbeam.html', product_name:'Бета-аланін - GymBeam', form:'порошок', candidate:true },
  'vitamin c 500mg': { url:'https://gymbeam.ua/vitamin-c-500-mg-gymbeam.html', product_name:'Вітамін C 500 мг - GymBeam', candidate:true },
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
// Parse data only. Never evaluate merchant JavaScript. Join variant ID AND SKU,
// check the product handle/name and price agreement before using a variant's name/pack.
function shopifyVariants(html, source) {
  if (source.variant_mode !== 'shopify_meta') return []
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    if (!script[1].includes('ShopifyAnalytics.meta')) continue
    const match = script[1].match(/\bvar meta\s*=\s*(\{[^\n]*\});/)
    if (!match) continue
    try {
      const product = JSON.parse(match[1]).product
      if (new URL(source.url).pathname !== '/products/' + product.handle) continue
      if (Array.isArray(product.variants)) return product.variants.filter(v =>
        typeof v.name === 'string' && v.name.startsWith(source.product_name + ' - ') && v.sku && v.id)
    } catch { /* malformed/changed data remains unknown */ }
  }
  return []
}
function decodeAttribute(text) {
  return text.replace(/&quot;/g,'"').replace(/&#0*39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
}
function singlePackage(html, product, source, offerCount) {
  if (offerCount !== 1 || !source.pack || !source.sku || String(product.sku) !== source.sku) return null
  if (source.pack_evidence && typeof product.description === 'string' &&
      product.description.includes(source.pack_evidence)) return source.pack
  if (!source.woo_pack) return null
  // WooCommerce may expose one product-level Offer across flavours. Only accept
  // the package when ALL variants of THIS product agree; never borrow a related product's pack.
  for (const m of html.matchAll(/<form\b[^>]*>/gi)) {
    const id=m[0].match(/data-product_id=["']([^"']+)["']/)
    const data=m[0].match(/data-product_variations=(['"])([\s\S]*?)\1/)
    if(id?.[1]!==source.sku || !data) continue
    try {
      const variants=JSON.parse(decodeAttribute(data[2]))
      if(Array.isArray(variants)&&variants.length&&variants.every(v=>v.attributes?.attribute_pa_upakovka===source.woo_pack)) return source.pack
    } catch { /* unknown */ }
  }
  return null
}
function parseOffers(html, source, now = new Date()) {
  const variants = shopifyVariants(html, source)
  const rows=[]
  for(const p of products(jsonld(html))) {
    if(!source.product_name || norm(p.name)!==norm(source.product_name)) continue
    const offers=leafOffers(p.offers)
    for(const o of offers) {
      const item = o.itemOffered || {}
      const url=safeUrl(o.url || p.url || source.url)
      const variant = variants.find(v => String(v.id) === (url && new URL(url).searchParams.get('variant')) && String(v.sku) === String(o.sku) && Number.isInteger(v.price) && Math.abs(v.price - Number(o.price)*100)<0.001)
      if (source.variant_mode && !variant) continue
      const name = variant?.name || o.name || item.name || (offers.length===1 ? p.name : null)
      const packMatch = String(name || '').match(/\b\d+(?:[.,]\d+)?\s*(?:капс(?:ул[аи]?)?|capsules?|caps|табл(?:ет(?:ок|ки))?|tablets?|softgels?|г|g|ml|мл)(?=\s|$|[.,])/iu)
      const pack = packMatch?.[0] || (offers.length===1 && typeof p.size==='string' ? p.size : null) || singlePackage(html,p,source,offers.length)
      const form = /капс|caps|softgel/i.test(pack || '') ? 'капсули' : /табл|tablet/i.test(pack || '') ? 'таблетки' : (source.form || null)
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
      rows.push({ merchant:new URL(url).hostname, product_name:source.candidate ? `Варіант покупки (бренд не визначений у вашому наборі): ${name}` : name, identity_status:source.candidate?'purchase_candidate':'matched_product', form, pack, sku:String(o.sku || item.sku || p.sku || ''), price, currency, price_uah:currency==='UAH'?price:null, checked_at:now.toISOString(), source_url:source.url, url, source_kind:'public_product_jsonld', availability:o.availability || null, price_valid_until:o.priceValidUntil || null })
    }
  }
  return rows.slice(0,20)
}
function sourcesFor(item, knowledge={}) {
  const mapped=SOURCES[norm(item.name)]
  const custom=Array.isArray(knowledge.product_sources)?knowledge.product_sources.slice(0,3):[]
  const sources=custom.length?custom:mapped?[mapped]:knowledge.purchase_url?[{url:knowledge.purchase_url}]:[]
  return sources.filter(s=>s&&typeof s==='object'&&safeUrl(s.url)).map(s=>({url:safeUrl(s.url),product_name:s.product_name||null,form:s.form||null,pack:s.pack||null,sku:s.sku||null,pack_evidence:s.pack_evidence||null,woo_pack:s.woo_pack||null,variant_mode:s.variant_mode||null,candidate:s.candidate===true}))
}
function sourceKey(sources) { return crypto.createHash('sha256').update(JSON.stringify(sources)).digest('hex') }
function present(doc, now=new Date()) {
  const age=now.getTime()-Date.parse(doc?.checked_at)
  const stale=!Number.isFinite(age)||age<0||age>=TTL_MS
  return {...doc, price_status:doc?.offers?.length?(stale||doc.error?'stale':'fresh'):'unknown', offers:(doc?.offers||[]).map(o=>({...o, price_status:stale||doc.error||o.price_valid_until&&Date.parse(o.price_valid_until)<now.getTime()?'stale':'fresh'}))}
}
module.exports={TTL_MS,ALLOWED_HOSTS,SOURCES,safeUrl,publicIPv4,fetchPublicHtml,jsonld,parseOffers,sourcesFor,sourceKey,present}
