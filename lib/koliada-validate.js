'use strict'

// #1487 (stage B of #1485, design D3): deterministic grounding validator for
// an LLM-produced "does the Koliada course / an external source cover this
// supplement" verdict. Canon lesson (rules/lessons-learned.md, "Prompt And
// LLM Calls"): "An acceptance gate on a non-deterministic LLM OUTPUT is not a
// correctness bar — make the LLM fill a declarative contract, validate that
// deterministically." The LLM is free to CLAIM `by:'koliada', ref:'lesson 12',
// quote:'...'` — this file is the only thing standing between that claim and
// a `supplement_knowledge` doc that looks authoritative but is fabricated.
//
// Contract (owner design D3): { kind, by, ref, quote }
//   kind: 'confirms' | 'neutral' | 'against' | 'not_covered'
//   by:   'koliada' | 'external'
//   ref:  a lesson reference ("lesson N"/"урок N") when by==='koliada',
//         or a URL when by==='external'
//   quote: string, ≤300 chars — REQUIRED to actually validate a 'koliada' claim
//
// Rules:
//   by==='koliada' is accepted ONLY IF:
//     (a) `ref` matches /lessons?\s*\d+/i or /урок\s*\d+/i, AND
//     (b) `quote` (after normalization) is a literal substring of the corpus
//         excerpt text (also normalized) — a fabricated quote or a real quote
//         that just paraphrases the provided excerpts both fail this, by
//         design: paraphrase-matching is exactly the class of "looks grounded
//         but isn't" this validator exists to catch.
//   Failing either (a) or (b) downgrades the ENTIRE verdict to
//   { kind: 'not_covered', by: 'external' } (no quote/ref carried over —
//   an ungrounded claim must not leak into the stored doc) and logs
//   KOLIADA_QUOTE_UNGROUNDED for observability.
//
//   by==='external' is accepted ONLY IF `ref` is a URL on the allowlist
//   domain set below; otherwise downgraded to `{kind:'not_covered', by:'external'}`
//   (ref/quote dropped) — same reasoning, just a different grounding source.
//
//   'against' keeps its kind through the same grounding checks as 'confirms'/
//   'neutral' — being negative evidence doesn't exempt a claim from grounding.

const VALID_KINDS = new Set(['confirms', 'neutral', 'against', 'not_covered'])
const EXTERNAL_ALLOWLIST_DOMAINS = [
  'examine.com',
  'cochranelibrary.com',
  'ods.od.nih.gov',
  'pubmed.ncbi.nlm.nih.gov',
]
const LESSON_REF_RE = /(?:lessons?|урок)\s*\d+/i

function normalizeWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function normalizeForSubstring(s) {
  return normalizeWhitespace(s)
    .toLowerCase()
    .replace(/[«»“”„"'`]/g, '')
    .replace(/[–—-]/g, ' ')
    .replace(/[()[\]{}.,:;!?/\\|*_~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isAllowlistedUrl(ref) {
  let u
  try {
    u = new URL(String(ref || ''))
  } catch {
    return false
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  return EXTERNAL_ALLOWLIST_DOMAINS.some(d => host === d || host.endsWith(`.${d}`))
}

const NOT_COVERED = Object.freeze({ kind: 'not_covered', by: 'external' })

/**
 * Validate one verdict object against the corpus text. Never throws — an
 * invalid/malformed input degrades to NOT_COVERED, same as a failed grounding
 * check, because "the LLM returned garbage" and "the LLM's grounding claim
 * doesn't hold up" both mean the same thing to a caller: don't trust this.
 */
function validateVerdict(verdict, corpusText) {
  if (!verdict || typeof verdict !== 'object') return { ...NOT_COVERED }
  const kind = VALID_KINDS.has(verdict.kind) ? verdict.kind : 'not_covered'
  if (kind === 'not_covered') return { ...NOT_COVERED }

  if (verdict.by === 'koliada') {
    const ref = String(verdict.ref || '')
    const quote = normalizeWhitespace(verdict.quote).slice(0, 300)
    const refOk = LESSON_REF_RE.test(ref)
    const normalizedCorpus = normalizeForSubstring(corpusText)
    const quoteOk = quote.length > 0 && normalizedCorpus.includes(normalizeForSubstring(quote))
    if (refOk && quoteOk) {
      return { kind, by: 'koliada', ref, quote }
    }
    console.warn('KOLIADA_QUOTE_UNGROUNDED', JSON.stringify({ ref: verdict.ref, quotePreview: String(verdict.quote || '').slice(0, 80) }))
    return { ...NOT_COVERED }
  }

  if (verdict.by === 'external') {
    const ref = String(verdict.ref || '')
    if (isAllowlistedUrl(ref)) {
      return { kind, by: 'external', ref }
    }
    return { ...NOT_COVERED }
  }

  return { ...NOT_COVERED }
}

module.exports = { validateVerdict, isAllowlistedUrl, EXTERNAL_ALLOWLIST_DOMAINS, LESSON_REF_RE, normalizeForSubstring }
