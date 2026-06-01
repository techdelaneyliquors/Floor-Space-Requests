if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config()
}

const express = require('express')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const cookieParser = require('cookie-parser')
const sqlite3 = require('sqlite3').verbose()
const fs = require('fs')

const app = express()
const User = require('./models/User')

// ------------------------
// DB SETUP
// ------------------------


const mongoose = require('mongoose')

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected ✅"))
  .catch(err => console.error(err))


const db = new sqlite3.Database('./app.db')

db.get("SELECT sqlite_version() AS v", (err, row) => {
  if (!err) console.log("SQLite version:", row.v)
})

if (fs.existsSync('./schema.sql')) {
  db.exec(fs.readFileSync('./schema.sql', 'utf8'), (err) => {
    if (err) {
      console.error('Schema load error:', err.message)
    }
  })
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err)
      else resolve(rows)
    })
  })
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err)
      else resolve(this)
    })
  })
}

// ------------------------
// EXPRESS SETUP
// ------------------------

app.set('view engine', 'ejs')
app.use(express.urlencoded({ extended: false }))
app.use(express.json())
app.use(cookieParser())

// If you split frontend/backend later, lock this down to your real frontend origin
app.use(cors({
  origin: true,
  credentials: true
}))

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
      role: user.role
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

async function requireAuth(req, res, next) {
  try {
    const token = getTokenFromRequest(req)

    if (!token) {
      return res.redirect('/login')
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET)
    const user = await User.findById(payload.sub).lean()

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

    const payload = jwt.verify(token, process.env.JWT_SECRET)
    const user = await User.findById(payload.sub).lean()

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

    const payload = jwt.verify(token, process.env.JWT_SECRET)
    const user = await User.findById(payload.sub).lean()

    if (user) {
      return res.redirect('/')
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
  return res.status(403).send('Forbidden')
}

function requireAdminApi(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    return next()
  }
  return res.status(403).json({ error: 'Forbidden' })
}

// ------------------------
// AUTH ROUTES
// ------------------------

app.get('/login', requireGuest, (req, res) => {
  res.render('login.ejs', { error: null })
})

app.post('/login', requireGuest, async (req, res) => {
  try {
    const { email, password } = req.body

    const user = await User.findOne({ email })
    if (!user) {
      return res.status(401).render('login.ejs', { error: 'Invalid credentials' })
    }

    const ok = await bcrypt.compare(password, user.password)
    if (!ok) {
      return res.status(401).render('login.ejs', { error: 'Invalid credentials' })
    }

    const token = signToken(user)

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    })

    res.redirect('/')
  } catch (err) {
    console.error(err)
    res.status(500).send('Login failed')
  }
})

app.get('/register', requireGuest, (req, res) => {
  res.render('register.ejs', { error: null })
})

app.post('/register', requireGuest, async (req, res) => {
  try {
    const existingUser = await User.findOne({ email: req.body.email })

    if (existingUser) {
      return res.status(400).render('register.ejs', { error: 'Email already registered' })
    }

    const hashedPassword = await bcrypt.hash(req.body.password, 10)

    await User.create({
      name: req.body.name,
      email: req.body.email,
      password: hashedPassword,
      role: 'user'
    })

    res.redirect('/login')
  } catch (err) {
    console.error(err)
    res.status(500).render('register.ejs', { error: 'Registration failed' })
  }
})

app.post('/logout', (req, res) => {
  res.clearCookie('token')
  res.redirect('/login')
})

// Optional JSON login route for API clients/Postman
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body

    const user = await User.findOne({ email })
    if (!user) return res.status(401).json({ error: 'Invalid credentials' })

    const ok = await bcrypt.compare(password, user.password)
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' })

    const token = signToken(user)

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
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

app.get('/', requireAuth, (req, res) => {
  res.render('index.ejs', {
    name: req.user.name,
    user: req.user
  })
})

