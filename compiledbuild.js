if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config()
}


const Item = require('./models/Item')

const AttendancePoint = require(
  './models/AttendancePoint'
);

const AttendancePointRecommendation =
  require(
    './models/AttendancePointRecommendation'
  );

const {
  STORE_LIST,
  ALL_STORES_VALUE,
  ACCESS_ROLES,
  getCanonicalStoreName,
  normalizeStoreList
} = require('./models/stores');

async function seedIfEmpty() {
  const count = await Item.countDocuments()
  if (count === 0) {
    console.log("Seeding items...")

    const items = ["FloorSpace"]
    for (let i = 1; i <= 108; i++) {
      items.push(`FloorSpace${i}`)
    }

    await Item.insertMany(items.map(i => ({ item_id: i })))
    console.log("✅ Items seeded")
  }
}

seedIfEmpty()

const crypto = require('crypto')
const path = require('path')
const express = require('express')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const cookieParser = require('cookie-parser')

const app = express()
app.set('trust proxy', 1);
const mongoose = require('mongoose')
const User = require('./models/User')
const LoginThrottle = require('./models/LoginThrottle')
const PostedSchedule = require('./models/PostedSchedule')
const SCHEDULE_STORES = require('./config/scheduleStores')
const TimeOffRequest = require('./models/TimeOffRequest')
const EmployeeAvailability = require('./models/EmployeeAvailability')
const ItemMonthStatus = require('./models/ItemMonthStatus')
const ItemRequest = require('./models/ItemRequest')
const ScheduleSettings = require(
  './models/ScheduleSettings'
)
const ScheduleTemplate = require('./models/ScheduleTemplate')
const AttendanceOvertimeReview = require(
  './models/AttendanceOvertimeReview'
);
const cron = require('node-cron');
// ------------------------
// EMAIL (Brevo HTTPS API — Render blocks outbound SMTP)
// ------------------------

const BREVO_SEND_URL =
  'https://api.brevo.com/v3/smtp/email';

// Sends one Brevo request for a single recipient.
// Returns the Brevo messageId.
async function sendBrevoEmail({
  to,
  subject,
  text,
  html
}) {
  const body = {
    sender: {
      name:
        process.env.EMAIL_FROM_NAME ||
        'Delaney App',

      email:
        process.env.EMAIL_FROM
    },

    to: [{ email: to }],

    subject
  };

  // Brevo rejects empty content fields
  if (html) body.htmlContent = html;
  if (text) body.textContent = text;

  const response = await fetch(
    BREVO_SEND_URL,
    {
      method: 'POST',

      headers: {
        'api-key':
          process.env.BREVO_API_KEY,

        'content-type':
          'application/json',

        accept:
          'application/json'
      },

      body:
        JSON.stringify(body)
    }
  );

  const data = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.message ||
      `The email provider rejected the message (HTTP ${response.status}).`
    );
  }

  return data.messageId || '';
}

// Each recipient gets a separate email, so one bad address does not
// block the others and recipients do not see each other's addresses.
// Throws only if every recipient failed.
async function sendEmail({
  to,
  subject,
  text,
  html
}) {
  if (!process.env.BREVO_API_KEY) {
    throw new Error(
      'BREVO_API_KEY is not configured.'
    );
  }

  if (!process.env.EMAIL_FROM) {
    throw new Error(
      'EMAIL_FROM is not configured.'
    );
  }

  const recipients =
    Array.isArray(to)
      ? to
      : [to];

  const cleanRecipients = [
    ...new Set(
      recipients
        .map(value =>
          String(value || '').trim()
        )
        .filter(Boolean)
    )
  ];

  if (!cleanRecipients.length) {
    throw new Error(
      'At least one email recipient is required.'
    );
  }

  const cleanSubject =
    String(subject || '').trim();

  const results = await Promise.allSettled(
    cleanRecipients.map(recipient =>
      sendBrevoEmail({
        to: recipient,
        subject: cleanSubject,
        text: String(text || ''),
        html: String(html || '')
      })
    )
  );

  const sent = [];
  const failed = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      sent.push({
        to: cleanRecipients[index],
        id: result.value
      });
    } else {
      failed.push({
        to: cleanRecipients[index],
        error: result.reason?.message || String(result.reason)
      });
    }
  });

  if (failed.length) {
    console.error(
      'Brevo email errors:',
      failed
    );
  }

  if (!sent.length) {
    throw new Error(
      failed[0]?.error ||
      'The email provider rejected the message.'
    );
  }

  console.log(
    'Brevo email accepted:',
    {
      sent,
      subject: cleanSubject
    }
  );

  return {
    id: sent[0].id,
    sent,
    failed
  };
}


// ------------------------
// DB SETUP
// ------------------------

// Only the Images folder is public. Serving __dirname exposed the server
// source, views and database files.
app.use(
  '/Images',
  express.static(path.join(__dirname, 'Images'))
)


mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("MongoDB connected ✅")
    await migrateUserRoles()
    await linkItemRequestsToUsers()
  })
  .catch(err => console.error(err))

// One-time, idempotent: floor-space requests used to identify their owner
// only by name. Link each older request to the single account with exactly
// that name; names matching no account or several are left unlinked (they
// still show on the Final pages, just not in anyone's My Requests).
async function linkItemRequestsToUsers() {
  const names = await ItemRequest.distinct('user', {
    userId: { $exists: false }
  })

  let linked = 0
  const skipped = []

  for (const name of names) {
    const matches = await User.find({ name }).select('_id').limit(2).lean()

    if (matches.length !== 1) {
      skipped.push({ name, accounts: matches.length })
      continue
    }

    const result = await ItemRequest.updateMany(
      { user: name, userId: { $exists: false } },
      { $set: { userId: matches[0]._id } }
    )
    linked += result.modifiedCount
  }

  if (linked || skipped.length) {
    console.log('Floor-space request owner migration:', { linked, skipped })
  }
}

// One-time, idempotent: move users from the old user/admin roles to the
// approval-based role + stores model.
async function migrateUserRoles() {
  const legacyFilter = {
    accessStatus: { $exists: false }
  }

  const admins = await User.updateMany(
    { ...legacyFilter, role: 'admin' },
    {
      $set: {
        stores: [ALL_STORES_VALUE],
        accessStatus: 'approved'
      }
    }
  )

  const others = await User.updateMany(
    { ...legacyFilter, role: { $ne: 'admin' } },
    {
      $set: {
        role: 'none',
        stores: [],
        accessStatus: 'none'
      }
    }
  )

  console.log('User role migration:', {
    adminsMigrated: admins.modifiedCount,
    usersMigrated: others.modifiedCount
  })

  // Accounts from before email verification: approved ones were vetted by
  // an admin and count as verified; everyone else must verify.
  const verified = await User.updateMany(
    { emailVerified: { $exists: false }, accessStatus: 'approved' },
    { $set: { emailVerified: true } }
  )

  const unverified = await User.updateMany(
    { emailVerified: { $exists: false } },
    { $set: { emailVerified: false } }
  )

  console.log('Email verification migration:', {
    markedVerified: verified.modifiedCount,
    markedUnverified: unverified.modifiedCount
  })
}




// ------------------------
// EXPRESS SETUP
// ------------------------

app.set('view engine', 'ejs')

// For embedding data in an inline <script>: <%- safeJson(value) %>.
// Plain JSON.stringify lets a value containing "</script>" end the script
// block early. Escaping < > & (and the two JS line separators) as \uXXXX
// leaves the parsed data identical but gives the HTML parser nothing to act on.
// The separators are built from char codes so no raw ones sit in this file.
const UNSAFE_SCRIPT_CHARS = new RegExp(
  "[<>&" + String.fromCharCode(0x2028, 0x2029) + "]",
  "g"
)

app.locals.safeJson = value =>
  JSON.stringify(value === undefined ? null : value)
    .replace(
      UNSAFE_SCRIPT_CHARS,
      char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')
    )

app.use(express.urlencoded({
  extended: false,
  limit: '2mb'
}));

app.use(express.json({
  limit: '2mb'
}));

// Many routes put request values straight into MongoDB filters. A key
// starting with "$" (e.g. {"month": {"$ne": null}}) would be read as a query
// operator and match far more than intended, so reject any request carrying
// one. No page sends such keys. (mongoose's sanitizeFilter option isn't used
// because it would also neutralize the app's own $lte/$gt queries.)
function findOperatorKey(value) {
  const stack = [value]

  while (stack.length) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue

    for (const key of Object.keys(current)) {
      if (key.startsWith('$')) return key
      stack.push(current[key])
    }
  }

  return null
}

app.use((req, res, next) => {
  const key = findOperatorKey(req.body) || findOperatorKey(req.query)

  if (key) {
    console.warn('Rejected request with operator key:', {
      path: req.path,
      key,
      ip: req.ip
    })

    return res.status(400).json({
      error: 'Invalid request data.'
    })
  }

  next()
})

app.use(cookieParser())


const PORT = process.env.PORT || 3301
const currentMonth = () => new Date().toISOString().slice(0, 7)

// ------------------------
// JWT HELPERS
// ------------------------

function signToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      // Must match user.tokenVersion; a password reset bumps it,
      // which invalidates every login issued before the reset
      tv: user.tokenVersion || 0
    },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d'
    }
  )
}

function getTokenFromRequest(req) {
  // Prefer cookie for browser app
  if (req.cookies && req.cookies.token) {
    return req.cookies.token
  }

  // Also allow Bearer token for API testing / future clients
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1]
  }

  return null
}

// Verifies a login token and returns its user, or null if the token is
// invalid, expired, for a deleted user, or from before a password reset.
async function userFromToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET)
  const user = await User.findById(payload.sub).lean()

  if (!user) return null

  // Tokens issued before tokenVersion existed have no tv; treat as 0
  if ((payload.tv || 0) !== (user.tokenVersion || 0)) return null

  return user
}

async function requireAuth(req, res, next) {
  try {
    const token = getTokenFromRequest(req)

    if (!token) {
      return res.redirect('/login')
    }

    const user = await userFromToken(token)

    if (!user) {
      res.clearCookie('token')
      return res.redirect('/login')
    }

    req.user = user
    next()
  } catch (err) {
    res.clearCookie('token')
    return res.redirect('/login')
  }
}

async function requireAuthApi(req, res, next) {
  try {
    const token = getTokenFromRequest(req)

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const user = await userFromToken(token)

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    req.user = user
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
}

async function requireGuest(req, res, next) {
  try {
    const token = getTokenFromRequest(req)
    if (!token) return next()

    const user = await userFromToken(token)

    if (user) {
      return res.redirect(homePathFor(user))
    }

    next()
  } catch {
    next()
  }
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    return next()
  }
  return sendForbiddenPage(res)
}

function requireAdminApi(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    return next()
  }
  return res.status(403).json({ error: 'Forbidden' })
}

// ------------------------
// ROLES & STORES
// ------------------------

// Page URLs per store. Express routing is case-insensitive, so these
// match the existing (inconsistently cased) route definitions.
const STORE_PAGES = {
  Branford: {
    mapId: 'branford',
    mapPath: '/branfordstoremap',
    finalPath: '/branfordstoremap/final',
    schedulePath: '/Branfordstoremap/Schedule',
    employeePath: '/branfordstoremap/my-schedule',
    image: '/Images/CoastalBranford.jpg'
  },
  Hamden: {
    mapId: 'Hamden',
    mapPath: '/Hamdenstoremap',
    finalPath: '/Hamdenstoremap/final',
    schedulePath: '/hamdenstoremap/schedule',
    employeePath: '/Hamdenstoremap/my-schedule',
    image: '/Images/Amity Hamden.jpg'
  },
  'New Haven': {
    mapId: 'New Haven',
    mapPath: '/New-Havenstoremap',
    finalPath: '/New-Havenstoremap/final',
    schedulePath: '/New-Havenstoremap/Schedule',
    employeePath: '/New-Havenstoremap/my-schedule',
    image: '/Images/Amity New Haven.jpg'
  },
  'New Milford': {
    mapId: 'New Milford',
    mapPath: '/New-Milfordstoremap',
    finalPath: '/New-Milfordstoremap/final',
    schedulePath: '/New-Milfordstoremap/schedule',
    employeePath: '/New-Milfordstoremap/my-schedule',
    image: '/Images/Classic New Milford.jpg'
  },
  Stratford: {
    mapId: 'stratford',
    mapPath: '/stratfordstoremap',
    finalPath: '/stratfordstoremap/final',
    schedulePath: '/stratfordstoremap/Schedule',
    employeePath: '/stratfordstoremap/my-schedule',
    image: '/Images/Stratford Townline.jpg'
  }
}

const ROLE_LABELS = {
  none: 'No access',
  employee: 'Employee',
  manager: 'Manager',
  vendor: 'Vendor',
  admin: 'Admin'
}

// map_id values are stored with inconsistent casing ('branford', 'Hamden')
function mapIdToStore(mapId) {
  return getCanonicalStoreName(mapId)
}

function isApproved(user) {
  return Boolean(
    user &&
    user.emailVerified === true &&
    user.accessStatus === 'approved' &&
    user.role &&
    user.role !== 'none'
  )
}

// Concrete list of store names a user covers
function userStores(user) {
  if (!user) return []

  const stores = Array.isArray(user.stores) ? user.stores : []

  if (
    user.role === 'admin' ||
    stores.includes(ALL_STORES_VALUE)
  ) {
    return [...STORE_LIST]
  }

  return stores.filter(store => STORE_LIST.includes(store))
}

function hasAllStores(user) {
  return Boolean(
    user &&
    (
      user.role === 'admin' ||
      (user.stores || []).includes(ALL_STORES_VALUE)
    )
  )
}

function canAccessStore(user, store) {
  return isApproved(user) && userStores(user).includes(store)
}

function canManageStore(user, store) {
  return (
    canAccessStore(user, store) &&
    (user.role === 'admin' || user.role === 'manager')
  )
}

// True when the approver covers every store in the list.
// Granting 'all' requires the approver to have 'all'.
function coversStores(approver, stores) {
  if (!stores || !stores.length) return false

  if (stores.includes(ALL_STORES_VALUE)) {
    return hasAllStores(approver)
  }

  const covered = userStores(approver)
  return stores.every(store => covered.includes(store))
}

function canApprove(approver, role, stores) {
  if (!isApproved(approver)) return false
  if (approver.role === 'admin') return true

  if (approver.role === 'manager') {
    return (
      (role === 'employee' || role === 'vendor') &&
      coversStores(approver, stores)
    )
  }

  return false
}

function homePathFor(user) {
  if (user && !user.emailVerified) {
    return '/verify-email'
  }

  if (!isApproved(user)) {
    return '/request-access'
  }

  const stores = userStores(user)

  if (
    user.role === 'admin' ||
    stores.length !== 1
  ) {
    return '/'
  }

  const pages = STORE_PAGES[stores[0]]

  if (user.role === 'manager') return pages.schedulePath
  if (user.role === 'vendor') return pages.mapPath
  if (user.role === 'employee') return pages.employeePath

  return '/'
}

// Index card link for one store. Managers/admins get the map, which
// shows their Final and Schedule buttons.
function storeLinkFor(user, store) {
  const pages = STORE_PAGES[store]

  if (user.role === 'employee') return pages.employeePath
  return pages.mapPath
}

function formatStores(stores) {
  if (!stores || !stores.length) return 'None'
  if (stores.includes(ALL_STORES_VALUE)) return 'All stores'
  return stores.join(', ')
}

function sendForbiddenPage(res, message) {
  return res.status(403).send(
    '<!DOCTYPE html><html><head><title>Forbidden</title>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '</head><body style="font-family:sans-serif;padding:40px;">' +
    '<h1>Access denied</h1>' +
    `<p>${escapeHtml(message || 'Your account does not have access to this page.')}</p>` +
    '<p><a href="/">Go to your home page</a></p>' +
    '</body></html>'
  )
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function requireApproved(req, res, next) {
  if (isApproved(req.user)) {
    return next()
  }
  return res.redirect('/request-access')
}

function requireApprovedApi(req, res, next) {
  if (isApproved(req.user)) {
    return next()
  }
  return res.status(403).json({
    error: 'Your account has not been approved yet.'
  })
}

// Admin always passes
function requireRole(...roles) {
  return (req, res, next) => {
    const role = req.user && req.user.role

    if (role === 'admin' || roles.includes(role)) {
      return next()
    }
    return sendForbiddenPage(res)
  }
}

function requireRoleApi(...roles) {
  return (req, res, next) => {
    const role = req.user && req.user.role

    if (role === 'admin' || roles.includes(role)) {
      return next()
    }
    return res.status(403).json({ error: 'Forbidden' })
  }
}

// For routes that belong to one fixed store
function requireStore(store) {
  return (req, res, next) => {
    if (canAccessStore(req.user, store)) {
      return next()
    }
    return sendForbiddenPage(
      res,
      `Your account does not have access to ${store}.`
    )
  }
}

// For APIs that name a store (or map_id) in the query or body.
// getter(req) returns the raw value; it is canonicalized here and
// stored on req.storeName for the handler.
function requireStoreFromRequest(getter) {
  return (req, res, next) => {
    const store = getCanonicalStoreName(getter(req))

    if (!store) {
      return res.status(400).json({
        success: false,
        error: 'A valid store is required.'
      })
    }

    if (!canAccessStore(req.user, store)) {
      return res.status(403).json({
        success: false,
        error: `Your account does not have access to ${store}.`
      })
    }

    req.storeName = store
    next()
  }
}

const storeFromQueryOrBody = req =>
  (req.query && req.query.store) ||
  (req.body && req.body.store)

const storeFromMapId = req =>
  mapIdToStore(
    (req.query && (req.query.map || req.query.map_id)) ||
    (req.body && (req.body.map || req.body.map_id))
  )

// Floor-space request APIs identify the store by map id
const floorSpaceApi = (...roles) => [
  ...approvedApi,
  requireRoleApi(...roles),
  requireStoreFromRequest(storeFromMapId)
]

// Loads an ItemRequest by body.request_id and checks the user can
// manage its store. Sets req.itemRequest.
async function requireItemRequestStore(req, res, next) {
  try {
    const requestId = req.body && req.body.request_id

    if (!requestId || !mongoose.isValidObjectId(requestId)) {
      return res.status(400).json({ error: 'request_id is required' })
    }

    const itemRequest = await ItemRequest.findById(requestId).lean()

    if (!itemRequest) {
      return res.status(404).json({ error: 'Request not found' })
    }

    if (!canManageStore(req.user, mapIdToStore(itemRequest.map_id))) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    req.itemRequest = itemRequest
    next()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
}

// For /:id routes: loads the document and checks the user manages its store
function requireDocStore(Model) {
  return async (req, res, next) => {
    try {
      const id = String(req.params.id || '').trim()

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid ID.'
        })
      }

      const doc = await Model.findById(id).select('store').lean()

      if (!doc) {
        return res.status(404).json({
          success: false,
          error: 'Record not found.'
        })
      }

      if (!canManageStore(req.user, getCanonicalStoreName(doc.store))) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden'
        })
      }

      next()
    } catch (err) {
      console.error(err)
      res.status(500).json({ success: false, error: err.message })
    }
  }
}

// Page guards: logged in + approved (+ role)
const approvedPage = [requireAuth, requireApproved]
const adminPage = [...approvedPage, requireAdmin]
const managerPage = store => [
  ...approvedPage,
  requireRole('manager'),
  requireStore(store)
]
const approvedApi = [requireAuthApi, requireApprovedApi]
const managerApi = [...approvedApi, requireRoleApi('manager')]
// Assigning or voiding attendance points is admin-only; managers recommend
const adminApi = [...approvedApi, requireAdminApi]

