/**
 * whoop-token.test.ts — unit tests for the token-rotation logic in sync-whoop.js
 *
 * Covers every branch of the 2026-08-03 fix:
 *   1. clean rotation (2xx first try) — refresh_token_prev stashed
 *   2. 5xx → one retry → 5xx → TransientRefreshError (no blind 3×, no alert)
 *   3. 5xx → one retry → 2xx (Ory reuse-window recovery)
 *   4. 4xx (current) → 2xx (prev) → "recovered via prev token"
 *   5. 4xx (current) → 4xx (prev) → ReauthRequiredError + dedup alert ONCE
 *   6. 4xx, no prev → ReauthRequiredError + alert
 *   7. getToken threshold logic (15min window + 1h anti-churn + expired override)
 *   8. alertReauthIfDue dedup (≥24h gate)
 *
 * Each branch verified RED against the pre-fix file (see RED-verification step in
 * the task proof): the pre-fix sync-whoop.js has no TransientRefreshError, no
 * prev-token fallback, and a 3× blind retry — so the branch-specific assertions
 * below either fail to compile or fail to match.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require('../../scripts/sync-whoop')
const { refreshToken, getToken, alertReauthIfDue, ReauthRequiredError, TransientRefreshError,
  REFRESH_THRESHOLD_MS, MIN_REFRESH_INTERVAL_MS, REAUTH_DEDUP_HOURS } = mod as {
    refreshToken: (c: any, deps?: any) => Promise<any>
    getToken: (deps?: any) => Promise<string>
    alertReauthIfDue: (detail: string, deps?: any) => Promise<boolean>
    ReauthRequiredError: any
    TransientRefreshError: any
    REFRESH_THRESHOLD_MS: number
    MIN_REFRESH_INTERVAL_MS: number
    REAUTH_DEDUP_HOURS: number
  }

// ── Helpers ──────────────────────────────────────────────────────────────────
// Build a mock httpRequest that returns a queue of responses (values or throws).
function mockHttp(queue: Array<{ data?: any; err?: string }>) {
  let i = 0
  const calls: any[] = []
  const fn = jest.fn(async (url: string, opts: any, body: string) => {
    calls.push({ url, opts, body })
    const next = queue[Math.min(i, queue.length - 1)]
    i++
    if (next.err) throw new Error(next.err)
    return next.data
  })
  return { fn, calls }
}

function baseCreds(over: Record<string, any> = {}) {
  return {
    client_id: 'cid',
    client_secret: 'csec',
    access_token: 'ACCESS',
    refresh_token: 'RT_CUR',
    refresh_token_prev: 'RT_PREV',
    token_expires_at: '2026-08-03T11:00:00.000Z',
    ...over,
  }
}

function depsWith(http: ReturnType<typeof mockHttp>, over: Record<string, any> = {}) {
  return {
    httpRequest: http.fn,
    readCreds: () => baseCreds(),
    writeCreds: jest.fn(),
    log: jest.fn(),
    sleep: jest.fn(async () => {}),
    alertReauthIfDue: jest.fn(async () => true),
    now: () => Date.parse('2026-08-03T10:00:00.000Z'), // 1h before token expiry
    ...over,
  }
}

// ── 1. Clean rotation: refresh_token_prev stashed, rotated token persisted ──
describe('refreshToken — clean 2xx rotation', () => {
  it('stashes the just-used token as refresh_token_prev and persists new token', async () => {
    const http = mockHttp([{ data: { access_token: 'A2', refresh_token: 'RT_NEW', expires_in: 3600 } }])
    const deps = depsWith(http)
    const out = await refreshToken(baseCreds(), deps)

    expect(out.access_token).toBe('A2')
    expect(out.refresh_token).toBe('RT_NEW')
    expect(out.refresh_token_prev).toBe('RT_CUR') // the token that just worked
    expect(deps.writeCreds).toHaveBeenCalledTimes(1)
    expect(http.calls).toHaveLength(1)
    // scope=offline MUST be present (lesson 2026-07-31)
    expect(http.calls[0].body).toContain('scope=offline')
  })
})

// ── 2. 5xx → one retry → 5xx → TransientRefreshError (no alert, no write) ─────
describe('refreshToken — persistent 5xx throws Transient (no blind 3×)', () => {
  it('retries ONCE after a 60s pause, then throws TransientRefreshError', async () => {
    const http = mockHttp([{ err: 'HTTP 502: Bad Gateway' }, { err: 'HTTP 502: Bad Gateway' }])
    const deps = depsWith(http)
    await expect(refreshToken(baseCreds(), deps)).rejects.toThrow(/WHOOP_REFRESH_TRANSIENT/)

    expect(http.calls).toHaveLength(2)            // exactly one retry, NOT three
    expect(deps.sleep).toHaveBeenCalledTimes(1)   // the 60s pause before the retry
    expect(deps.writeCreds).not.toHaveBeenCalled()
    expect(deps.alertReauthIfDue).not.toHaveBeenCalled() // 5xx is not a reauth crisis
  })

  it('both attempts send the SAME refresh_token (no rotation between retries)', async () => {
    const http = mockHttp([{ err: 'HTTP 503' }, { err: 'HTTP 503' }])
    const deps = depsWith(http)
    await expect(refreshToken(baseCreds(), deps)).rejects.toThrow()
    expect(http.calls[0].body).toContain('refresh_token=RT_CUR')
    expect(http.calls[1].body).toContain('refresh_token=RT_CUR')
  })

  it('network error (no HTTP code) is treated as transient → retry then Transient', async () => {
    const http = mockHttp([{ err: 'connect ECONNRESET' }, { err: 'connect ETIMEDOUT' }])
    const deps = depsWith(http)
    await expect(refreshToken(baseCreds(), deps)).rejects.toThrow(/WHOOP_REFRESH_TRANSIENT/)
    expect(deps.sleep).toHaveBeenCalledTimes(1)
  })
})

// ── 3. 5xx → retry → 2xx (Ory reuse-window recovery) ─────────────────────────
describe('refreshToken — 5xx then 2xx recovers via reuse window', () => {
  it('pauses once, retries the same token, and persists the rotation', async () => {
    const http = mockHttp([
      { err: 'HTTP 502: Bad Gateway' },
      { data: { access_token: 'A2', refresh_token: 'RT_NEW', expires_in: 3600 } },
    ])
    const deps = depsWith(http)
    const out = await refreshToken(baseCreds(), deps)

    expect(out.access_token).toBe('A2')
    expect(out.refresh_token).toBe('RT_NEW')
    expect(out.refresh_token_prev).toBe('RT_CUR')
    expect(deps.sleep).toHaveBeenCalledTimes(1)
    expect(deps.writeCreds).toHaveBeenCalledTimes(1)
  })
})

// ── 4. 4xx (current) → 2xx (prev) → "recovered via prev token" ───────────────
describe('refreshToken — prev-token fallback', () => {
  it('recovers via refresh_token_prev and logs it, without alerting', async () => {
    const http = mockHttp([
      { err: 'HTTP 400: invalid_grant' }, // current rejected
      { data: { access_token: 'A2', refresh_token: 'RT_NEW', expires_in: 3600 } }, // prev works
    ])
    const deps = depsWith(http)
    const out = await refreshToken(baseCreds(), deps)

    expect(out.access_token).toBe('A2')
    expect(out.refresh_token).toBe('RT_NEW')
    // second call used the prev token
    expect(http.calls[1].body).toContain('refresh_token=RT_PREV')
    // alert is NOT raised — we recovered
    expect(deps.alertReauthIfDue).not.toHaveBeenCalled()
    // recovery was logged with the canonical marker
    const logs = deps.log.mock.calls.map((c: any[]) => c[0]).join('\n')
    expect(logs).toMatch(/recovered via prev token/)
  })

  it('does NOT retry the current token on 4xx (falls straight through to prev)', async () => {
    const http = mockHttp([
      { err: 'HTTP 400: invalid_grant' },
      { data: { access_token: 'A2', refresh_token: 'RT_NEW', expires_in: 3600 } },
    ])
    const deps = depsWith(http)
    await refreshToken(baseCreds(), deps)
    expect(http.calls).toHaveLength(2) // current once, prev once — no sleep, no 3rd call
    expect(deps.sleep).not.toHaveBeenCalled()
  })
})

// ── 5. 4xx + 4xx → ReauthRequiredError + dedup alert EXACTLY ONCE ────────────
describe('refreshToken — definitive reauth crisis', () => {
  it('alerts once (dedup) and throws ReauthRequiredError when both tokens rejected', async () => {
    const http = mockHttp([
      { err: 'HTTP 400: invalid_grant' },
      { err: 'HTTP 400: invalid_grant' },
    ])
    const deps = depsWith(http)
    await expect(refreshToken(baseCreds(), deps)).rejects.toThrow(/WHOOP_REAUTH_REQUIRED/)
    expect(deps.alertReauthIfDue).toHaveBeenCalledTimes(1) // NOT 48×
    expect(deps.writeCreds).not.toHaveBeenCalled()
  })
})

// ── 6. 4xx with no prev token → alert + ReauthRequiredError ──────────────────
describe('refreshToken — no prev to fall back to', () => {
  it('alerts and throws when refresh_token_prev is absent', async () => {
    const http = mockHttp([{ err: 'HTTP 400: invalid_grant' }])
    const creds = baseCreds({ refresh_token_prev: undefined })
    const deps = depsWith(http)
    await expect(refreshToken(creds, deps)).rejects.toThrow(/no prev token/)
    expect(deps.alertReauthIfDue).toHaveBeenCalledTimes(1)
    expect(http.calls).toHaveLength(1) // never tried prev (there is none)
  })

  it('treats prev === current as "no prev" (avoids retrying the same dead token)', async () => {
    const http = mockHttp([{ err: 'HTTP 400: invalid_grant' }])
    const creds = baseCreds({ refresh_token_prev: 'RT_CUR' }) // same as current
    const deps = depsWith(http)
    await expect(refreshToken(creds, deps)).rejects.toThrow(/no prev token/)
    expect(http.calls).toHaveLength(1)
  })
})

// ── 7. getToken — threshold + anti-churn + expired override + transient handling ─
describe('getToken — when to refresh', () => {
  function tokenDeps(over: Record<string, any> = {}) {
    const refresh = jest.fn(async (creds: any) => ({ ...creds, access_token: 'REFRESHED' }))
    const fixedNow = Date.parse('2026-08-03T10:00:00.000Z')
    return {
      deps: {
        readCreds: () => baseCreds(),
        refreshToken: refresh,
        log: jest.fn(),
        now: () => fixedNow,
        ...over,
      },
      refresh,
      fixedNow,
    }
  }

  it('refreshes when token is within the 15-min threshold and not churned', async () => {
    // token expires 11:00; now=10:46 → 14min < 15min threshold → refresh
    const { deps, refresh } = tokenDeps({
      readCreds: () => baseCreds({ token_expires_at: '2026-08-03T10:46:00.000Z' }),
      now: () => Date.parse('2026-08-03T10:46:00.000Z'),
    })
    const tok = await getToken(deps)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(tok).toBe('REFRESHED')
  })

  it('does NOT refresh when within threshold but refreshed recently (anti-churn)', async () => {
    // expires 10:50, now 10:46 → 4min left (within 15min threshold);
    // token_refreshed_at 10:41 → 5min ago (< 1h guard) → skip
    const { deps, refresh } = tokenDeps({
      readCreds: () => baseCreds({
        token_expires_at: '2026-08-03T10:50:00.000Z',
        token_refreshed_at: '2026-08-03T10:41:00.000Z', // 5min ago
      }),
      now: () => Date.parse('2026-08-03T10:46:00.000Z'),
    })
    const tok = await getToken(deps)
    expect(refresh).not.toHaveBeenCalled()
    expect(tok).toBe('ACCESS')
  })

  it('refreshes when EXPIRED even if the anti-churn guard would block (no token left)', async () => {
    const { deps, refresh } = tokenDeps({
      readCreds: () => baseCreds({
        token_expires_at: '2026-08-03T09:00:00.000Z', // already expired
        token_refreshed_at: '2026-08-03T09:59:00.000Z', // 1min ago — would block pre-refresh
      }),
      now: () => Date.parse('2026-08-03T10:00:00.000Z'),
    })
    const tok = await getToken(deps)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(tok).toBe('REFRESHED')
  })

  it('does NOT refresh when comfortably within lifetime', async () => {
    // expires 11:00, now 10:00 → 60min left, well outside 15min threshold
    const { deps, refresh } = tokenDeps()
    const tok = await getToken(deps)
    expect(refresh).not.toHaveBeenCalled()
    expect(tok).toBe('ACCESS')
  })

  it('transient failure with token still valid → continues on current access_token', async () => {
    // expires 10:50, now 10:46 → within 15min threshold but NOT expired;
    // refreshToken throws TransientRefreshError → fall back to current access_token
    const throwingRefresh = jest.fn(async () => { throw new TransientRefreshError('502 after retry') })
    const { deps } = tokenDeps({
      readCreds: () => baseCreds({ token_expires_at: '2026-08-03T10:50:00.000Z' }),
      now: () => Date.parse('2026-08-03T10:46:00.000Z'),
      refreshToken: throwingRefresh,
    })
    const tok = await getToken(deps)
    expect(tok).toBe('ACCESS') // kept going on the still-valid token
    expect(throwingRefresh).toHaveBeenCalledTimes(1)
  })

  it('transient failure with token EXPIRED → propagates TransientRefreshError', async () => {
    const { deps } = tokenDeps({
      readCreds: () => baseCreds({ token_expires_at: '2026-08-03T09:00:00.000Z' }),
      now: () => Date.parse('2026-08-03T10:00:00.000Z'),
      refreshToken: jest.fn(async () => { throw new TransientRefreshError('502 after retry') }),
    })
    await expect(getToken(deps)).rejects.toThrow(/WHOOP_REFRESH_TRANSIENT/)
  })
})

// ── 8. alertReauthIfDue — dedup gate (≥24h between alerts) ───────────────────
describe('alertReauthIfDue — dedup', () => {
  const baseDeps = (over: Record<string, any> = {}) => ({
    now: () => Date.parse('2026-08-03T10:00:00.000Z'),
    readFile: () => { throw new Error('ENOENT') }, // no prior alert by default
    writeFile: jest.fn(),
    sendTelegram: jest.fn(async () => true),
    ...over,
  })

  it('sends the alert when no prior alert file exists', async () => {
    const d = baseDeps()
    const sent = await alertReauthIfDue('current 400; prev 400', d)
    expect(sent).toBe(true)
    expect(d.sendTelegram).toHaveBeenCalledTimes(1)
    expect(d.writeFile).toHaveBeenCalledTimes(1) // persisted dedup timestamp
  })

  it('suppresses when the last alert was < 24h ago', async () => {
    const d = baseDeps({
      readFile: () => JSON.stringify({ last_alerted_at: '2026-08-03T05:00:00.000Z' }), // 5h ago
    })
    const sent = await alertReauthIfDue('current 400; prev 400', d)
    expect(sent).toBe(false)
    expect(d.sendTelegram).not.toHaveBeenCalled()
    expect(d.writeFile).not.toHaveBeenCalled()
  })

  it('sends again when the last alert was > 24h ago', async () => {
    const d = baseDeps({
      readFile: () => JSON.stringify({ last_alerted_at: '2026-08-02T05:00:00.000Z' }), // 29h ago
    })
    const sent = await alertReauthIfDue('current 400; prev 400', d)
    expect(sent).toBe(true)
    expect(d.sendTelegram).toHaveBeenCalledTimes(1)
  })
})

// ── Sanity: the constants match the approved plan ────────────────────────────
describe('token constants (approved plan)', () => {
  it('REFRESH_THRESHOLD_MS is ~15 minutes', () => {
    expect(REFRESH_THRESHOLD_MS).toBeGreaterThanOrEqual(14 * 60 * 1000)
    expect(REFRESH_THRESHOLD_MS).toBeLessThanOrEqual(16 * 60 * 1000)
  })
  it('MIN_REFRESH_INTERVAL_MS is ~1 hour', () => {
    expect(MIN_REFRESH_INTERVAL_MS).toBeGreaterThanOrEqual(55 * 60 * 1000)
  })
  it('REAUTH_DEDUP_HOURS is 24', () => {
    expect(REAUTH_DEDUP_HOURS).toBe(24)
  })
})
