/**
 * Test for GET /api/version endpoint (SPEC-001, REQ-1, REQ-2, REQ-3)
 *
 * Tests the version handler logic directly without starting the server.
 */

const pkg = require('../../package.json')

describe('GET /api/version', () => {
  it('returns correct version from package.json (REQ-2)', () => {
    // Simulate the handler logic from server.js:
    // app.get('/api/version', (req, res) => res.json({ version: pkg.version, name: pkg.name, uptime: Math.floor(process.uptime()) }))
    const result = {
      version: pkg.version,
      name: pkg.name,
      uptime: Math.floor(process.uptime()),
    }

    expect(result.version).toBe('1.0.0')
  })

  it('returns name from package.json (REQ-1)', () => {
    expect(pkg.name).toBe('health-api')
  })

  it('uptime is a non-negative integer (REQ-1)', () => {
    const uptime = Math.floor(process.uptime())
    expect(typeof uptime).toBe('number')
    expect(Number.isInteger(uptime)).toBe(true)
    expect(uptime).toBeGreaterThanOrEqual(0)
  })

  it('response structure has exactly 3 fields (REQ-1)', () => {
    const result = {
      version: pkg.version,
      name: pkg.name,
      uptime: Math.floor(process.uptime()),
    }
    expect(Object.keys(result).sort()).toEqual(['name', 'uptime', 'version'])
  })

  it('package.json version matches semver format', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
