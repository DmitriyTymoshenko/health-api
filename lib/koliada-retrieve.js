'use strict'

// #1488 D3': retrieval-first grounding for Koliada evidence. Instead of
// placing the whole ~270KB course distillate into a Gemini prompt and hoping
// the model notices the relevant paragraph, callers pass supplement/lab terms
// here and get only deterministic, line-numbered excerpts. The validator then
// checks quotes against those excerpts (after normalization), so a Koliada
// verdict can only cite text that was actually shown to the model.

const DEFAULT_CONTEXT_LINES = 2
const DEFAULT_LIMIT = 12

const SYNONYMS = new Map([
  ['vitamin d', ['vitamin d', 'vitamin d3', '25-oh', '25(oh)', '25-oh-d3', 'вітамін d', 'витамин d']],
  ['vitamin_d', ['vitamin d', 'vitamin d3', '25-oh', '25(oh)', '25-oh-d3']],
  ['d3', ['vitamin d', 'vitamin d3', '25-oh', '25(oh)']],
  ['omega', ['omega', 'omega-3', 'omega 3', 'epa', 'dha', 'омега']],
  ['omega-3', ['omega', 'omega-3', 'omega 3', 'epa', 'dha']],
  ['fish oil', ['omega', 'omega-3', 'epa', 'dha', 'fish oil']],
  ['vitamin c', ['vitamin c', 'ascorbic', 'вітамін c', 'витамин c']],
  ['zinc', ['zinc', 'цинк']],
  ['magnesium', ['magnesium', 'магній', 'магний']],
  ['mg', ['magnesium']],
  ['zma', ['zinc', 'magnesium', 'b6', 'vitamin b6']],
  ['creatine', ['creatine', 'креатин']],
  ['beta alanine', ['beta-alanine', 'beta alanine', 'бета-аланін', 'бета аланін']],
  ['beta-alanine', ['beta-alanine', 'beta alanine']],
  ['iron', ['iron', 'ferritin', 'залізо', 'феритин']],
  ['ferritin', ['iron', 'ferritin']],
  ['b12', ['b12', 'vitamin b12', 'cobalamin']],
  ['folate', ['folate', 'folic', 'b9']],
  ['homocysteine', ['homocysteine', 'mthfr', 'b12', 'folate']],
  ['lion', ['lion', "lion's mane", 'hericium']],
])

function normalizeTerm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[_/()+[\]{}.,:;'"`!?|]+/g, ' ')
    .replace(/[–—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function expandTerms(terms) {
  const out = new Set()
  for (const raw of terms || []) {
    const term = normalizeTerm(raw)
    if (!term) continue
    out.add(term)
    for (const [key, values] of SYNONYMS.entries()) {
      if (term === key || term.includes(key) || key.includes(term)) {
        values.forEach(v => out.add(normalizeTerm(v)))
      }
    }
    // Split product names like "Omega 3 + Vitamin D3" into usable pieces.
    for (const part of term.split(/\s+\+\s+|\s+and\s+|\s*,\s*/)) {
      const p = normalizeTerm(part)
      if (p && p !== term) out.add(p)
    }
  }
  return [...out].filter(t => t.length >= 2)
}

function lineMatches(line, terms) {
  const normalized = normalizeTerm(line)
  return terms.some(t => normalized.includes(t))
}

function nearestLessonRef(lines, idx) {
  let headingFallback = null
  for (let i = idx; i >= 0; i--) {
    const line = lines[i] || ''
    const explicit = line.match(/(?:lessons?|урок)\s*\d+(?:\s*[–-]\s*\d+)?/i)
    if (explicit) return explicit[0].replace(/\s+/g, ' ')
    if (/^#{1,3}\s+/.test(line)) {
      const title = line.replace(/^#{1,3}\s+/, '').trim()
      if (title && !headingFallback) headingFallback = title
    }
  }
  return headingFallback || 'Koliada excerpt'
}

function retrieveKoliadaSnippets(corpusText, queryTerms, opts = {}) {
  const terms = expandTerms(queryTerms)
  if (!corpusText || terms.length === 0) return []

  const contextLines = opts.contextLines ?? DEFAULT_CONTEXT_LINES
  const limit = opts.limit ?? DEFAULT_LIMIT
  const lines = String(corpusText).split(/\r?\n/)
  const windows = []
  const seen = new Set()

  for (let i = 0; i < lines.length; i++) {
    if (!lineMatches(lines[i], terms)) continue
    const start = Math.max(0, i - contextLines)
    const end = Math.min(lines.length - 1, i + contextLines)
    const key = `${start}:${end}`
    if (seen.has(key)) continue
    seen.add(key)
    const hitTerms = terms.filter(t => normalizeTerm(lines[i]).includes(t))
    windows.push({
      ref: nearestLessonRef(lines, i),
      startLine: start + 1,
      endLine: end + 1,
      hitLine: i + 1,
      terms: hitTerms,
      text: lines.slice(start, end + 1).join('\n').trim(),
    })
    if (windows.length >= limit) break
  }

  return windows
}

function formatSnippets(snippets) {
  if (!snippets || snippets.length === 0) return '(no relevant Koliada excerpts found for the requested supplement/lab terms)'
  return snippets.map((s, idx) => (
    `[[KOLIADA_SNIPPET_${idx + 1} | ${s.ref} | lines ${s.startLine}-${s.endLine}]]\n${s.text}`
  )).join('\n\n---\n\n')
}

function termsFromStackAndLabs(activeStack, latestLabs) {
  const terms = []
  for (const item of activeStack || []) {
    terms.push(item.short_name, item.name, item.brand, item.dose, item.notes)
  }
  for (const marker of Object.keys(latestLabs || {})) {
    terms.push(marker)
  }
  return terms
}

module.exports = {
  retrieveKoliadaSnippets,
  formatSnippets,
  expandTerms,
  termsFromStackAndLabs,
}
