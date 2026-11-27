// Reads Outlook calendars live through Microsoft Graph, as the app itself
// (client credentials: an Entra app registration with the Calendars.Read
// application permission and admin consent). Nothing is saved to the
// database: events are kept in memory for a few minutes so repeated page
// loads don't call Microsoft every time.
//
// Settings (Render environment / .env):
//   MS_TENANT_ID      Directory (tenant) ID
//   MS_CLIENT_ID      Application (client) ID
//   MS_CLIENT_SECRET  client secret value ("MS-Client-Secret" also works)
//
// Which calendars (either or both):
//   OUTLOOK_CALENDAR_MAILBOXES  mailboxes (comma-separated) whose calendars
//                     named "<anything> Scheduling Events" are shown, e.g.
//                     "Branford Scheduling Events"; new ones appear on
//                     their own. OUTLOOK_CALENDAR_SUFFIX changes the
//                     "Scheduling Events" ending.
//   OUTLOOK_CALENDARS specific calendars, separated by semicolons:
//                     Label=mailbox (its main calendar) or
//                     Label=mailbox/Calendar name, e.g.
//                     Holidays=tech@delaneyliquors.com/Company Holidays
//
// Only those mailboxes and calendars can be read: pages refer to a calendar
// by its key, never by an address someone could change.

const TIME_ZONE = 'America/New_York'
const EVENTS_CACHE_MS = 5 * 60 * 1000
const CALENDAR_LIST_CACHE_MS = 10 * 60 * 1000
const MAX_CACHED = 60
const MAX_PAGES = 10
const EMAIL_PATTERN = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/

// Event colors, by calendar order
const CALENDAR_COLORS = ['#2563eb', '#0f766e', '#b45309', '#7c3aed', '#be123c', '#4d7c0f', '#0369a1', '#a21caf']

function settings() {
  const env = process.env
  return {
    tenantId: String(env.MS_TENANT_ID || '').trim(),
    clientId: String(env.MS_CLIENT_ID || '').trim(),
    clientSecret: String(env.MS_CLIENT_SECRET || env['MS-Client-Secret'] || '').trim()
  }
}

const discoveryMailboxes = () => String(process.env.OUTLOOK_CALENDAR_MAILBOXES || '')
  .split(/[,;]/)
  .map(value => value.trim().toLowerCase())
  .filter(value => EMAIL_PATTERN.test(value))

const calendarSuffix = () => String(process.env.OUTLOOK_CALENDAR_SUFFIX || 'Scheduling Events').trim()

// Specific calendars from OUTLOOK_CALENDARS: [{ label, mailbox, calendarName }]
function listedCalendars() {
  return String(process.env.OUTLOOK_CALENDARS || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const at = part.indexOf('=')
      const label = (at > 0 ? part.slice(0, at) : '').trim()
      const target = (at > 0 ? part.slice(at + 1) : part).trim()
      const slash = target.indexOf('/')
      const mailbox = (slash > 0 ? target.slice(0, slash) : target).trim().toLowerCase()
      const calendarName = slash > 0 ? target.slice(slash + 1).trim() : ''
      return { label: label || calendarName || mailbox, mailbox, calendarName }
    })
    .filter(entry => EMAIL_PATTERN.test(entry.mailbox))
}

function missingSettings() {
  const { tenantId, clientId, clientSecret } = settings()
  return [
    !tenantId && 'MS_TENANT_ID',
    !clientId && 'MS_CLIENT_ID',
    !clientSecret && 'MS_CLIENT_SECRET',
    !discoveryMailboxes().length && !listedCalendars().length && 'OUTLOOK_CALENDAR_MAILBOXES'
  ].filter(Boolean)
}

class OutlookError extends Error {
  constructor(message, detail) {
    super(message)
    this.detail = detail || ''
  }
}

// ---------- token ----------

let tokenCache = null

async function accessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60 * 1000) return tokenCache.token

  const { tenantId, clientId, clientSecret } = settings()
  if (!tenantId || !clientId || !clientSecret) {
    throw new OutlookError('The Outlook connection is not set up yet (missing app settings).')
  }

  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    }),
    signal: AbortSignal.timeout(15000)
  })
  const result = await response.json().catch(() => ({}))

  if (!response.ok || !result.access_token) {
    const description = String(result.error_description || result.error || response.status)
    const code = (description.match(/AADSTS\d+/) || [''])[0]
    const reasons = {
      AADSTS7000215: 'The client secret is wrong (use the secret\'s Value, not its Secret ID).',
      AADSTS7000222: 'The client secret has expired. Create a new one in Entra.',
      AADSTS700016: 'The application ID was not found in this directory.',
      AADSTS90002: 'The directory (tenant) ID was not found.',
      AADSTS900023: 'The directory (tenant) ID is not valid.'
    }
    throw new OutlookError(reasons[code] || 'Microsoft would not sign the app in.', description.split('\n')[0].slice(0, 300))
  }

  tokenCache = { token: result.access_token, expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000 }
  return tokenCache.token
}

