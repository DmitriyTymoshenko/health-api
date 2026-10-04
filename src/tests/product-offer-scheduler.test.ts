// @ts-nocheck
// Execute the real server bootstrap in a VM: isolate only external effects,
// capture its real timers, and drive both callbacks without touching live data.
export {}
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

async function bootstrap(rejectFirst = false) {
  const timeouts = [], intervals = []
  const refresh = jest.fn().mockResolvedValue({ status: 'ok' })
  if (rejectFirst) refresh.mockRejectedValueOnce(new Error('merchant unavailable'))
  const cycle = jest.fn().mockResolvedValue(undefined)
  const stock = jest.fn().mockResolvedValue(undefined)
  const labs = jest.fn().mockResolvedValue(undefined)
  const collection = { createIndex: jest.fn().mockResolvedValue(undefined) }
  const db = { collection: jest.fn(() => collection) }
  const app = { use: jest.fn(), get: jest.fn(), listen: jest.fn((_port, _host, ready) => ready()) }
  const express = Object.assign(() => app, { json: () => () => {}, static: () => () => {} })
  const module = { exports: {} }
  const imports = {
    express,
    mongodb: { MongoClient: class { async connect() {} db() { return db } } },
    fs: { existsSync: () => false }, path,
    './package.json': { version: 'test' },
    './lib/cycle-notify': { checkCycleEndsAndNotify: cycle },
    './lib/stock-notify': { checkLowStockAndNotify: stock },
    './lib/labs-digest': { sendWeeklyLabsDigest: labs },
    './lib/product-offer-cache': { refreshDueProductOffers: refresh },
  }
  const req = Object.assign((name) => {
    if (Object.hasOwn(imports, name)) return imports[name]
    if (name.startsWith('./routes/')) return () => () => {}
    throw new Error('Unexpected dependency: ' + name)
  }, { main: module })
  const errors = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8'), {
    require: req, module, __dirname: path.join(__dirname, '../..'),
    process: { env: {}, exit: code => { throw new Error('Unexpected exit ' + code) } },
    console: { log: () => {}, error: (...args) => errors.push(args) },
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return 1 },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 2 },
  }, { filename: 'real-health-server.js' })
  await new Promise(resolve => setImmediate(resolve))
  return { timeouts, intervals, refresh, cycle, stock, labs, db, errors }
}

test('real bootstrap refreshes offers after 30s and hourly on the existing shared timer', async () => {
  const h = await bootstrap()
  expect(h.timeouts).toHaveLength(1)
  expect(h.timeouts[0].ms).toBe(30000)
  expect(h.refresh).not.toHaveBeenCalled()
  h.timeouts[0].fn()
  await Promise.resolve()
  expect(h.refresh).toHaveBeenCalledWith(h.db)
  expect(h.refresh).toHaveBeenCalledTimes(1)
  expect(h.intervals).toHaveLength(1)
  expect(h.intervals[0].ms).toBe(3600000)
  h.intervals[0].fn()
  expect(h.refresh).toHaveBeenCalledTimes(2)
  for (const sibling of [h.cycle, h.stock, h.labs]) expect(sibling).toHaveBeenCalledTimes(2)
})

test('failed initial refresh is reported and the next shared tick still runs', async () => {
  const h = await bootstrap(true)
  h.timeouts[0].fn()
  await Promise.resolve()
  expect(h.errors.some(args => String(args[0]).includes('product-offers'))).toBe(true)
  h.intervals[0].fn()
  await Promise.resolve()
  expect(h.refresh).toHaveBeenCalledTimes(2)
})
