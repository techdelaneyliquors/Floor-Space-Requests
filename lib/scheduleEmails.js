// Schedule confirmations: who is on an approved schedule, the "Yes, I can
// work these hours" links, and the weekly email to tech@ that Power Automate
// splits into one email per employee.
//
// Kept apart from compiledbuild.js so the same code builds the real
// Wednesday email and any test send.

const crypto = require('crypto')
const jwt = require('jsonwebtoken')

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

// ------------------------
// Dates (YYYY-MM-DD, no time zone)
// ------------------------

const parseYmd = ymd => new Date(`${ymd}T00:00:00Z`)
const addDays = (ymd, days) => {
  const date = parseYmd(ymd)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
const formatDay = (ymd, options) => parseYmd(ymd).toLocaleDateString('en-US', { timeZone: 'UTC', ...options })

// "Nov 16 – 22, 2026" style, the same as the rest of the app
const weekRange = weekStart =>
  `${formatDay(weekStart, { month: 'short', day: 'numeric' })} – ` +
  `${formatDay(addDays(weekStart, 6), { month: 'short', day: 'numeric', year: 'numeric' })}`

// "Mon, Nov 16"
const dayLabel = (weekStart, index) =>
  formatDay(addDays(weekStart, index), { weekday: 'short', month: 'short', day: 'numeric' })

// ------------------------
// People on a schedule
// ------------------------

// One key per person: their employee number, or their name if they have none
function personKeyOf(employee) {
  const number = String((employee && employee.employeeNumber) || '').trim()
  if (number) return number
  return 'name:' + String((employee && employee.name) || '').trim().toLowerCase()
}

// The week's shifts in one string, to tell whether a reply was given for
// the schedule as it is now
const shiftsSignature = days =>
  DAY_KEYS.map(day => `${day}=${((days && days[day]) || []).join(',')}`).join(';')

// Everyone with at least one shift in an approved snapshot, once each (a
// person listed in two groups has their shifts combined)
function scheduledPeople(snapshot) {
  const byKey = new Map()

  for (const group of (snapshot && snapshot.groups) || []) {
    for (const employee of group.employees || []) {
      const name = String(employee.name || '').trim()
      if (!name) continue

      const key = personKeyOf(employee)
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          name,
          employeeNumber: String(employee.employeeNumber || '').trim(),
          groups: [],
          days: Object.fromEntries(DAY_KEYS.map(day => [day, []]))
        })
      }

      const person = byKey.get(key)
      if (group.label && !person.groups.includes(group.label)) person.groups.push(group.label)
      for (const day of DAY_KEYS) {
        person.days[day].push(...((employee.days && employee.days[day]) || []))
      }
    }
  }

  return [...byKey.values()]
    .filter(person => DAY_KEYS.some(day => person.days[day].length))
    .map(person => ({ ...person, signature: shiftsSignature(person.days) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Each day of the week with its shifts: [{ day, date, label, shifts }]
const weekDays = (weekStart, days) => DAY_KEYS.map((day, index) => ({
  day,
  date: addDays(weekStart, index),
  label: dayLabel(weekStart, index),
  shifts: (days && days[day]) || []
}))

// ------------------------
// Email addresses
// ------------------------

const canAccessStore = (user, store) =>
  (user.stores || []).includes('all') || (user.stores || []).includes(store)

// The account each scheduled person belongs to: the one linked to their
// employee number at this store, or (like the schedule page) the single
// account with exactly their name that isn't linked to anyone at this store.
// users: approved accounts with an email.
function accountFor(store, person, users) {
  if (person.employeeNumber) {
    const linked = users.find(user => (user.rosterLinks || []).some(link =>
      link.store === store && link.employeeNumber === person.employeeNumber))
    if (linked) return linked
  }

  const name = person.name.toLowerCase()
  const byName = users.filter(user =>
    !(user.rosterLinks || []).some(link => link.store === store) &&
    canAccessStore(user, store) &&
    String(user.name || '').trim().toLowerCase() === name)

  return byName.length === 1 ? byName[0] : null
}

// ------------------------
// "Yes" links
// ------------------------
//
// A signed token naming the store, week and person, so the link works
// without logging in. Signed with a key derived from JWT_SECRET, so it can't
// be used as a login token (or the other way round). It stops working the
// day after the week ends.

const replyKey = secret => crypto.createHmac('sha256', String(secret || '')).update('schedule-reply-link').digest()

function signReplyToken(secret, { store, weekStart, key }) {
  if (!secret) throw new Error('JWT_SECRET is not configured.')
  const expires = Math.floor(parseYmd(addDays(weekStart, 8)).getTime() / 1000)
  return jwt.sign({ t: 'schedule-reply', s: store, w: weekStart, k: key, exp: expires }, replyKey(secret), { algorithm: 'HS256' })
}

// { store, weekStart, key } or null if invalid or expired
function verifyReplyToken(secret, token) {
  try {
    const payload = jwt.verify(String(token || ''), replyKey(secret), { algorithms: ['HS256'] })
    if (payload.t !== 'schedule-reply' || !payload.s || !/^\d{4}-\d{2}-\d{2}$/.test(payload.w) || !payload.k) return null
    return { store: payload.s, weekStart: payload.w, key: String(payload.k) }
  } catch {
    return null
  }
}

// ------------------------
// The weekly email to tech@
// ------------------------

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

// One line, with nothing that could pose as one of the email's labels
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').replace(/={3,}/g, '=').trim()

const SUBJECT_TAG = '[Delaney schedules]'

// One employee's email, ready to send as is
function personEmail({ store, weekStart, person, email, yesLink, scheduleLink }) {
  const firstName = person.name.split(/\s+/)[0]
  const range = weekRange(weekStart)
  const days = weekDays(weekStart, person.days)
  const subject = `Your ${store} schedule: week of ${range}`
  const scheduleLines = days.map(day => `${day.label}: ${day.shifts.length ? day.shifts.join(', ') : 'Off'}`)

  const text = [
    `Hi ${firstName},`,
    '',
    `Here is your schedule at Delaney ${store} for the week of ${range}:`,
    '',
    ...scheduleLines,
    '',
    'Can you work these hours?',
    '',
    `Yes, I can work these hours: ${yesLink}`,
    '',
    `If you can't, open your schedule, choose "No" and tell us why: ${scheduleLink}`,
    '',
    'Thank you!'
  ].join('\n')

  const button = (href, label, color) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 20px;margin:4px 8px 4px 0;border-radius:8px;` +
    `background:${color};color:#ffffff;font-weight:600;text-decoration:none;">${escapeHtml(label)}</a>`

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1f2937;">` +
    `<p>Hi ${escapeHtml(firstName)},</p>` +
    `<p>Here is your schedule at Delaney ${escapeHtml(store)} for the week of <strong>${escapeHtml(range)}</strong>:</p>` +
    `<table style="border-collapse:collapse;margin:8px 0 16px;">` +
    days.map(day =>
      `<tr><td style="padding:4px 16px 4px 0;font-weight:600;">${escapeHtml(day.label)}</td>` +
      `<td style="padding:4px 0;${day.shifts.length ? '' : 'color:#9ca3af;'}">${escapeHtml(day.shifts.length ? day.shifts.join(', ') : 'Off')}</td></tr>`
    ).join('') +
    `</table>` +
    `<p style="font-weight:600;">Can you work these hours?</p>` +
    `<p>${button(yesLink, 'Yes, I can work these hours', '#16a34a')}${button(scheduleLink, "No, I can't (open my schedule)", '#dc2626')}</p>` +
    `<p style="color:#6b7280;font-size:13px;">If you can't work these hours, open your schedule, choose "No" and tell us why.</p>` +
    `<p>Thank you!</p></div>`

  return {
    to: email,
    name: person.name,
    store,
    employeeNumber: person.employeeNumber,
    subject,
    yesLink,
    scheduleLink,
    shifts: days.map(day => ({ date: day.date, day: day.label, shifts: day.shifts })),
    text,
    html
  }
}

// stores: [{ store, snapshot, scheduleLink }] for each approved schedule
// to include; notPosted: [{ store, note }]; users: approved accounts with
// an email. Returns { subject, text, html, attachment, emails, noEmail }.
function buildScheduleEmail({ weekStart, stores, notPosted = [], users, baseUrl, secret, relayKey }) {
  const range = weekRange(weekStart)
  const emails = []
  const noEmail = []

  for (const { store, snapshot, scheduleLink } of stores) {
    for (const person of scheduledPeople(snapshot)) {
      const account = accountFor(store, person, users)
      if (!account || !account.email) {
        noEmail.push({ store, name: person.name, employeeNumber: person.employeeNumber })
        continue
      }
      const token = signReplyToken(secret, { store, weekStart, key: person.key })
      emails.push(personEmail({
        store,
        weekStart,
        person,
        email: String(account.email).trim(),
        yesLink: `${baseUrl}/schedule-reply/${token}?answer=yes`,
        scheduleLink
      }))
    }
  }

  const storeNames = stores.map(entry => entry.store)
  const subject = `${SUBJECT_TAG} Week of ${range}: ${emails.length} email${emails.length === 1 ? '' : 's'}` +
    (storeNames.length ? ` (${storeNames.join(', ')})` : '')

  // The body, one labeled line at a time. Each email sits between
  // "===== EMAIL n =====" and "===== END EMAIL n =====".
  const lines = [
    `SCHEDULE-KEY: ${relayKey}`,
    `SCHEDULE-WEEK: ${weekStart}`,
    `SCHEDULE-COUNT: ${emails.length}`,
    ''
  ]

  emails.forEach((email, index) => {
    lines.push(
      `===== EMAIL ${index + 1} =====`,
      `TO: ${oneLine(email.to)}`,
      `NAME: ${oneLine(email.name)}`,
      `STORE: ${oneLine(email.store)}`,
      `SUBJECT: ${oneLine(email.subject)}`,
      `YES-LINK: ${email.yesLink}`,
      `SCHEDULE-LINK: ${email.scheduleLink}`,
      ...email.shifts.map(day => `SHIFT: ${day.day}: ${oneLine(day.shifts.length ? day.shifts.join(', ') : 'Off')}`),
      `===== END EMAIL ${index + 1} =====`,
      ''
    )
  })

  if (noEmail.length) {
    lines.push('No email on file (not emailed; tell them another way):')
    noEmail.forEach(person => lines.push(`  ${person.store}: ${oneLine(person.name)}${person.employeeNumber ? ` (#${person.employeeNumber})` : ''}`))
    lines.push('')
  }
  if (notPosted.length) {
    lines.push('Not included:')
    notPosted.forEach(entry => lines.push(`  ${entry.store}: ${entry.note}`))
    lines.push('')
  }
  lines.push(`The attached schedule-emails.txt holds the same emails as JSON, each with its finished text and HTML.`)

  const attachmentJson = JSON.stringify({
    type: 'schedule-emails',
    key: relayKey,
    weekStart,
    weekRange: range,
    count: emails.length,
    emails,
    noEmail,
    notPosted
  }, null, 2)

  return {
    subject,
    text: lines.join('\n'),
    html: `<div style="font-family:Consolas,monospace;font-size:13px;">${lines.map(line => escapeHtml(line) || '&nbsp;').join('<br>')}</div>`,
    attachment: { name: 'schedule-emails.txt', content: Buffer.from(attachmentJson, 'utf8').toString('base64') },
    emails,
    noEmail
  }
}

module.exports = {
  DAY_KEYS,
  SUBJECT_TAG,
  weekRange,
  weekDays,
  personKeyOf,
  shiftsSignature,
  scheduledPeople,
  accountFor,
  signReplyToken,
  verifyReplyToken,
  buildScheduleEmail
}
