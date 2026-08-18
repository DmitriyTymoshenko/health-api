/**
 * assertKyivDayBounds() — CANONICAL regression guard for the "date off-by-one" bug class
 * (task #1073, BATCH-4 umbrella over #825, #870, #971, #1045, #1052).
 *
 * Byte-for-byte mirror of dashboard/backend/src/test-utils/kyivDayBounds.ts. health-api and
 * dashboard/backend are SEPARATE git repos/npm packages (chuttyevo-dashboard vs
 * chuttyevo-agent), so a real shared npm package was out of scope for this batch — see #1073
 * Ф1 comment. Do NOT add a third, diverging implementation anywhere in this repo: every
 * consumer here imports THIS file.
 */

/** Byte-identical mirror of dashboard/backend conventions.ts::formatDateKyiv(). */
export function formatDateKyiv(date: Date): string {
  return date.toLocaleString('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export interface KyivDayBoundsExpectation {
  expectedFrom: string; // YYYY-MM-DD, Kyiv calendar day
  expectedTo: string; // YYYY-MM-DD, Kyiv calendar day
}

interface PeriodLike {
  from?: string;
  to?: string;
}

function extractPeriod(resp: any): PeriodLike {
  if (resp?.period && (resp.period.from !== undefined || resp.period.to !== undefined)) {
    return resp.period;
  }
  if (resp?.date_from !== undefined || resp?.date_to !== undefined) {
    return { from: resp.date_from, to: resp.date_to };
  }
  if (resp?.from !== undefined || resp?.to !== undefined) {
    return { from: resp.from, to: resp.to };
  }
  throw new Error(
    'assertKyivDayBounds: no period/from-to/date_from-date_to field found on response — ' +
      `got keys: ${Object.keys(resp ?? {}).join(', ')}`,
  );
}

const KYIV_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function daysDiff(a: string, b: string): number {
  return Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
}

export function assertKyivDayBounds(resp: any, { expectedFrom, expectedTo }: KyivDayBoundsExpectation): void {
  const { from, to } = extractPeriod(resp);

  if (!from || !KYIV_DAY_RE.test(from)) {
    throw new Error(
      `assertKyivDayBounds: period.from is not a bare YYYY-MM-DD Kyiv day: ${JSON.stringify(from)}`,
    );
  }
  if (!to || !KYIV_DAY_RE.test(to)) {
    throw new Error(`assertKyivDayBounds: period.to is not a bare YYYY-MM-DD Kyiv day: ${JSON.stringify(to)}`);
  }
  if (from !== expectedFrom) {
    const off = daysDiff(from, expectedFrom);
    throw new Error(
      `assertKyivDayBounds: period.from=${from} !== expected Kyiv day ${expectedFrom} ` +
        `(off by ${off}d${off === -1 ? ' — classic UTC-slice off-by-one' : ''})`,
    );
  }
  if (to !== expectedTo) {
    const off = daysDiff(to, expectedTo);
    throw new Error(
      `assertKyivDayBounds: period.to=${to} !== expected Kyiv day ${expectedTo} ` +
        `(off by ${off}d${off === -1 ? ' — classic UTC-slice off-by-one' : ''})`,
    );
  }
}

/** Byte-identical mirror of the dashboard/backend fixture — see there for full rationale. */
export const KYIV_MIDNIGHT_BOUNDARY_CASE = {
  utcInstant: '2026-07-31T21:00:00.000Z',
  kyivDay: '2026-08-01',
  utcInstantHalfPastMidnight: '2026-07-31T21:30:00.000Z',
} as const;
