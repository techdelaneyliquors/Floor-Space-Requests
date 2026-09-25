// Shared store/role lists used by the User model and the server.

const CANONICAL_STORE_NAMES = {
  branford: 'Branford',
  hamden: 'Hamden',
  'new haven': 'New Haven',
  'new milford': 'New Milford',
  stratford: 'Stratford'
}

const STORE_LIST = Object.values(CANONICAL_STORE_NAMES)

const ALL_STORES_VALUE = 'all'

const ACCESS_ROLES = ['employee', 'manager', 'vendor', 'admin']

function getCanonicalStoreName(value) {
  const normalized = String(
    value || ''
  )
    .trim()
    .toLowerCase()

  return CANONICAL_STORE_NAMES[
    normalized
  ] || ''
}

// Accepts a string or array (urlencoded forms send either) and returns
// a de-duplicated list of canonical store names, or ['all'].
function normalizeStoreList(value) {
  const values = Array.isArray(value)
    ? value
    : (value === undefined || value === null ? [] : [value])

  const result = []

  for (const raw of values) {
    const text = String(raw || '').trim()

    if (text.toLowerCase() === ALL_STORES_VALUE) {
      return [ALL_STORES_VALUE]
    }

    const store = getCanonicalStoreName(text)

    if (store && !result.includes(store)) {
      result.push(store)
    }
  }

  return result
}

module.exports = {
  CANONICAL_STORE_NAMES,
  STORE_LIST,
  ALL_STORES_VALUE,
  ACCESS_ROLES,
  getCanonicalStoreName,
  normalizeStoreList
}