// ACCESS_REQUEST_NOTIFY_TO (comma-separated) overrides the approver list,
// e.g. to keep daily email volume down. Unset it to email approvers.
function getAccessRequestNotifyOverride() {
  return String(process.env.ACCESS_REQUEST_NOTIFY_TO || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
}

async function notifyApprovers(user) {
  const request = user.accessRequest || {}
  const requestedStores = request.stores || []

  const override = getAccessRequestNotifyOverride()

  const recipients = override.length
    ? override
    : await findApproverEmails(request, requestedStores)

  if (!recipients.length) {
    console.warn('No approvers to notify for access request:', user.email)
    return
  }

  const baseUrl = getAppBaseUrl()
  const link = `${baseUrl}/access-requests`
  const summary =
    `${user.name} (${user.email}) requested ` +
    `${ROLE_LABELS[request.role] || request.role} access for ` +
    `${formatStores(requestedStores)}.`

  await sendEmail({
    to: recipients,
    subject: 'New access request',
    text:
      `${summary}\n\n` +
      (request.note ? `Note: ${request.note}\n\n` : '') +
      `Review it here: ${link}`,
    html:
      `<p>${escapeHtml(summary)}</p>` +
      (request.note ? `<p>Note: ${escapeHtml(request.note)}</p>` : '') +
      `<p><a href="${escapeHtml(link)}">Review access requests</a></p>`
  })
}

// Admins, plus managers covering any requested store (employee/vendor only)
async function findApproverEmails(request, requestedStores) {
  const approvers = await User.find({
    accessStatus: 'approved',
    role: { $in: ['admin', 'manager'] }
  }).lean()

  return approvers
    .filter(approver => {
      if (approver.role === 'admin') return true

      if (!['employee', 'vendor'].includes(request.role)) {
        return false
      }

      // Managers who cover any of the requested stores
      if (requestedStores.includes(ALL_STORES_VALUE)) {
        return hasAllStores(approver)
      }
      const covered = userStores(approver)
      return requestedStores.some(store => covered.includes(store))
    })
    .map(approver => approver.email)
}

async function notifyRequester(user, decision, reason) {
  const baseUrl = getAppBaseUrl()
  const approved = decision === 'approved'

  const summary = approved
    ? `Your access request was approved. You now have ` +
      `${ROLE_LABELS[user.role] || user.role} access for ` +
      `${formatStores(user.stores)}.`
    : 'Your access request was denied.' +
      (reason ? ` Reason: ${reason}` : '')

  await sendEmail({
    to: user.email,
    subject: approved
      ? 'Your access request was approved'
      : 'Your access request was denied',
    text: `${summary}\n\n${baseUrl}/login`,
    html:
      `<p>${escapeHtml(summary)}</p>` +
      `<p><a href="${escapeHtml(baseUrl)}/login">Log in</a></p>`
  })
}

function getAppBaseUrl() {
  return String(
    process.env.APP_BASE_URL || `http://localhost:${PORT}`
  ).replace(/\/+$/, '')
}

// ------------------------
// AUTH ROUTES
// ------------------------

app.get('/login', requireGuest, (req, res) => {
  res.render('login.ejs', {
    error: null,
    notice: req.query.registered
      ? 'Account created. We sent a link to your email to confirm it. ' +
        'Log in to resend it if needed.'
      : null
  })
})



app.post(
  '/api/attendance-point-recommendations',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {
      const {
        store,
        employeeNumber,
        employeeName,
        infractionDate,
        infractionType,
        recommendedPoints,
        managerComment,
        sourceExceptionId
      } = req.body;

      const cleanStore =
        getCanonicalStoreName(store);

      const cleanEmployeeNumber = String(
        employeeNumber || ''
      ).trim();

      const cleanEmployeeName = String(
        employeeName || ''
      ).trim();

      const cleanInfractionType = String(
        infractionType || ''
      ).trim();

      const cleanComment = String(
        managerComment || ''
      ).trim();

      const cleanSourceExceptionId = String(
        sourceExceptionId || ''
      ).trim();

      const numericPoints =
        Number(recommendedPoints);

      const parsedInfractionDate =
        new Date(infractionDate);

      if (!cleanStore) {
        return res.status(400).json({
          success: false,
          error: 'A valid store is required.'
        });
      }

      if (!cleanEmployeeNumber) {
        return res.status(400).json({
          success: false,
          error:
            'Employee number is required.'
        });
      }

      if (!cleanEmployeeName) {
        return res.status(400).json({
          success: false,
          error:
            'Employee name is required.'
        });
      }

      if (
        Number.isNaN(
          parsedInfractionDate.getTime()
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            'A valid infraction date is required.'
        });
      }

      if (
        !Number.isInteger(numericPoints)
      ) {
        return res.status(400).json({
          success: false,
          error:
            'Recommended points must be a whole number.'
        });
      }

      const pointValidation =
        validateAttendancePointValue(
          cleanInfractionType,
          numericPoints
        );

      if (!pointValidation.valid) {
        return res.status(400).json({
          success: false,
          error:
            pointValidation.error
        });
      }

      if (!cleanComment) {
        return res.status(400).json({
          success: false,
          error:
            'A manager explanation is required.'
        });
      }

      if (!cleanSourceExceptionId) {
        return res.status(400).json({
          success: false,
          error:
            'The attendance exception ID is required.'
        });
      }

      const settings =
        await ScheduleSettings.findOne({
          store: cleanStore
        }).lean();

      if (!settings) {
        return res.status(404).json({
          success: false,
          error:
            'Schedule settings were not found.'
        });
      }

      const roster =
        buildExcelEmployeeRoster(settings);

      const rosterEmployee =
        roster.find(employee =>
          employee.employeeNumber ===
          cleanEmployeeNumber
        );

      if (!rosterEmployee) {
        return res.status(400).json({
          success: false,
          error:
            'The employee number does not belong to the selected store.'
        });
      }

      if (
        rosterEmployee.employeeName
          .trim()
          .toLowerCase() !==
        cleanEmployeeName
          .trim()
          .toLowerCase()
      ) {
        return res.status(400).json({
          success: false,
          error:
            'The supplied employee name does not match the employee number.'
        });
      }

      const existingRecommendation =
  await AttendancePointRecommendation.findOne({
    store: cleanStore,
    sourceExceptionId:
      cleanSourceExceptionId
  }).lean();

if (
  existingRecommendation?.assigned === true
) {
  return res.status(409).json({
    success: false,
    code:
      'RECOMMENDATION_ALREADY_ASSIGNED',
    error:
      'This recommendation has already been ' +
      'assigned and can no longer be changed.'
  });
}

      const recommendation =
        await AttendancePointRecommendation.findOneAndUpdate(
          {
            store: cleanStore,
            sourceExceptionId:
              cleanSourceExceptionId,
              assigned: false
          },
          {
            $set: {
              employeeNumber:
                cleanEmployeeNumber,

              employeeName:
                rosterEmployee.employeeName,

              infractionDate:
                parsedInfractionDate,

              infractionType:
                cleanInfractionType,

              recommendedPoints:
                numericPoints,

              managerComment:
                cleanComment,

              recommendedByUserId:
                req.user._id,

              recommendedByName:
                req.user.name
            },

            $setOnInsert: {
              store:
                cleanStore,

              sourceExceptionId:
                cleanSourceExceptionId,

              assigned:
                false
            }
          },
          {
            upsert: true,
            returnDocument: 'after',
            runValidators: true,
            setDefaultsOnInsert: true
          }
        ).lean();

      return res.json({
        success: true,

        message:
          'Recommendation saved.',

        recommendation
      });

    } catch (err) {

      console.error(
        'Attendance recommendation error:',
        err
      );

      return res.status(500).json({
        success: false,
        error:
          err.message ||
          'Recommendation could not be saved.'
      });
    }
  }
);

app.get(
  '/api/attendance-point-recommendations',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {

      const store =
        getCanonicalStoreName(
          req.query.store
        );

      if (!store) {
        return res.status(400).json({
          success: false,
          error:
            'A valid store is required.'
        });
      }

      const includeAll =
        String(
          req.query.includeAll || ''
        ).toLowerCase() === 'true';

      const employeeNumber =
        String(
          req.query.employeeNumber || ''
        ).trim();

      const filter = {
        store
      };

      if (employeeNumber) {
        filter.employeeNumber =
          employeeNumber;
      }

      if (!includeAll) {

        const oneYearAgo =
          new Date();

        oneYearAgo.setFullYear(
          oneYearAgo.getFullYear() - 1
        );

        filter.infractionDate = {
          $gte: oneYearAgo
        };
      }

      const recommendations =
        await AttendancePointRecommendation
          .find(filter)
          .sort({
            infractionDate: -1,
            updatedAt: -1
          })
          .lean();

      return res.json({
        success: true,
        recommendations
      });

    } catch (err) {

      console.error(
        'Recommendation retrieval error:',
        err
      );

      return res.status(500).json({
        success: false,
        error:
          err.message ||
          'Recommendations could not be loaded.'
      });
    }
  }
);

app.post(
  '/api/attendance-point-recommendations/:id/mark-assigned',
  ...adminApi,
  requireDocStore(AttendancePointRecommendation),
  async (req, res) => {
    try {

      const recommendationId = String(
        req.params.id || ''
      ).trim();

      const pointRecordId = String(
        req.body.pointRecordId || ''
      ).trim();

      if (
        !mongoose.Types.ObjectId.isValid(
          recommendationId
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            'Invalid recommendation ID.'
        });
      }

      if (
        !mongoose.Types.ObjectId.isValid(
          pointRecordId
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            'Invalid attendance point ID.'
        });
      }

      const pointRecord =
        await AttendancePoint.findById(
          pointRecordId
        ).lean();

      if (!pointRecord) {
        return res.status(404).json({
          success: false,
          error:
            'The attendance point record was not found.'
        });
      }

      const recommendation =
        await AttendancePointRecommendation.findOneAndUpdate(
          {
            _id: recommendationId,

            store:
              pointRecord.store,

            sourceExceptionId:
              pointRecord.sourceExceptionId
          },
          {
            $set: {
              assigned: true,

              assignedAt:
                new Date(),

              assignedPointRecordId:
                pointRecord._id
            }
          },
          {
            returnDocument: 'after',
            runValidators: true
          }
        ).lean();

      if (!recommendation) {
        return res.status(404).json({
          success: false,
          error:
            'The matching recommendation was not found.'
        });
      }

      return res.json({
        success: true,

        message:
          'Recommendation marked as assigned.',

        recommendation
      });

    } catch (err) {

      console.error(
        'Recommendation completion error:',
        err
      );

      return res.status(500).json({
        success: false,
        error:
          err.message ||
          'The recommendation could not be marked assigned.'
      });

    }
  }
);

app.get(
  '/api/attendance-points-summary',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {
      const store =
        getCanonicalStoreName(
          req.query.store
        );

      if (!store) {
        return res.status(400).json({
          success: false,
          error:
            'A valid store is required.'
        });
      }

      /*
       * Load the current Build Schedule roster.
       */
      const settings =
        await ScheduleSettings.findOne({
          store
        }).lean();

      if (!settings) {
        return res.status(404).json({
          success: false,
          error:
            'Schedule settings were not found.'
        });
      }

      /*
       * This helper builds the roster from:
       *
       * settings.managers
       * settings.associates
       * settings.cashiers
       * settings.buildEmployeeIdentifiers
       *
       * Employees without an employee number are
       * excluded by buildExcelEmployeeRoster().
       */
      const roster =
        buildExcelEmployeeRoster(
          settings
        );

      /*
       * Initialize the summary with every current
       * Build Schedule employee, including employees
       * who currently have zero points.
       */
      const employeeSummary = {};

      for (const employee of roster) {
        employeeSummary[
          employee.employeeNumber
        ] = {
          employeeNumber:
            employee.employeeNumber,

          employeeName:
            employee.employeeName,

          role:
            employee.role,

          totalPoints: 0,

          infractions: []
        };
      }

      /*
       * Build employee-number filtering from the
       * current Build Schedule roster.
       */
      const activeEmployeeNumbers =
        roster.map(employee =>
          employee.employeeNumber
        );

      /*
       * Calculate the exact rolling 365-day cutoff.
       */
      const cutoffDate =
        new Date();

      cutoffDate.setDate(
        cutoffDate.getDate() - 365
      );

      /*
       * Only query:
       *
       * 1. This store
       * 2. Non-voided point records
       * 3. Current Build Schedule employees
       * 4. Infractions from the last 365 days
       */
      const pointRecords =
        activeEmployeeNumbers.length > 0
          ? await AttendancePoint.find({
              store,

              voided: false,

              employeeNumber: {
                $in:
                  activeEmployeeNumbers
              },

              infractionDate: {
                $gte:
                  cutoffDate
              }
            })
              .sort({
                employeeName: 1,
                infractionDate: -1
              })
              .lean()
          : [];

      /*
       * Add each point record to its matching
       * Build Schedule employee.
       */
      for (const record of pointRecords) {
        const employee =
          employeeSummary[
            record.employeeNumber
          ];

        /*
         * This guard prevents records belonging to
         * removed employees from appearing.
         */
        if (!employee) {
          continue;
        }

        const pointValue =
          Number(record.points || 0);

        employee.totalPoints +=
          pointValue;

        employee.infractions.push({
          id:
            record._id,

          infractionDate:
            record.infractionDate,

          infractionType:
            record.infractionType,

          points:
            pointValue,

          managerComment:
            record.managerComment || '',

          assignedByName:
            record.assignedByName || '',

          assignedAt:
            record.createdAt || null,

          scheduledShift:
            record.scheduledShift || '',

          actualShift:
            record.actualShift || '',

          lateMinutes:
            Number(
              record.lateMinutes || 0
            ),

          earlyMinutes:
            Number(
              record.earlyMinutes || 0
            )
        });
      }

      /*
       * Employees with the most points appear first.
       * Equal point totals are sorted by employee name.
       */
      const employees =
        Object.values(
          employeeSummary
        ).sort(
          (first, second) => {
            if (
              second.totalPoints !==
              first.totalPoints
            ) {
              return (
                second.totalPoints -
                first.totalPoints
              );
            }

            return first.employeeName
              .localeCompare(
                second.employeeName
              );
          }
        );

      return res.json({
        success: true,

        store,

        cutoffDate:
          cutoffDate.toISOString(),

        employeeCount:
          employees.length,

        employees
      });
    } catch (err) {
      console.error(
        'Attendance point summary error:',
        err
      );

      return res.status(500).json({
        success: false,

        error:
          err.message ||
          'Attendance point history could not be loaded.'
      });
    }
  }
);


app.post(
  '/api/attendance-points/:id/void',
  ...adminApi,
  requireDocStore(AttendancePoint),
  async (req, res) => {
    try {
      const pointId = String(
        req.params.id || ''
      ).trim();

      const reason = String(
        req.body.reason || ''
      ).trim();

      if (
        !mongoose.Types.ObjectId.isValid(
          pointId
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            'Invalid attendance point ID.'
        });
      }

      if (!reason) {
        return res.status(400).json({
          success: false,
          error:
            'A reason is required to void points.'
        });
      }

      const pointRecord =
        await AttendancePoint.findOneAndUpdate(
          {
            _id: pointId,
            voided: false
          },
          {
            $set: {
              voided: true,
              voidedAt: new Date(),
              voidedByName:
                req.user.name,
              voidReason:
                reason
            }
          },
          {
            returnDocument: 'after',
            runValidators: true
          }
        ).lean();

      if (!pointRecord) {
        return res.status(404).json({
          success: false,
          error:
            'The active point record was not found.'
        });
      }

      return res.json({
        success: true,
        pointRecord
      });
    } catch (err) {
      console.error(
        'Attendance point void error:',
        err
      );

      return res.status(500).json({
        success: false,
        error:
          err.message ||
          'The point record could not be voided.'
      });
    }
  }
);


app.post('/login', requireGuest, async (req, res) => {
  try {
    const { email, password } = req.body

    const { user, error } = await attemptLogin(email, password, req.ip)
    if (!user) {
      return res.status(error.status).render('login.ejs', { error: error.message })
    }

    const token = signToken(user)

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    })

    res.redirect(homePathFor(user))
  } catch (err) {
    console.error(err)
    res.status(500).send('Login failed')
  }
})

// Case-insensitive so older accounts saved with mixed-case emails still match
function findUserByEmail(email) {
  return User.findOne({
    email: String(email || '').trim()
  }).collation({ locale: 'en', strength: 2 })
}

// ------------------------
// RATE LIMITS
// ------------------------

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

// 5 failed logins lock the account for 5 minutes; each further failure
// after a lockout doubles it, up to 24 hours.
const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_BASE_LOCKOUT_MS = 5 * MINUTE_MS
const LOGIN_MAX_LOCKOUT_MS = 24 * HOUR_MS

const RESET_EMAIL_INTERVAL_MS = HOUR_MS
const ACCESS_REQUEST_INTERVAL_MS = 6 * HOUR_MS
const VERIFY_EMAIL_INTERVAL_MS = 15 * MINUTE_MS
const VERIFY_LINK_LIFETIME_MS = 24 * HOUR_MS

// Per client IP, across all accounts: 20 failed logins within 15 minutes
// blocks that IP from logging in for 30 minutes. Employees at one store
// share an internet connection, so their typos count together.
const IP_MAX_FAILED_LOGINS = 20
const IP_FAILED_LOGIN_WINDOW_MS = 15 * MINUTE_MS
const IP_BLOCK_MS = 30 * MINUTE_MS

// Sign-up attempts per client IP. Every attempt counts (not just successful
// ones) so "Email already registered" can't be used to probe many addresses.
const REGISTER_MAX_PER_IP = 10
const REGISTER_WINDOW_MS = HOUR_MS

// Fixed-window counter for one action per IP, e.g. key "register:1.2.3.4".
// Counts the attempt atomically and returns { allowed, waitMs }.
async function claimIpQuota(key, max, windowMs) {
  const now = new Date()
  const windowExpired = {
    $or: [
      { $eq: [{ $ifNull: ['$windowStart', null] }, null] },
      { $lte: ['$windowStart', new Date(now.getTime() - windowMs)] }
    ]
  }

  const doc = await LoginThrottle.collection.findOneAndUpdate(
    { _id: key },
    [
      {
        $set: {
          count: {
            $cond: [windowExpired, 1, { $add: [{ $ifNull: ['$count', 0] }, 1] }]
          },
          windowStart: {
            $cond: [windowExpired, now, '$windowStart']
          }
        }
      },
      {
        $set: {
          expireAt: { $add: ['$windowStart', windowMs] }
        }
      }
    ],
    { upsert: true, returnDocument: 'after' }
  )

  if (doc.count <= max) return { allowed: true, waitMs: 0 }

  return {
    allowed: false,
    waitMs: Math.max(0, new Date(doc.windowStart).getTime() + windowMs - now.getTime())
  }
}

function ipBlockedError(blockedUntil) {
  return {
    status: 429,
    message:
      'Too many failed login attempts from your network. Try again in ' +
      `${formatWait(new Date(blockedUntil) - Date.now())}.`
  }
}

// Counts one login attempt for this IP *before* the password is checked,
// setting the block in the same atomic update when the limit is reached.
// Returns { blockedUntil } if the IP was already blocked, or
// { reachedLimitUntil } if this attempt started a block (it still gets
// checked, so a correct password on it succeeds and lifts the block).
async function countIpLoginAttempt(ip) {
  const now = new Date()
  const windowExpired = {
    $or: [
      { $eq: [{ $ifNull: ['$windowStart', null] }, null] },
      { $lt: ['$windowStart', new Date(now.getTime() - IP_FAILED_LOGIN_WINDOW_MS)] }
    ]
  }

  try {
    const counted = await LoginThrottle.collection.findOneAndUpdate(
      {
        _id: ip,
        $or: [
          { blockedUntil: null },
          { blockedUntil: { $lte: now } }
        ]
      },
      [
        {
          $set: {
            count: {
              $cond: [windowExpired, 1, { $add: [{ $ifNull: ['$count', 0] }, 1] }]
            },
            windowStart: {
              $cond: [windowExpired, now, '$windowStart']
            }
          }
        },
        {
          $set: {
            blockedUntil: {
              $cond: [
                { $gte: ['$count', IP_MAX_FAILED_LOGINS] },
                new Date(now.getTime() + IP_BLOCK_MS),
                null
              ]
            },
            expireAt: new Date(now.getTime() + IP_FAILED_LOGIN_WINDOW_MS + IP_BLOCK_MS)
          }
        }
      ],
      { upsert: true, returnDocument: 'after' }
    )

    return counted && counted.blockedUntil
      ? { reachedLimitUntil: counted.blockedUntil }
      : {}
  } catch (err) {
    // Filter didn't match because the IP is blocked, so the upsert tried to
    // insert a second document with the same _id
    if (err && err.code === 11000) {
      const current = await LoginThrottle.findById(ip).lean()
      return { blockedUntil: (current && current.blockedUntil) || now }
    }
    throw err
  }
}

// A successful login gives back the attempt it was charged
async function refundIpLoginAttempt(ip) {
  await LoginThrottle.collection.updateOne(
    { _id: ip },
    [
      { $set: { count: { $max: [0, { $subtract: [{ $ifNull: ['$count', 0] }, 1] }] } } },
      {
        $set: {
          blockedUntil: {
            $cond: [
              { $lt: ['$count', IP_MAX_FAILED_LOGINS] },
              null,
              '$blockedUntil'
            ]
          }
        }
      }
    ]
  )
}

function formatWait(ms) {
  const totalMinutes = Math.max(1, Math.ceil(ms / MINUTE_MS))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

  if (!hours) return plural(minutes, 'minute')
  if (!minutes) return plural(hours, 'hour')
  return `${plural(hours, 'hour')} ${plural(minutes, 'minute')}`
}

function lockedOutError(lockoutUntil) {
  return {
    status: 429,
    message:
      'Too many failed login attempts. Try again in ' +
      `${formatWait(new Date(lockoutUntil) - Date.now())}, ` +
      'or reset your password.'
  }
}

// Returns { user } on success or { error: { status, message } }.
//
// Each attempt is counted in one atomic update *before* the password is
// checked, and the attempt that reaches the limit sets the lockout in that
// same update. Many simultaneous guesses therefore can't slip past the limit.
//
// The client IP is limited first, across all accounts, so guessing one
// password against many accounts is also capped.
async function attemptLogin(email, password, ip) {
  const invalid = {
    error: { status: 401, message: 'Invalid credentials' }
  }

  const clientIp = String(ip || 'unknown')
  const ipCheck = await countIpLoginAttempt(clientIp)

  if (ipCheck.blockedUntil) {
    console.warn('Login blocked for IP:', clientIp)
    return { error: ipBlockedError(ipCheck.blockedUntil) }
  }

  // Any failure on the attempt that started an IP block reports the block
  const fail = result => {
    if (!ipCheck.reachedLimitUntil) return result

    console.warn('IP login block started:', clientIp)
    return { error: ipBlockedError(ipCheck.reachedLimitUntil) }
  }

  const user = await findUserByEmail(email)
  if (!user) return fail(invalid)

  const now = new Date()
  const attemptsExpr = {
    $add: [{ $ifNull: ['$failedLoginAttempts', 0] }, 1]
  }

  const counted = await User.collection.findOneAndUpdate(
    {
      _id: user._id,
      $or: [
        { lockoutUntil: null },
        { lockoutUntil: { $lte: now } }
      ]
    },
    [
      { $set: { failedLoginAttempts: attemptsExpr } },
      {
        $set: {
          lockoutUntil: {
            $cond: [
              { $gte: ['$failedLoginAttempts', LOGIN_MAX_ATTEMPTS] },
              {
                $add: [
                  now,
                  {
                    $min: [
                      LOGIN_MAX_LOCKOUT_MS,
                      {
                        $multiply: [
                          LOGIN_BASE_LOCKOUT_MS,
                          {
                            $pow: [
                              2,
                              {
                                // Cap the exponent; 2^20 x 5 min is already
                                // far past the 24-hour cap
                                $min: [
                                  20,
                                  { $subtract: ['$failedLoginAttempts', LOGIN_MAX_ATTEMPTS] }
                                ]
                              }
                            ]
                          }
                        ]
                      }
                    ]
                  }
                ]
              },
              null
            ]
          }
        }
      }
    ],
    { returnDocument: 'after' }
  )

  // Filter didn't match: the account is currently locked
  if (!counted) {
    const current = await User.findById(user._id)
      .select('lockoutUntil')
      .lean()

    return fail({
      error: lockedOutError(current && current.lockoutUntil || now)
    })
  }

  const ok = await bcrypt.compare(String(password || ''), user.password)

  if (ok) {
    await User.updateOne(
      { _id: user._id },
      { $set: { failedLoginAttempts: 0, lockoutUntil: null } }
    )
    await refundIpLoginAttempt(clientIp)
    return { user }
  }

  if (counted.lockoutUntil) {
    console.warn('Login lockout:', {
      email: user.email,
      failedLoginAttempts: counted.failedLoginAttempts,
      lockoutUntil: counted.lockoutUntil
    })

    return fail({ error: lockedOutError(counted.lockoutUntil) })
  }

  return fail(invalid)
}