// ---------- events ----------

const eventsCache = new Map()

async function graphGet(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: `outlook.timezone="${TIME_ZONE}"`,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(20000)
  })
  const result = await response.json().catch(() => ({}))
  if (response.ok) return result

  const code = (result.error && result.error.code) || String(response.status)
  const message = (result.error && result.error.message) || ''
  if (response.status === 401 || response.status === 403 || /AccessDenied|Authorization_RequestDenied/i.test(code)) {
    throw new OutlookError(
      'Microsoft denied access to this calendar. An admin still needs to grant consent for Calendars.Read, ' +
      'or the mailbox is outside the app\'s access policy.',
      `${code}: ${message}`.slice(0, 300)
    )
  }
  if (response.status === 404 || /MailboxNotEnabledForRESTAPI|ResourceNotFound|ErrorItemNotFound/i.test(code)) {
    throw new OutlookError('That calendar or mailbox was not found.', `${code}: ${message}`.slice(0, 300))
  }
  if (response.status === 429) {
    throw new OutlookError('Microsoft is rate-limiting requests. Try again in a minute.', code)
  }
  throw new OutlookError('Outlook could not be read right now.', `${code}: ${message}`.slice(0, 300))
}

// "2026-11-27T09:30:00.0000000" (already in store time) -> { date, time }
const splitDateTime = value => ({
  date: String(value || '').slice(0, 10),
  time: String(value || '').slice(11, 16)
})

function simplifyEvent(event, calendar) {
  const start = splitDateTime(event.start && event.start.dateTime)
  const end = splitDateTime(event.end && event.end.dateTime)
  const isPrivate = event.sensitivity === 'private' || event.sensitivity === 'confidential'
  return {
    id: event.id,
    calendarKey: calendar.key,
    calendarLabel: calendar.label,
    color: calendar.color,
    // Private events show only that the time is taken
    subject: isPrivate ? 'Private event' : (event.subject || '(No title)'),
    isPrivate,
    location: isPrivate ? '' : ((event.location && event.location.displayName) || ''),
    organizer: isPrivate ? '' : ((event.organizer && event.organizer.emailAddress && event.organizer.emailAddress.name) || ''),
    isAllDay: Boolean(event.isAllDay),
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    showAs: event.showAs || '',
    // Only plain https links (it's used as a link on the page)
    webLink: !isPrivate && /^https:\/\//i.test(event.webLink || '') ? event.webLink : ''
  }
}

// ---------- calendars ----------

const mailboxCalendarsCache = new Map()

