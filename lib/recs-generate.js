'use strict'

// #1488 (stage C of #1485): prompt + response schema for the supplement
// recommendations generator. Pure/testable — no fetch, no Mongo — the route
// (routes/supplement_catalog.js) gathers the inputs (active stack, labs,
// WHOOP, corpus) and calls lib/gemini-text.js::callGemini with these.

const RECS_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          key: { type: 'STRING' },
          name: { type: 'STRING' },
          reason: { type: 'STRING' },
          source: { type: 'STRING', enum: ['lab', 'whoop', 'koliada', 'external'] },
          lab_marker: { type: 'STRING', nullable: true },
          verdict: {
            type: 'OBJECT',
            properties: {
              kind: { type: 'STRING', enum: ['confirms', 'neutral', 'against', 'not_covered'] },
              by: { type: 'STRING', enum: ['koliada', 'external'] },
              ref: { type: 'STRING' },
              quote: { type: 'STRING' },
            },
            required: ['kind', 'by', 'ref'],
          },
          suggested_dose: { type: 'STRING' },
          suggested_schedule: { type: 'STRING', enum: ['morning', 'pre_meal', 'pre_workout', 'evening'] },
          continuous: { type: 'BOOLEAN' },
          cycle_duration_weeks: { type: 'INTEGER', nullable: true },
          cycle_pause_weeks: { type: 'INTEGER', nullable: true },
        },
        required: ['key', 'name', 'reason', 'source', 'verdict', 'suggested_dose', 'suggested_schedule', 'continuous'],
      },
    },
  },
  required: ['items'],
}

const STALE_LAB_PROMPT_THRESHOLD_DAYS = 30

function formatStackLine(s, knowledge) {
  const k = knowledge
  const regime = k?.continuous === true ? 'continuous' : k?.continuous === false ? `cycled (${k.cycle?.duration_weeks || '?'}w on / ${k.cycle?.pause_weeks || 0}w off)` : 'regime unknown'
  return `- ${s.short_name || s.name} (${s.schedule}, ${s.dose || 'dose unknown'}) — ${regime}`
}

function formatLabLine(marker, entry) {
  const stale = entry.age_days > STALE_LAB_PROMPT_THRESHOLD_DAYS
  const staleTag = stale ? ' [STALE — do not give a dosing recommendation off this value, only note it needs a retest]' : ''
  return `- ${marker}: ${entry.value} ${entry.ref?.unit || ''} (${entry.status}, tested ${entry.date}, ${entry.age_days}d ago)${staleTag}`
}

function formatWhoopLine(latest) {
  if (!latest) return 'No recent WHOOP data available.'
  const parts = []
  if (latest.recovery_score != null) parts.push(`Recovery ${latest.recovery_score}%`)
  if (latest.hrv_rmssd != null) parts.push(`HRV ${Math.round(latest.hrv_rmssd)}ms`)
  if (latest.sleep_performance != null) parts.push(`Sleep performance ${latest.sleep_performance}%`)
  if (latest.sleep_deep_hours != null) parts.push(`Deep sleep ${latest.sleep_deep_hours}h`)
  if (latest.strain != null) parts.push(`Strain ${latest.strain.toFixed?.(1) ?? latest.strain}`)
  if (latest.spo2_percentage != null) parts.push(`SpO2 ${latest.spo2_percentage}%`)
  return parts.length ? `Latest WHOOP (${latest.date}): ${parts.join(', ')}` : 'No usable WHOOP fields in the latest record.'
}

/**
 * Builds the full generation prompt. `activeStack` = array of catalog docs
 * (active:false already excluded by the caller). `knowledgeByCatalogId` =
 * Map<catalog_id, knowledgeDoc>. `latestLabs` = output of
 * lib/labs-latest.js::fetchLatestLabs. `whoopLatest` = latest daily_metrics
 * doc or null. `corpusText` = full Koliada corpus (lib/koliada-corpus.js).
 */
function buildRecsPrompt({ activeStack, knowledgeByCatalogId, latestLabs, whoopLatest, corpusText }) {
  const stackLines = activeStack.length
    ? activeStack.map(s => formatStackLine(s, knowledgeByCatalogId.get(s.id))).join('\n')
    : '(empty — no supplements currently tracked)'
  const labLines = Object.entries(latestLabs || {}).length
    ? Object.entries(latestLabs).map(([marker, entry]) => formatLabLine(marker, entry)).join('\n')
    : '(no lab results on file)'
  const whoopLine = formatWhoopLine(whoopLatest)

  return `You are a supplement advisor for a health-tracking app. Given the person's CURRENT supplement stack, recent lab results, recent WHOOP recovery/sleep/strain data, and a nutrition-course corpus (distilled from Oleksandr Koliada's course, Ukrainian), produce a JSON list of supplement recommendations.

Each item is EITHER (a) a NEW supplement to consider adding (not already in the current stack) OR (b) a flag on an EXISTING stack item if you have real evidence it may be unhelpful or contraindicated (use verdict.kind:"against" and set "name" to match the existing item's name exactly).

For EVERY item, cite your evidence: if the Koliada corpus discusses it directly, cite a real "Lesson N"/"урок N" reference AND a verbatim quote copied character-for-character from the corpus — never paraphrase, never invent a citation. If the corpus doesn't cover it, cite a reputable external source (examine.com, cochranelibrary.com, ods.od.nih.gov, or pubmed.ncbi.nlm.nih.gov) by URL. If you are not confident either way, set verdict.kind to "not_covered" — this is honest and expected, not a failure.

Any item derived from a LAB marker marked [STALE] above must NOT include a dosing recommendation — only note the marker needs a retest (or omit it; the app already surfaces stale-lab warnings separately).

Do NOT recommend anything already in the current stack (listed below) unless you are flagging it as "against".

=== CURRENT STACK ===
${stackLines}

=== RECENT LAB RESULTS ===
${labLines}

=== RECENT WHOOP ===
${whoopLine}

Respond with ONLY the JSON object matching the schema (a single "items" array, possibly empty).

=== KOLIADA CORPUS START ===
${corpusText}
=== KOLIADA CORPUS END ===`
}

/**
 * Maps one raw LLM item (already schema-shaped, pre-postprocess) into the
 * `recommendations[]` shape from the GET /recommendations contract —
 * attaches `lab` (from latestLabs, keyed by lab_marker) and `suggested`
 * (the exact body a caller would POST to /api/catalog to add it, including
 * the knowledge block stage B's autocycle wiring expects).
 */
function toRawCandidate(item, latestLabs) {
  const labEntry = item.lab_marker ? latestLabs[item.lab_marker] : null
  return {
    key: item.key,
    name: item.name,
    reason: item.reason,
    source: item.source,
    lab: labEntry ? { marker: item.lab_marker, value: labEntry.value, unit: labEntry.ref?.unit || null, test_date: labEntry.date, age_days: labEntry.age_days } : null,
    verdict: item.verdict,
    suggested: {
      short_name: item.name,
      dose: item.suggested_dose,
      schedule: item.suggested_schedule,
      knowledge: {
        continuous: !!item.continuous,
        cycle: item.continuous ? null : { duration_weeks: item.cycle_duration_weeks || 8, pause_weeks: item.cycle_pause_weeks || 0 },
        purchase_verified: false,
      },
    },
  }
}

module.exports = { RECS_RESPONSE_SCHEMA, buildRecsPrompt, toRawCandidate, STALE_LAB_PROMPT_THRESHOLD_DAYS }