app.post(
  '/api/attendance-points',
  ...adminApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {
      const {
        store,
        employeeNumber,
        employeeName,
        infractionDate,
        infractionType,
        points,
        scheduledShift,
        actualShift,
        lateMinutes,
        earlyMinutes,
        managerComment,
        sourceExceptionId
      } = req.body;

      const cleanStore =
        getCanonicalStoreName(store);

      const cleanEmployeeNumber = String(
        employeeNumber || ''
      ).trim();

      const cleanEmployeeName = String(
        employeeName || ''
      ).trim();

      const cleanInfractionType = String(
        infractionType || ''
      ).trim();

      const cleanComment = String(
        managerComment || ''
      ).trim();

      const cleanSourceExceptionId = String(
        sourceExceptionId || ''
      ).trim();

      const numericPoints =
        Number(points);

      const parsedInfractionDate =
        new Date(infractionDate);

      if (!cleanStore) {
        return res.status(400).json({
          success: false,
          error: 'A valid store is required.'
        });
      }

      if (!cleanEmployeeNumber) {
        return res.status(400).json({
          success: false,
          error:
            'Employee number is required.'
        });
      }

      if (!cleanEmployeeName) {
        return res.status(400).json({
          success: false,
          error:
            'Employee name is required.'
        });
      }

      if (
        Number.isNaN(
          parsedInfractionDate.getTime()
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            'A valid infraction date is required.'
        });
      }

      if (
        !Number.isInteger(numericPoints)
      ) {
        return res.status(400).json({
          success: false,
          error:
            'Points must be a whole number.'
        });
      }

      const pointValidation =
        validateAttendancePointValue(
          cleanInfractionType,
          numericPoints
        );

      if (!pointValidation.valid) {
        return res.status(400).json({
          success: false,
          error:
            pointValidation.error
        });
      }

      if (!cleanComment) {
        return res.status(400).json({
          success: false,
          error:
            'A manager comment is required ' +
            'before points can be assigned.'
        });
      }

      if (!cleanSourceExceptionId) {
        return res.status(400).json({
          success: false,
          error:
            'The attendance exception ID is required.'
        });
      }

      const settings =
        await ScheduleSettings.findOne({
          store: cleanStore
        }).lean();

      if (!settings) {
        return res.status(404).json({
          success: false,
          error:
            'Schedule settings were not found.'
        });
      }

      const roster =
        buildExcelEmployeeRoster(settings);

      const rosterEmployee =
        roster.find(employee =>
          employee.employeeNumber ===
          cleanEmployeeNumber
        );

      if (!rosterEmployee) {
        return res.status(400).json({
          success: false,
          error:
            'The employee number does not belong ' +
            'to the selected store.'
        });
      }

      if (
        rosterEmployee.employeeName
          .trim()
          .toLowerCase() !==
        cleanEmployeeName
          .trim()
          .toLowerCase()
      ) {
        return res.status(400).json({
          success: false,
          error:
            'The supplied employee name does not ' +
            'match the employee number.'
        });
      }

      const existingPoint =
        await AttendancePoint.findOne({
          store: cleanStore,
          sourceExceptionId:
            cleanSourceExceptionId,
          voided: false
        }).lean();

      if (existingPoint) {
        return res.status(409).json({
          success: false,
          code: 'POINTS_ALREADY_ASSIGNED',
          error:
            'Points have already been assigned ' +
            'for this attendance exception.',
          pointRecord: existingPoint
        });
      }

      const pointRecord =
        await AttendancePoint.create({
          store: cleanStore,

          employeeNumber:
            cleanEmployeeNumber,

          employeeName:
            rosterEmployee.employeeName,

          infractionDate:
            parsedInfractionDate,

          infractionType:
            cleanInfractionType,

          points:
            numericPoints,

          scheduledShift: String(
            scheduledShift || ''
          ).trim(),

          actualShift: String(
            actualShift || ''
          ).trim(),

          lateMinutes: Math.max(
            0,
            Number(lateMinutes || 0)
          ),

          earlyMinutes: Math.max(
            0,
            Number(earlyMinutes || 0)
          ),

          managerComment:
            cleanComment,

          assignedByUserId:
            req.user._id,

          assignedByName:
            req.user.name,

          assignedByEmail:
            req.user.email || '',

          sourceExceptionId:
            cleanSourceExceptionId
        });

      return res.status(201).json({
        success: true,
        message:
          `${numericPoints} point(s) assigned ` +
          `to ${rosterEmployee.employeeName}.`,
        pointRecord:
          pointRecord.toObject()
      });
    } catch (err) {
      console.error(
        'Attendance point assignment error:',
        err
      );

      if (err?.code === 11000) {
        return res.status(409).json({
          success: false,
          code: 'POINTS_ALREADY_ASSIGNED',
          error:
            'Points have already been assigned ' +
            'for this attendance exception.'
        });
      }

      return res.status(500).json({
        success: false,
        error:
          err.message ||
          'Attendance points could not be assigned.'
      });
    }
  }
);

app.post(
  '/api/overtime-reviews',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {
      const {
        store,
        employeeNumber,
        employeeName,
        workDate,
        dayLabel,
        scheduledShift,
        actualShift,
        scheduledHours,
        actualHours,
        overtimeHours,
        explanation,
        sourceExceptionId
      } = req.body;

      const cleanStore =
        getCanonicalStoreName(store);

      const cleanEmployeeNumber = String(
        employeeNumber || ''
      ).trim();

      const cleanEmployeeName = String(
        employeeName || ''
      ).trim();

      const cleanDayLabel = String(
        dayLabel || ''
      ).trim();

      const cleanExplanation = String(
        explanation || ''
      ).trim();

      const cleanSourceExceptionId = String(
        sourceExceptionId || ''
      ).trim();

      const parsedWorkDate =
        new Date(workDate);

      const numericScheduledHours =
        Number(scheduledHours);

      const numericActualHours =
        Number(actualHours);

      const numericOvertimeHours =
        Number(overtimeHours);

      if (!cleanStore) {
        return res.status(400).json({
          success: false,
          error:
            'A valid store is required.'
        });
      }

      if (!cleanEmployeeNumber) {
        return res.status(400).json({
          success: false,
          error:
            'Employee number is required.'
        });
      }

      if (!cleanEmployeeName) {
        return res.status(400).json({
          success: false,
          error:
            'Employee name is required.'
        });
      }

      if (
        Number.isNaN(
          parsedWorkDate.getTime()
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            'A valid overtime date is required.'
        });
      }

      if (!cleanDayLabel) {
        return res.status(400).json({
          success: false,
          error:
            'The overtime day is required.'
        });
      }

      if (!cleanExplanation) {
        return res.status(400).json({
          success: false,
          error:
            'A manager overtime explanation is required.'
        });
      }

      if (
        cleanExplanation.length > 2000
      ) {
        return res.status(400).json({
          success: false,
          error:
            'The overtime explanation cannot exceed ' +
            '2,000 characters.'
        });
      }

      if (!cleanSourceExceptionId) {
        return res.status(400).json({
          success: false,
          error:
            'The overtime exception ID is required.'
        });
      }

      if (
        !Number.isFinite(
          numericScheduledHours
        ) ||
        numericScheduledHours < 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            'Scheduled hours must be a valid ' +
            'nonnegative number.'
        });
      }

      if (
        !Number.isFinite(
          numericActualHours
        ) ||
        numericActualHours < 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            'Actual hours must be a valid ' +
            'nonnegative number.'
        });
      }

      if (
        !Number.isFinite(
          numericOvertimeHours
        ) ||
        numericOvertimeHours < 0.5
      ) {
        return res.status(400).json({
          success: false,
          error:
            'The overtime amount must be at least ' +
            '0.50 hours.'
        });
      }

      const settings =
        await ScheduleSettings.findOne({
          store: cleanStore
        }).lean();

      if (!settings) {
        return res.status(404).json({
          success: false,
          error:
            'Schedule settings were not found.'
        });
      }

      const roster =
        buildExcelEmployeeRoster(settings);

      const rosterEmployee =
        roster.find(employee =>
          employee.employeeNumber ===
          cleanEmployeeNumber
        );

      if (!rosterEmployee) {
        return res.status(400).json({
          success: false,
          error:
            'The employee number does not belong ' +
            'to the selected store.'
        });
      }

      if (
        rosterEmployee.employeeName
          .trim()
          .toLowerCase() !==
        cleanEmployeeName
          .trim()
          .toLowerCase()
      ) {
        return res.status(400).json({
          success: false,
          error:
            'The employee name does not match ' +
            'the employee number.'
        });
      }

      const review =
        await AttendanceOvertimeReview.findOneAndUpdate(
          {
            store: cleanStore,
            sourceExceptionId:
              cleanSourceExceptionId,
            voided: false
          },
          {
            $set: {
              employeeNumber:
                cleanEmployeeNumber,

              employeeName:
                rosterEmployee.employeeName,

              workDate:
                parsedWorkDate,

              dayLabel:
                cleanDayLabel,

              scheduledShift: String(
                scheduledShift || ''
              ).trim(),

              actualShift: String(
                actualShift || ''
              ).trim(),

              scheduledHours:
                numericScheduledHours,

              actualHours:
                numericActualHours,

              overtimeHours:
                numericOvertimeHours,

              explanation:
                cleanExplanation,

              reviewedByUserId:
                req.user._id,

              reviewedByName:
                req.user.name,

              reviewedByEmail:
                req.user.email || ''
            },

            $setOnInsert: {
              store:
                cleanStore,

              sourceExceptionId:
                cleanSourceExceptionId,

              voided:
                false
            }
          },
          {
            upsert: true,
            returnDocument: 'after',
            runValidators: true,
            setDefaultsOnInsert: true
          }
        ).lean();

      return res.json({
        success: true,

        message:
          'The overtime explanation was saved.',

        review
      });
    } catch (err) {
      console.error(
        'Overtime review save error:',
        err
      );

      if (err?.code === 11000) {
        return res.status(409).json({
          success: false,
          error:
            'An overtime review already exists ' +
            'for this exception.'
        });
      }

      return res.status(500).json({
        success: false,
        error:
          err.message ||
          'The overtime explanation could not be saved.'
      });
    }
  }
);

app.get(
  '/api/overtime-reviews',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {
      const store =
        getCanonicalStoreName(
          req.query.store
        );

      if (!store) {
        return res.status(400).json({
          success: false,
          error:
            'A valid store is required.'
        });
      }

      const includeAll =
        String(
          req.query.includeAll || ''
        ).toLowerCase() === 'true';

      const filter = {
        store,
        voided: false
      };

      if (!includeAll) {
        const oneYearAgo =
          new Date();

        oneYearAgo.setFullYear(
          oneYearAgo.getFullYear() - 1
        );

        filter.workDate = {
          $gte: oneYearAgo
        };
      }

      const reviews =
        await AttendanceOvertimeReview.find(
          filter
        )
          .sort({
            workDate: -1,
            updatedAt: -1
          })
          .lean();

      return res.json({
        success: true,
        reviews
      });
    } catch (err) {
      console.error(
        'Overtime review retrieval error:',
        err
      );

      return res.status(500).json({
        success: false,
        error:
          err.message ||
          'Overtime reviews could not be loaded.'
      });
    }
  }
);

const ALLOWED_ATTENDANCE_POINTS = {
  tardy: [0, 1],
  left_early: [0, 1],
  late_and_left_early: [0, 1, 2],
  absence: [0, 1, 2, 3, 4, 5],
  no_call_no_show: [0, 5]
};

function validateAttendancePointValue(
  infractionType,
  points
) {
  const allowed =
    ALLOWED_ATTENDANCE_POINTS[
      infractionType
    ];

  if (!allowed) {
    return {
      valid: false,
      error: 'Invalid infraction type.'
    };
  }

  if (!allowed.includes(points)) {
    return {
      valid: false,
      error:
        `Invalid point value for ${infractionType}`
    };
  }

  return {
    valid: true
  };
}

app.get(
  '/api/attendance-points',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {
      const store =
        getCanonicalStoreName(
          req.query.store
        );


        if (!store) {
  return res.status(400).json({
    success: false,
    error: 'A valid store is required.'
  });
}
      const includeAll =
        String(
          req.query.includeAll || ''
        ).toLowerCase() === 'true';

      const employeeNumber =
        String(
          req.query.employeeNumber || ''
        ).trim();

      const filter = {
        store,
        voided: false
      };

      if (employeeNumber) {
        filter.employeeNumber =
          employeeNumber;
      }

      if (!includeAll) {
        const oneYearAgo =
          new Date();

        oneYearAgo.setFullYear(
          oneYearAgo.getFullYear() - 1
        );

        filter.infractionDate = {
          $gte: oneYearAgo
        };
      }

      const pointRecords =
        await AttendancePoint.find(filter)
          .sort({
            infractionDate: -1
          })
          .lean();

      return res.json({
        success: true,
        pointRecords
      });

    } catch (err) {

      console.error(err);

      return res.status(500).json({
        success:false,
        error:err.message
      });

    }
  }
);

app.get('/register', requireGuest, (req, res) => {
  res.render('register.ejs', { error: null })
})

app.post('/register', requireGuest, async (req, res) => {
  try {
    const quota = await claimIpQuota(
      `register:${req.ip || 'unknown'}`,
      REGISTER_MAX_PER_IP,
      REGISTER_WINDOW_MS
    )

    if (!quota.allowed) {
      console.warn('Sign-up rate limited for IP:', req.ip)
      return res.status(429).render('register.ejs', {
        error:
          'Too many sign-up attempts from your network. ' +
          `Try again in ${formatWait(quota.waitMs)}.`
      })
    }

    const { name, email, password, confirmPassword } = req.body;

    // ✅ check passwords match
    if (password !== confirmPassword) {
      return res.status(400).render('register.ejs', { 
        error: "Passwords do not match" 
      });
    }

    const cleanEmail = String(email || '').trim().toLowerCase()

    const existingUser = await findUserByEmail(cleanEmail)

    if (existingUser) {
      return res.status(400).render('register.ejs', { error: 'Email already registered' })
    }

    const hashedPassword = await bcrypt.hash(password, 10)

    // New accounts have no access until the email is verified and an
    // access request is approved
    const user = await User.create({
      name: String(name || '').trim(),
      email: cleanEmail,
      password: hashedPassword,
      role: 'none',
      stores: [],
      accessStatus: 'none',
      emailVerified: false
    })

    // A failed send isn't fatal: the verify page has a resend button
    await sendVerificationEmail(user).catch(err =>
      console.error('Verification email failed:', err)
    )

    res.redirect('/login?registered=1')
  } catch (err) {
    console.error(err)
    res.status(500).render('register.ejs', { error: 'Registration failed' })
  }
})

// ------------------------
// EMAIL VERIFICATION
// ------------------------

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

// Issues a new verification link (invalidating any earlier one) and emails
// it. Limited to once per 15 minutes per account, claimed atomically.
// Returns { sent: true } or { waitMs } when rate limited.
async function sendVerificationEmail(user) {
  const now = new Date()
  const token = crypto.randomBytes(32).toString('hex')

  const previous = await User.findOneAndUpdate(
    {
      _id: user._id,
      emailVerified: false,
      $or: [
        { lastVerifyEmailAt: null },
        { lastVerifyEmailAt: { $lte: new Date(now.getTime() - VERIFY_EMAIL_INTERVAL_MS) } }
      ]
    },
    {
      $set: {
        lastVerifyEmailAt: now,
        emailVerifyTokenHash: hashToken(token),
        emailVerifyExpiry: new Date(now.getTime() + VERIFY_LINK_LIFETIME_MS)
      }
    }
    // Returns the document as it was before the update, for rollback
  ).lean()

  if (!previous) {
    const current = await User.findById(user._id)
      .select('emailVerified lastVerifyEmailAt')
      .lean()

    if (!current || current.emailVerified) return { sent: false }

    return {
      waitMs: Math.max(
        0,
        new Date(current.lastVerifyEmailAt).getTime() + VERIFY_EMAIL_INTERVAL_MS - now.getTime()
      )
    }
  }

  const link = `${getAppBaseUrl()}/verify-email/${token}`

  try {
    await sendEmail({
      to: previous.email,
      subject: 'Confirm your email for the Delaney App',
      text:
        `Hi ${previous.name},\n\n` +
        'Confirm your email address to finish setting up your account:\n' +
        `${link}\n\n` +
        'This link expires in 24 hours. If you did not create an account, ' +
        'you can ignore this email.',
      html:
        `<p>Hi ${escapeHtml(previous.name)},</p>` +
        '<p>Confirm your email address to finish setting up your account:</p>' +
        `<p><a href="${escapeHtml(link)}">Confirm my email</a></p>` +
        '<p>This link expires in 24 hours. If you did not create an account, ' +
        'you can ignore this email.</p>'
    })
  } catch (err) {
    // Nothing was delivered, so don't spend the cooldown
    await User.updateOne(
      { _id: user._id },
      previous.lastVerifyEmailAt
        ? { $set: { lastVerifyEmailAt: previous.lastVerifyEmailAt } }
        : { $unset: { lastVerifyEmailAt: 1 } }
    )
    throw err
  }

  return { sent: true }
}

// Finds the unverified user for a link token that hasn't expired
function findUserByVerifyToken(token) {
  return User.findOne({
    emailVerifyTokenHash: hashToken(token),
    emailVerifyExpiry: { $gt: new Date() },
    emailVerified: false
  }).lean()
}

app.get('/verify-email', requireAuth, (req, res) => {
  if (req.user.emailVerified) {
    return res.redirect(homePathFor(req.user))
  }

  const last = req.user.lastVerifyEmailAt
  const waitMs = last
    ? Math.max(0, new Date(last).getTime() + VERIFY_EMAIL_INTERVAL_MS - Date.now())
    : 0

  res.render('verify-email.ejs', {
    mode: 'pending',
    user: req.user,
    resendWait: waitMs ? formatWait(waitMs) : '',
    message: req.query.message || '',
    error: req.query.error || ''
  })
})

// Defined before /verify-email/:token so "resend" isn't read as a token
app.post('/verify-email/resend', requireAuth, async (req, res) => {
  if (req.user.emailVerified) {
    return res.redirect(homePathFor(req.user))
  }

  try {
    const result = await sendVerificationEmail(req.user)

    if (result.waitMs) {
      return redirectWithMessage(res, '/verify-email', {
        error: `You can send another email in ${formatWait(result.waitMs)}.`
      })
    }

    return redirectWithMessage(res, '/verify-email', {
      message: `A new link was sent to ${req.user.email}.`
    })
  } catch (err) {
    console.error('Verification resend failed:', err)
    return redirectWithMessage(res, '/verify-email', {
      error: 'The email could not be sent. Please try again.'
    })
  }
})

// The emailed link only shows a confirm button. Verifying on GET would let
// email security scanners, which open links automatically, verify an
// address its owner never approved.
app.get('/verify-email/:token', async (req, res) => {
  const user = await findUserByVerifyToken(req.params.token)

  res.render('verify-email.ejs', {
    mode: user ? 'confirm' : 'invalid',
    user: user ? { name: user.name, email: user.email } : null,
    token: req.params.token,
    resendWait: '',
    message: '',
    error: ''
  })
})

app.post('/verify-email/:token', async (req, res) => {
  const user = await User.findOneAndUpdate(
    {
      emailVerifyTokenHash: hashToken(req.params.token),
      emailVerifyExpiry: { $gt: new Date() },
      emailVerified: false
    },
    {
      $set: { emailVerified: true },
      $unset: { emailVerifyTokenHash: 1, emailVerifyExpiry: 1 }
    },
    { returnDocument: 'after' }
  ).lean()

  if (user) {
    console.log('Email verified:', user.email)
  }

  res.render('verify-email.ejs', {
    mode: user ? 'done' : 'invalid',
    user: user ? { name: user.name, email: user.email } : null,
    token: '',
    resendWait: '',
    message: '',
    error: ''
  })
})

app.post('/logout', (req, res) => {
  res.clearCookie('token')
  res.redirect('/login')
})

// Optional JSON login route for API clients/Postman
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body

    const { user, error } = await attemptLogin(email, password, req.ip)
    if (!user) return res.status(error.status).json({ error: error.message })

    if (!isApproved(user)) {
      return res.status(403).json({
        error: 'Your account has not been approved yet.'
      })
    }

    const token = signToken(user)

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        stores: user.stores
      }
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Login failed' })
  }
})

// ------------------------
// PAGE ROUTES
// ------------------------

app.get('/', ...approvedPage, async (req, res) => {
  const home = homePathFor(req.user)

  if (home !== '/') {
    return res.redirect(home)
  }

  const pendingScheduleCount = req.user.role === 'admin'
    ? await PostedSchedule.countDocuments({ 'pending.submittedAt': { $exists: true } })
    : 0

  const storeCards = userStores(req.user).map(store => ({
    store,
    link: storeLinkFor(req.user, store),
    image: STORE_PAGES[store].image
  }))

  res.render('index.ejs', {
    name: req.user.name,
    user: req.user,
    storeCards,
    roleLabel: ROLE_LABELS[req.user.role] || req.user.role,
    canReviewAccess: ['admin', 'manager'].includes(req.user.role),
    canRequestSpace: ['admin', 'manager', 'vendor'].includes(req.user.role),
    pendingScheduleCount,
    canRequestTimeOff: ['employee', 'manager'].includes(req.user.role),
    pendingTimeOffCount: await pendingTimeOffCount(req.user)
  })
})

// Floor-space maps: vendors, managers and admins
const MAP_VIEWS = {
  Branford: 'Branford Store Map.ejs',
  Stratford: 'Stratford Map.ejs',
  'New Haven': 'New Haven Map.ejs',
  Hamden: 'Hamden Map.ejs',
  'New Milford': 'New Milford Map.ejs'
}

for (const [store, view] of Object.entries(MAP_VIEWS)) {
  app.get(
    STORE_PAGES[store].mapPath,
    ...approvedPage,
    requireRole('vendor', 'manager'),
    requireStore(store),
    (req, res) => {
      res.render(view, {
        user: req.user,
        // Shows the final/schedule buttons and approve/reject controls
        isAdmin: canManageStore(req.user, store),
        mapId: STORE_PAGES[store].mapId
      })
    }
  )
}

// ------------------------
// POSTED SCHEDULES
// ------------------------
//
// Managers submit a week's schedule for approval, admins approve it, and
// employees see approved weeks only. Weeks start on Monday and are stored
// as YYYY-MM-DD dates in the stores' time zone.

const SCHEDULE_DAY_KEYS = [
  'monday', 'tuesday', 'wednesday', 'thursday',
  'friday', 'saturday', 'sunday'
]

const SCHEDULE_GROUPS = {
  manager: 'Managers',
  associate: 'Associates',
  cashier: 'Cashiers'
}

const STORE_TIME_ZONE = 'America/New_York'

// How far from the current week a schedule can be posted
const POST_WEEKS_BACK = 4
const POST_WEEKS_AHEAD = 12

function storeToday() {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date())
}

function parseYmd(ymd) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''))
  if (!match) return null

  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]))

  // Rejects dates like 2026-02-31 that roll over
  return date.toISOString().slice(0, 10) === ymd ? date : null
}

