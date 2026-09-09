'use strict'

/**
 * Free-text strength-session parser — task #1314. Owner dictates sessions in Telegram,
 * one line per exercise, in HIS OWN reference format (verified live against #1291's
 * "РЕФЕРЕНС ВЛАСНИКА" comment, 09.09):
 *
 *   Тяга блока:        8х52  · 8х66  · 8х73  · 8х73
 *
 * Contract (do NOT "fix" to the gym-common convention — this is the owner's own data,
 * verified against his literal quotes twice, #1291 §"РЕФЕРЕНС ВЛАСНИКА" point 1):
 *   - one line = one exercise. Exercise name is everything before the FIRST `:`.
 *   - one set token = `REPSxWEIGHT` — REPS FIRST, WEIGHT SECOND (reverse of the common
 *     gym notation "3x8 @80kg"). `8х80` = 8 reps at 80, never 80 reps at 8.
 *   - the `x` between reps/weight may be Cyrillic х/Х, Latin x/X, or × (U+00D7).
 *   - sets on a line are separated by `·` (U+00B7, the owner's own delimiter) or `,`;
 *     falls back to whitespace-run splitting if neither is present, so a session typed
 *     without the middle dot still parses.
 *
 * Pure parsing only — no DB access, no weight_kg conversion (that needs the exercise's
 * weight_unit from exercises_library, resolved by the caller per set — #1291 §5: unit
 * lives on the EXERCISE, not globally, and an unknown unit is an explicit state, never a
 * silent kg default).
 */

const SET_TOKEN_RE = /^(\d+)\s*[xXхХ×]\s*(\d+(?:[.,]\d+)?)$/

/**
 * @param {string} token e.g. "8х80"
 * @returns {{reps:number, weight_input:number}|null} null if the token doesn't match
 */
function parseSetToken(token) {
  const t = String(token || '').trim()
  if (!t) return null
  const m = t.match(SET_TOKEN_RE)
  if (!m) return null
  const reps = parseInt(m[1], 10)
  const weight_input = parseFloat(m[2].replace(',', '.'))
  if (!Number.isFinite(reps) || reps <= 0) return null
  if (!Number.isFinite(weight_input) || weight_input <= 0) return null
  return { reps, weight_input }
}

/**
 * Split a set-list string into raw tokens. Prefers the owner's own `·` delimiter,
 * falls back to `,`, falls back to whitespace between a delimiter-less run of tokens.
 * @param {string} setsRaw
 * @returns {string[]}
 */
function splitSetTokens(setsRaw) {
  const s = String(setsRaw || '').trim()
  if (!s) return []
  if (s.includes('·')) return s.split(/\s*·\s*/).map(t => t.trim()).filter(Boolean)
  if (s.includes(',')) return s.split(/\s*,\s*/).map(t => t.trim()).filter(Boolean)
  // No explicit delimiter — split before each new "digits + x" run.
  return s.split(/\s+(?=\d+\s*[xXхХ×])/).map(t => t.trim()).filter(Boolean)
}

/**
 * @param {string} text raw multi-line dictated session
 * @returns {{entries: Array<{name:string, sets: Array<{reps:number, weight_input:number}>}>, skipped: Array<{line:string, reason:string}>}}
 */
function parseWorkoutLogText(text) {
  const entries = []
  const skipped = []
  const lines = String(text || '').split(/\r?\n/)

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) {
      skipped.push({ line, reason: 'no_colon' })
      continue
    }

    const name = line.slice(0, colonIdx).trim()
    const setsRaw = line.slice(colonIdx + 1).trim()
    if (!name) {
      skipped.push({ line, reason: 'no_exercise_name' })
      continue
    }
    if (!setsRaw) {
      skipped.push({ line, reason: 'no_sets' })
      continue
    }

    const tokens = splitSetTokens(setsRaw)
    const sets = []
    let hadInvalidToken = false
    for (const tok of tokens) {
      const parsed = parseSetToken(tok)
      if (!parsed) {
        hadInvalidToken = true
        continue
      }
      sets.push(parsed)
    }

    if (sets.length === 0) {
      skipped.push({ line, reason: hadInvalidToken ? 'unparseable_sets' : 'no_sets' })
      continue
    }
    if (hadInvalidToken) {
      // Partial line — keep the sets we could parse, but flag it so the caller can
      // surface a warning (don't silently drop data, don't silently drop the line).
      skipped.push({ line, reason: 'partial_unparseable_sets' })
    }

    entries.push({ name, sets })
  }

  return { entries, skipped }
}

module.exports = { parseSetToken, splitSetTokens, parseWorkoutLogText, SET_TOKEN_RE }
