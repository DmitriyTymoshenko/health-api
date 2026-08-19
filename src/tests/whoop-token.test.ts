/**
 * whoop-token.test.ts — unit tests for the token-rotation logic in sync-whoop.js
 *
 * Covers every branch of the 2026-08-03 fix PLUS the #1029 hardening (2026-08-13):
 *   1. clean rotation (2xx first try) — refresh_token_prev stashed
 *   2. network-level failure (no HTTP status) → one retry → still failing → Transient
 *   3. pre-flight probe (#1029): gates the real refresh — 5xx/network on the probe
 *      itself skips the real refresh entirely (real token never spent); 4xx/2xx on
 *      the probe means proceed
 *   4. 5xx on the REAL refresh (#1029): no same-token retry — treated exactly like
 *      a 4xx, straight to refresh_token_prev
 *   5. 4xx (current) → 2xx (prev) → "recovered via prev token"
 *   6. 4xx (current) → 4xx (prev) → ReauthRequiredError + dedup alert ONCE
 *   7. 4xx, no prev → ReauthRequiredError + alert
 *   8. getToken threshold logic (15min window + 1h anti-churn + expired override)
 *   9. alertReauthIfDue dedup (≥24h gate) + #1029 authorize-link in the alert text
 *
 * Each #1029 branch verified RED against the pre-#1029 file (see RED-verification
 * step in the task proof): the pre-#1029 sync-whoop.js retries a 5xx with the SAME
 * refresh_token and has no pre-flight probe — so the #1029-specific assertions
 * below either fail to compile or fail to match against that version.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require('../../scripts/sync-whoop')
const { refreshToken, getToken, alertReauthIfDue, ReauthRequiredError, TransientRefreshError,
  REFRESH_THRESHOLD_MS, MIN_REFRESH_INTERVAL_MS, REAUTH_DEDUP_HOURS, RETRY_5XX_PAUSE_MS,
  DEFAULT_UA, buildRequestHeaders, captureSetCookie, cookieHeaderFor, resetCookieJar,
  markSyncSuccess, preflightProbe } = mod as {
    refreshToken: (c: any, deps?: any) => Promise<any>
    getToken: (deps?: any) => Promise<string>
    alertReauthIfDue: (detail: string, deps?: any) => Promise<boolean>
    ReauthRequiredError: any
    TransientRefreshError: any
    REFRESH_THRESHOLD_MS: number
    MIN_REFRESH_INTERVAL_MS: number
    REAUTH_DEDUP_HOURS: number
    RETRY_5XX_PAUSE_MS: number
    DEFAULT_UA: string
    buildRequestHeaders: (opts: any, host: string) => Record<string, string>
    captureSetCookie: (host: string, setCookieHeader: string | string[] | undefined) => void
    cookieHeaderFor: (host: string) => string | null
    resetCookieJar: () => void
    markSyncSuccess: (deps?: any) => boolean
    preflightProbe: (creds: any, d: any) => Promise<{ ok: boolean, detail?: string }>
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
    sleep: jest.fn(async (_ms: number) => {}),
    alertReauthIfDue: jest.fn(async () => true),
    // #1029: default the probe to a no-op "edge is fine" stub so every EXISTING
    // test below (written before the probe existed) keeps its exact http.calls
    // count/ordering. The dedicated pre-flight describe block below overrides
    // this with the REAL preflightProbe to exercise the probe itself.
    preflightProbe: jest.fn(async () => ({ ok: true })),
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

// ── 2. Network-level failure (no HTTP status) → one retry → still failing ────
describe('refreshToken — persistent network-level failure throws Transient (no blind 3×)', () => {
  it('retries ONCE after a SHORT (~5s) pause, then throws TransientRefreshError', async () => {
    const http = mockHttp([{ err: 'connect ECONNRESET' }, { err: 'connect ETIMEDOUT' }])
    const deps = depsWith(http)
    await expect(refreshToken(baseCreds(), deps)).rejects.toThrow(/WHOOP_REFRESH_TRANSIENT/)

    expect(http.calls).toHaveLength(2)            // exactly one retry, NOT three
    expect(deps.sleep).toHaveBeenCalledTimes(1)   // one pause before the retry
    // #904/C2: pause must be SHORT (≤10s) to land inside Ory's reuse window — 60s was a guaranteed miss
    expect(deps.sleep.mock.calls[0][0]).toBeLessThanOrEqual(10_000)
    expect(deps.writeCreds).not.toHaveBeenCalled()
    expect(deps.alertReauthIfDue).not.toHaveBeenCalled() // no HTTP response is not a reauth crisis
  })

  it('both attempts send the SAME refresh_token (nothing reached the origin, safe to retry)', async () => {
    const http = mockHttp([{ err: 'connect ECONNRESET' }, { err: 'connect ECONNRESET' }])
    const deps = depsWith(http)
    await expect(refreshToken(baseCreds(), deps)).rejects.toThrow()
    expect(http.calls[0].body).toContain('refresh_token=RT_CUR')
    expect(http.calls[1].body).toContain('refresh_token=RT_CUR')
  })
})

// ── 3. Real 5xx (#1029) → treated like a 4xx: NO same-token retry, straight to prev ──
// This is the behavior FLIP from the 2026-08-03 fix: that version retried a 5xx
// once with the same token (measured 0.9% success, 1/113, /var/log/whoop-sync.log
// 09–13.08.2026 — 112 burned the prev-token fallback for nothing). A 5xx means a
// response WAS received, so the one-shot token may already be spent server-side.
describe('refreshToken — real 5xx is treated like 4xx (no same-token retry, straight to prev)', () => {
  it('does NOT retry the current token on 502 — falls straight through to prev, no sleep', async () => {
    const http = mockHttp([
      { err: 'HTTP 502: Bad Gateway' }, // current — no retry
      { data: { access_token: 'A2', refresh_token: 'RT_NEW', expires_in: 3600 } }, // prev works
    ])
    const deps = depsWith(http)
    const out = await refreshToken(baseCreds(), deps)

    expect(out.access_token).toBe('A2')
    expect(out.refresh_token).toBe('RT_NEW')
    expect(http.calls).toHaveLength(2) // current once, prev once — no 3rd (retry) call
    expect(http.calls[0].body).toContain('refresh_token=RT_CUR')
    expect(http.calls[1].body).toContain('refresh_token=RT_PREV')
    expect(deps.sleep).not.toHaveBeenCalled() // no pause — no same-token retry happened
  })

  it('502 on current AND prev → ReauthRequiredError + dedup alert (same as 4xx+4xx)', async () => {
    const http = mockHttp([{ err: 'HTTP 502: Bad Gateway' }, { err: 'HTTP 503: Service Unavailable' }])
    const deps = depsWith(http)
    await expect(refreshToken(baseCreds(), deps)).rejects.toThrow(/WHOOP_REAUTH_REQUIRED/)
    expect(deps.alertReauthIfDue).toHaveBeenCalledTimes(1)
    expect(deps.sleep).not.toHaveBeenCalled()
  })
})

// ── 3b. Pre-flight probe (#1029): gates the real refresh ─────────────────────
describe('preflightProbe — direct unit tests (mocked httpRequest, no network)', () => {
  it('ok:true on a 4xx (Hydra alive, rejected the garbage token as expected)', async () => {
    const http = mockHttp([{ err: 'HTTP 400: invalid_grant' }])
    const result = await preflightProbe(baseCreds(), { httpRequest: http.fn })
    expect(result.ok).toBe(true)
  })

  it('ok:true on an actual 2xx (bizarre, but the edge answered)', async () => {
    const http = mockHttp([{ data: { access_token: 'ignored' } }])
    const result = await preflightProbe(baseCreds(), { httpRequest: http.fn })
    expect(result.ok).toBe(true)
  })

  it('ok:false on a 5xx (edge unhealthy — do not risk the real token)', async () => {
    const http = mockHttp([{ err: 'HTTP 502: Bad Gateway' }])
    const result = await preflightProbe(baseCreds(), { httpRequest: http.fn })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('502')
  })

  it('ok:false on a response-less network failure', async () => {
    const http = mockHttp([{ err: 'connect ETIMEDOUT' }])
    const result = await preflightProbe(baseCreds(), { httpRequest: http.fn })
    expect(result.ok).toBe(false)
  })

  it('never sends the REAL refresh_token in the probe body', async () => {
    const http = mockHttp([{ err: 'HTTP 400: invalid_grant' }])
    await preflightProbe(baseCreds(), { httpRequest: http.fn })
    expect(http.calls[0].body).not.toContain('refresh_token=RT_CUR')
    expect(http.calls[0].body).toContain('refresh_token=preflight-')
  })
})

describe('refreshToken — pre-flight probe gates the real refresh (integration, real preflightProbe)', () => {
  it('probe 5xx → real refresh is NEVER attempted, real token never spent', async () => {
    const http = mockHttp([{ err: 'HTTP 502: Bad Gateway' }])
    const deps = depsWith(http, { preflightProbe })
    await expect(refreshToken(baseCreds(), deps)).rejects.toThrow(/WHOOP_REFRESH_TRANSIENT/)
    expect(http.calls).toHaveLength(1) // ONLY the probe — real refresh_token=RT_CUR was never sent
    expect(http.calls[0].body).not.toContain('refresh_token=RT_CUR')
    expect(deps.writeCreds).not.toHaveBeenCalled()
  })

  it('probe 4xx (edge reachable) → proceeds to spend the real token normally', async () => {
    const http = mockHttp([
      { err: 'HTTP 400: invalid_grant' }, // probe — garbage token correctly rejected
      { data: { access_token: 'A2', refresh_token: 'RT_NEW', expires_in: 3600 } }, // real refresh
    ])
    const deps = depsWith(http, { preflightProbe })
    const out = await refreshToken(baseCreds(), deps)
    expect(out.access_token).toBe('A2')
    expect(http.calls).toHaveLength(2)
    expect(http.calls[0].body).toContain('refresh_token=preflight-')
    expect(http.calls[1].body).toContain('refresh_token=RT_CUR')
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

  // #1029 acceptance criterion (Apex, verbatim): "token_expires_at у майбутньому +
  // запас ⇒ refresh НЕ викликається" — the anti-churn guard already exists
  // (withinThreshold && !tooSoon); this pins the exact wording of the criterion
  // as its own explicit test, distinct from the (equivalent) test just above.
  it('#1029: token_expires_at is in the future with margin ⇒ refresh is NOT called', async () => {
    // expires 11:00, now 10:00 → 60min margin ⇒ neither expired nor within the 15min threshold
    const { deps, refresh } = tokenDeps({
      readCreds: () => baseCreds({ token_expires_at: '2026-08-03T11:00:00.000Z' }),
      now: () => Date.parse('2026-08-03T10:00:00.000Z'),
    })
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

// ── 8. alertReauthIfDue — dedup gate (state-change ok→fail + ≥24h reminder) ──
// #919 B/C: the dedup is tied to a STATE CHANGE, not just time. ok→fail alerts
// IMMEDIATELY (even within 24h); fail→fail is suppressed up to 24h, then reminds.
// This is the fix for the 14h-silent re-death: a system that was healthy and just
// died must be heard at once, not absorbed by a leftover dedup window.
describe('alertReauthIfDue — dedup', () => {
  const baseDeps = (over: Record<string, any> = {}) => ({
    now: () => Date.parse('2026-08-03T10:00:00.000Z'),
    readFile: () => { throw new Error('ENOENT') }, // no prior alert by default
    writeFile: jest.fn(),
    sendTelegram: jest.fn(async (_text: string) => true),
    // #1029: stub creds/URL-builder so these dedup tests never touch the real
    // /root/.config/whoop/whoop.json file — deterministic, no fs side effects.
    readCreds: () => ({ client_id: 'cid' }),
    buildAuthorizeUrl: jest.fn((c: any) => `https://api.prod.whoop.com/oauth/oauth2/auth?client_id=${c.client_id}`),
    ...over,
  })

  it('sends the alert when no prior alert file exists (first-ever failure = state change)', async () => {
    const d = baseDeps()
    const sent = await alertReauthIfDue('current 400; prev 400', d)
    expect(sent).toBe(true)
    expect(d.sendTelegram).toHaveBeenCalledTimes(1)
    expect(d.writeFile).toHaveBeenCalledTimes(1) // persisted dedup state
  })

  it('state change ok→fail alerts IMMEDIATELY even within 24h', async () => {
    const d = baseDeps({
      readFile: () => JSON.stringify({ last_state: 'ok', last_alerted_at: '2026-08-03T05:00:00.000Z' }), // was ok, alerted 5h ago
    })
    const sent = await alertReauthIfDue('current 400; prev 400', d)
    expect(sent).toBe(true) // NOT suppressed — state changed
    expect(d.sendTelegram).toHaveBeenCalledTimes(1)
  })

  it('fail→fail within 24h is suppressed (reminder cadence)', async () => {
    const d = baseDeps({
      readFile: () => JSON.stringify({ last_state: 'fail', last_alerted_at: '2026-08-03T05:00:00.000Z' }), // 5h ago
    })
    const sent = await alertReauthIfDue('current 400; prev 400', d)
    expect(sent).toBe(false)
    expect(d.sendTelegram).not.toHaveBeenCalled()
    expect(d.writeFile).not.toHaveBeenCalled()
  })

  it('fail→fail after 24h sends a reminder', async () => {
    const d = baseDeps({
      readFile: () => JSON.stringify({ last_state: 'fail', last_alerted_at: '2026-08-02T05:00:00.000Z' }), // 29h ago
    })
    const sent = await alertReauthIfDue('current 400; prev 400', d)
    expect(sent).toBe(true)
    expect(d.sendTelegram).toHaveBeenCalledTimes(1)
  })

  it('persists last_state:"fail" when alerting', async () => {
    const d = baseDeps()
    await alertReauthIfDue('current 400; prev 400', d)
    const written = JSON.parse(d.writeFile.mock.calls[0][1])
    expect(written.last_state).toBe('fail')
  })

  // ── #1029: clickable authorize URL in the alert (no bare "run this command") ──
  it('includes a tap-able authorize URL built via buildAuthorizeUrl, not just a CLI command', async () => {
    const d = baseDeps()
    await alertReauthIfDue('current 400; prev 400', d)
    expect(d.buildAuthorizeUrl).toHaveBeenCalledWith({ client_id: 'cid' })
    const text = d.sendTelegram.mock.calls[0][0]
    expect(text).toContain('https://api.prod.whoop.com/oauth/oauth2/auth?client_id=cid')
  })

  it('never puts a token value in the alert text (only client_id via the URL)', async () => {
    const d = baseDeps({
      readCreds: () => ({ client_id: 'cid', client_secret: 'TOP_SECRET', refresh_token: 'RT_LIVE' }),
    })
    await alertReauthIfDue('current 400; prev 400', d)
    const text = d.sendTelegram.mock.calls[0][0]
    expect(text).not.toContain('TOP_SECRET')
    expect(text).not.toContain('RT_LIVE')
  })

  it('falls back to the CLI instruction (no crash) if buildAuthorizeUrl throws', async () => {
    const d = baseDeps({
      buildAuthorizeUrl: () => { throw new Error('creds file unreadable') },
    })
    const sent = await alertReauthIfDue('current 400; prev 400', d)
    expect(sent).toBe(true) // still alerts — degrades, doesn't crash
    const text = d.sendTelegram.mock.calls[0][0]
    expect(text).toContain('whoop-reauth.js')
  })
})

// ── 8b. markSyncSuccess — reset alert state on a clean sync / re-auth (#919 B) ─
describe('markSyncSuccess — reset alert state', () => {
  it('writes last_state:"ok" so the next failure is a state change', () => {
    const writeFile = jest.fn()
    markSyncSuccess({ writeFile })
    expect(writeFile).toHaveBeenCalledTimes(1)
    const written = JSON.parse(writeFile.mock.calls[0][1])
    expect(written.last_state).toBe('ok')
  })

  it('after markSyncSuccess, a failure 1h later alerts immediately (not suppressed)', async () => {
    const writeFile = jest.fn()
    markSyncSuccess({ writeFile })
    // simulate the dedup file markSyncSuccess just wrote, read back on the next failure
    const okState = writeFile.mock.calls[0][1]
    const d = {
      now: () => Date.parse('2026-08-03T10:00:00.000Z'),
      readFile: () => okState,
      writeFile: jest.fn(),
      sendTelegram: jest.fn(async () => true),
    }
    const sent = await alertReauthIfDue('current 400; prev 400', d)
    expect(sent).toBe(true) // ok→fail = state change = immediate
    expect(d.sendTelegram).toHaveBeenCalledTimes(1)
  })

  it('does not throw if the dedup file is unwritable (best-effort)', () => {
    const writeFile = () => { throw new Error('EACCES') }
    expect(() => markSyncSuccess({ writeFile })).not.toThrow()
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
  it('RETRY_5XX_PAUSE_MS is short (~5s, ≤15s) — inside Ory reuse window (#904/C2)', () => {
    expect(RETRY_5XX_PAUSE_MS).toBeGreaterThanOrEqual(1_000)
    expect(RETRY_5XX_PAUSE_MS).toBeLessThanOrEqual(15_000)
  })
})

// ── 9. Transport: User-Agent + __cf_bm cookie jar (#904/C3) ──────────────────
// Pure-function tests on the header/cookie helpers (httpRequest itself is mocked in
// token tests; the transport contract is the helpers it delegates to). The pre-fix
// file had no UA and no cookie jar — every request looked like a fresh bot to
// Cloudflare's bot-management, which is part of why the token endpoint 502s.
describe('transport — User-Agent + __cf_bm cookie jar (#904/C3)', () => {
  beforeEach(() => resetCookieJar())

  it('DEFAULT_UA is the chuttyevo-health string carrying the domain', () => {
    expect(DEFAULT_UA).toMatch(/chuttyevo-health\//)
    expect(DEFAULT_UA).toContain('srv1532186.hstgr.cloud')
  })

  it('buildRequestHeaders adds the default User-Agent when the caller sets none', () => {
    const h = buildRequestHeaders({ method: 'POST', headers: { 'Content-Type': 'x' } }, 'api.prod.whoop.com')
    expect(h['User-Agent']).toBe(DEFAULT_UA)
    expect(h['Content-Type']).toBe('x')
  })

  it('buildRequestHeaders lets the caller override User-Agent', () => {
    const h = buildRequestHeaders({ headers: { 'User-Agent': 'custom/9.9' } }, 'h')
    expect(h['User-Agent']).toBe('custom/9.9')
  })

  it('buildRequestHeaders omits Cookie when the jar is empty (no leakage)', () => {
    const h = buildRequestHeaders({}, 'fresh-host.example')
    expect(h['Cookie']).toBeUndefined()
  })

  it('captureSetCookie parses __cf_bm and buildRequestHeaders replays it as Cookie', () => {
    captureSetCookie('api.prod.whoop.com', '__cf_bm=abc123; Domain=prod.whoop.com; Path=/; HttpOnly')
    expect(cookieHeaderFor('api.prod.whoop.com')).toBe('__cf_bm=abc123')
    const h = buildRequestHeaders({}, 'api.prod.whoop.com')
    expect(h['Cookie']).toBe('__cf_bm=abc123')
  })

  it('captureSetCookie handles an array of set-cookie values', () => {
    captureSetCookie('h', ['__cf_bm=zzz; Path=/', 'other=val; Path=/'])
    expect(cookieHeaderFor('h')).toBe('__cf_bm=zzz')
  })

  it('captureSetCookie ignores cookies that are not __cf_bm', () => {
    captureSetCookie('h', 'session=xyz; Path=/')
    expect(cookieHeaderFor('h')).toBeNull()
  })

  it('cookie jar is per-host (token host and API host do not bleed)', () => {
    captureSetCookie('a.host', '__cf_bm=aaa; Path=/')
    expect(cookieHeaderFor('b.host')).toBeNull()
    expect(cookieHeaderFor('a.host')).toBe('__cf_bm=aaa')
  })
})

export {};