function addDaysYmd(ymd, days) {
  const date = parseYmd(ymd)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function mondayOf(ymd) {
  const date = parseYmd(ymd)
  const daysSinceMonday = (date.getUTCDay() + 6) % 7
  return addDaysYmd(ymd, -daysSinceMonday)
}

function isMonday(ymd) {
  const date = parseYmd(ymd)
  return Boolean(date) && date.getUTCDay() === 1
}

function formatYmd(ymd, options) {
  return parseYmd(ymd).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    ...options
  })
}

// "Current week", "Next week", or
// "Schedule posted for the week starting on Monday, October 5, 2026"
function weekLabel(weekStart, currentMonday) {
  if (weekStart === currentMonday) return 'Current week'
  if (weekStart === addDaysYmd(currentMonday, 7)) return 'Next week'

  return 'Schedule posted for the week starting on ' +
    formatYmd(weekStart, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function weekRangeText(weekStart) {
  const short = { month: 'short', day: 'numeric' }
  return `${formatYmd(weekStart, short)} – ` +
    `${formatYmd(addDaysYmd(weekStart, 6), { ...short, year: 'numeric' })}`
}

const cleanText = (value, max) =>
  String(value ?? '').trim().slice(0, max)

// A number of hours between 0 and max, to 2 decimals (0 if not a number)
const cleanHours = (value, max) => {
  const number = Number(value)
  return Number.isFinite(number)
    ? Math.round(Math.min(Math.max(number, 0), max) * 100) / 100
    : 0
}

// Rebuilds a submitted snapshot from known fields only, with size limits.
// Returns null if nothing usable was sent.
function cleanScheduleSnapshot(input) {
  if (!input || typeof input !== 'object') return null

  const groups = []

  for (const group of Array.isArray(input.groups) ? input.groups : []) {
    const type = String(group && group.type)
    if (!SCHEDULE_GROUPS[type]) continue
    if (groups.some(existing => existing.type === type)) continue

    const employees = []

    for (const employee of Array.isArray(group.employees) ? group.employees.slice(0, 500) : []) {
      const name = cleanText(employee && employee.name, 100)
      if (!name) continue

      const days = {}
      const changed = {}
      const hours = {}
      let shiftCount = 0

      for (const day of SCHEDULE_DAY_KEYS) {
        const shifts = Array.isArray(employee.days && employee.days[day])
          ? employee.days[day].slice(0, 6)
          : []

        const flags = Array.isArray(employee.changed && employee.changed[day])
          ? employee.changed[day]
          : []

        days[day] = []
        changed[day] = []

        shifts.forEach((shift, index) => {
          const text = cleanText(shift, 60)
          if (!text) return
          days[day].push(text)
          changed[day].push(flags[index] === true)
        })

        hours[day] = cleanHours(employee.hours && employee.hours[day], 24)
        shiftCount += days[day].length
      }

      if (shiftCount) {
        employees.push({
          name,
          employeeNumber: cleanText(employee.employeeNumber, 20),
          days,
          // Review details for admins (employees see names and times only)
          changed,
          hours,
          totalHours: cleanHours(employee.totalHours, 168),
          approvedOvertimeHours: cleanHours(employee.approvedOvertimeHours, 168),
          withinApproval: employee.withinApproval !== false,
          unapprovedOvertimeHours: cleanHours(employee.unapprovedOvertimeHours, 168)
        })
      }
    }

    if (employees.length) {
      groups.push({ type, label: SCHEDULE_GROUPS[type], employees })
    }
  }

  if (!groups.length) return null

  const adjustments = (Array.isArray(input.adjustments) ? input.adjustments : [])
    .slice(0, 1000)
    .map(item => ({
      day: cleanText(item && item.day, 40),
      shift: cleanText(item && item.shift, 100),
      details: cleanText(item && item.details, 300),
      reason: cleanText(item && item.reason, 1000)
    }))

  // Scheduling warnings the manager submitted anyway, and why
  const warnings = (Array.isArray(input.warnings) ? input.warnings : [])
    .slice(0, 200)
    .map(item => ({
      type: cleanText(item && item.type, 40),
      message: cleanText(item && item.message, 500)
    }))
    .filter(item => item.message)

  // When resubmitting a rejected week: the rejection being answered
  const previous = input.previousRejection
  const previousRejection = previous && typeof previous === 'object' && cleanText(previous.reason, 500)
    ? {
        reason: cleanText(previous.reason, 500),
        rejectedBy: cleanText(previous.rejectedBy, 100),
        rejectedAt: isNaN(new Date(previous.rejectedAt)) ? null : new Date(previous.rejectedAt)
      }
    : null

  return {
    templateName: cleanText(input.templateName, 200),
    groups,
    adjustments,
    previousRejection,
    warnings,
    warningsReason: warnings.length ? cleanText(input.warningsReason, 1000) : ''
  }
}

const personRef = user => ({ userId: user._id, name: user.name })

// Inside an update pipeline a string starting with "$" is read as a field
// path, so user-supplied values must be wrapped in $literal there
const literal = value => ({ $literal: value })
const pipelinePersonRef = user => ({
  userId: literal(user._id),
  name: literal(user.name)
})

async function notifyScheduleApprovers(store, weekStart, submitter) {
  const override = getAccessRequestNotifyOverride()

  const recipients = override.length
    ? override
    : (await User.find({ accessStatus: 'approved', role: 'admin' })
        .select('email')
        .lean()
      ).map(admin => admin.email)

  if (!recipients.length) return

  const link = `${getAppBaseUrl()}/schedule-approvals`
  const summary =
    `${submitter.name} submitted the ${store} schedule for the week of ` +
    `${weekRangeText(weekStart)} for approval.`

  await sendEmail({
    to: recipients,
    subject: `${store} schedule waiting for approval`,
    text: `${summary}\n\nReview it here: ${link}`,
    html:
      `<p>${escapeHtml(summary)}</p>` +
      `<p><a href="${escapeHtml(link)}">Review schedules</a></p>`
  })
}

// Manager submits a week. Admins' own submissions are approved at once.
app.post(
  '/api/posted-schedules',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {
      const store = req.storeName
      const weekStart = String(req.body.weekStart || '')
      const currentMonday = mondayOf(storeToday())

      if (!isMonday(weekStart)) {
        return res.status(400).json({
          success: false,
          error: 'Choose the Monday the week starts on.'
        })
      }

      if (
        weekStart < addDaysYmd(currentMonday, -7 * POST_WEEKS_BACK) ||
        weekStart > addDaysYmd(currentMonday, 7 * POST_WEEKS_AHEAD)
      ) {
        return res.status(400).json({
          success: false,
          error:
            `Schedules can be posted up to ${POST_WEEKS_BACK} weeks back ` +
            `and ${POST_WEEKS_AHEAD} weeks ahead.`
        })
      }

      const snapshot = cleanScheduleSnapshot(req.body.snapshot)

      if (!snapshot) {
        return res.status(400).json({
          success: false,
          error: 'The schedule has no assigned shifts to post.'
        })
      }

      if (snapshot.warnings.length && !snapshot.warningsReason) {
        return res.status(400).json({
          success: false,
          error: 'This schedule has warnings. Enter a reason to submit it anyway.'
        })
      }

      const now = new Date()
      const version = {
        snapshot,
        builderStateJson: cleanBuilderState(req.body.builderState),
        submittedBy: personRef(req.user),
        submittedAt: now
      }

      const autoApprove = req.user.role === 'admin'

      const update = autoApprove
        ? {
            $set: {
              approved: { ...version, approvedBy: personRef(req.user), approvedAt: now }
            },
            $unset: { pending: 1, lastRejection: 1 }
          }
        : { $set: { pending: version } }

      await PostedSchedule.updateOne(
        { store, weekStart },
        update,
        { upsert: true }
      )

      if (!autoApprove) {
        notifyScheduleApprovers(store, weekStart, req.user).catch(err =>
          console.error('Schedule approval notification failed:', err)
        )
      }

      console.log('Schedule posted:', {
        store,
        weekStart,
        by: req.user.email,
        status: autoApprove ? 'approved' : 'pending'
      })

      return res.json({
        success: true,
        status: autoApprove ? 'approved' : 'pending',
        weekStart
      })
    } catch (err) {
      console.error('Post schedule error:', err)
      return res.status(500).json({
        success: false,
        error: 'The schedule could not be posted.'
      })
    }
  }
)

// The Schedule page's working state sent with a submission: kept as JSON
// text (up to ~1 MB) so it round-trips exactly and its keys never reach
// MongoDB as field names. Returns '' if missing or not a JSON object.
function cleanBuilderState(value) {
  const text = typeof value === 'string' ? value : ''
  if (!text || text.length > 1000000) return ''

  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? text : ''
  } catch {
    return ''
  }
}

// A rejected week's saved page state, so the manager can load it and fix it
app.get(
  '/api/posted-schedules/rejected',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {
      const weekStart = String(req.query.week || '')

      const doc = await PostedSchedule.findOne({
        store: req.storeName,
        weekStart,
        'lastRejection.rejectedAt': { $exists: true }
      })
        .select('lastRejection')
        .lean()

      const rejection = doc && doc.lastRejection
      if (!rejection || !rejection.builderStateJson) {
        return res.status(404).json({
          success: false,
          error: 'There is no saved rejected schedule for that week.'
        })
      }

      return res.json({
        success: true,
        weekStart,
        builderState: JSON.parse(rejection.builderStateJson),
        rejection: {
          reason: rejection.reason || '',
          rejectedBy: rejection.rejectedBy && rejection.rejectedBy.name,
          rejectedAt: rejection.rejectedAt
        }
      })
    } catch (err) {
      console.error('Load rejected schedule error:', err)
      return res.status(500).json({
        success: false,
        error: 'The rejected schedule could not be loaded.'
      })
    }
  }
)

// Posting status per week, for the manager's Schedule page
app.get(
  '/api/posted-schedules',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {
      const currentMonday = mondayOf(storeToday())

      const docs = await PostedSchedule.aggregate([
        { $match: { store: req.storeName } },
        { $sort: { weekStart: -1 } },
        { $limit: 60 },
        {
          $project: {
            weekStart: 1,
            'approved.submittedBy': 1,
            'approved.approvedBy': 1,
            'approved.approvedAt': 1,
            'pending.submittedBy': 1,
            'pending.submittedAt': 1,
            'lastRejection.reason': 1,
            'lastRejection.rejectedBy': 1,
            'lastRejection.rejectedAt': 1,
            rejectedCanLoad: {
              $gt: [{ $strLenCP: { $ifNull: ['$lastRejection.builderStateJson', ''] } }, 0]
            }
          }
        }
      ])

      return res.json({
        success: true,
        currentMonday,
        weeks: docs.map(doc => ({
          weekStart: doc.weekStart,
          label: weekLabel(doc.weekStart, currentMonday),
          range: weekRangeText(doc.weekStart),
          approved: doc.approved && doc.approved.approvedAt
            ? {
                approvedBy: doc.approved.approvedBy && doc.approved.approvedBy.name,
                approvedAt: doc.approved.approvedAt
              }
            : null,
          pending: doc.pending && doc.pending.submittedAt
            ? {
                submittedBy: doc.pending.submittedBy && doc.pending.submittedBy.name,
                submittedAt: doc.pending.submittedAt
              }
            : null,
          lastRejection: doc.lastRejection && doc.lastRejection.rejectedAt
            ? {
                reason: doc.lastRejection.reason || '',
                rejectedBy: doc.lastRejection.rejectedBy && doc.lastRejection.rejectedBy.name,
                rejectedAt: doc.lastRejection.rejectedAt,
                canLoad: Boolean(doc.rejectedCanLoad)
              }
            : null
        }))
      })
    } catch (err) {
      console.error('List posted schedules error:', err)
      return res.status(500).json({
        success: false,
        error: 'Posted schedules could not be loaded.'
      })
    }
  }
)

// Builds the admin review table in the printable schedule's layout: one
// row per employee (managers, associates, cashiers), shifts by day with
// changed shifts flagged, hours, overtime, and day/grand totals. When the
// week already has an approved version, each cell also carries what
// employees currently see if it differs.
function buildScheduleReview(snapshot, liveSnapshot) {
  const flatten = snap => (snap && Array.isArray(snap.groups) ? snap.groups : [])
    .flatMap(group => group.employees || [])

  const employees = flatten(snapshot)
  const live = liveSnapshot ? flatten(liveSnapshot) : null
  const liveByName = new Map((live || []).map(employee => [employee.name, employee]))

  const rows = employees.map(employee => {
    const before = live ? liveByName.get(employee.name) : null

    return {
      name: employee.name,
      isNew: Boolean(live) && !before,
      cells: SCHEDULE_DAY_KEYS.map(day => {
        const shifts = (employee.days && employee.days[day]) || []
        const changed = (employee.changed && employee.changed[day]) || []
        const liveShifts = before ? (before.days[day] || []) : []

        return {
          shifts: shifts.map((text, i) => ({ text, changed: changed[i] === true })),
          liveShifts,
          differsFromLive: Boolean(live) && before &&
            shifts.join('|') !== liveShifts.join('|')
        }
      }),
      totalHours: employee.totalHours,
      approvedOvertimeHours: employee.approvedOvertimeHours,
      withinApproval: employee.withinApproval !== false,
      unapprovedOvertimeHours: employee.unapprovedOvertimeHours,
      // Older submissions didn't include hours
      hasHours: typeof employee.totalHours === 'number',
      hasChangedShift: SCHEDULE_DAY_KEYS.some(day =>
        ((employee.changed && employee.changed[day]) || []).includes(true))
    }
  })

  const hasHours = rows.some(row => row.hasHours)

  const dayTotals = SCHEDULE_DAY_KEYS.map(day =>
    employees.reduce((sum, employee) =>
      sum + ((employee.hours && employee.hours[day]) || 0), 0))

  return {
    rows,
    hasHours,
    dayTotals,
    grandTotal: dayTotals.reduce((sum, value) => sum + value, 0),
    // Store-wide overtime: approved OT hours and hours over approval
    totalApprovedOvertime: rows.reduce((sum, row) =>
      sum + (row.hasHours ? row.approvedOvertimeHours : 0), 0),
    totalOverApproval: rows.reduce((sum, row) =>
      sum + (row.hasHours ? row.unapprovedOvertimeHours : 0), 0),
    // In the live version but no longer scheduled at all
    removedFromLive: live
      ? live.filter(employee => !employees.some(e => e.name === employee.name))
        .map(employee => employee.name)
      : []
  }
}

// Admin review queue
app.get('/schedule-approvals', ...adminPage, async (req, res) => {
  const currentMonday = mondayOf(storeToday())

  const pending = await PostedSchedule.find({ 'pending.submittedAt': { $exists: true } })
    .sort({ 'pending.submittedAt': 1 })
    .lean()

  res.render('schedule-approvals.ejs', {
    user: req.user,
    items: pending.map(doc => ({
      id: String(doc._id),
      store: doc.store,
      weekStart: doc.weekStart,
      label: weekLabel(doc.weekStart, currentMonday),
      range: weekRangeText(doc.weekStart),
      replacesApproved: Boolean(doc.approved && doc.approved.approvedAt),
      submittedBy: doc.pending.submittedBy && doc.pending.submittedBy.name,
      submittedAt: doc.pending.submittedAt,
      snapshot: doc.pending.snapshot || { groups: [], adjustments: [] },
      review: buildScheduleReview(
        doc.pending.snapshot,
        doc.approved && doc.approved.approvedAt ? doc.approved.snapshot : null
      )
    })),
    dayKeys: SCHEDULE_DAY_KEYS,
    message: req.query.message || '',
    error: req.query.error || ''
  })
})

// Admin: browse approved schedules by store and week, in the same review
// layout as the approvals page (changes, reasons, hours and overtime)
app.get('/posted-schedules', ...adminPage, async (req, res) => {
  const currentMonday = mondayOf(storeToday())
  const store = getCanonicalStoreName(req.query.store) || STORE_LIST[0]

  const weeks = await PostedSchedule.find({
    store,
    'approved.approvedAt': { $exists: true }
  })
    .select('weekStart pending.submittedAt')
    .sort({ weekStart: -1 })
    .lean()

  const weekStarts = weeks.map(doc => doc.weekStart)
  const requested = String(req.query.week || '')

  // Default: the current week if posted, else the nearest upcoming one,
  // else the most recent
  const selected = weekStarts.includes(requested)
    ? requested
    : weekStarts.includes(currentMonday)
      ? currentMonday
      : [...weekStarts].reverse().find(week => week > currentMonday) ||
        weekStarts[0] ||
        ''

  const doc = selected
    ? await PostedSchedule.findOne({ store, weekStart: selected }).lean()
    : null

  const approved = doc && doc.approved

  res.render('posted-schedules.ejs', {
    user: req.user,
    stores: STORE_LIST,
    store,
    dayKeys: SCHEDULE_DAY_KEYS,
    weeks: weeks.map(week => ({
      weekStart: week.weekStart,
      label: weekLabel(week.weekStart, currentMonday),
      range: weekRangeText(week.weekStart),
      hasPending: Boolean(week.pending && week.pending.submittedAt)
    })),
    selected: approved
      ? {
          weekStart: selected,
          label: weekLabel(selected, currentMonday),
          range: weekRangeText(selected),
          submittedBy: approved.submittedBy && approved.submittedBy.name,
          submittedAt: approved.submittedAt,
          approvedBy: approved.approvedBy && approved.approvedBy.name,
          approvedAt: approved.approvedAt,
          hasPending: Boolean(doc.pending && doc.pending.submittedAt),
          item: {
            snapshot: approved.snapshot || { groups: [], adjustments: [] },
            review: buildScheduleReview(approved.snapshot, null),
            replacesApproved: false
          }
        }
      : null
  })
})

// Approve or reject exactly the version the admin reviewed: the form sends
// the pending version's submittedAt, so a resubmission made in the meantime
// isn't approved unseen.
function pendingVersionFilter(req) {
  const submittedAt = new Date(String(req.body.submittedAt || ''))

  if (!mongoose.isValidObjectId(req.params.id) || isNaN(submittedAt)) {
    return null
  }

  return {
    _id: new mongoose.Types.ObjectId(req.params.id),
    'pending.submittedAt': submittedAt
  }
}

app.post('/schedule-approvals/:id/approve', ...adminPage, async (req, res) => {
  try {
    const filter = pendingVersionFilter(req)
    if (!filter) {
      return redirectWithMessage(res, '/schedule-approvals', { error: 'Schedule not found.' })
    }

    const doc = await PostedSchedule.collection.findOneAndUpdate(
      filter,
      [
        {
          $set: {
            approved: {
              $mergeObjects: [
                '$pending',
                { approvedBy: pipelinePersonRef(req.user), approvedAt: literal(new Date()) }
              ]
            }
          }
        },
        { $unset: ['pending', 'lastRejection'] }
      ],
      { returnDocument: 'after' }
    )

    if (!doc) {
      return redirectWithMessage(res, '/schedule-approvals', {
        error: 'That schedule was changed or already reviewed. Please check it again.'
      })
    }

    console.log('Schedule approved:', { store: doc.store, weekStart: doc.weekStart, by: req.user.email })

    return redirectWithMessage(res, '/schedule-approvals', {
      message: `Approved the ${doc.store} schedule for ${weekRangeText(doc.weekStart)}. Employees can see it now.`
    })
  } catch (err) {
    console.error('Approve schedule error:', err)
    return redirectWithMessage(res, '/schedule-approvals', { error: 'Could not approve the schedule.' })
  }
})

app.post('/schedule-approvals/:id/reject', ...adminPage, async (req, res) => {
  try {
    const filter = pendingVersionFilter(req)
    if (!filter) {
      return redirectWithMessage(res, '/schedule-approvals', { error: 'Schedule not found.' })
    }

    // The manager needs to know what to fix
    if (!cleanText(req.body.reason, 500)) {
      return redirectWithMessage(res, '/schedule-approvals', {
        error: 'Enter a reason to reject the schedule.'
      })
    }

    const doc = await PostedSchedule.collection.findOneAndUpdate(
      filter,
      [
        {
          $set: {
            lastRejection: {
              reason: literal(cleanText(req.body.reason, 500)),
              rejectedBy: pipelinePersonRef(req.user),
              rejectedAt: literal(new Date()),
              submittedAt: '$pending.submittedAt',
              // Kept so the manager can load it back and fix it
              submittedBy: '$pending.submittedBy',
              snapshot: '$pending.snapshot',
              builderStateJson: '$pending.builderStateJson'
            }
          }
        },
        { $unset: 'pending' }
      ],
      { returnDocument: 'after' }
    )

    if (!doc) {
      return redirectWithMessage(res, '/schedule-approvals', {
        error: 'That schedule was changed or already reviewed. Please check it again.'
      })
    }

    return redirectWithMessage(res, '/schedule-approvals', {
      message: `Rejected the ${doc.store} schedule for ${weekRangeText(doc.weekStart)}.`
    })
  } catch (err) {
    console.error('Reject schedule error:', err)
    return redirectWithMessage(res, '/schedule-approvals', { error: 'Could not reject the schedule.' })
  }
})

function isViewersRow(user, store, employee) {
  const link = (user.rosterLinks || []).find(item => item.store === store)

  if (link) {
    return Boolean(employee.employeeNumber) &&
      employee.employeeNumber === link.employeeNumber
  }

  return employee.name.trim().toLowerCase() ===
    String(user.name || '').trim().toLowerCase()
}

// ------------------------
// CALENDAR DOWNLOAD (.ics)
// ------------------------
//
// An employee's own shifts for next week, from the approved schedule, as a
// standard calendar
// file that Google Calendar, Outlook and Apple Calendar can import. Times
// are store-local (America/New_York). Each shift has a stable UID, so
// re-importing an updated week updates events instead of duplicating them
// in calendars that support that.

const ICS_TIME_ZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'TZNAME:EDT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'TZNAME:EST',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE'
]

// '9:30 PM' -> minutes after midnight
function clockTextToMinutes(text) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(text || '').trim())
  if (!match) return null
  let hours = Number(match[1]) % 12
  if (match[3].toUpperCase() === 'PM') hours += 12
  return hours * 60 + Number(match[2])
}

// '2026-09-29' + 570 minutes -> '20260929T093000' (minutes may pass midnight)
function icsLocalDateTime(ymd, minutes) {
  const date = addDaysYmd(ymd, Math.floor(minutes / 1440))
  const inDay = ((minutes % 1440) + 1440) % 1440
  return date.replace(/-/g, '') + 'T' +
    String(Math.floor(inDay / 60)).padStart(2, '0') +
    String(inDay % 60).padStart(2, '0') + '00'
}

