'use strict'

// Grounding is quote presence in supplied source content, NOT medical validation.
// Legacy validateVerdict keeps {kind, by, ref?, quote?}; the detailed companion
// exposes provenance separately so existing persisted verdict schemas stay valid.
const VALID_KINDS = new Set(['confirms', 'neutral', 'against', 'not_covered'])
const EXTERNAL_ALLOWLIST_DOMAINS = ['examine.com', 'cochranelibrary.com', 'ods.od.nih.gov', 'pubmed.ncbi.nlm.nih.gov']
const LESSON_REF_RE = /(?:lessons?|урок)\s*\d+/i
const EXACT_LESSON_RE = /^(?:lessons?|урок)\s*(\d+)(?:\s*[-–—]\s*(\d+))?$/i
const NOT_COVERED = Object.freeze({ kind: 'not_covered', by: 'external' })

function normalizeWhitespace(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
}
function normalizeForSubstring(s) {
  return normalizeWhitespace(s).toLowerCase().replace(/[«»“”„"'`]/g, '')
    .replace(/[–—-]/g, ' ').replace(/[()[\]{}.,:;!?/\\|*_~]+/g, ' ').replace(/\s+/g, ' ').trim()
}
function lessonKey(ref) {
  const m = normalizeWhitespace(ref).match(EXACT_LESSON_RE)
  if (!m || Number(m[1]) < 1 || (m[2] && Number(m[2]) < Number(m[1]))) return null
  return m[2] ? Number(m[1]) + '-' + Number(m[2]) : String(Number(m[1]))
}
function metadataRef(line) {
  // Only source metadata, never arbitrary mentions of a lesson in prose.
  if (!/^(?:#{1,6}\s+|title:\s*)/i.test(line)) return null
  const refs = line.match(/(?:lessons?|урок)\s*\d+(?:\s*[-–—]\s*\d+)?/gi)
  return refs && refs.length === 1 ? lessonKey(refs[0]) : null
}
function sourceBlocks(corpusText) {
  if (typeof corpusText !== 'string') return []
  const blocks = []
  let ref = null
  let frontmatter = false
  let lines = []
  const flush = () => { if (ref) blocks.push({ ref, text: lines.join('\n') }); lines = [] }
  const sourceLines = corpusText.split(/\r?\n/)
  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i]
    if (/^---\s*$/.test(line)) {
      if (frontmatter) { frontmatter = false; continue }
      flush(); ref = null
      frontmatter = /^(?:id|title):/.test(sourceLines[i + 1] || '')
      continue
    }
    const next = metadataRef(line)
    if (next) { flush(); ref = next; continue }
    // A new document or unnamed top-level heading cannot inherit attribution.
    if (/^title:|^#\s+|^---\s*$/i.test(line)) { flush(); ref = null; continue }
    if (!frontmatter) lines.push(line)
  }
  flush()
  return blocks
}
function koliadaBlocks(text) {
  if (typeof text !== 'string') return []
  if (!text.includes('[[KOLIADA_SNIPPET_')) return sourceBlocks(text)
  const blocks = []
  const re = /^\[\[KOLIADA_SNIPPET_\d+ \| ([^\n|]+) \| lines \d+-\d+\]\]\r?\n([\s\S]*?)(?=^\[\[KOLIADA_SNIPPET_|$(?![\s\S]))/gm
  for (const m of text.matchAll(re)) {
    const ref = lessonKey(m[1])
    if (!ref) continue
    // Retrieval context can straddle a source boundary. Fail closed rather
    // than attributing the entire context window to its hit-line's lesson.
    const metadata = m[2].split(/\r?\n/).map(metadataRef).filter(Boolean)
    if (metadata.some(other => other !== ref)) continue
    blocks.push({ ref, text: m[2].replace(/\n\n---\s*$/, '') })
  }
  return blocks
}
function isAllowlistedUrl(ref) {
  try {
    const u = new URL(typeof ref === 'string' ? ref : '')
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return false
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    return EXTERNAL_ALLOWLIST_DOMAINS.some(d => host === d || host.endsWith('.' + d))
  } catch { return false }
}
function canonicalUrl(ref) {
  try { const u = new URL(ref); u.hash = ''; return u.href } catch { return null }
}

/**
 * externalEvidence is a TRUSTED caller input [{url, text}], never a field of
 * the LLM verdict. No URL fetch or verification timestamp is invented here.
 * Current legacy callers provide none, so external claims fail closed.
 * quote_matched means literal normalized quote presence only, not that the
 * quote logically supports the claim, or that advice/dosage is clinically safe.
 */
function validateVerdictWithProvenance(verdict, corpusText, externalEvidence = []) {
  const fail = reason => ({ verdict: { ...NOT_COVERED }, provenance: { state: 'unverified', reason } })
  if (!verdict || typeof verdict !== 'object' || !VALID_KINDS.has(verdict.kind)) return fail('invalid_verdict')
  if (verdict.kind === 'not_covered') return { verdict: { ...NOT_COVERED }, provenance: { state: 'not_covered' } }
  const ref = typeof verdict.ref === 'string' ? verdict.ref : ''
  const quote = normalizeWhitespace(verdict.quote)
  const normalizedQuote = normalizeForSubstring(quote)
  if (!normalizedQuote || quote.length > 300) return fail('missing_or_invalid_quote')
  if (verdict.by === 'koliada') {
    const key = lessonKey(ref)
    const matched = key && koliadaBlocks(corpusText).some(b => b.ref === key && normalizeForSubstring(b.text).includes(normalizedQuote))
    if (!matched) return fail('source_quote_mismatch')
    return { verdict: { kind: verdict.kind, by: 'koliada', ref, quote }, provenance: { state: 'quote_matched', source: 'koliada', ref } }
  }
  if (verdict.by === 'external') {
    if (!isAllowlistedUrl(ref)) return fail('source_not_allowed')
    const evidence = Array.isArray(externalEvidence) ? externalEvidence : []
    const matched = evidence.some(e => e && canonicalUrl(e.url) === canonicalUrl(ref) &&
      typeof e.text === 'string' && normalizeForSubstring(e.text).includes(normalizedQuote))
    if (!matched) return fail('external_content_unverified')
    return { verdict: { kind: verdict.kind, by: 'external', ref, quote }, provenance: { state: 'quote_matched', source: 'external', ref } }
  }
  return fail('invalid_source')
}
function validateVerdict(verdict, corpusText, externalEvidence) {
  return validateVerdictWithProvenance(verdict, corpusText, externalEvidence).verdict
}
module.exports = { validateVerdict, validateVerdictWithProvenance, isAllowlistedUrl, EXTERNAL_ALLOWLIST_DOMAINS, LESSON_REF_RE, normalizeForSubstring, metadataRef }
