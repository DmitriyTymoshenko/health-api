'use strict'

/**
 * Shared WHOOP-recovery-score → zone threshold — task #1292 (Ф3, readiness badge).
 *
 * Extracted VERBATIM from `routes/activity_plan.js` (`GET /api/activity-plan/suggest`,
 * measured live 09.09 + 19.09: still inline at lines ~114-116, `>=67 hard / >=34
 * moderate / else light`). This is the ONLY change made to that endpoint's logic —
 * the threshold values are copied unchanged, so `/suggest`'s live behavior and its
 * existing regression test (`activity_plan.test.ts`) are untouched.
 *
 * Why this file has to exist: #1292's acceptance requires `GET /api/readiness` to
 * report the SAME zone as `GET /api/activity-plan/suggest` for the same day. Two
 * independently-typed copies of "67"/"34" are two definitions of one metric — they
 * drift on the next owner re-tune (task body, 09.09). One function, two callers.
 */

const RECOVERY_ZONE_THRESHOLDS = { hard: 67, moderate: 34 }

/**
 * @param {number} recoveryScore
 * @returns {'hard'|'moderate'|'light'}
 */
function recoveryZone(recoveryScore) {
  if (recoveryScore >= RECOVERY_ZONE_THRESHOLDS.hard) return 'hard'
  if (recoveryScore >= RECOVERY_ZONE_THRESHOLDS.moderate) return 'moderate'
  return 'light'
}

// Readiness-badge vocabulary (#1292) maps 1:1 onto the same zone: hard=🟢, moderate=🟡,
// light=🔴. `/suggest` talks strain targets ("hard day"); `/readiness` talks
// go/hold/base — same underlying zone, different words for different audiences.
const ZONE_TO_COLOR = { hard: 'green', moderate: 'yellow', light: 'red' }

module.exports = { RECOVERY_ZONE_THRESHOLDS, recoveryZone, ZONE_TO_COLOR }