const icsText = value => String(value ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n')

// Lines longer than 75 characters continue on the next line after a space
function foldIcsLine(line) {
  const parts = []
  let rest = line
  while (rest.length > 75) {
    parts.push(rest.slice(0, 75))
    rest = ' ' + rest.slice(75)
  }
  parts.push(rest)
  return parts.join('\r\n')
}

// The viewer's shifts in approved schedules, as calendar events
async function collectMyShifts(user, weekStarts) {
  const stores = userStores(user)
  const docs = await PostedSchedule.find({
    store: { $in: stores },
    weekStart: { $in: weekStarts },
    'approved.approvedAt': { $exists: true }
  })
    .select('store weekStart approved.snapshot.groups')
    .lean()

  const events = []

  for (const doc of docs) {
    for (const group of doc.approved.snapshot.groups || []) {
      for (const employee of group.employees || []) {
        if (!isViewersRow(user, doc.store, employee)) continue

        SCHEDULE_DAY_KEYS.forEach((day, index) => {
          const date = addDaysYmd(doc.weekStart, index)

          for (const shift of (employee.days && employee.days[day]) || []) {
            const [startText, endText] = String(shift).split(' to ')
            const start = clockTextToMinutes(startText)
            let end = clockTextToMinutes(endText)
            if (start == null || end == null) continue
            if (end <= start) end += 1440 // ends after midnight

            events.push({
              uid: `${doc.store}-${date}-${start}-${end}-${employee.employeeNumber || employee.name}`
                .replace(/[^A-Za-z0-9-]/g, '') + '@delaney-schedule',
              store: doc.store,
              role: SCHEDULE_GROUPS[group.type] ? SCHEDULE_GROUPS[group.type].replace(/s$/, '') : '',
              date,
              start,
              end,
              shift,
              weekStart: doc.weekStart
            })
          }
        })
      }
    }
  }

  return events.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
}

function buildIcs(events) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Delaney App//Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Delaney work schedule',
    'X-WR-TIMEZONE:America/New_York',
    ...ICS_TIME_ZONE
  ]

  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=America/New_York:${icsLocalDateTime(event.date, event.start)}`,
      `DTEND;TZID=America/New_York:${icsLocalDateTime(event.date, event.end)}`,
      `SUMMARY:${icsText(`Work: ${event.store}${event.role ? ` (${event.role})` : ''}`)}`,
      `LOCATION:${icsText(`Delaney ${event.store}`)}`,
      `DESCRIPTION:${icsText(`Scheduled shift ${event.shift}. From the approved schedule for the week of ${weekRangeText(event.weekStart)}.`)}`,
      'END:VEVENT'
    )
  }

  lines.push('END:VCALENDAR')
  return lines.map(foldIcsLine).join('\r\n') + '\r\n'
}

// Next week's shifts only
app.get('/my-schedule.ics', ...approvedPage, requireRole('employee', 'manager'), async (req, res) => {
  try {
    const nextMonday = addDaysYmd(mondayOf(storeToday()), 7)
    const events = await collectMyShifts(req.user, [nextMonday])

    if (!events.length) {
      return res.status(404).send(
        '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>No shifts</title></head><body style="font-family:sans-serif;padding:40px;">' +
        `<h1>No shifts to add</h1><p>${escapeHtml(
          `You have no shifts in an approved schedule for next week (${weekRangeText(nextMonday)}). ` +
          'It may not have been posted yet.')}</p>` +
        `<p><a href="${escapeHtml(homePathFor(req.user))}">Back to my schedule</a></p></body></html>`
      )
    }

    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="delaney-shifts-week-of-${nextMonday}.ics"`,
      'Cache-Control': 'no-store'
    })
    return res.send(buildIcs(events))
  } catch (err) {
    console.error('Calendar download error:', err)
    return res.status(500).send('The calendar file could not be created.')
  }
})

// Employees: approved schedules only, with a week picker
for (const store of STORE_LIST) {
  app.get(
    STORE_PAGES[store].employeePath,
    ...approvedPage,
    requireRole('employee', 'manager'),
    requireStore(store),
    async (req, res) => {
      try {
        const currentMonday = mondayOf(storeToday())
        const nextMonday = addDaysYmd(currentMonday, 7)

        const approvedWeeks = (await PostedSchedule.find({
          store,
          'approved.approvedAt': { $exists: true }
        })
          .select('weekStart')
          .sort({ weekStart: -1 })
          .limit(52)
          .lean()
        ).map(doc => doc.weekStart)

        // Current and next week are always listed, posted or not
        const weekStarts = [...new Set([nextMonday, currentMonday, ...approvedWeeks])]
          .sort()
          .reverse()

        const requested = String(req.query.week || '')
        const selected = weekStarts.includes(requested)
          ? requested
          : currentMonday

        const doc = await PostedSchedule.findOne({
          store,
          weekStart: selected,
          'approved.approvedAt': { $exists: true }
        })
          .select('approved.snapshot.groups approved.approvedAt')
          .lean()

        res.render('employee-schedule.ejs', {
          user: req.user,
          store,
          weeks: weekStarts.map(weekStart => ({
            weekStart,
            label: weekLabel(weekStart, currentMonday),
            range: weekRangeText(weekStart)
          })),
          selectedWeek: {
            weekStart: selected,
            label: weekLabel(selected, currentMonday),
            range: weekRangeText(selected)
          },
          // Shifts only: adjustment reasons are for managers and admins
          // Names and times only; "me" marks the viewer's own row, found by
          // their roster link (or, if not linked, by exact name)
          groups: doc
            ? doc.approved.snapshot.groups.map(group => ({
                label: group.label,
                employees: group.employees.map(employee => ({
                  name: employee.name,
                  days: employee.days,
                  me: isViewersRow(req.user, store, employee)
                }))
              }))
            : [],
          posted: Boolean(doc),
          dayKeys: SCHEDULE_DAY_KEYS,
          showHomeLink: homePathFor(req.user) !== STORE_PAGES[store].employeePath
        })
      } catch (err) {
        console.error(`${store} employee schedule error:`, err)
        res.status(500).send('Error loading schedule')
      }
    }
  )
}

// ------------------------
// MY REQUESTS PAGES
// ------------------------

function getExcelClients() {
  return [
    {
      clientId: 'hamden-attendance-workbook',
      store: 'Hamden',
      token: String(
        process.env.EXCEL_TOKEN_HAMDEN || ''
      ).trim()
    },
    {
      clientId: 'new-milford-attendance-workbook',
      store: 'New Milford',
      token: String(
        process.env.EXCEL_TOKEN_NEW_MILFORD || ''
      ).trim()
    },
    {
      clientId: 'stratford-attendance-workbook',
      store: 'Stratford',
      token: String(
        process.env.EXCEL_TOKEN_STRATFORD || ''
      ).trim()
    },
    {
      clientId: 'new-haven-attendance-workbook',
      store: 'New Haven',
      token: String(
        process.env.EXCEL_TOKEN_NEW_HAVEN || ''
      ).trim()
    },

    {clientId: 'branford-attendance-workbook',
      store: 'Branford',
      token: String(
        process.env.EXCEL_TOKEN_BRANFORD || ''
        ).trim()
    }
  ].filter(client => client.token)
}

function secureTokenEquals(
  suppliedToken,
  expectedToken
) {
  const suppliedBuffer = Buffer.from(
    String(suppliedToken || ''),
    'utf8'
  )

  const expectedBuffer = Buffer.from(
    String(expectedToken || ''),
    'utf8'
  )

  if (
    suppliedBuffer.length !==
    expectedBuffer.length
  ) {
    return false
  }

  return crypto.timingSafeEqual(
    suppliedBuffer,
    expectedBuffer
  )
}

function requireExcelClient(req, res, next) {
  try {
    const authorization = String(
      req.headers.authorization || ''
    ).trim()

    if (
      !authorization.startsWith('Bearer ')
    ) {
      return res.status(401).json({
        success: false,
        error:
          'A valid Excel authorization token is required.'
      })
    }

    const suppliedToken =
      authorization.slice(7).trim()

    if (!suppliedToken) {
      return res.status(401).json({
        success: false,
        error:
          'A valid Excel authorization token is required.'
      })
    }

    const clients = getExcelClients()

    const client = clients.find(candidate =>
      secureTokenEquals(
        suppliedToken,
        candidate.token
      )
    )

    if (!client) {
      return res.status(401).json({
        success: false,
        error:
          'The Excel authorization token is invalid.'
      })
    }

    req.excelClient = {
      clientId: client.clientId,
      store: client.store
    }

    next()
  } catch (err) {
    console.error(
      'Excel authentication error:',
      err
    )

    return res.status(401).json({
      success: false,
      error:
        'Excel authentication failed.'
    })
  }
}
function buildExcelEmployeeRoster(settings) {
  const buildEmployeeIdentifiers =
    settings.buildEmployeeIdentifiers || {}

  const roster = []

  const roleGroups = [
    {
      role: 'manager',
      employees: settings.managers || []
    },
    {
      role: 'associate',
      employees: settings.associates || []
    },
    {
      role: 'cashier',
      employees: settings.cashiers || []
    }
  ]

  for (const group of roleGroups) {
    for (const suppliedName of group.employees) {
      const employeeName = String(
        suppliedName || ''
      ).trim()

      const employeeNumber = String(
        buildEmployeeIdentifiers[
          employeeName
        ] || ''
      ).trim()

      if (
        !employeeName ||
        !employeeNumber
      ) {
        continue
      }

      roster.push({
        employeeNumber,
        employeeName,
        role: group.role
      })
    }
  }

  return roster
}

function validateExcelEmployeeRoster(roster) {
  const seenNumbers = new Map()
  const seenNames = new Map()

  const duplicateNumbers = []
  const duplicateNames = []

  for (const employee of roster) {
    const normalizedNumber =
      employee.employeeNumber.toLowerCase()

    const normalizedName =
      employee.employeeName.toLowerCase()

    if (seenNumbers.has(normalizedNumber)) {
      duplicateNumbers.push(
        employee.employeeNumber
      )
    } else {
      seenNumbers.set(
        normalizedNumber,
        employee.employeeName
      )
    }

    if (seenNames.has(normalizedName)) {
      duplicateNames.push(
        employee.employeeName
      )
    } else {
      seenNames.set(
        normalizedName,
        employee.employeeNumber
      )
    }
  }

  return {
    valid:
      duplicateNumbers.length === 0 &&
      duplicateNames.length === 0,

    duplicateNumbers: [
      ...new Set(duplicateNumbers)
    ],

    duplicateNames: [
      ...new Set(duplicateNames)
    ]
  }
}

function createRosterVersion(
  store,
  roster
) {
  const versionSource = JSON.stringify({
    store,

    employees: roster
      .map(employee => ({
        employeeNumber:
          employee.employeeNumber,

        employeeName:
          employee.employeeName,

        role:
          employee.role
      }))
      .sort((first, second) =>
        first.employeeNumber.localeCompare(
          second.employeeNumber
        )
      )
  })

  return crypto
    .createHash('sha256')
    .update(versionSource)
    .digest('hex')
}

app.get(
  '/api/excel/employee-roster',
  requireExcelClient,
  async (req, res) => {
    try {
      const store =
        req.excelClient.store

      const requestedStore = String(
        req.query.store || ''
      ).trim()

      if (
        requestedStore &&
        requestedStore !== store
      ) {
        return res.status(403).json({
          success: false,
          error:
            'This Excel workbook cannot access ' +
            'the requested store.'
        })
      }

      const settings =
        await ScheduleSettings.findOne({
          store
        }).lean()

      if (!settings) {
        return res.status(404).json({
          success: false,
          error:
            'Schedule settings were not found ' +
            `for ${store}.`
        })
      }

      const employees =
        buildExcelEmployeeRoster(settings)

      const validation =
        validateExcelEmployeeRoster(
          employees
        )

      if (!validation.valid) {
        return res.status(409).json({
          success: false,

          error:
            'The employee roster contains duplicate ' +
            'names or employee numbers.',

          duplicateNumbers:
            validation.duplicateNumbers,

          duplicateNames:
            validation.duplicateNames
        })
      }

      const rosterVersion =
        createRosterVersion(
          store,
          employees
        )

      res.setHeader(
        'Cache-Control',
        'no-store'
      )

      console.log(
        'Excel roster downloaded:',
        {
          clientId:
            req.excelClient.clientId,

          store,

          employeeCount:
            employees.length,

          rosterVersion
        }
      )

      return res.json({
        success: true,
        store,
        generatedAt:
          new Date().toISOString(),
        rosterVersion,
        employeeCount:
          employees.length,
        employees
      })
    } catch (err) {
      console.error(
        'Excel roster download error:',
        err
      )

      return res.status(500).json({
        success: false,
        error:
          'The employee roster could not be downloaded.'
      })
    }
  }
)

app.post(
  '/api/excel/attendance',
  requireExcelClient,
  async (req, res) => {
    try {
      const store =
        req.excelClient.store

      const {
        rosterVersion,
        attendance
      } = req.body

      if (
        !attendance ||
        typeof attendance !== 'object' ||
        Array.isArray(attendance)
      ) {
        return res.status(400).json({
          success: false,
          error:
            'Attendance must be a JSON object.'
        })
      }

      const settings =
        await ScheduleSettings.findOne({
          store
        }).lean()

      if (!settings) {
        return res.status(404).json({
          success: false,
          error:
            'Schedule settings were not found ' +
            `for ${store}.`
        })
      }

      const currentRoster =
        buildExcelEmployeeRoster(settings)

      const rosterValidation =
        validateExcelEmployeeRoster(
          currentRoster
        )

      if (!rosterValidation.valid) {
        return res.status(409).json({
          success: false,
          error:
            'The server employee roster contains ' +
            'duplicate employee information.'
        })
      }

      const currentRosterVersion =
        createRosterVersion(
          store,
          currentRoster
        )

      if (
        rosterVersion &&
        rosterVersion !==
          currentRosterVersion
      ) {
        return res.status(409).json({
          success: false,
          code: 'ROSTER_OUTDATED',
          error:
            'The employee roster has changed. ' +
            'Refresh Sheet3 and try again.',
          currentRosterVersion
        })
      }

      const rosterByNumber =
        new Map(
          currentRoster.map(employee => [
            employee.employeeNumber,
            employee
          ])
        )

      const cleanAttendance = {}
      const rejectedNumbers = []

      for (
        const [
          suppliedNumber,
          suppliedRecord
        ] of Object.entries(attendance)
      ) {
        const record =
          suppliedRecord &&
          typeof suppliedRecord === 'object'
            ? suppliedRecord
            : {}

        const employeeNumber = String(
          record.employeeNumber ||
          suppliedNumber ||
          ''
        ).trim()

        if (!employeeNumber) {
          continue
        }

        const rosterEmployee =
          rosterByNumber.get(
            employeeNumber
          )

        if (!rosterEmployee) {
          rejectedNumbers.push(
            employeeNumber
          )

          continue
        }

        cleanAttendance[employeeNumber] = {
          employeeNumber,

          employeeName:
            rosterEmployee.employeeName,

          week:
            cleanAttendancePeriod(
              record.week
            ),

          year:
            cleanAttendancePeriod(
              record.year
            ),

          allTime:
            cleanAttendancePeriod(
              record.allTime
            )
        }
      }

      if (rejectedNumbers.length > 0) {
        return res.status(400).json({
          success: false,
          error:
            'Attendance contains employee numbers ' +
            'that do not belong to this store.',
          rejectedNumbers: [
            ...new Set(rejectedNumbers)
          ]
        })
      }

      if (
        Object.keys(cleanAttendance).length === 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            'No valid attendance records were supplied.'
        })
      }

      const updatedSettings =
        await ScheduleSettings.findOneAndUpdate(
          {
            store
          },
          {
            $set: {
              attendance:
                cleanAttendance
            }
          },
          {
            upsert: true,
            returnDocument: 'after',
            runValidators: true,
            setDefaultsOnInsert: true
          }
        ).lean()

      console.log(
        'Excel attendance uploaded:',
        {
          clientId:
            req.excelClient.clientId,

          store,

          employeeCount:
            Object.keys(
              cleanAttendance
            ).length,

          rosterVersion:
            currentRosterVersion
        }
      )

      return res.json({
        success: true,
        store,

        employeeCount:
          Object.keys(
            cleanAttendance
          ).length,

        rosterVersion:
          currentRosterVersion,

        attendance:
          updatedSettings.attendance || {}
      })
    } catch (err) {
      console.error(
        'Excel attendance upload error:',
        err
      )

      return res.status(500).json({
        success: false,
        error:
          err.message ||
          'Attendance could not be uploaded.'
      })
    }
  }
)

app.get("/my-requests", ...approvedPage, requireRole('vendor', 'manager'), async (req, res) => {
  const { store } = req.query;

  // By account, not name: two people can share a name
  const filter = {
    userId: req.user._id
  };

  const rows = await ItemRequest.find(filter)
    .sort({ created_at: -1 })
    .lean();

  //console.log(rows)
  res.render("my-requests.ejs", {
    user: req.user,
    requests: rows,
    selectedStore: req.query.store || ""
  });
});


// ------------------------
// FINAL PAGES (ADMIN ONLY)
// ------------------------

app.get('/branfordstoremap/final', ...managerPage('Branford'), async (req, res) => {
  const MAP_ID = 'branford'
  try {
    
    const month = req.query.month || currentMonth()

    const confirmed = await ItemRequest.find({
      month,
      map_id: MAP_ID
    })
      .select('item_id user brand products status')
      .sort({ item_id: 1 })
      .lean()


    res.render('branford-final.ejs', {
      user: req.user,
      month,
      requests: confirmed,
      mapId: MAP_ID
    })
  } catch (err) {
    console.error(err)
    res.send('Error loading final page')
  }
})

// Schedule page for every store: one shared view, with each store's preset
// coverage rows and whether it schedules cashiers from config/scheduleStores.js
for (const store of STORE_LIST) {
  const setup = SCHEDULE_STORES[store]

  app.get(
    STORE_PAGES[store].schedulePath,
    ...managerPage(store),
    async (req, res) => {
      try {
        let settings =
          await ScheduleSettings.findOne({ store }).lean()

        if (!settings) {
          const createdSettings =
            await ScheduleSettings.create({
              store,
              managers: [],
              associates: [],
              cashiers: [],
              availability: {},
              assignments: {},
              attendance: {},
              employeeIdentifiers: {},
              buildEmployeeIdentifiers: {},
              previousScheduledShifts: {},
              previousActualShifts: {},
              previousActualHours: {},
              previousScheduledHours: {},
              previousWeekStart: null,
              previousWeekEnd: null
            })

          settings = createdSettings.toObject()
        }

        return res.render('Store Schedule.ejs', {
          user: req.user,
          // The manager's own view of this store's approved schedule
          myScheduleUrl: STORE_PAGES[store].employeePath,
          pendingTimeOffCount: await pendingTimeOffCount(req.user),
          mapId: store,
          storeName: store,
          scheduleSetup: setup,
          scheduleData: {
            store,
            managers: settings.managers || [],
            associates: settings.associates || [],
            // Cashiers only exist at stores that schedule them
            cashiers: setup.hasCashiers ? (settings.cashiers || []) : [],
            approvedOvertimeHours: settings.approvedOvertimeHours || {},
            availability: settings.availability || {},
            assignments: settings.assignments || {},
            attendance: settings.attendance || {},
            buildEmployeeIdentifiers: settings.buildEmployeeIdentifiers || {},
            employeeIdentifiers: settings.employeeIdentifiers || {},
            previousScheduledShifts: settings.previousScheduledShifts || {},
            previousActualShifts: settings.previousActualShifts || {},
            previousActualHours: settings.previousActualHours || {},
            previousScheduledHours: settings.previousScheduledHours || {},
            previousWeekStart: settings.previousWeekStart || null,
            previousWeekEnd: settings.previousWeekEnd || null
          }
        })
      } catch (err) {
        console.error(`${store} schedule page error:`, err)
        return res.status(500).send(`Error loading ${store} schedule`)
      }
    }
  )
}

app.get('/stratfordstoremap/final', ...managerPage('Stratford'), async (req, res) => {
  const MAP_ID = 'stratford'
  try {
    
    const month = req.query.month || currentMonth()

    const confirmed = await ItemRequest.find({
      month,
      map_id: MAP_ID
    })
      .select('item_id user brand products status')
      .sort({ item_id: 1 })
      .lean()


    res.render('Stratford Final.ejs', {
      user: req.user,
      month,
      requests: confirmed,
      mapId: MAP_ID
    })
  } catch (err) {
    console.error(err)
    res.send('Error loading final page')
  }
})


app.get('/New-Havenstoremap/final', ...managerPage('New Haven'), async (req, res) => {
  const MAP_ID = 'New Haven'
  try {
    
    const month = req.query.month || currentMonth()

    const confirmed = await ItemRequest.find({
      month,
      map_id: MAP_ID
    })
      .select('item_id user brand products status')
      .sort({ item_id: 1 })
      .lean()


    res.render('New Haven final.ejs', {
      user: req.user,
      month,
      requests: confirmed,
      mapId: MAP_ID
    })
  } catch (err) {
    console.error(err)
    res.send('Error loading final page')
  }
})

app.get('/Hamdenstoremap/final', ...managerPage('Hamden'), async (req, res) => {
  const MAP_ID = 'Hamden'
  try {
    
    const month = req.query.month || currentMonth()

    const confirmed = await ItemRequest.find({
      month,
      map_id: MAP_ID
    })
      .select('item_id user brand products status')
      .sort({ item_id: 1 })
      .lean()


    res.render('Hamden-final.ejs', {
      user: req.user,
      month,
      requests: confirmed,
      mapId: MAP_ID
    })
  } catch (err) {
    console.error(err)
    res.send('Error loading final page')
  }
})



app.get('/New-Milfordstoremap/final', ...managerPage('New Milford'), async (req, res) => {
  const MAP_ID = 'New Milford'
  try {
    
    const month = req.query.month || currentMonth()

    const confirmed = await ItemRequest.find({
      month,
      map_id: MAP_ID
    })
      .select('item_id user brand products status')
      .sort({ item_id: 1 })
      .lean()


    res.render('New Milford Final.ejs', {
      user: req.user,
      month,
      requests: confirmed,
      mapId: MAP_ID
    })
  } catch (err) {
    console.error(err)
    res.send('Error loading final page')
  }
})




// ------------------------
// ADMIN USER MGMT
// ------------------------

app.get('/admin/users', ...adminPage, async (req, res) => {
  const users = await User.find()
    .select('name email role stores accessStatus accessRequest emailVerified rosterLinks')
    .sort({ name: 1 })
    .lean()

  const rosters = await getRosters(STORE_LIST)
  const owners = await getLinkOwners()

  res.render('admin-users.ejs', {
    user: req.user,
    users: users.map(u => ({
      ...u,
      linkDescriptions: describeRosterLinks(u, rosters),
      linkSuggestions: suggestionsFor(u, STORE_LIST, rosters, owners)
    })),
    rosters: rostersForForm(rosters, owners),
    roles: ACCESS_ROLES,
    roleLabels: ROLE_LABELS,
    storeList: STORE_LIST,
    formatStores,
    message: req.query.message || '',
    error: req.query.error || ''
  })
})

