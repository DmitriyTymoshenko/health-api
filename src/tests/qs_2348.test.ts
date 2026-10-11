export {}
const path = require('path')
const request = require('supertest')
const qs = require(require.resolve('qs', { paths: [path.dirname(require.resolve('express/package.json'))] }))
const app = require('../../server')

describe('#2348 patched Express qs compatibility', () => {
  it('retains nested filters, arrays, empty strings and zero values', () => {
    expect(qs.parse('filter[name]=Чуттєво&tags[]=a&tags[]=b&n=0&empty=', { allowPrototypes: true }))
      .toEqual({ filter: { name: 'Чуттєво' }, tags: ['a', 'b'], n: '0', empty: '' })
  })
  it('serializes a hostile constructor from the real Express parser options without throwing', () => {
    const parsed = qs.parse('x[constructor][isBuffer]=y', { allowPrototypes: true })
    expect(() => qs.stringify(parsed)).not.toThrow()
  })
  it('enforces comma array limit with bracket keys when callers opt in', () => {
    expect(() => qs.parse('a[]=1,2,3,4,5,6', { comma: true, arrayLimit: 5, throwOnLimitExceeded: true })).toThrow()
  })
  it('handles null and undefined comma values', () => {
    expect(() => qs.stringify({ a: [null, undefined, 'b'] }, { arrayFormat: 'comma', encodeValuesOnly: true })).not.toThrow()
  })
  it('keeps the actual app healthy with nested and hostile queries', async () => {
    const res = await request(app).get('/health?filter[name]=Чуттєво&x[constructor][isBuffer]=y')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
  })
})
