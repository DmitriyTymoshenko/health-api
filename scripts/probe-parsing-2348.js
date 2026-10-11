// Read-only probe of the actual exported server and Express's resolved qs module.
// No Mongo connection, no production listener, no application data writes.
const assert = require('node:assert/strict')
const path = require('node:path')
const request = require('supertest')
const expressPath = path.dirname(require.resolve('express/package.json'))
const qsPath = require.resolve('qs', { paths: [expressPath] })
const qs = require(qsPath)
const originalParse = qs.parse
const calls = []
qs.parse = function (input, options) {
  const result = originalParse(input, options)
  calls.push({ input, options, result })
  return result
}
const app = require('../server')
assert.ok(!Object.keys(require.cache).some(file => file.includes('/sprintf-js/')), 'dev formatter must not load in the actual server')

async function main() {
  const query = 'filter[name]=Чуттєво&tags[]=a&tags[]=b&n=0&empty='
  const response = await request(app).get('/health?' + encodeURI(query))
  assert.equal(response.status, 200)
  assert.equal(response.body.status, 'ok')
  const call = calls.find(c => c.input && c.input.includes('filter'))
  assert.ok(call, 'actual server request must call the Express-resolved qs.parse')
  assert.deepEqual(call.result, { filter: { name: 'Чуттєво' }, tags: ['a', 'b'], n: '0', empty: '' })
  assert.equal(call.options.allowPrototypes, true)
  assert.notEqual(call.options.comma, true)
  const hostile = await request(app).get('/health?x[constructor][isBuffer]=y')
  assert.equal(hostile.status, 200)
  const parsed = calls.find(c => c.input && c.input.includes('isBuffer')).result
  let roundTrip = 'safe'
  try { qs.stringify(parsed) } catch (error) { roundTrip = error.name }
  // This hypothetical sink is deliberately outside the application's routes.
  // The source is reachable; a real parse -> qs.stringify sink is not established.
  const count = calls.length
  const json = await request(app).post('/health').send({ x: { constructor: { isBuffer: 'y' } } })
  assert.equal(json.status, 404)
  assert.ok(calls.slice(count).every(c => !c.input), 'JSON body must not reach qs.parse')
  const form = await request(app).post('/health').type('form').send('x[constructor][isBuffer]=y')
  assert.equal(form.status, 404)
  assert.ok(calls.slice(count).every(c => !c.input), 'no URL-encoded body middleware in actual app')
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), qs: require(path.join(path.dirname(qsPath), '../package.json')).version,
    parser: app.get('query parser'), query: call, hostileStatus: hostile.status, hypotheticalRoundTrip: roundTrip,
    jsonStatus: json.status, formStatus: form.status, bodyReachedQs: false }, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