function redirectWithMessage(res, path, { message, error }) {
  const params = new URLSearchParams()
  if (message) params.set('message', message)
  if (error) params.set('error', error)
  return res.redirect(`${path}?${params.toString()}`)
}

// Set a user's role and stores directly (also approves them)
app.post('/admin/users/:id/access', ...adminPage, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return redirectWithMessage(res, '/admin/users', { error: 'User not found.' })
    }

    const target = await User.findById(req.params.id)

    if (!target) {
      return redirectWithMessage(res, '/admin/users', { error: 'User not found.' })
    }

    if (target._id.equals(req.user._id)) {
      return redirectWithMessage(res, '/admin/users', {
        error: 'You cannot change your own access.'
      })
    }

    if (!target.emailVerified) {
      return redirectWithMessage(res, '/admin/users', {
        error: `${target.email} has not verified their email yet.`
      })
    }

    const role = String(req.body.role || '')
    const stores = normalizeStoreList(req.body.stores)

    if (!ACCESS_ROLES.includes(role)) {
      return redirectWithMessage(res, '/admin/users', { error: 'Choose a valid role.' })
    }

    if (role !== 'admin' && !stores.length) {
      return redirectWithMessage(res, '/admin/users', {
        error: 'Choose at least one store.'
      })
    }

    const grantedStores = role === 'admin' ? [ALL_STORES_VALUE] : stores

    const linkResult = await readRosterLinks(req.body, {
      role,
      stores: grantedStores,
      targetUserId: target._id
    })

    if (linkResult.error) {
      return redirectWithMessage(res, '/admin/users', { error: linkResult.error })
    }

    target.role = role
    target.stores = grantedStores
    target.rosterLinks = linkResult.links
    target.accessStatus = 'approved'
    target.accessReview = {
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
      decision: 'approved'
    }
    await target.save()

    return redirectWithMessage(res, '/admin/users', {
      message: `${target.email} is now ${ROLE_LABELS[role]} for ${formatStores(target.stores)}.`
    })
  } catch (err) {
    console.error('Set user access error:', err)
    return redirectWithMessage(res, '/admin/users', { error: 'Could not update the user.' })
  }
})

// Remove all access; the user can request again
app.post('/admin/users/:id/revoke', ...adminPage, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return redirectWithMessage(res, '/admin/users', { error: 'User not found.' })
    }

    const target = await User.findById(req.params.id)

    if (!target) {
      return redirectWithMessage(res, '/admin/users', { error: 'User not found.' })
    }

    if (target._id.equals(req.user._id)) {
      return redirectWithMessage(res, '/admin/users', {
        error: 'You cannot revoke your own access.'
      })
    }

    target.role = 'none'
    target.stores = []
    target.accessStatus = 'none'
    // Fresh start: clears the 6-hour request cooldown too
    target.accessRequest = undefined
    // Free their roster entries for another account
    target.rosterLinks = []
    target.accessReview = {
      reviewedBy: req.user._id,
      reviewedAt: new Date(),
      decision: 'revoked'
    }
    await target.save()

    return redirectWithMessage(res, '/admin/users', {
      message: `Access revoked for ${target.email}.`
    })
  } catch (err) {
    console.error('Revoke user access error:', err)
    return redirectWithMessage(res, '/admin/users', { error: 'Could not revoke access.' })
  }
})

// ------------------------
// ROSTER LINKS
// ------------------------
//
// An employee or manager account is linked to the person it belongs to on
// each store's schedule roster, by employee number. Approvers pick the
// entry when approving (a name match is suggested); admins can change it
// on the Admin Panel. Employees must be linked to be approved.

const LINKED_ROLES = ['employee', 'manager']

// Everyone on a store's roster who has an employee number (only they can
// be linked), with their roster role
async function getStoreRoster(store) {
  const settings = await ScheduleSettings.findOne({ store }).lean()
  if (!settings) return []

  const ids = settings.buildEmployeeIdentifiers || {}
  const setup = SCHEDULE_STORES[store]
  const groups = [
    ['Manager', settings.managers],
    ['Associate', settings.associates],
    ...(setup && setup.hasCashiers ? [['Cashier', settings.cashiers]] : [])
  ]

  const seen = new Set()
  const roster = []

  for (const [role, names] of groups) {
    for (const name of names || []) {
      const employeeNumber = String(ids[name] || '').trim()
      if (!employeeNumber || seen.has(employeeNumber)) continue
      seen.add(employeeNumber)
      roster.push({ name, employeeNumber, role })
    }
  }

  return roster.sort((a, b) => a.name.localeCompare(b.name))
}

async function getRosters(stores) {
  const rosters = {}
  for (const store of stores) {
    rosters[store] = await getStoreRoster(store)
  }
  return rosters
}

// 'store|employeeNumber' -> { userId, name } for every existing link
async function getLinkOwners() {
  const users = await User.find({ 'rosterLinks.0': { $exists: true } })
    .select('name rosterLinks')
    .lean()

  const owners = new Map()
  for (const user of users) {
    for (const link of user.rosterLinks) {
      owners.set(`${link.store}|${link.employeeNumber}`, {
        userId: String(user._id),
        name: user.name
      })
    }
  }
  return owners
}

// Rosters with who (if anyone) each entry is already linked to, for the
// link dropdowns
function rostersForForm(rosters, owners) {
  return Object.fromEntries(
    Object.entries(rosters).map(([store, roster]) => [
      store,
      roster.map(entry => {
        const owner = owners.get(`${store}|${entry.employeeNumber}`)
        return { ...entry, linkedToId: owner ? owner.userId : '', linkedToName: owner ? owner.name : '' }
      })
    ])
  )
}

const nameWords = name =>
  String(name || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)

// Best roster entry for an account name: exact match, or same last name
// with a matching or similar first name ("Mike Smith" -> "Michael Smith").
// Entries already linked to someone else are skipped.
function suggestRosterMatch(accountName, roster, owners, store, targetUserId) {
  const account = nameWords(accountName)
  if (!account.length) return ''

  let best = ''
  let bestScore = 0

  for (const entry of roster) {
    const owner = owners.get(`${store}|${entry.employeeNumber}`)
    if (owner && owner.userId !== String(targetUserId)) continue

    const words = nameWords(entry.name)
    let score = 0

    if (words.join(' ') === account.join(' ')) {
      score = 100
    } else if (words.length && words[words.length - 1] === account[account.length - 1]) {
      score = 50
      if (words[0] === account[0]) score += 30
      else if (words[0].startsWith(account[0]) || account[0].startsWith(words[0])) score += 20
      else if (words[0][0] === account[0][0]) score += 5
    }

    if (score > bestScore) {
      bestScore = score
      best = entry.employeeNumber
    }
  }

  return best
}

function suggestionsFor(user, stores, rosters, owners) {
  const current = Object.fromEntries(
    (user.rosterLinks || []).map(link => [link.store, link.employeeNumber])
  )

  return Object.fromEntries(
    stores.map(store => [
      store,
      current[store] ||
        suggestRosterMatch(user.name, rosters[store] || [], owners, store, user._id)
    ])
  )
}

// Reads link_<store> fields for the stores being granted and checks them.
// Returns { links } or { error }.
async function readRosterLinks(body, { role, stores, targetUserId }) {
  if (!LINKED_ROLES.includes(role)) return { links: [] }

  const allStores = stores.includes(ALL_STORES_VALUE)
  const storeList = allStores ? STORE_LIST : stores
  const rosters = await getRosters(storeList)
  const owners = await getLinkOwners()
  const links = []

  for (const store of storeList) {
    const employeeNumber = String(body[`link_${store}`] || '').trim()
    if (!employeeNumber) continue

    if (!rosters[store].some(entry => entry.employeeNumber === employeeNumber)) {
      return { error: `Employee #${employeeNumber} is not on the ${store} roster.` }
    }

    const owner = owners.get(`${store}|${employeeNumber}`)
    if (owner && owner.userId !== String(targetUserId)) {
      return { error: `${store} #${employeeNumber} is already linked to ${owner.name}.` }
    }

    links.push({ store, employeeNumber })
  }

  if (role === 'employee') {
    const missing = allStores
      ? (links.length ? [] : ['at least one store'])
      : storeList.filter(store => !links.some(link => link.store === store))

    if (missing.length) {
      return {
        error: `Employees must be linked to their roster entry for ${missing.join(', ')}. ` +
          'If they are not on the roster yet, a manager needs to add them on the Schedule page ' +
          'with an employee number first.'
      }
    }
  }

  return { links }
}

// "Hamden #1042 Michael Smith" style descriptions of an account's links
function describeRosterLinks(user, rosters) {
  return (user.rosterLinks || []).map(link => {
    const entry = (rosters[link.store] || [])
      .find(item => item.employeeNumber === link.employeeNumber)
    return {
      store: link.store,
      employeeNumber: link.employeeNumber,
      name: entry ? entry.name : '(no longer on the roster)'
    }
  })
}

// ------------------------
// TIME OFF & AVAILABILITY
// ------------------------
//
// Employees and managers request time off (a date or range, all day or
// between two times) and set their regular weekly availability. Managers
// of any store they're linked to, or an admin, approve or deny. Approved
// time off and availability are shown on the Schedule page for the week
// being posted, and assigning someone against them raises a warning.

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/
const MAX_TIME_OFF_DAYS = 31
const MAX_PENDING_TIME_OFF = 20
const AVAILABILITY_MODES = ['all', 'none', 'hours']

const minutesOfDay = value => {
  const match = TIME_OF_DAY.exec(String(value || ''))
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

// '16:30' -> '4:30 PM'
function formatTimeOfDay(value) {
  const minutes = minutesOfDay(value)
  if (minutes == null) return ''
  const hours = Math.floor(minutes / 60)
  const suffix = hours >= 12 ? 'PM' : 'AM'
  return `${hours % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${suffix}`
}

function describeTimeOffDates(request) {
  const format = ymd => formatYmd(ymd, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  const dates = request.startDate === request.endDate
    ? format(request.startDate)
    : `${format(request.startDate)} – ${format(request.endDate)}`

  return request.allDay
    ? `${dates}, all day`
    : `${dates}, ${formatTimeOfDay(request.startTime)} – ${formatTimeOfDay(request.endTime)}`
}

// Builds a week pattern from form fields mode_<day>, start_<day>, end_<day>.
// Returns { pattern } or { error }.
function readAvailabilityPattern(body) {
  const pattern = {}

  for (const day of SCHEDULE_DAY_KEYS) {
    const mode = String(body[`mode_${day}`] || 'all')
    if (!AVAILABILITY_MODES.includes(mode)) {
      return { error: 'Choose a valid option for each day.' }
    }

    if (mode === 'hours') {
      const start = String(body[`start_${day}`] || '')
      const end = String(body[`end_${day}`] || '')
      const startMinutes = minutesOfDay(start)
      const endMinutes = minutesOfDay(end)

      if (startMinutes == null || endMinutes == null || endMinutes <= startMinutes) {
        const label = day.charAt(0).toUpperCase() + day.slice(1)
        return { error: `Enter a start and end time for ${label}, with the end after the start.` }
      }

      pattern[day] = { mode, start, end }
    } else {
      pattern[day] = { mode }
    }
  }

  return { pattern }
}

function describeAvailabilityDay(entry) {
  if (!entry || entry.mode === 'all') return 'Available all day'
  if (entry.mode === 'none') return 'Not available'
  return `Only ${formatTimeOfDay(entry.start)} – ${formatTimeOfDay(entry.end)}`
}

// Managers of any of these stores, or admins, may review
function canReviewForLinks(user, links) {
  if (!isApproved(user)) return false
  if (user.role === 'admin') return true
  if (user.role !== 'manager') return false
  return (links || []).some(link => canAccessStore(user, link.store))
}

// Stores whose requests this approver sees
const reviewStoresFor = user => userStores(user)

async function pendingTimeOffCount(user) {
  if (!isApproved(user) || !['admin', 'manager'].includes(user.role)) return 0
  const stores = reviewStoresFor(user)

  const [timeOff, availability] = await Promise.all([
    TimeOffRequest.countDocuments({ status: 'pending', 'links.store': { $in: stores } }),
    EmployeeAvailability.countDocuments({
      'pending.submittedAt': { $exists: true },
      'pending.links.store': { $in: stores }
    })
  ])

  return timeOff + availability
}

// ---------- the requester's own page ----------

app.get('/time-off', ...approvedPage, requireRole('employee', 'manager'), async (req, res) => {
  const links = req.user.rosterLinks || []
  const rosters = await getRosters([...new Set(links.map(link => link.store))])

  const requests = await TimeOffRequest.find({ 'user.userId': req.user._id })
    .sort({ startDate: -1 })
    .limit(50)
    .lean()

  const availability = await EmployeeAvailability.findOne({ 'user.userId': req.user._id }).lean()
  const today = storeToday()

  res.render('time-off.ejs', {
    user: req.user,
    links: describeRosterLinks(req.user, rosters),
    today,
    requests: requests.map(request => ({
      id: String(request._id),
      when: describeTimeOffDates(request),
      note: request.note || '',
      status: request.status,
      reviewNote: request.review && request.review.note,
      reviewedBy: request.review && request.review.by && request.review.by.name,
      canCancel: request.status === 'pending' ||
        (request.status === 'approved' && request.startDate >= today)
    })),
    availability,
    dayKeys: SCHEDULE_DAY_KEYS,
    describeAvailabilityDay,
    homePath: homePathFor(req.user),
    message: req.query.message || '',
    error: req.query.error || ''
  })
})

app.post('/time-off', ...approvedPage, requireRole('employee', 'manager'), async (req, res) => {
  try {
    const links = req.user.rosterLinks || []
    if (!links.length) {
      return redirectWithMessage(res, '/time-off', {
        error: 'Your account is not linked to a store roster yet. Ask a manager or admin to link it.'
      })
    }

    const startDate = String(req.body.startDate || '')
    const endDate = String(req.body.endDate || '') || startDate
    const allDay = req.body.allDay !== 'no'
    const today = storeToday()

    if (!parseYmd(startDate) || !parseYmd(endDate)) {
      return redirectWithMessage(res, '/time-off', { error: 'Choose the date(s) you need off.' })
    }
    if (endDate < startDate) {
      return redirectWithMessage(res, '/time-off', { error: 'The end date must be on or after the start date.' })
    }
    if (startDate < today) {
      return redirectWithMessage(res, '/time-off', { error: 'Time off can only be requested for today or later.' })
    }
    if (endDate > addDaysYmd(startDate, MAX_TIME_OFF_DAYS - 1)) {
      return redirectWithMessage(res, '/time-off', {
        error: `A single request can cover up to ${MAX_TIME_OFF_DAYS} days.`
      })
    }

    let startTime = ''
    let endTime = ''
    if (!allDay) {
      startTime = String(req.body.startTime || '')
      endTime = String(req.body.endTime || '')
      const startMinutes = minutesOfDay(startTime)
      const endMinutes = minutesOfDay(endTime)
      if (startMinutes == null || endMinutes == null || endMinutes <= startMinutes) {
        return redirectWithMessage(res, '/time-off', {
          error: 'Enter the hours you need off, with the end after the start.'
        })
      }
    }

    const pendingCount = await TimeOffRequest.countDocuments({
      'user.userId': req.user._id,
      status: 'pending'
    })
    if (pendingCount >= MAX_PENDING_TIME_OFF) {
      return redirectWithMessage(res, '/time-off', {
        error: `You already have ${MAX_PENDING_TIME_OFF} requests waiting. Wait for some to be reviewed.`
      })
    }

    await TimeOffRequest.create({
      user: personRef(req.user),
      links: links.map(link => ({ store: link.store, employeeNumber: link.employeeNumber })),
      startDate,
      endDate,
      allDay,
      startTime: allDay ? undefined : startTime,
      endTime: allDay ? undefined : endTime,
      note: cleanText(req.body.note, 500),
      status: 'pending'
    })

    return redirectWithMessage(res, '/time-off', { message: 'Time-off request sent for approval.' })
  } catch (err) {
    console.error('Time-off request error:', err)
    return redirectWithMessage(res, '/time-off', { error: 'The request could not be saved.' })
  }
})

app.post('/time-off/:id/cancel', ...approvedPage, requireRole('employee', 'manager'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return redirectWithMessage(res, '/time-off', { error: 'Request not found.' })
  }

  const result = await TimeOffRequest.updateOne(
    {
      _id: req.params.id,
      'user.userId': req.user._id,
      $or: [
        { status: 'pending' },
        { status: 'approved', startDate: { $gte: storeToday() } }
      ]
    },
    { $set: { status: 'cancelled' } }
  )

  return redirectWithMessage(res, '/time-off', result.modifiedCount
    ? { message: 'Request cancelled.' }
    : { error: 'That request can no longer be cancelled.' })
})

app.post('/time-off/availability', ...approvedPage, requireRole('employee', 'manager'), async (req, res) => {
  const links = req.user.rosterLinks || []
  if (!links.length) {
    return redirectWithMessage(res, '/time-off', {
      error: 'Your account is not linked to a store roster yet. Ask a manager or admin to link it.'
    })
  }

  const { pattern, error } = readAvailabilityPattern(req.body)
  if (error) return redirectWithMessage(res, '/time-off', { error })

  await EmployeeAvailability.updateOne(
    { 'user.userId': req.user._id },
    {
      $set: {
        user: personRef(req.user),
        pending: {
          pattern,
          note: cleanText(req.body.note, 500),
          submittedAt: new Date(),
          links: links.map(link => ({ store: link.store, employeeNumber: link.employeeNumber }))
        }
      }
    },
    { upsert: true }
  )

  return redirectWithMessage(res, '/time-off', { message: 'Availability change sent for approval.' })
})

app.post('/time-off/availability/withdraw', ...approvedPage, requireRole('employee', 'manager'), async (req, res) => {
  await EmployeeAvailability.updateOne(
    { 'user.userId': req.user._id },
    { $unset: { pending: 1 } }
  )
  return redirectWithMessage(res, '/time-off', { message: 'Availability change withdrawn.' })
})

// ---------- approvers ----------

app.get('/time-off-requests', ...approvedPage, requireRole('manager'), async (req, res) => {
  const stores = reviewStoresFor(req.user)
  const today = storeToday()
  const rosters = await getRosters(stores)

  // "Hamden: Michael Smith (#2001)" for each linked store this approver covers
  const who = links => (links || [])
    .filter(link => stores.includes(link.store))
    .map(link => {
      const entry = (rosters[link.store] || []).find(item => item.employeeNumber === link.employeeNumber)
      return `${link.store}: ${entry ? entry.name : 'not on roster'} (#${link.employeeNumber})`
    })
    .join(', ')

  const [pendingTimeOff, pendingAvailability, upcoming] = await Promise.all([
    TimeOffRequest.find({ status: 'pending', 'links.store': { $in: stores } })
      .sort({ startDate: 1 }).limit(200).lean(),
    EmployeeAvailability.find({
      'pending.submittedAt': { $exists: true },
      'pending.links.store': { $in: stores }
    }).sort({ 'pending.submittedAt': 1 }).limit(200).lean(),
    TimeOffRequest.find({ status: 'approved', endDate: { $gte: today }, 'links.store': { $in: stores } })
      .sort({ startDate: 1 }).limit(200).lean()
  ])

  res.render('time-off-requests.ejs', {
    user: req.user,
    pendingTimeOff: pendingTimeOff.map(request => ({
      id: String(request._id),
      name: request.user && request.user.name,
      who: who(request.links),
      when: describeTimeOffDates(request),
      note: request.note || '',
      requestedAt: request.createdAt
    })),
    pendingAvailability: pendingAvailability.map(doc => ({
      id: String(doc._id),
      name: doc.user && doc.user.name,
      who: who(doc.pending.links),
      note: doc.pending.note || '',
      submittedAt: doc.pending.submittedAt,
      days: SCHEDULE_DAY_KEYS.map(day => ({
        day,
        now: describeAvailabilityDay(doc.approved && doc.approved.pattern && doc.approved.pattern[day]),
        requested: describeAvailabilityDay(doc.pending.pattern && doc.pending.pattern[day])
      }))
    })),
    upcoming: upcoming.map(request => ({
      name: request.user && request.user.name,
      who: who(request.links),
      when: describeTimeOffDates(request),
      note: request.note || '',
      approvedBy: request.review && request.review.by && request.review.by.name
    })),
    message: req.query.message || '',
    error: req.query.error || ''
  })
})

async function decideTimeOff(req, res, decision) {
  const back = '/time-off-requests'
  if (!mongoose.isValidObjectId(req.params.id)) {
    return redirectWithMessage(res, back, { error: 'Request not found.' })
  }

  const request = await TimeOffRequest.findById(req.params.id).lean()
  if (!request || request.status !== 'pending' || !canReviewForLinks(req.user, request.links)) {
    return redirectWithMessage(res, back, { error: 'Request not found or already reviewed.' })
  }

  const note = cleanText(req.body.note, 500)
  if (decision === 'denied' && !note) {
    return redirectWithMessage(res, back, { error: 'Enter a reason to deny the request.' })
  }

  const result = await TimeOffRequest.updateOne(
    { _id: request._id, status: 'pending' },
    { $set: { status: decision, review: { by: personRef(req.user), at: new Date(), note } } }
  )

  return redirectWithMessage(res, back, result.modifiedCount
    ? { message: `${decision === 'approved' ? 'Approved' : 'Denied'} time off for ${request.user.name}.` }
    : { error: 'That request was already reviewed.' })
}

app.post('/time-off-requests/:id/approve', ...approvedPage, requireRole('manager'),
  (req, res) => decideTimeOff(req, res, 'approved'))
app.post('/time-off-requests/:id/deny', ...approvedPage, requireRole('manager'),
  (req, res) => decideTimeOff(req, res, 'denied'))

async function decideAvailability(req, res, decision) {
  const back = '/time-off-requests'
  if (!mongoose.isValidObjectId(req.params.id)) {
    return redirectWithMessage(res, back, { error: 'Request not found.' })
  }

  const doc = await EmployeeAvailability.findById(req.params.id).lean()
  if (!doc || !doc.pending || !doc.pending.submittedAt || !canReviewForLinks(req.user, doc.pending.links)) {
    return redirectWithMessage(res, back, { error: 'Request not found or already reviewed.' })
  }

  const note = cleanText(req.body.note, 500)
  if (decision === 'denied' && !note) {
    return redirectWithMessage(res, back, { error: 'Enter a reason to deny the change.' })
  }

  const now = new Date()
  const update = {
    $set: { lastDecision: { decision, by: personRef(req.user), at: now, note } },
    $unset: { pending: 1 }
  }
  if (decision === 'approved') {
    update.$set.approved = { pattern: doc.pending.pattern, by: personRef(req.user), at: now }
  }

  // Only decide the version that was reviewed
  const result = await EmployeeAvailability.updateOne(
    { _id: doc._id, 'pending.submittedAt': doc.pending.submittedAt },
    update
  )

  return redirectWithMessage(res, back, result.modifiedCount
    ? { message: `${decision === 'approved' ? 'Approved' : 'Denied'} availability for ${doc.user.name}.` }
    : { error: 'That change was updated or already reviewed.' })
}

app.post('/availability-requests/:id/approve', ...approvedPage, requireRole('manager'),
  (req, res) => decideAvailability(req, res, 'approved'))
app.post('/availability-requests/:id/deny', ...approvedPage, requireRole('manager'),
  (req, res) => decideAvailability(req, res, 'denied'))

// ---------- the Schedule page ----------

// Approved time off overlapping a week, and everyone's approved weekly
// availability, by roster name, for one store
app.get(
  '/api/time-off-schedule',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {
      const store = req.storeName
      const weekStart = String(req.query.week || '')
      if (!isMonday(weekStart)) {
        return res.status(400).json({ success: false, error: 'Choose the Monday the week starts on.' })
      }
      const weekEnd = addDaysYmd(weekStart, 6)

      const roster = await getStoreRoster(store)
      const nameOf = number => {
        const entry = roster.find(item => item.employeeNumber === number)
        return entry ? entry.name : ''
      }
      const linkFor = links => (links || []).find(link => link.store === store)

      const requests = await TimeOffRequest.find({
        status: 'approved',
        'links.store': store,
        startDate: { $lte: weekEnd },
        endDate: { $gte: weekStart }
      }).lean()

      const timeOff = []
      for (const request of requests) {
        const link = linkFor(request.links)
        const name = link && nameOf(link.employeeNumber)
        if (!name) continue

        SCHEDULE_DAY_KEYS.forEach((day, index) => {
          const date = addDaysYmd(weekStart, index)
          if (date < request.startDate || date > request.endDate) return
          timeOff.push({
            name,
            day,
            date,
            allDay: request.allDay !== false,
            startTime: request.allDay === false ? request.startTime : '',
            endTime: request.allDay === false ? request.endTime : '',
            note: request.note || ''
          })
        })
      }

      // Availability for everyone linked to this store
      const linkedUsers = await User.find({ 'rosterLinks.store': store })
        .select('rosterLinks')
        .lean()
      const docs = await EmployeeAvailability.find({
        'user.userId': { $in: linkedUsers.map(u => u._id) },
        'approved.pattern': { $exists: true }
      }).lean()

      const availability = {}
      for (const doc of docs) {
        const linkedUser = linkedUsers.find(u => String(u._id) === String(doc.user.userId))
        const link = linkedUser && linkFor(linkedUser.rosterLinks)
        const name = link && nameOf(link.employeeNumber)
        if (name) availability[name] = doc.approved.pattern
      }

      return res.json({
        success: true,
        weekStart,
        timeOff,
        availability,
        pendingCount: await pendingTimeOffCount(req.user)
      })
    } catch (err) {
      console.error('Time-off schedule error:', err)
      return res.status(500).json({ success: false, error: 'Time off could not be loaded.' })
    }
  }
)

