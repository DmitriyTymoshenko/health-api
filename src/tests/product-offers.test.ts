// @ts-nocheck
// Real production helpers, collected by the standard Jest/deploy gate (#1991).
export {}

const assert=require('node:assert/strict')
const {EventEmitter}=require('node:events')
const {safeUrl,publicIPv4,fetchPublicHtml,parseOffers,SOURCES,present,TTL_MS,sourcesFor}=require('../../lib/product-offers')
const source=SOURCES['gymbeam omega 3']
const html=p=>`<script type="application/ld+json">${JSON.stringify({'@graph':[p]})}</script>`
const product=offers=>({'@type':'Product',name:source.product_name,offers})
const offer=(pack=120,price=455)=>({'@type':'Offer',name:`Омега 3 - GymBeam ${pack} капс`,price,priceCurrency:'UAH',url:source.url+'#'+pack,sku:String(pack)})
test('all exact AggregateOffer variants, not aggregate cheapest',()=>{
 const rows=parseOffers(html(product({'@type':'AggregateOffer',lowPrice:1,offers:[offer(60,255),offer(120,455)]})),source)
 assert.equal(rows.length,2);assert.deepEqual(rows.map(x=>x.price),[255,455]);assert.equal(rows[1].pack,'120 капс');assert.equal(rows[1].form,'капсули');assert.equal(rows[1].price_uah,455)
})
test('SKU selection is explicit, no cheapest or first fallback',()=>{
 const page=html(product({'@type':'AggregateOffer',offers:[offer(60,100),offer(120,400)]}))
 assert.equal(parseOffers(page,{...source,sku:'120'})[0].price,400)
 assert.equal(parseOffers(page,{...source,sku:'missing'}).length,0)
})
test('reject mismatch, no package, aggregate-only, malformed and foreign URL',()=>{
 assert.equal(parseOffers(html(product(offer())),{...source,product_name:'Other'}).length,0)
 for(const o of [{...offer(),name:'generic'},{'@type':'AggregateOffer',lowPrice:1},{...offer(),url:'https://evil.test/x'},{...offer(),url:'https://gymbeam.ua/other.html'},{...offer(),price:'NaN'},{...offer(),price:0},{...offer(),priceCurrency:'bad'},{...offer(),priceValidUntil:'2000-01-01'}]) assert.equal(parseOffers(html(product(o)),source).length,0)
 assert.deepEqual(parseOffers('<script type="application/ld+json">{broken}</script>',source),[])
})
test('unidentified multiple variants are unknown; original currency never fake UAH',()=>{
 assert.equal(parseOffers(html(product([{...offer(),name:undefined},{...offer(),name:undefined}])),source).length,0)
 const row=parseOffers(html(product({...offer(),price:14.99,priceCurrency:'EUR'})),source)[0]
 assert.equal(row.price_uah,null);assert.equal(row.currency,'EUR')
})
test('URL and IP SSRF guard rejects credentials, tricks, search, private and mapped IPv6',()=>{
 for(const u of ['http://gymbeam.ua/a','https://gymbeam.ua.evil.test/a','https://user@gymbeam.ua/a','https://gymbeam.ua:8080/a','https://127.0.0.1/a','https://gymbeam.ua/catalogsearch/result?q=x','https://gymbeam.ua/?search=x','file:///etc/passwd']) assert.equal(safeUrl(u),null)
 for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::ffff:127.0.0.1','198.19.1.1']) assert.equal(publicIPv4(ip),false)
 assert.equal(publicIPv4('8.8.8.8'),true)
})
test('DNS blocked before request; late DNS after deadline never initiates connection',async()=>{
 let calls=0;const request=()=>{calls++;throw Error('unexpected')}
 await assert.rejects(fetchPublicHtml(source.url,{lookup:async()=>[{address:'127.0.0.1'}],request}),/non_public/)
 await assert.rejects(fetchPublicHtml(source.url,{lookup:async()=>{await new Promise(r=>setTimeout(r,25));return[{address:'8.8.8.8'}]},request,timeoutMs:5}),/timeout/)
 await new Promise(r=>setTimeout(r,30));assert.equal(calls,0)
})
test('pins resolved address; rejects redirects, oversized and non HTML responses',async()=>{
 for(const [status,type,body,expected] of [[302,'text/html','',/http/],[200,'application/json','{}',/not_html/],[200,'text/html','toolarge',/too_large/]]) {
 const request=(url,opts,cb)=>{opts.lookup(url.hostname,{},(_,ip)=>assert.equal(ip,'8.8.8.8'));opts.lookup(url.hostname,{all:true},(_,ips)=>assert.deepEqual(ips,[{address:'8.8.8.8',family:4}])); const req=new EventEmitter();req.destroy=()=>{};queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=status;res.headers={'content-type':type};res.resume=()=>{};cb(res);res.emit('data',Buffer.from(body));res.emit('end')});return req}
 await assert.rejects(fetchPublicHtml(source.url,{lookup:async()=>[{address:'8.8.8.8'}],request,maxBytes:2}),expected)
 }
})
test('freshness flips at exactly 24h; future timestamps and error are not fresh',()=>{
 const now=new Date('2026-10-04T12:00:00Z'),doc={offers:[{price:1}],checked_at:new Date(now-TTL_MS).toISOString()}
 assert.equal(present(doc,now).price_status,'stale')
 assert.equal(present({...doc,checked_at:now.toISOString()},now).price_status,'fresh')
 assert.equal(present({...doc,checked_at:now.toISOString(),error:'failed'},now).price_status,'stale')
 assert.equal(present({...doc,checked_at:'2027-01-01'},now).price_status,'stale')
})
test('knowledge URL fallback is preserved but unverified identity never assumed',()=>{
 assert.equal(sourcesFor({name:'unknown'}, {purchase_url:'https://vplab.com/products/vplab-zma'})[0].product_name,null)
 assert.equal(sourcesFor({name:'GymBeam Omega 3'})[0].url,source.url)
})