// A mailbox's calendars: [{ id, name }]
async function mailboxCalendars(mailbox) {
  const cached = mailboxCalendarsCache.get(mailbox)
  if (cached && cached.expiresAt > Date.now()) return cached.calendars

  const token = await accessToken()
  let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/calendars?$select=id,name&$top=100`
  const calendars = []
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const result = await graphGet(url, token)
    for (const calendar of result.value || []) calendars.push({ id: calendar.id, name: String(calendar.name || '').trim() })
    url = result['@odata.nextLink'] || ''
  }
  mailboxCalendarsCache.set(mailbox, { calendars, expiresAt: Date.now() + CALENDAR_LIST_CACHE_MS })
  return calendars
}

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase()

// Every calendar the page can show:
// { calendars: [{ key, label, mailbox, calendarId, color }], errors: [{ label, message, detail }] }
// calendarId '' is the mailbox's main calendar.
async function listCalendars() {
  const found = []
  const errors = []
  // discovery: searching a mailbox for "… Scheduling Events" failed, so a
  // store's calendar may be missing
  const failed = (label, err, discovery = false) => errors.push({
    label,
    discovery,
    message: err instanceof OutlookError ? err.message : 'Outlook could not be read right now.',
    detail: err.detail || err.message
  })

  // "<anything> Scheduling Events" in each listed mailbox
  const suffix = calendarSuffix().toLowerCase()
  for (const mailbox of discoveryMailboxes()) {
    try {
      const matches = (await mailboxCalendars(mailbox))
        .filter(calendar => calendar.name.toLowerCase().endsWith(suffix))
        .sort((a, b) => a.name.localeCompare(b.name))
      matches.forEach(calendar => found.push({ label: calendar.name, mailbox, calendarId: calendar.id }))
    } catch (err) {
      failed(mailbox, err, true)
    }
  }

  for (const entry of listedCalendars()) {
    if (!entry.calendarName) {
      found.push({ label: entry.label, mailbox: entry.mailbox, calendarId: '' })
      continue
    }
    try {
      const match = (await mailboxCalendars(entry.mailbox)).find(calendar => sameName(calendar.name, entry.calendarName))
      if (match) found.push({ label: entry.label, mailbox: entry.mailbox, calendarId: match.id })
      else errors.push({ label: entry.label, message: `No calendar named "${entry.calendarName}" was found in that mailbox.`, detail: '' })
    } catch (err) {
      failed(entry.label, err)
    }
  }

  // The same calendar listed twice is shown once
  const seenCalendars = new Set()
  const seenKeys = new Set()
  const calendars = found
    .filter(calendar => {
      const id = `${calendar.mailbox}|${calendar.calendarId}`
      if (seenCalendars.has(id)) return false
      seenCalendars.add(id)
      return true
    })
    .map((calendar, index) => {
      let key = calendar.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `calendar-${index + 1}`
      while (seenKeys.has(key)) key += '-2'
      seenKeys.add(key)
      return { ...calendar, key, color: CALENDAR_COLORS[index % CALENDAR_COLORS.length] }
    })

  return { calendars, errors }
}

// ---------- events ----------

// Events overlapping [startYmd, endYmd] (inclusive dates, store time)
async function calendarEvents(calendar, startYmd, endYmd) {
  const cacheKey = `${calendar.mailbox}|${calendar.calendarId}|${startYmd}|${endYmd}`
  const cached = eventsCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.events

  const token = await accessToken()

  // Ask a day wider on each side in UTC, then keep the events that touch the
  // requested store-time days
  const widen = (ymd, days) => {
    const date = new Date(`${ymd}T12:00:00Z`)
    date.setUTCDate(date.getUTCDate() + days)
    return date.toISOString().slice(0, 10)
  }
  const params = new URLSearchParams({
    startDateTime: `${widen(startYmd, -1)}T00:00:00Z`,
    endDateTime: `${widen(endYmd, 2)}T00:00:00Z`,
    $select: 'id,subject,start,end,isAllDay,location,organizer,sensitivity,showAs,isCancelled,webLink',
    $orderby: 'start/dateTime',
    $top: '200'
  })
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(calendar.mailbox)}`
  let url = calendar.calendarId
    ? `${base}/calendars/${encodeURIComponent(calendar.calendarId)}/calendarView?${params}`
    : `${base}/calendarView?${params}`

  const events = []
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const result = await graphGet(url, token)
    for (const event of result.value || []) {
      if (event.isCancelled) continue
      const simple = simplifyEvent(event, calendar)
      // All-day events end at midnight of the day after
      const lastDay = simple.isAllDay || simple.endTime === '00:00' ? widen(simple.endDate, -1) : simple.endDate
      simple.lastDate = lastDay < simple.startDate ? simple.startDate : lastDay
      if (simple.lastDate >= startYmd && simple.startDate <= endYmd) events.push(simple)
    }
    url = result['@odata.nextLink'] || ''
  }

  if (eventsCache.size >= MAX_CACHED) eventsCache.delete(eventsCache.keys().next().value)
  eventsCache.set(cacheKey, { events, expiresAt: Date.now() + EVENTS_CACHE_MS })
  return events
}

// Several calendars at once; one failing doesn't hide the others
async function eventsFor(calendars, startYmd, endYmd) {
  const results = await Promise.all(calendars.map(async calendar => {
    try {
      return { calendar, events: await calendarEvents(calendar, startYmd, endYmd) }
    } catch (err) {
      return { calendar, events: [], error: err instanceof OutlookError ? err.message : 'Outlook could not be read right now.', detail: err.detail || err.message }
    }
  }))
  const sortKey = event => `${event.startDate} ${event.isAllDay ? '00:00' : event.startTime}`
  return {
    events: results.flatMap(result => result.events).sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
    errors: results.filter(result => result.error).map(result => ({
      label: result.calendar.label,
      message: result.error,
      detail: result.detail
    }))
  }
}

function clearCache() {
  eventsCache.clear()
  mailboxCalendarsCache.clear()
}

module.exports = { listCalendars, missingSettings, eventsFor, accessToken, clearCache, OutlookError, TIME_ZONE }