// ------------------------
// ACCESS REQUESTS
// ------------------------

// Milliseconds until the user may submit another access request (0 = now)
function accessRequestWaitMs(user) {
  const requestedAt =
    user && user.accessRequest && user.accessRequest.requestedAt

  if (!requestedAt) return 0

  return Math.max(
    0,
    new Date(requestedAt).getTime() + ACCESS_REQUEST_INTERVAL_MS - Date.now()
  )
}

app.get('/request-access', requireAuth, (req, res) => {
  if (!req.user.emailVerified || isApproved(req.user)) {
    return res.redirect(homePathFor(req.user))
  }

  const waitMs = accessRequestWaitMs(req.user)

  res.render('request-access.ejs', {
    user: req.user,
    roles: ACCESS_ROLES,
    roleLabels: ROLE_LABELS,
    storeList: STORE_LIST,
    formatStores,
    error: req.query.error || '',
    nextRequestWait: waitMs ? formatWait(waitMs) : ''
  })
})

app.post('/request-access', requireAuth, async (req, res) => {
  try {
    if (!req.user.emailVerified || isApproved(req.user)) {
      return res.redirect(homePathFor(req.user))
    }

    const role = String(req.body.role || '')
    const stores = normalizeStoreList(req.body.stores)
    const note = String(req.body.note || '').trim().slice(0, 500)

    if (!ACCESS_ROLES.includes(role)) {
      return redirectWithMessage(res, '/request-access', { error: 'Choose a role.' })
    }

    if (!stores.length) {
      return redirectWithMessage(res, '/request-access', {
        error: 'Choose at least one store.'
      })
    }

    // One request per 6 hours. Claimed atomically so simultaneous
    // submissions can't both go through.
    const now = new Date()
    const user = await User.findOneAndUpdate(
      {
        _id: req.user._id,
        $or: [
          { 'accessRequest.requestedAt': null },
          {
            'accessRequest.requestedAt': {
              $lte: new Date(now.getTime() - ACCESS_REQUEST_INTERVAL_MS)
            }
          }
        ]
      },
      {
        $set: {
          accessStatus: 'pending',
          accessRequest: {
            role,
            stores,
            note,
            requestedAt: now
          }
        }
      },
      { returnDocument: 'after', runValidators: true }
    )

    if (!user) {
      const wait = accessRequestWaitMs(req.user)
      return redirectWithMessage(res, '/request-access', {
        error: `You can submit another request in ${formatWait(wait)}.`
      })
    }

    // Email failures must not block the request
    notifyApprovers(user).catch(err =>
      console.error('Access request notification failed:', err)
    )

    return res.redirect('/request-access')
  } catch (err) {
    console.error('Access request error:', err)
    return redirectWithMessage(res, '/request-access', {
      error: 'Your request could not be submitted.'
    })
  }
})

// Whether an approver may see a pending request at all
function canSeeRequest(approver, request) {
  if (approver.role === 'admin') return true
  if (!['employee', 'vendor'].includes(request.role)) return false

  const requested = request.stores || []

  if (requested.includes(ALL_STORES_VALUE)) {
    return hasAllStores(approver)
  }

  const covered = userStores(approver)
  return requested.some(store => covered.includes(store))
}

app.get(
  '/access-requests',
  ...approvedPage,
  requireRole('manager'),
  async (req, res) => {
    const pending = await User.find({ accessStatus: 'pending' })
      .select('name email accessRequest rosterLinks')
      .sort({ 'accessRequest.requestedAt': 1 })
      .lean()

    const isAdmin = req.user.role === 'admin'
    const grantableStores = userStores(req.user)
    const rosters = await getRosters(grantableStores)
    const owners = await getLinkOwners()

    const requests = pending
      .filter(u => canSeeRequest(req.user, u.accessRequest || {}))
      .map(u => ({
        ...u,
        linkSuggestions: suggestionsFor(u, grantableStores, rosters, owners)
      }))

    res.render('access-requests.ejs', {
      user: req.user,
      requests,
      rosters: rostersForForm(rosters, owners),
      // Managers may only grant employee/vendor for their own stores
      grantableRoles: isAdmin ? ACCESS_ROLES : ['employee', 'vendor'],
      grantableStores: userStores(req.user),
      canGrantAll: hasAllStores(req.user),
      roleLabels: ROLE_LABELS,
      formatStores,
      message: req.query.message || '',
      error: req.query.error || ''
    })
  }
)

async function loadPendingRequest(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    redirectWithMessage(res, '/access-requests', { error: 'Request not found.' })
    return null
  }

  const target = await User.findById(req.params.id)

  if (
    !target ||
    target.accessStatus !== 'pending' ||
    !canSeeRequest(req.user, target.accessRequest || {})
  ) {
    redirectWithMessage(res, '/access-requests', { error: 'Request not found.' })
    return null
  }

  return target
}

app.post(
  '/access-requests/:id/approve',
  ...approvedPage,
  requireRole('manager'),
  async (req, res) => {
    try {
      const target = await loadPendingRequest(req, res)
      if (!target) return

      if (!target.emailVerified) {
        return redirectWithMessage(res, '/access-requests', {
          error: `${target.email} has not verified their email yet.`
        })
      }

      const role = String(req.body.role || '')
      let stores = normalizeStoreList(req.body.stores)

      if (role === 'admin') {
        stores = [ALL_STORES_VALUE]
      }

      if (!ACCESS_ROLES.includes(role) || !stores.length) {
        return redirectWithMessage(res, '/access-requests', {
          error: 'Choose a role and at least one store.'
        })
      }

      if (!canApprove(req.user, role, stores)) {
        return redirectWithMessage(res, '/access-requests', {
          error: `You cannot grant ${ROLE_LABELS[role]} access for ${formatStores(stores)}.`
        })
      }

      const linkResult = await readRosterLinks(req.body, {
        role,
        stores,
        targetUserId: target._id
      })

      if (linkResult.error) {
        return redirectWithMessage(res, '/access-requests', { error: linkResult.error })
      }

      target.role = role
      target.stores = stores
      target.rosterLinks = linkResult.links
      target.accessStatus = 'approved'
      target.accessReview = {
        reviewedBy: req.user._id,
        reviewedAt: new Date(),
        decision: 'approved'
      }
      await target.save()

      notifyRequester(target, 'approved').catch(err =>
        console.error('Approval email failed:', err)
      )

      return redirectWithMessage(res, '/access-requests', {
        message: `Approved ${target.email} as ${ROLE_LABELS[role]} for ${formatStores(stores)}.`
      })
    } catch (err) {
      console.error('Approve access error:', err)
      return redirectWithMessage(res, '/access-requests', {
        error: 'Could not approve the request.'
      })
    }
  }
)

app.post(
  '/access-requests/:id/deny',
  ...approvedPage,
  requireRole('manager'),
  async (req, res) => {
    try {
      const target = await loadPendingRequest(req, res)
      if (!target) return

      const reason = String(req.body.reason || '').trim().slice(0, 500)

      target.accessStatus = 'denied'
      target.accessReview = {
        reviewedBy: req.user._id,
        reviewedAt: new Date(),
        decision: 'denied',
        reason
      }
      await target.save()

      notifyRequester(target, 'denied', reason).catch(err =>
        console.error('Denial email failed:', err)
      )

      return redirectWithMessage(res, '/access-requests', {
        message: `Denied the request from ${target.email}.`
      })
    } catch (err) {
      console.error('Deny access error:', err)
      return redirectWithMessage(res, '/access-requests', {
        error: 'Could not deny the request.'
      })
    }
  }
)

// ------------------------
// API ROUTES (JWT-PROTECTED)
// ------------------------

