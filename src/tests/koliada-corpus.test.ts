/**
 * Unit tests for lib/koliada-corpus.js (#1487, stage B of #1485, design D2).
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadCorpus, DEFAULT_DIR, FILE_NAMES, _resetCacheForTests } = require('../../lib/koliada-corpus')

describe('loadCorpus — real vault directory (B1)', () => {
  beforeEach(() => _resetCacheForTests())

  it('the real vault dir yields 4 files and >250KB of combined text', () => {
    const { text, files } = loadCorpus(DEFAULT_DIR)
    expect(files).toHaveLength(4)
    expect(text.length).toBeGreaterThan(250000)
    expect(files.map((f: { name: string }) => f.name).sort()).toEqual([...FILE_NAMES].sort())
  })
})

describe('loadCorpus — missing directory degrades to empty, never throws (B1)', () => {
  beforeEach(() => _resetCacheForTests())

  it('a nonexistent directory returns {text:"", files:[]}', () => {
    expect(() => loadCorpus('/tmp/does-not-exist-1487-koliada')).not.toThrow()
    const { text, files } = loadCorpus('/tmp/does-not-exist-1487-koliada')
    expect(text).toBe('')
    expect(files).toEqual([])
  })
})

describe('loadCorpus — partial directory (some files present, some missing)', () => {
  let tmpDir: string
  beforeEach(() => {
    _resetCacheForTests()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koliada-test-'))
    fs.writeFileSync(path.join(tmpDir, FILE_NAMES[0]), 'lesson 1 content about protein')
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reads only the files that exist, does not throw on the missing 3', () => {
    const { text, files } = loadCorpus(tmpDir)
    expect(files).toHaveLength(1)
    expect(text).toContain('lesson 1 content about protein')
  })
})

describe('loadCorpus — mtime cache invalidation', () => {
  let tmpDir: string
  beforeEach(() => {
    _resetCacheForTests()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koliada-cache-test-'))
    fs.writeFileSync(path.join(tmpDir, FILE_NAMES[0]), 'version A')
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('a second call with unchanged mtimes returns the cached text (no re-read needed for correctness, but content matches)', () => {
    const first = loadCorpus(tmpDir)
    const second = loadCorpus(tmpDir)
    expect(second.text).toBe(first.text)
    expect(second.text).toContain('version A')
  })

  it('editing a file (new mtime) is picked up on the next call', async () => {
    loadCorpus(tmpDir)
    // Ensure the mtime actually advances (some filesystems have 1s resolution).
    await new Promise(r => setTimeout(r, 20))
    fs.writeFileSync(path.join(tmpDir, FILE_NAMES[0]), 'version B')
    const utimeMs = Date.now() + 5000
    fs.utimesSync(path.join(tmpDir, FILE_NAMES[0]), utimeMs / 1000, utimeMs / 1000)
    const second = loadCorpus(tmpDir)
    expect(second.text).toContain('version B')
    expect(second.text).not.toContain('version A')
  })
})

export {}
