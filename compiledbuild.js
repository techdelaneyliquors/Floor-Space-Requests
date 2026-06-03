if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config()
}


const Item = require('./models/Item')

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
const express = require('express')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const cookieParser = require('cookie-parser')

const app = express()
const mongoose = require('mongoose')
const User = require('./models/User')
const ItemMonthStatus = require('./models/ItemMonthStatus')
const ItemRequest = require('./models/ItemRequest')

const cron = require('node-cron');
const nodemailer = require('nodemailer');


// ------------------------
// DB SETUP
// ------------------------

app.use(express.static(__dirname))


mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected ✅"))
  .catch(err => console.error(err))




// ------------------------
// EXPRESS SETUP
// ------------------------

app.set('view engine', 'ejs')
app.use(express.urlencoded({ extended: false }))
app.use(express.json())
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
    
    const { name, email, password, confirmPassword } = req.body;

    // ✅ check passwords match
    if (password !== confirmPassword) {
      return res.status(400).render('register.ejs', { 
        error: "Passwords do not match" 
      });
    }

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


app.get("/my-requests", requireAuth, async (req, res) => {
  const { store } = req.query;

  const filter = {
    user: req.user.name
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

app.get('/branfordstoremap/final', requireAuth, requireAdmin, async (req, res) => {
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

app.get('/stratfordstoremap/final', requireAuth, requireAdmin, async (req, res) => {
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

app.get('/New-Havenstoremap/final', requireAuth, requireAdmin, async (req, res) => {
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

app.get('/Hamdenstoremap/final', requireAuth, requireAdmin, async (req, res) => {
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

app.get('/New-Milfordstoremap/final', requireAuth, requireAdmin, async (req, res) => {
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
app.post('/api/request', requireAuthApi, async (req, res) => {
  
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
app.get('/api/requests', requireAuthApi, requireAdminApi, async (req, res) => {
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
app.post('/api/approve', requireAuthApi, requireAdminApi, async (req, res) => {
  const { request_id, item_id, month, map } = req.body

  if (!request_id || !item_id || !month || !map) {
    return res.status(400).json({
      error: 'request_id, item_id, month, and map are required'
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
        new: true
      }
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
app.get('/api/user-requests', requireAuthApi, async (req, res) => {
  try {
    const rows = await ItemRequest.find({
      user: req.user.name
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
app.get('/api/final-data', requireAuthApi, async (req, res) => {
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



app.post("/set-month", (req, res) => {
  const { month } = req.body

  //console.log("Set month:", month)

  res.json({ success: true })
})


app.get("/debug-db", async (req, res) => {
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


const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
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
  const nextMonth = getNextMonthKey();

  // exact map ids used in your app / DB
  const mapOrder = ['branford', 'Hamden', 'New Haven', 'New Milford', 'stratford'];

  const summary = await ItemRequest.aggregate([
    {
      $match: {
        status: 'requested',
        month: nextMonth
      }
    },
    {
      $group: {
        _id: '$map_id',
        count: { $sum: 1 }
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
    if (counts.hasOwnProperty(row._id)) {
      counts[row._id] = row.count;
    }
  }

  const totalPending = mapOrder.reduce((sum, map) => sum + (counts[map] || 0), 0);

  // only send if there is at least one pending request
  if (totalPending === 0) {
    console.log(`[next-month-email] No pending requested spots for ${nextMonth}; email not sent.`);
    return;
  }

  const subject = `Pending requests for ${nextMonth}`;

  const text = [
    `Hi Zach,`,
    ``,
    `There are currently ${totalPending} pending request${totalPending === 1 ? '' : 's'} for next month (${nextMonth}).`,
    ``,
    `Branford: ${counts['branford']}`,
    `Hamden: ${counts['Hamden']}`,
    `New Haven: ${counts['New Haven']}`,
    `New Milford: ${counts['New Milford']}`,
    `Stratford: ${counts['stratford']}`,
    ``,
    `- Sent automatically from tech@delaneyliquors.com`
  ].join('\n');

  const html = `
    <p>Hi Zach,</p>
    <p>There are currently <strong>${totalPending}</strong> pending request${totalPending === 1 ? '' : 's'} for next month (<strong>${nextMonth}</strong>).</p>
    <ul>
      <li><strong>Branford:</strong> ${counts['branford']}</li>
      <li><strong>Hamden:</strong> ${counts['Hamden']}</li>
      <li><strong>New Haven:</strong> ${counts['New Haven']}</li>
      <li><strong>New Milford:</strong> ${counts['New Milford']}</li>
      <li><strong>Stratford:</strong> ${counts['stratford']}</li>
    </ul>
    <p>- Sent automatically from tech@delaneyliquors.com</p>
    <p>- link to webpage https://floor-space-requests-app.onrender.com/ </p>
  `;

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.NEXT_MONTH_REQUESTS_TO,
    subject,
    text,
    html
  });

  console.log(`[next-month-email] Sent summary for ${nextMonth} to ${process.env.NEXT_MONTH_REQUESTS_TO}`);
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


app.get('/admin/test-next-month-email', requireAuth, requireAdmin, async (req, res) => {
  try {
    await sendNextMonthRequestsSummaryEmail();
    res.send('Next month pending requests summary email sent (if pending requests existed).');
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to send summary email.');
  }
});


app.get('/forgot-password', (req, res) => {
  res.render('forgot-password.ejs', { success: false });
});


app.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  const user = await User.findOne({ email });

  // ✅ Never reveal if email exists
  if (!user) {
    return res.send("If that email exists, a reset link was sent.");
  }

  
let token = user.resetToken;

  if (
    !user.resetToken ||
    !user.resetTokenExpiry ||
    user.resetTokenExpiry <= new Date()
  ) {
    token = crypto.randomBytes(32).toString('hex');

    user.resetToken = token;
    user.resetTokenExpiry = new Date(Date.now() + (1000 * 60 * 60));
    //console.log("EXPIRY IN DB:", user.resetTokenExpiry);
    await user.save();
  }


  const resetLink = `http://${req.headers.host}/reset-password/${token}`;
  //console.log("TOKEN IN DB:", user?.resetToken);
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: user.email,
    subject: "Reset your password",
    text: `Reset your password:\n${resetLink}`
  });

  res.render('forgot-password.ejs', { success: true });
});




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

  await user.save();

  return res.redirect('/login');
});




startNextMonthRequestsEmailJob();
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})