// Effective month map state
app.get('/api/month', ...floorSpaceApi('vendor', 'manager'), async (req, res) => {
  const { month, map } = req.query

  if (!month || !map) {
    return res.status(400).json({ error: 'month and map are required' })
  }

  try {
    const reservedRows = await ItemMonthStatus.find({
      month,
      map_id: map,
      status: 'reserved'
    })
      .select('item_id status -_id')
      .lean()

    const requestedDocs = await ItemRequest.find({
      month,
      map_id: map,
      status: 'requested'
    })
      .select('item_id')
      .lean()

    const reservedSet = new Set(reservedRows.map(r => r.item_id))

    const requestedRows = [...new Set(
      requestedDocs
        .map(r => r.item_id)
        .filter(itemId => !reservedSet.has(itemId))
    )].map(item_id => ({
      item_id,
      status: 'requested'
    }))


    res.json([...reservedRows, ...requestedRows])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Create request
app.post('/api/request', ...floorSpaceApi('vendor', 'manager'), async (req, res) => {
  
  const { item_id, month, brand, products, map } = req.body
  const user = req.user.name

  if (!item_id || !month || !brand || !products || !map) {
    console.log("❌ Missing field!")
    return res.status(400).json({
      error: 'item_id, month, brand, products, and map are required'
    })
  }

  try {
    const itemExists = await Item.exists({ item_id })
    if (!itemExists) {
      return res.status(400).json({ error: 'Invalid item_id' })
    }

    const reserved = await ItemMonthStatus.exists({
      map_id: map,
      item_id,
      month,
      status: 'reserved'
    })

    if (reserved) {
      return res.status(409).json({ error: 'This spot is already reserved for that month' })
    }

    await ItemRequest.create({
      map_id: map,
      item_id,
      month,
      userId: req.user._id,
      user,
      brand,
      products,
      status: 'requested'
    })


    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Pending requests for admin review
app.get('/api/requests', ...floorSpaceApi('manager'), async (req, res) => {
  const { month, map } = req.query

  if (!month || !map) {
    return res.status(400).json({ error: 'month and map are required' })
  }

  try {
    
    const rows = await ItemRequest.find({
      month,
      map_id: map,
      status: 'requested'
    })
      .select('item_id month user brand products status created_at')
      .sort({ item_id: 1, created_at: 1 })
      .lean()


    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Approve request (admin only)
app.post(
  '/api/approve',
  ...floorSpaceApi('manager'),
  requireItemRequestStore,
  async (req, res) => {
  const { request_id, item_id, month, map } = req.body

  if (!request_id || !item_id || !month || !map) {
    return res.status(400).json({
      error: 'request_id, item_id, month, and map are required'
    })
  }

  if (req.itemRequest.map_id !== map) {
    return res.status(400).json({
      error: 'The request does not belong to this map'
    })
  }

  try {
    // 1) Approve selected request
    await ItemRequest.findByIdAndUpdate(request_id, {
      status: 'reserved'
    })

    // 2) Reject competing requests
    await ItemRequest.updateMany(
      {
        item_id,
        month,
        map_id: map,
        _id: { $ne: request_id },
        status: 'requested'
      },
      {
        $set: { status: 'rejected' }
      }
    )

    // 3) Mark final map state reserved
    await ItemMonthStatus.findOneAndUpdate(
      {
        map_id: map,
        item_id,
        month
      },
      {
        $set: {
          status: 'reserved',
          updated_at: new Date()
        }
      },
      {
        upsert: true,
        returnDocument: 'after'
      }
    )


    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Reject request (managers/admins of the request's store)
app.post(
  '/api/reject',
  ...approvedApi,
  requireRoleApi('manager'),
  requireItemRequestStore,
  async (req, res) => {
  const { request_id } = req.body

  if (!request_id) {
    return res.status(400).json({ error: 'request_id is required' })
  }

  try {
    
    await ItemRequest.findByIdAndUpdate(request_id, {
      status: 'rejected'
    })


    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Current user's own requests
app.get('/api/user-requests', ...approvedApi, requireRoleApi('vendor', 'manager'), async (req, res) => {
  try {
    const rows = await ItemRequest.find({
      userId: req.user._id
    })
      .select('map_id item_id brand products status month created_at')
      .sort({ created_at: -1 })
      .lean()


    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Final page data
app.get('/api/final-data', ...floorSpaceApi('manager'), async (req, res) => {
  try {
    const { month, map } = req.query

    const rows = await ItemRequest.find({
      month,
      map_id: map
    })
      .select('item_id user brand products status')
      .sort({ item_id: 1 })
      .lean()


    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})



app.post("/set-month", ...approvedApi, (req, res) => {
  const { month } = req.body

  //console.log("Set month:", month)

  res.json({ success: true })
})


app.get("/debug-db", ...adminPage, async (req, res) => {
  try {
    const rows = await ItemRequest.find()
      .select('item_id user brand products status month map_id created_at')
      .lean()

    res.json(rows);      // ✅ shows in browser

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});




function getNextMonthKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based

  const next = new Date(year, month + 1, 1);
  const yyyy = next.getFullYear();
  const mm = String(next.getMonth() + 1).padStart(2, '0');

  return `${yyyy}-${mm}`;
}

async function sendNextMonthRequestsSummaryEmail() {
  const nextMonth =
    getNextMonthKey();

  const mapOrder = [
    'branford',
    'Hamden',
    'New Haven',
    'New Milford',
    'stratford'
  ];

  const summary =
    await ItemRequest.aggregate([
      {
        $match: {
          status:
            'requested',

          month:
            nextMonth
        }
      },
      {
        $group: {
          _id:
            '$map_id',

          count: {
            $sum: 1
          }
        }
      }
    ]);

  const counts = {
    branford: 0,
    Hamden: 0,
    'New Haven': 0,
    'New Milford': 0,
    stratford: 0
  };

  for (const row of summary) {
    if (
      Object.prototype.hasOwnProperty.call(
        counts,
        row._id
      )
    ) {
      counts[row._id] =
        Number(row.count || 0);
    }
  }

  const totalPending =
    mapOrder.reduce(
      (sum, map) =>
        sum +
        Number(counts[map] || 0),
      0
    );

  if (totalPending === 0) {
    console.log(
      `[next-month-email] No pending ` +
      `requests for ${nextMonth}; ` +
      `email not sent.`
    );

    return {
      sent: false,
      reason:
        'NO_PENDING_REQUESTS'
    };
  }

  const recipient =
    String(
      process.env
        .NEXT_MONTH_REQUESTS_TO || ''
    ).trim();

  if (!recipient) {
    throw new Error(
      'NEXT_MONTH_REQUESTS_TO is not configured.'
    );
  }

  const subject =
    `Pending requests for ${nextMonth}`;

  const applicationUrl =
    process.env.APP_BASE_URL ||
    'https://floor-space-requests-app.onrender.com';

  const text = [
    'Hi Zach,',
    '',
    `There are currently ${totalPending} ` +
      `pending request${
        totalPending === 1
          ? ''
          : 's'
      } for next month (${nextMonth}).`,
    '',
    `Branford: ${counts.branford}`,
    `Hamden: ${counts.Hamden}`,
    `New Haven: ${counts['New Haven']}`,
    `New Milford: ${counts['New Milford']}`,
    `Stratford: ${counts.stratford}`,
    '',
    `Open the application: ${applicationUrl}`,
    '',
    'Sent automatically from the Delaney App.'
  ].join('\n');

  const html = `
    <div
      style="
        max-width:600px;
        margin:0 auto;
        padding:24px;
        font-family:Arial,Helvetica,sans-serif;
        color:#172033;
      "
    >
      <h2 style="color:#17365d;">
        Pending requests for ${nextMonth}
      </h2>

      <p>
        Hi Zach,
      </p>

      <p>
        There are currently
        <strong>${totalPending}</strong>
        pending request${
          totalPending === 1
            ? ''
            : 's'
        } for next month.
      </p>

      <ul>
        <li>
          <strong>Branford:</strong>
          ${counts.branford}
        </li>

        <li>
          <strong>Hamden:</strong>
          ${counts.Hamden}
        </li>

        <li>
          <strong>New Haven:</strong>
          ${counts['New Haven']}
        </li>

        <li>
          <strong>New Milford:</strong>
          ${counts['New Milford']}
        </li>

        <li>
          <strong>Stratford:</strong>
          ${counts.stratford}
        </li>
      </ul>

      <p>
        ${applicationUrl}
          Open Application
        </a>
      </p>

      <p
        style="
          margin-top:24px;
          color:#64748b;
          font-size:13px;
        "
      >
        Sent automatically from the Delaney App.
      </p>
    </div>
  `;

  const emailResult =
    await sendEmail({
      to:
        recipient,

      subject,

      text,

      html
    });

  console.log(
    `[next-month-email] Sent summary ` +
    `for ${nextMonth} to ${recipient}.`
  );

  return {
    sent: true,
    emailId:
      emailResult?.id || ''
  };
}



function startNextMonthRequestsEmailJob() {
  const scheduledDay = process.env.NEXT_MONTH_REQUESTS_DAY || '3'; // default Monday

  // Run at 9:00 AM Eastern on the selected day of week
  const cronExpression = `0 9 * * ${scheduledDay}`;

  cron.schedule(
    cronExpression,
    async () => {
      try {
        await sendNextMonthRequestsSummaryEmail();
      } catch (err) {
        console.error('[next-month-email] Failed to send scheduled summary:', err);
      }
    },
    {
      timezone: 'America/New_York'
    }
  );

  console.log(`[next-month-email] Weekly summary job scheduled with cron: ${cronExpression} (America/New_York)`);
}


app.get('/admin/test-next-month-email', ...adminPage, async (req, res) => {
  try {
    await sendNextMonthRequestsSummaryEmail();
    res.send('Next month pending requests summary email sent (if pending requests existed).');
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to send summary email.');
  }
});


app.get(
  '/forgot-password',
  requireGuest,
  (req, res) => {
    return res.render(
      'forgot-password.ejs',
      {
        success: false,
        error: null
      }
    );
  }
);

app.post(
  '/forgot-password',
  requireGuest,
  async (req, res) => {
    const genericSuccessMessage =
      'If that email address is registered, ' +
      'a password reset link was sent. ' +
      'Reset emails can be sent once per hour.';

    try {
      const email =
        String(
          req.body.email || ''
        )
          .trim()
          .toLowerCase();

      const user =
        email
          ? await User.findOne({
              email
            })
          : null;

      /*
       * Never reveal whether an account exists.
       */
      if (!user) {
        return res.render(
          'forgot-password.ejs',
          {
            success: true,
            error: null,
            message:
              genericSuccessMessage
          }
        );
      }

      /*
       * One reset email per account per hour. Claimed
       * atomically so simultaneous requests can't both send.
       * The response stays generic so it doesn't reveal
       * whether the account exists or was rate limited.
       */
      const previousResetEmailAt =
        user.lastResetEmailAt || null;

      const claimed =
        await User.findOneAndUpdate(
          {
            _id: user._id,
            $or: [
              { lastResetEmailAt: null },
              {
                lastResetEmailAt: {
                  $lte: new Date(
                    Date.now() -
                    RESET_EMAIL_INTERVAL_MS
                  )
                }
              }
            ]
          },
          {
            $set: {
              lastResetEmailAt: new Date()
            }
          }
        );

      if (!claimed) {
        console.log(
          'Password reset email rate limited:',
          user.email
        );

        return res.render(
          'forgot-password.ejs',
          {
            success: true,
            error: null,
            message:
              genericSuccessMessage
          }
        );
      }

      /*
       * Always create a fresh token. This invalidates
       * any previously issued reset link.
       */
      const token =
        crypto
          .randomBytes(32)
          .toString('hex');

      user.resetToken =
        token;

      user.resetTokenExpiry =
        new Date(
          Date.now() +
          60 * 60 * 1000
        );

      await user.save();

      /*
       * Local:
       * http://localhost:3301/reset-password/token
       *
       * Render:
       * https://floor-space-requests-app.onrender.com/
       * reset-password/token
       */
      const resetLink =
        `${req.protocol}://` +
        `${req.get('host')}` +
        `/reset-password/` +
        `${encodeURIComponent(token)}`;

      const subject =
        'Reset your password';

      const text = [
        'A password reset was requested for your account.',
        '',
        'Use this link to reset your password:',
        resetLink,
        '',
        'This link expires in one hour.',
        '',
        'If you did not request this reset, ' +
          'you can ignore this message.'
      ].join('\n');

      const html = `
        <div
          style="
            max-width:600px;
            margin:0 auto;
            padding:24px;
            font-family:Arial,Helvetica,sans-serif;
            color:#172033;
          "
        >
          <h2 style="color:#17365d;">
            Reset your password
          </h2>

          <p>
            A password reset was requested
            for your account.
          </p>

          <p style="margin:28px 0;">
            ${resetLink}
              Reset Password
            </a>
          </p>

          <p>
            This link expires in one hour.
          </p>

          <p
            style="
              color:#64748b;
              font-size:13px;
            "
          >
            If the button does not work,
            copy and paste this link into
            your browser:
          </p>

          <p
            style="
              overflow-wrap:anywhere;
              color:#2f5597;
              font-size:13px;
            "
          >
            ${resetLink}
          </p>

          <p
            style="
              margin-top:24px;
              color:#64748b;
              font-size:13px;
            "
          >
            If you did not request this reset,
            you can ignore this message.
          </p>
        </div>
      `;

      try {
        await sendEmail({
          to:
            user.email,

          subject,

          text,

          html
        });
      } catch (emailError) {
        /*
         * If email delivery fails, remove the unusable
         * token from the database.
         */
        user.resetToken =
          undefined;

        user.resetTokenExpiry =
          undefined;

        // Nothing was delivered, so let them retry now
        user.lastResetEmailAt =
          previousResetEmailAt || undefined;

        await user.save();

        throw emailError;
      }

      return res.render(
        'forgot-password.ejs',
        {
          success: true,
          error: null,
          message:
            genericSuccessMessage
        }
      );
    } catch (err) {
      console.error(
        'Forgot password error:',
        err
      );

      return res.status(500).render(
        'forgot-password.ejs',
        {
          success: false,
          error:
            'The reset email could not be sent. ' +
            'Please try again.'
        }
      );
    }
  }
);
``




app.get('/reset-password/:token', async (req, res) => {
  //console.log("TOKEN FROM URL:", req.params.token);

  const user = await User.findOne({
    resetToken: req.params.token
  });

  //console.log("FOUND USER:", user);

  //if (user) {
    //console.log("EXPIRY IN DB:", user.resetTokenExpiry);
    //console.log("CURRENT TIME:", new Date());
  //}

  if (!user || user.resetTokenExpiry <= new Date()) {
    return res.send("Invalid or expired link");
  }

  res.render('reset-password.ejs', { token: req.params.token, error: null });
});





app.post('/reset-password/:token', async (req, res) => {
  const { password, confirmPassword } = req.body;

  if (password !== confirmPassword) {
    return res.render('reset-password.ejs', {
      token: req.params.token,
      error: "Passwords do not match"
    });
  }

  const user = await User.findOne({
    resetToken: req.params.token,
    resetTokenExpiry: { $gt: new Date() }
  });

  if (!user) {
    return res.send("Invalid or expired link");
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  user.password = hashedPassword;
  user.resetToken = undefined;
  user.resetTokenExpiry = undefined;

  // Proving control of the email unlocks the account
  user.failedLoginAttempts = 0;
  user.lockoutUntil = undefined;

  // Log out every session from before the reset
  user.tokenVersion = (user.tokenVersion || 0) + 1;

  // The reset link arrived by email, which proves ownership too
  user.emailVerified = true;
  user.emailVerifyTokenHash = undefined;
  user.emailVerifyExpiry = undefined;

  await user.save();

  return res.redirect('/login');
});



app.get('/class', ...adminPage, (req, res) => {
  res.render('MylesJamesClass.ejs', {
    user: req.user
  });
});


app.post('/class', ...adminPage, async (req, res) => {
  try {
    const response = await fetch("https://script.google.com/macros/s/AKfycbxh9CnrerqjfoylKGkAIUUmpyvNWdCjEJxWCAlV-ohEt7LUEmMBLMLMD08jeh-SLvqx/exec", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(req.body)
    });

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.json({ success: false });
  }
});

app.get('/Hamdenmap', ...adminPage, (req, res) => {
  res.render('Hamdensorter.ejs', {
    user: req.user
  });
});


app.post(
  '/api/schedule-settings',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {
      const {
        store,
        managers,
        associates,
        cashiers = [],
        buildEmployeeIdentifiers = {},
        approvedOvertimeHours = {},
        availability = {}
      } = req.body;

      const cleanStore =
        getCanonicalStoreName(store);

      if (!cleanStore) {
        return res.status(400).json({
          success: false,
          error:
            'A valid store is required.'
        });
      }

      if (!Array.isArray(managers)) {
        return res.status(400).json({
          success: false,
          error:
            'managers must be an array.'
        });
      }

      if (!Array.isArray(associates)) {
        return res.status(400).json({
          success: false,
          error:
            'associates must be an array.'
        });
      }

      if (!Array.isArray(cashiers)) {
        return res.status(400).json({
          success: false,
          error:
            'cashiers must be an array.'
        });
      }

      if (
        !buildEmployeeIdentifiers ||
        typeof buildEmployeeIdentifiers !==
          'object' ||
        Array.isArray(
          buildEmployeeIdentifiers
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            'buildEmployeeIdentifiers must be an object.'
        });
      }

      if (
        !approvedOvertimeHours ||
        typeof approvedOvertimeHours !==
          'object' ||
        Array.isArray(
          approvedOvertimeHours
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            'approvedOvertimeHours must be an object.'
        });
      }

      if (
        !availability ||
        typeof availability !== 'object' ||
        Array.isArray(availability)
      ) {
        return res.status(400).json({
          success: false,
          error:
            'availability must be an object.'
        });
      }

      const cleanManagers = [
        ...new Set(
          managers
            .map(name =>
              String(name || '').trim()
            )
            .filter(Boolean)
        )
      ];

      const cleanAssociates = [
        ...new Set(
          associates
            .map(name =>
              String(name || '').trim()
            )
            .filter(Boolean)
        )
      ];

      const cleanCashiers = [
        ...new Set(
          cashiers
            .map(name =>
              String(name || '').trim()
            )
            .filter(Boolean)
        )
      ];

      /*
       * Prevent the same employee name from appearing
       * in more than one role.
       */
      const roleByNormalizedName =
        new Map();

      const roleDuplicates = [];

      const employeeGroups = [
        {
          role: 'manager',
          names: cleanManagers
        },
        {
          role: 'associate',
          names: cleanAssociates
        },
        {
          role: 'cashier',
          names: cleanCashiers
        }
      ];

      for (const group of employeeGroups) {
        for (const name of group.names) {
          const normalizedName =
            name.toLowerCase();

          if (
            roleByNormalizedName.has(
              normalizedName
            )
          ) {
            roleDuplicates.push(name);
          } else {
            roleByNormalizedName.set(
              normalizedName,
              group.role
            );
          }
        }
      }

      if (roleDuplicates.length > 0) {
        return res.status(400).json({
          success: false,
          error:
            'An employee cannot appear in more ' +
            'than one role: ' +
            [
              ...new Set(roleDuplicates)
            ].join(', ')
        });
      }

      const validEmployees = [
        ...cleanManagers,
        ...cleanAssociates,
        ...cleanCashiers
      ];

      const cleanAvailability = {};

      const cleanBuildEmployeeIdentifiers =
        {};

      /*
       * Approved overtime is stored by employee number:
       *
       * {
       *   "243": 3,
       *   "191": 0,
       *   "184": 2.5
       * }
       */
      const cleanApprovedOvertimeHours = {};

      const employeeNameByNumber =
        new Map();

      for (const employee of validEmployees) {
        cleanAvailability[employee] =
          availability[employee] !== false;

        const employeeNumber =
          String(
            buildEmployeeIdentifiers[
              employee
            ] || ''
          ).trim();

        cleanBuildEmployeeIdentifiers[
          employee
        ] = employeeNumber;

        /*
         * Employees without an employee number cannot
         * have an overtime setting keyed by number.
         * Their frontend default remains zero.
         */
        if (!employeeNumber) {
          continue;
        }

        const normalizedEmployeeNumber =
          employeeNumber.toLowerCase();

        /*
         * Prevent two current employees from sharing
         * the same employee number.
         */
        if (
          employeeNameByNumber.has(
            normalizedEmployeeNumber
          )
        ) {
          return res.status(400).json({
            success: false,
            error:
              `Employee number ${employeeNumber} is ` +
              `assigned to both ` +
              `${employeeNameByNumber.get(
                normalizedEmployeeNumber
              )} and ${employee}.`
          });
        }

        employeeNameByNumber.set(
          normalizedEmployeeNumber,
          employee
        );

        const suppliedApprovedHours =
          Number(
            approvedOvertimeHours[
              employeeNumber
            ] ?? 0
          );

        if (
          !Number.isFinite(
            suppliedApprovedHours
          )
        ) {
          return res.status(400).json({
            success: false,
            error:
              `Approved overtime for ${employee} ` +
              `must be a valid number.`
          });
        }

        if (
          suppliedApprovedHours < 0 ||
          suppliedApprovedHours > 40
        ) {
          return res.status(400).json({
            success: false,
            error:
              `Approved overtime for ${employee} ` +
              `must be between 0 and 40 hours.`
          });
        }

        /*
         * Store a maximum of two decimal places.
         * A missing value is stored as zero.
         */
        cleanApprovedOvertimeHours[
          employeeNumber
        ] = Number(
          suppliedApprovedHours.toFixed(2)
        );
      }

      console.log(
        'Schedule settings request:',
        {
          store:
            cleanStore,

          managers:
            cleanManagers,

          associates:
            cleanAssociates,

          cashiers:
            cleanCashiers,

          buildEmployeeIdentifiers:
            cleanBuildEmployeeIdentifiers,

          approvedOvertimeHours:
            cleanApprovedOvertimeHours,

          availability:
            cleanAvailability
        }
      );

      const settings =
        await ScheduleSettings.findOneAndUpdate(
          {
            store:
              cleanStore
          },
          {
            $set: {
              managers:
                cleanManagers,

              associates:
                cleanAssociates,

              cashiers:
                cleanCashiers,

              buildEmployeeIdentifiers:
                cleanBuildEmployeeIdentifiers,

              approvedOvertimeHours:
                cleanApprovedOvertimeHours,

              availability:
                cleanAvailability
            }
          },
          {
            upsert:
              true,

            returnDocument: 'after',

            runValidators:
              true,

            setDefaultsOnInsert:
              true
          }
        ).lean();

      return res.json({
        success: true,

        message:
          'Schedule settings saved successfully.',

        settings
      });
    } catch (err) {
      console.error(
        'Schedule settings save error:',
        err
      );

      return res.status(500).json({
        success: false,
        error:
          err.message ||
          'Schedule settings could not be saved.'
      });
    }
  }
);

function cleanAttendancePeriod(period) {
  const source =
    period &&
    typeof period === 'object'
      ? period
      : {};

  return {
    absences: Math.max(
      0,
      Number(source.absences || 0)
    ),

    tardies: Math.max(
      0,
      Number(source.tardies || 0)
    ),

    leftEarly: Math.max(
      0,
      Number(source.leftEarly || 0)
    )
  };
}

app.post(
  '/api/attendance/upload',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {
      const { attendance } = req.body;

      // Canonical store name, checked by requireStoreFromRequest
      const store = req.storeName;

      if (!store) {
        return res.status(400).json({
          success: false,
          error: 'Store is required.'
        });
      }

      if (
        !attendance ||
        typeof attendance !== 'object' ||
        Array.isArray(attendance)
      ) {
        return res.status(400).json({
          success: false,
          error: 'Attendance must be an object.'
        });
      }

      const cleanAttendance = {};

      for (
        const [
          suppliedEmployeeNumber,
          suppliedRecord
        ] of Object.entries(attendance)
      ) {
        const record =
          suppliedRecord &&
          typeof suppliedRecord === 'object'
            ? suppliedRecord
            : {};

        const employeeNumber = String(
          record.employeeNumber ||
          suppliedEmployeeNumber ||
          ''
        ).trim();

        const employeeName = String(
          record.employeeName ||
          record.name ||
          ''
        ).trim();

        if (!employeeNumber) {
          continue;
        }

        cleanAttendance[employeeNumber] = {
          employeeNumber,
          employeeName,

          week: cleanAttendancePeriod(
            record.week
          ),

          year: cleanAttendancePeriod(
            record.year
          ),

          allTime: cleanAttendancePeriod(
            record.allTime
          )
        };
      }

      if (
        Object.keys(cleanAttendance).length === 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            'No valid employee attendance records were supplied.'
        });
      }

      const settings =
        await ScheduleSettings.findOneAndUpdate(
          {
            store
          },
          {
            $set: {
              attendance: cleanAttendance
            }
          },
          {
            upsert: true,
            returnDocument: 'after',
            runValidators: true,
            setDefaultsOnInsert: true
          }
        ).lean();

      console.log(
        'Attendance saved by employee number:',
        Object.keys(cleanAttendance)
      );

      res.json({
        success: true,
        employeeCount:
          Object.keys(cleanAttendance).length,
        attendance:
          settings.attendance || {}
      });
    } catch (err) {
      console.error(
        'Attendance upload error:',
        err
      );

      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }
);


app.post(
  '/api/previous-week-review',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {

  try {

    // Canonical store name, checked by requireStoreFromRequest
    const store = req.storeName;

    const {
      weekStart,
      weekEnd,
      employeeIdentifiers,
      previousScheduledShifts,
      previousActualShifts,
      previousActualHours,
      previousScheduledHours
    } = req.body;

    if (!store) {
      return res.status(400).json({
        success: false,
        error: 'Store is required.'
      });
    }

    await ScheduleSettings.findOneAndUpdate(
      { store },
      {
        $set: {
          previousWeekStart:
            weekStart
              ? new Date(`${weekStart}T12:00:00Z`)
              : null,

          previousWeekEnd:
            weekEnd
              ? new Date(`${weekEnd}T12:00:00Z`)
              : null,

          employeeIdentifiers:
            employeeIdentifiers || {},

          previousScheduledShifts:
            previousScheduledShifts || {},

          previousActualShifts:
            previousActualShifts || {},

          previousActualHours:
            previousActualHours || {},

          previousScheduledHours:
            previousScheduledHours || {}
        }
      },
      {
        upsert: true,
        returnDocument: 'after'
      }
    );

    res.json({
      success: true
    });

  } catch (err) {

    console.error(
      'Previous week review upload error:',
      err
    );

    res.status(500).json({
      success: false,
      error: err.message
    });

  }

});

function cleanTemplateObject(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return {}
  }

  return value
}

function cleanCoverageData(coverage) {
  const source =
    cleanTemplateObject(coverage)

  const cleaned = {}

  for (
    const [shiftId, rowValue] of
    Object.entries(source)
  ) {
    const row =
      cleanTemplateObject(rowValue)

    cleaned[String(shiftId)] = {
      label: String(
        row.label || shiftId
      ).trim(),

      monday: String(
        row.monday || ''
      ).trim(),

      tuesday: String(
        row.tuesday || ''
      ).trim(),

      wednesday: String(
        row.wednesday || ''
      ).trim(),

      thursday: String(
        row.thursday || ''
      ).trim(),

      friday: String(
        row.friday || ''
      ).trim(),

      saturday: String(
        row.saturday || ''
      ).trim(),

      sunday: String(
        row.sunday || ''
      ).trim()
    }
  }

  return cleaned
}

function escapeMongoRegex(value) {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  )
}
``

app.post(
  '/api/schedule-templates',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {
      const {
        store,
        templateName,
        isDefault,
        templateData
      } = req.body

      const cleanStore =
        String(store || '').trim()

      const cleanTemplateName =
        String(templateName || '').trim()

      if (!cleanStore) {
        return res.status(400).json({
          success: false,
          error: 'store is required'
        })
      }

      if (!cleanTemplateName) {
        return res.status(400).json({
          success: false,
          error: 'templateName is required'
        })
      }

      if (cleanTemplateName.length > 100) {
        return res.status(400).json({
          success: false,
          error:
            'Template name cannot exceed ' +
            '100 characters.'
        })
      }

      if (
        !templateData ||
        typeof templateData !== 'object' ||
        Array.isArray(templateData)
      ) {
        return res.status(400).json({
          success: false,
          error:
            'templateData must be an object'
        })
      }

      const assignments =
        cleanTemplateObject(
          templateData.assignments
        )

      const managerCoverage =
        cleanCoverageData(
          templateData.managerCoverage
        )

      const associateCoverage =
        cleanCoverageData(
          templateData.associateCoverage
        )

      const cashierCoverage =
        cleanCoverageData(
          templateData.cashierCoverage
        )

      const hasManagerRows =
        Object.keys(
          managerCoverage
        ).length > 0

      const hasAssociateRows =
        Object.keys(
          associateCoverage
        ).length > 0

      const hasCashierRows =
        Object.keys(
          cashierCoverage
        ).length > 0

      if (
        !hasManagerRows &&
        !hasAssociateRows &&
        !hasCashierRows
      ) {
        return res.status(400).json({
          success: false,
          error:
            'The template does not contain ' +
            'any manager, associate, or ' +
            'cashier coverage rows.'
        })
      }

      const existingTemplate =
        await ScheduleTemplate.findOne({
          store: cleanStore,

          templateName: {
            $regex:
              `^${escapeMongoRegex(
                cleanTemplateName
              )}$`,

            $options: 'i'
          }
        }).lean()

      if (existingTemplate) {
        return res.status(409).json({
          success: false,
          error:
            'A template with this name already ' +
            'exists for this store.'
        })
      }

      const makeDefault =
        isDefault === true

      if (makeDefault) {
        await ScheduleTemplate.updateMany(
          {
            store: cleanStore,
            isDefault: true
          },
          {
            $set: {
              isDefault: false
            }
          }
        )
      }

      const template =
        await ScheduleTemplate.create({
          store: cleanStore,

          templateName:
            cleanTemplateName,

          isDefault:
            makeDefault,

          createdBy:
            req.user?.email ||
            req.user?.name ||
            '',

          templateData: {
            assignments,
            managerCoverage,
            associateCoverage,
            cashierCoverage,
            temporaryShifts: {},
            temporaryShiftNotes: {}
          }
        })

      return res.status(201).json({
        success: true,

        message:
          'Schedule template saved successfully.',

        template:
          template.toObject()
      })
    } catch (err) {
      console.error(
        'Schedule template creation error:',
        err
      )

      if (err?.code === 11000) {
        return res.status(409).json({
          success: false,
          error:
            'A template with this name already ' +
            'exists for this store.'
        })
      }

      return res.status(500).json({
        success: false,
        error:
          err.message ||
          'The schedule template could not be saved.'
      })
    }
  }
)

app.get(
  '/api/schedule-templates',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {
      const store = String(
        req.query.store || ''
      ).trim();

      if (!store) {
        return res.status(400).json({
          success: false,
          error: 'store is required'
        });
      }

      const templates =
        await ScheduleTemplate.find({
          store
        })
          .select(
            '_id store templateName ' +
            'isDefault createdAt updatedAt'
          )
          .sort({
            isDefault: -1,
            templateName: 1
          })
          .lean();

      return res.json({
        success: true,
        templates
      });
    } catch (err) {
      console.error(
        'Schedule template list error:',
        err
      );

      return res.status(500).json({
        success: false,
        error:
          err.message ||
          'Schedule templates could not be loaded.'
      });
    }
  }
);

app.get(
  '/api/schedule-templates/:id',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {
      const templateId = String(
        req.params.id || ''
      ).trim()

      const store = String(
        req.query.store || ''
      ).trim()

      if (
        !mongoose.Types.ObjectId.isValid(
          templateId
        )
      ) {
        return res.status(400).json({
          success: false,
          error: 'Invalid template ID'
        })
      }

      if (!store) {
        return res.status(400).json({
          success: false,
          error: 'store is required'
        })
      }

      const template =
        await ScheduleTemplate.findOne({
          _id: templateId,
          store
        }).lean()

      if (!template) {
        return res.status(404).json({
          success: false,
          error:
            'The selected template was not found.'
        })
      }

      return res.json({
        success: true,
        template
      })
    } catch (err) {
      console.error(
        'Schedule template retrieval error:',
        err
      )

      return res.status(500).json({
        success: false,
        error:
          'The schedule template could not be loaded.'
      })
    }
  }
)
app.delete(
  '/api/schedule-templates/:id',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
    try {
      const templateId = String(
        req.params.id || ''
      ).trim()

      const store = String(
        req.query.store || ''
      ).trim()

      if (
        !mongoose.Types.ObjectId.isValid(
          templateId
        )
      ) {
        return res.status(400).json({
          success: false,
          error: 'Invalid template ID'
        })
      }

      if (!store) {
        return res.status(400).json({
          success: false,
          error: 'store is required'
        })
      }

      const deletedTemplate =
        await ScheduleTemplate.findOneAndDelete({
          _id: templateId,
          store
        }).lean()

      if (!deletedTemplate) {
        return res.status(404).json({
          success: false,
          error:
            'The selected template was not found.'
        })
      }

      return res.json({
        success: true,

        deletedTemplate: {
          _id:
            deletedTemplate._id,

          store:
            deletedTemplate.store,

          templateName:
            deletedTemplate.templateName,

          wasDefault:
            deletedTemplate.isDefault === true
        }
      })
    } catch (err) {
      console.error(
        'Schedule template deletion error:',
        err
      )

      return res.status(500).json({
        success: false,
        error:
          'The schedule template could not be deleted.'
      })
    }
  }
)



app.post(
  '/api/actuals/upload',
  ...managerApi,
  requireStoreFromRequest(storeFromQueryOrBody),
  async (req, res) => {
  try {

    // Canonical store name, checked by requireStoreFromRequest
    const store = req.storeName;

    const {
      previousActualShifts,
      previousActualHours,
      previousScheduledHours
    } = req.body;

    if (!store) {
      return res.status(400).json({
        error: 'Store is required.'
      });
    }

    await ScheduleSettings.findOneAndUpdate(
      { store },
      {
        $set: {
          previousActualShifts:
            previousActualShifts || {},

          previousActualHours:
            previousActualHours || {},

          previousScheduledHours:
            previousScheduledHours || {}
        }
      },
      {
        upsert: true,
        returnDocument: 'after'
      }
    );

    res.json({
      success: true
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });

  }
});


startNextMonthRequestsEmailJob();
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})