app.get('/branfordstoremap', requireAuth, (req, res) => {
  res.render('Branford Store Map.ejs', {
    user: req.user,
    isAdmin: req.user.role === 'admin',
    mapId: 'branford'
  })
})

app.get('/stratfordstoremap', requireAuth, (req, res) => {
  res.render('Stratford Map.ejs', {
    user: req.user,
    isAdmin: req.user.role === 'admin',
    mapId: 'stratford'
  })
})

app.get('/New-Havenstoremap', requireAuth, (req, res) => {
  res.render('New Haven Map.ejs', {
    user: req.user,
    isAdmin: req.user.role === 'admin',
    mapId: 'New Haven'
  })
})

app.get('/Hamdenstoremap', requireAuth, (req, res) => {
  res.render('Hamden Map.ejs', {
    user: req.user,
    isAdmin: req.user.role === 'admin',
    mapId: 'Hamden'
  })
})

app.get('/New-Milfordstoremap', requireAuth, (req, res) => {
  res.render('New Milford Map.ejs', {
    user: req.user,
    isAdmin: req.user.role === 'admin',
    mapId: 'New Milford'
  })
})

// ------------------------
// MY REQUESTS PAGES
// ------------------------

app.get('/my-requests-Branford', requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, map_id, item_id, brand, products, status, month, created_at
       FROM item_requests
       WHERE user = ?
         AND map_id = ?
       ORDER BY created_at DESC`,
      [req.user.name, 'branford']
    )

    res.render('my-requests Branford.ejs', {
      user: req.user,
      requests: rows
    })
  } catch (err) {
    console.error(err)
    res.send('Error loading requests')
  }
})

app.get('/my-requests-Stratford', requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, map_id, item_id, brand, products, status, month, created_at
       FROM item_requests
       WHERE user = ?
         AND map_id = ?
       ORDER BY created_at DESC`,
      [req.user.name, 'stratford']
    )

    res.render('my-requests Stratford.ejs', {
      user: req.user,
      requests: rows
    })
  } catch (err) {
    console.error(err)
    res.send('Error loading requests')
  }
})

app.get('/my-requests-New-Haven', requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, map_id, item_id, brand, products, status, month, created_at
       FROM item_requests
       WHERE user = ?
         AND map_id = ?
       ORDER BY created_at DESC`,
      [req.user.name, 'New Haven']
    )

    res.render('my-requests New Haven.ejs', {
      user: req.user,
      requests: rows
    })
  } catch (err) {
    console.error(err)
    res.send('Error loading requests')
  }
})

app.get('/my-requests-Hamden', requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, map_id, item_id, brand, products, status, month, created_at
       FROM item_requests
       WHERE user = ?
         AND map_id = ?
       ORDER BY created_at DESC`,
      [req.user.name, 'Hamden']
    )

    res.render('my-requests Hamden.ejs', {
      user: req.user,
      requests: rows
    })
  } catch (err) {
    console.error(err)
    res.send('Error loading requests')
  }
})

