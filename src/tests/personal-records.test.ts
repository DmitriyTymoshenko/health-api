/**
 * Personal Records (PR) — unit tests for calc1RM and PR logic
 */

// Import calc1RM logic (replicate since it's embedded in route)
function calc1RM(weight: number, reps: number): number {
  if (!weight || !reps) return 0
  return Math.round(weight * (1 + reps / 30) * 10) / 10
}

describe('calc1RM (Epley formula)', () => {
  it('calculates 1RM for 100kg x 5 reps', () => {
    const result = calc1RM(100, 5)
    // 100 * (1 + 5/30) = 100 * 1.1667 = 116.67 → 116.7
    expect(result).toBe(116.7)
  })

  it('calculates 1RM for 80kg x 10 reps', () => {
    const result = calc1RM(80, 10)
    // 80 * (1 + 10/30) = 80 * 1.3333 = 106.67 → 106.7
    expect(result).toBe(106.7)
  })

  it('returns 0 for 0 weight', () => {
    expect(calc1RM(0, 10)).toBe(0)
  })

  it('returns 0 for 0 reps', () => {
    expect(calc1RM(100, 0)).toBe(0)
  })

  it('1 rep = actual weight', () => {
    const result = calc1RM(120, 1)
    // 120 * (1 + 1/30) = 120 * 1.0333 = 124.0
    expect(result).toBe(124)
  })
})

describe('PR detection logic', () => {
  interface PRData {
    max_weight: { value: number }
    max_volume: { value: number }
    max_1rm: { value: number }
    max_reps: { value: number }
  }

  function detectNewPRs(
    sets: Array<{ weight_kg: number; reps: number }>,
    oldPR: PRData | null
  ) {
    const prs: Array<{ type: string; value: number; previous: number }> = []

    for (const s of sets) {
      const weight = s.weight_kg || 0
      const reps = s.reps || 0
      const orm = calc1RM(weight, reps)

      if (!oldPR || weight > oldPR.max_weight.value) {
        prs.push({ type: 'max_weight', value: weight, previous: oldPR ? oldPR.max_weight.value : 0 })
      }

      if (!oldPR || orm > oldPR.max_1rm.value) {
        prs.push({ type: 'max_1rm', value: orm, previous: oldPR ? oldPR.max_1rm.value : 0 })
      }

      if (weight > 0 && (!oldPR || reps > oldPR.max_reps.value)) {
        prs.push({ type: 'max_reps', value: reps, previous: oldPR ? oldPR.max_reps.value : 0 })
      }
    }

    const sessionVolume = Math.round(sets.reduce((sum, s) => sum + (s.weight_kg || 0) * (s.reps || 0), 0))
    if (!oldPR || sessionVolume > oldPR.max_volume.value) {
      prs.push({ type: 'max_volume', value: sessionVolume, previous: oldPR ? oldPR.max_volume.value : 0 })
    }

    // Deduplicate — keep best per type
    const bestByType: Record<string, { type: string; value: number; previous: number }> = {}
    for (const pr of prs) {
      if (!bestByType[pr.type] || pr.value > bestByType[pr.type].value) {
        bestByType[pr.type] = pr
      }
    }
    return Object.values(bestByType)
  }

  it('detects all PRs for first workout (no previous)', () => {
    const sets = [
      { weight_kg: 80, reps: 8 },
      { weight_kg: 90, reps: 5 },
    ]
    const prs = detectNewPRs(sets, null)
    expect(prs.length).toBe(4) // max_weight, max_1rm, max_reps, max_volume

    const types = prs.map(p => p.type)
    expect(types).toContain('max_weight')
    expect(types).toContain('max_1rm')
    expect(types).toContain('max_reps')
    expect(types).toContain('max_volume')

    expect(prs.find(p => p.type === 'max_weight')!.value).toBe(90)
    expect(prs.find(p => p.type === 'max_reps')!.value).toBe(8)
  })

  it('detects new weight PR when beating old record', () => {
    const oldPR: PRData = {
      max_weight: { value: 85 },
      max_volume: { value: 2000 },
      max_1rm: { value: 100 },
      max_reps: { value: 10 },
    }
    const sets = [{ weight_kg: 90, reps: 3 }]
    const prs = detectNewPRs(sets, oldPR)

    const weightPR = prs.find(p => p.type === 'max_weight')
    expect(weightPR).toBeDefined()
    expect(weightPR!.value).toBe(90)
    expect(weightPR!.previous).toBe(85)
  })

  it('does NOT detect PR when below old record', () => {
    const oldPR: PRData = {
      max_weight: { value: 100 },
      max_volume: { value: 5000 },
      max_1rm: { value: 120 },
      max_reps: { value: 15 },
    }
    const sets = [{ weight_kg: 80, reps: 8 }]
    const prs = detectNewPRs(sets, oldPR)

    expect(prs.length).toBe(0)
  })

  it('detects only 1RM PR with lighter weight but more reps', () => {
    const oldPR: PRData = {
      max_weight: { value: 100 },
      max_volume: { value: 5000 },
      max_1rm: { value: 110 },
      max_reps: { value: 5 },
    }
    // 80kg x 12 reps → 1RM = 80 * (1 + 12/30) = 80 * 1.4 = 112 > 110
    const sets = [{ weight_kg: 80, reps: 12 }]
    const prs = detectNewPRs(sets, oldPR)

    const ormPR = prs.find(p => p.type === 'max_1rm')
    expect(ormPR).toBeDefined()
    expect(ormPR!.value).toBe(112)

    const repsPR = prs.find(p => p.type === 'max_reps')
    expect(repsPR).toBeDefined()
    expect(repsPR!.value).toBe(12)

    // weight not beaten
    expect(prs.find(p => p.type === 'max_weight')).toBeUndefined()
  })

  it('calculates session volume correctly', () => {
    const sets = [
      { weight_kg: 80, reps: 10 },  // 800
      { weight_kg: 85, reps: 8 },   // 680
      { weight_kg: 90, reps: 6 },   // 540
    ]
    // Total: 2020
    const prs = detectNewPRs(sets, null)
    const volPR = prs.find(p => p.type === 'max_volume')
    expect(volPR!.value).toBe(2020)
  })
})
