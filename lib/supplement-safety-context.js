// Local context availability only. No clinical assessment or provider input.
// Empty arrays have no explicit absence confirmation in the profile contract.
const FIELDS = ['medications', 'allergies', 'chronic_conditions']

function supplementSafetyContext(profile, unavailable = false) {
  const missing = profile == null
  const invalid = !missing && (typeof profile !== 'object' || Array.isArray(profile))
  const reasons = ['clinical_safety_not_assessed']
  if (unavailable) reasons.push('profile_unavailable')
  else if (missing) reasons.push('profile_missing')
  else if (invalid) reasons.push('profile_invalid')
  const fields = Object.fromEntries(FIELDS.map(field => {
    let state
    if (unavailable) state = 'unavailable'
    else if (invalid) state = 'invalid'
    else if (missing || !Object.hasOwn(profile, field)) state = 'missing'
    else if (!Array.isArray(profile[field]) || profile[field].some(value => typeof value !== 'string' || !value.trim())) state = 'invalid'
    else state = profile[field].length ? 'available' : 'empty_unconfirmed'
    if (state !== 'available') reasons.push(`${field}_${state}`)
    return [field, state]
  }))
  return { status: 'not_assessed', fields, reasons, context_checked_at: new Date().toISOString() }
}

async function readSupplementSafetyContext(getDB) {
  try {
    const profile = await getDB().collection('personal_profile').findOne({ _type: 'profile' })
    return supplementSafetyContext(profile)
  } catch {
    // Do not expose database errors or medical values, and do not block
    // educational content when profile context cannot be read.
    return supplementSafetyContext(null, true)
  }
}

module.exports = { supplementSafetyContext, readSupplementSafetyContext }