app.get('/my-requests-New-Milford', requireAuth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, map_id, item_id, brand, products, status, month, created_at
       FROM item_requests
       WHERE user = ?
         AND map_id = ?
       ORDER BY created_at DESC`,
      [req.user.name, 'New Milford']
    )

    res.render('my-requests New Milford.ejs', {
      user: req.user,
      requests: rows
    })
  } catch (err) {
    console.error(err)
    res.send('Error loading requests')
  }
})

// ------------------------
// FINAL PAGES (ADMIN ONLY)
// ------------------------

app.get('/branfordstoremap/final', requireAuth, requireAdmin, async (req, res) => {
  const MAP_ID = 'branford'
  try {
    const month = req.query.month || currentMonth()

    const confirmed = await all(
      `SELECT item_id, user, brand, products, status
       FROM item_requests
       WHERE month = ? AND map_id = ?
       ORDER BY item_id`,
      [month, MAP_ID]
    )

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

app.get('/stratfordstoremap/final', requireAuth, requireAdmin, async (req, res) => {
  const MAP_ID = 'stratford'
  try {
    const month = req.query.month || currentMonth()

    const confirmed = await all(
      `SELECT item_id, user, brand, products, status
       FROM item_requests
       WHERE month = ? AND map_id = ?
       ORDER BY item_id`,
      [month, MAP_ID]
    )

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

app.get('/New-Havenstoremap/final', requireAuth, requireAdmin, async (req, res) => {
  const MAP_ID = 'New Haven'
  try {
    const month = req.query.month || currentMonth()

    const confirmed = await all(
      `SELECT item_id, user, brand, products, status
       FROM item_requests
       WHERE month = ? AND map_id = ?
       ORDER BY item_id`,
      [month, MAP_ID]
    )

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

app.get('/Hamdenstoremap/final', requireAuth, requireAdmin, async (req, res) => {
  const MAP_ID = 'Hamden'
  try {
    const month = req.query.month || currentMonth()

    const confirmed = await all(
      `SELECT item_id, user, brand, products, status
       FROM item_requests
       WHERE month = ? AND map_id = ?
       ORDER BY item_id`,
      [month, MAP_ID]
    )

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

app.get('/New-Milfordstoremap/final', requireAuth, requireAdmin, async (req, res) => {
  const MAP_ID = 'New Milford'
  try {
    const month = req.query.month || currentMonth()

    const confirmed = await all(
      `SELECT item_id, user, brand, products, status
       FROM item_requests
       WHERE month = ? AND map_id = ?
       ORDER BY item_id`,
      [month, MAP_ID]
    )

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

app.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const users = await User.find().lean()

  res.render('admin-users.ejs', {
    user: req.user,
    users
  })
})

app.post('/admin/promote', requireAuth, requireAdmin, async (req, res) => {
  const { email } = req.body

  try {
    const user = await User.findOne({ email })

    if (!user) {
      return res.status(404).send('User not found')
    }

    user.role = 'admin'
    await user.save()

    res.send(`${user.email} is now an admin ✅`)
  } catch (err) {
    console.error(err)
    res.status(500).send('Error promoting user')
  }
})

app.post('/admin/demote', requireAuth, requireAdmin, async (req, res) => {
  const { email } = req.body

  const user = await User.findOne({ email })

  if (!user) {
    return res.status(404).send('User not found')
  }

  if (user.email === req.user.email) {
    return res.status(400).send('You cannot remove yourself as admin')
  }

  user.role = 'user'
  await user.save()

  res.send('Admin removed ✅')
})

// ------------------------
// API ROUTES (JWT-PROTECTED)
// ------------------------

// Effective month map state
app.get('/api/month', requireAuthApi, async (req, res) => {
  const { month, map } = req.query

  if (!month || !map) {
    return res.status(400).json({ error: 'month and map are required' })
  }

  try {
    const reservedRows = await all(
      `SELECT item_id, 'reserved' AS status
       FROM item_month_status
       WHERE month = ? AND map_id = ?`,
      [month, map]
    )

    const requestedRows = await all(
      `SELECT DISTINCT r.item_id, 'requested' AS status
       FROM item_requests r
       WHERE r.month = ?
         AND r.map_id = ?
         AND r.status = 'requested'
         AND NOT EXISTS (
           SELECT 1
           FROM item_month_status s
           WHERE s.item_id = r.item_id
             AND s.map_id = r.map_id
             AND s.month = r.month
             AND s.status = 'reserved'
         )`,
      [month, map]
    )

    res.json([...reservedRows, ...requestedRows])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Create request
app.post('/api/request', requireAuthApi, async (req, res) => {
  const { item_id, month, brand, products, map } = req.body
  const user = req.user.name

  if (!item_id || !month || !brand || !products || !map) {
    return res.status(400).json({
      error: 'item_id, month, brand, products, and map are required'
    })
  }

  try {
    const reserved = await all(
      `SELECT 1
       FROM item_month_status
       WHERE map_id = ? AND item_id = ? AND month = ? AND status = 'reserved'`,
      [map, item_id, month]
    )

    if (reserved.length > 0) {
      return res.status(409).json({ error: 'This spot is already reserved for that month' })
    }

    await run(
      `INSERT INTO item_requests (map_id, item_id, month, user, brand, products, status)
       VALUES (?, ?, ?, ?, ?, ?, 'requested')`,
      [map, item_id, month, user, brand, products]
    )

    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Pending requests for admin review
app.get('/api/requests', requireAuthApi, requireAdminApi, async (req, res) => {
  const { month, map } = req.query

  if (!month || !map) {
    return res.status(400).json({ error: 'month and map are required' })
  }

  try {
    const rows = await all(
      `SELECT id, item_id, month, user, brand, products, status, created_at
       FROM item_requests
       WHERE month = ? AND map_id = ? AND status = 'requested'
       ORDER BY item_id, created_at`,
      [month, map]
    )

    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Approve request (admin only)
app.post('/api/approve', requireAuthApi, requireAdminApi, async (req, res) => {
  const { request_id, item_id, month, map } = req.body

  if (!request_id || !item_id || !month || !map) {
    return res.status(400).json({
      error: 'request_id, item_id, month, and map are required'
    })
  }

  try {
    // 1) Approve selected request
    await run(
      `UPDATE item_requests
       SET status = 'reserved'
       WHERE id = ?`,
      [request_id]
    )

    // 2) Reject competing requests
    // FIXED: correct parameter order must match item_id, month, map_id, id
    await run(
      `UPDATE item_requests
       SET status = 'rejected'
       WHERE item_id = ?
         AND month = ?
         AND map_id = ?
         AND id != ?
         AND status = 'requested'`,
      [item_id, month, map, request_id]
    )

    // 3) Mark final state reserved
    await run(
      `INSERT INTO item_month_status (map_id, item_id, month, status)
       VALUES (?, ?, ?, 'reserved')
       ON CONFLICT(map_id, item_id, month) DO UPDATE SET
         status = 'reserved',
         updated_at = datetime('now')`,
      [map, item_id, month]
    )

    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Reject request (admin only)
app.post('/api/reject', requireAuthApi, requireAdminApi, async (req, res) => {
  const { request_id } = req.body

  if (!request_id) {
    return res.status(400).json({ error: 'request_id is required' })
  }

  try {
    await run(
      `UPDATE item_requests
       SET status = 'rejected'
       WHERE id = ?`,
      [request_id]
    )

    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Current user's own requests
app.get('/api/user-requests', requireAuthApi, async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, map_id, item_id, brand, products, status, month, created_at
       FROM item_requests
       WHERE user = ?
       ORDER BY created_at DESC`,
      [req.user.name]
    )

    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Final page data
app.get('/api/final-data', requireAuthApi, async (req, res) => {
  try {
    const { month, map } = req.query

    const rows = await all(
      `SELECT item_id, user, brand, products, status
       FROM item_requests
       WHERE month = ? AND map_id = ?
       ORDER BY item_id`,
      [month, map]
    )

    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

app.get("/api/month", async (req, res) => {
  const { month, map } = req.query;

  try {
    const rows = await all(`
      SELECT item_id, status
      FROM item_month_status
      WHERE month = ? AND map_id = ?
    `, [month, map])

    res.json(rows)
    
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
});
``


app.post("/set-month", (req, res) => {
  const { month } = req.body

  console.log("Set month:", month)

  res.json({ success: true })
})


app.get("/debug-db", async (req, res) => {
  try {
    const rows = await all(`
      SELECT id, item_id, user, brand, products 
      FROM item_requests
    `);

    console.log(rows);   // ✅ prints to terminal
    res.json(rows);      // ✅ shows in browser

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})