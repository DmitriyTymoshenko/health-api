'use strict'

const fs = require('fs')
const path = require('path')

// #1487 (stage B of #1485, design D2): the Koliada nutrition-course corpus
// lives as 4 Markdown files in the Obsidian vault, NOT in Postgres/kb_search
// (health-api has no pg client, and kb_search is an agent MCP tool — neither
// is reachable from this plain-Node service). Read straight off disk, cached
// in memory keyed by each file's mtime so a vault edit invalidates the cache
// without a restart, but a steady-state read (the common case — one
// generation per catalog item per day, per D5) costs one stat() per file,
// not a re-read of ~273KB.
const DEFAULT_DIR = '/root/obsidian-vault/Chuttyevo/EN/00-09 System & Personal/04 Health'
const FILE_NAMES = [
  '04.01 Koliada-Nutrition-Part1.md',
  '04.02 Koliada-Nutrition-Part2.md',
  '04.03 Koliada-Nutrition-Part3.md',
  '04.04 Koliada-Nutrition-Part4.md',
]

let cache = null // { dir, mtimes: {name: ms}, text, files }

function statMs(p) {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return null
  }
}

// Returns { text, files: [{name, bytes}] }. Missing directory/files degrade
// to an EMPTY corpus (`text: ''`, `files: []`) — never throws — so a caller
// (fill-script, validator) can treat "no corpus" as a normal `not_covered`
// verdict instead of crashing the whole run over one moved/renamed vault
// folder.
function loadCorpus(dir = process.env.KOLIADA_VAULT_DIR || DEFAULT_DIR) {
  const currentMtimes = {}
  let anyFound = false
  for (const name of FILE_NAMES) {
    const ms = statMs(path.join(dir, name))
    currentMtimes[name] = ms
    if (ms !== null) anyFound = true
  }

  if (cache && cache.dir === dir && sameMtimes(cache.mtimes, currentMtimes)) {
    return { text: cache.text, files: cache.files }
  }

  if (!anyFound) {
    cache = { dir, mtimes: currentMtimes, text: '', files: [] }
    return { text: '', files: [] }
  }

  const files = []
  const parts = []
  for (const name of FILE_NAMES) {
    const p = path.join(dir, name)
    if (currentMtimes[name] === null) continue
    const content = fs.readFileSync(p, 'utf8')
    files.push({ name, bytes: Buffer.byteLength(content, 'utf8') })
    parts.push(content)
  }

  const text = parts.join('\n\n---\n\n')
  cache = { dir, mtimes: currentMtimes, text, files }
  return { text, files }
}

function sameMtimes(a, b) {
  const keys = FILE_NAMES
  return keys.every(k => a[k] === b[k])
}

// Test-only escape hatch — clears the in-memory cache so a test using a temp
// dir doesn't get a stale hit from a previous test's real-vault read.
function _resetCacheForTests() {
  cache = null
}

module.exports = { loadCorpus, DEFAULT_DIR, FILE_NAMES, _resetCacheForTests }
