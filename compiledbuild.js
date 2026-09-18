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

const CANONICAL_STORE_NAMES = {
  branford: 'Branford',
  hamden: 'Hamden',
  'new haven': 'New Haven',
  'new milford': 'New Milford',
  stratford: 'Stratford'
};

function getCanonicalStoreName(value) {
  const normalized = String(
    value || ''
  )
    .trim()
    .toLowerCase();

  return CANONICAL_STORE_NAMES[
    normalized
  ] || '';
}

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
const ScheduleSettings = require(
  './models/ScheduleSettings'
)
const ScheduleTemplate = require('./models/ScheduleTemplate')
const AttendanceOvertimeReview = require(
  './models/AttendanceOvertimeReview'
);
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
app.use(express.urlencoded({
  extended: false,
  limit: '2mb'
}));

app.use(express.json({
  limit: '2mb'
}));
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



app.post(
  '/api/attendance-point-recommendations',
  requireAuthApi,
  requireAdminApi,
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
            new: true,
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
  requireAuthApi,
  requireAdminApi,
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
  requireAuthApi,
  requireAdminApi,
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
            new: true,
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
  requireAuthApi,
  requireAdminApi,
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
  requireAuthApi,
  requireAdminApi,
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
            new: true,
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



app.post(
  '/api/attendance-points',
  requireAuthApi,
  requireAdminApi,
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
  requireAuthApi,
  requireAdminApi,
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
            new: true,
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
  requireAuthApi,
  requireAdminApi,
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
  requireAuthApi,
  requireAdminApi,
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
            new: true,
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

app.get(
  '/Branfordstoremap/Schedule',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      let settings =
        await ScheduleSettings.findOne({
          store: 'Branford'
        }).lean()

      if (!settings) {
        const createdSettings =
          await ScheduleSettings.create({
            store: 'Branford',

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

        settings =
          createdSettings.toObject()
      }

      console.log(
        'Branford settings loaded:',
        {
          managers:
            settings.managers || [],

          associates:
            settings.associates || [],

          cashiers:
            settings.cashiers || [],

          buildEmployeeIdentifiers:
            settings.buildEmployeeIdentifiers || {},

          availability:
            settings.availability || {}
        }
      )

      return res.render(
        'Branford Schedule.ejs',
        {
          user: req.user,
          mapId: 'Branford',

          scheduleData: {
            store: 'Branford',

            managers:
              settings.managers || [],

            associates:
              settings.associates || [],

            cashiers:
              settings.cashiers || [],

              approvedOvertimeHours:
  settings.approvedOvertimeHours || {},

            availability:
              settings.availability || {},

            assignments:
              settings.assignments || {},

            attendance:
              settings.attendance || {},

            buildEmployeeIdentifiers:
              settings.buildEmployeeIdentifiers || {},

            employeeIdentifiers:
              settings.employeeIdentifiers || {},

            previousScheduledShifts:
              settings.previousScheduledShifts || {},

            previousActualShifts:
              settings.previousActualShifts || {},

            previousActualHours:
              settings.previousActualHours || {},

            previousScheduledHours:
              settings.previousScheduledHours || {},

              previousWeekStart:
  settings.previousWeekStart || null,

previousWeekEnd:
  settings.previousWeekEnd || null


          }
        }
      )
    } catch (err) {
      console.error(
        'Branford schedule page error:',
        err
      )

      return res.status(500).send(
        'Error loading Branford schedule'
      )
    }
  }
)

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

app.get(
  '/stratfordstoremap/Schedule',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      let settings =
        await ScheduleSettings.findOne({
          store: 'Stratford'
        }).lean()

      if (!settings) {
        const createdSettings =
          await ScheduleSettings.create({
            store: 'Stratford',

            managers: [],
            associates: [],

            availability: {},
            assignments: {},
            attendance: {},

            employeeIdentifiers: {},
            buildEmployeeIdentifiers: {},

            previousScheduledShifts: {},
            previousActualShifts: {},
            previousActualHours: {},
            previousScheduledHours: {}
          })

        settings =
          createdSettings.toObject()
      }

      console.log(
        'Stratford settings loaded:',
        {
          managers:
            settings.managers || [],

          associates:
            settings.associates || [],

          buildEmployeeIdentifiers:
            settings.buildEmployeeIdentifiers || {},

          availability:
            settings.availability || {}
        }
      )

      return res.render(
        'Stratford Schedule',
        {
          user: req.user,
          mapId: 'stratford',

          scheduleData: {
            store: 'Stratford',

            managers:
              settings.managers || [],

            associates:
              settings.associates || [],

            availability:
              settings.availability || {},

            assignments:
              settings.assignments || {},

            attendance:
              settings.attendance || {},

            buildEmployeeIdentifiers:
              settings.buildEmployeeIdentifiers || {},

            employeeIdentifiers:
              settings.employeeIdentifiers || {},

            previousScheduledShifts:
              settings.previousScheduledShifts || {},

            previousActualShifts:
              settings.previousActualShifts || {},

            previousActualHours:
              settings.previousActualHours || {},

            previousScheduledHours:
              settings.previousScheduledHours || {}
          }
        }
      )
    } catch (err) {
      console.error(
        'Stratford schedule page error:',
        err
      )

      return res.status(500).send(
        'Error loading Stratford schedule'
      )
    }
  }
)

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

app.get(
  '/New-Havenstoremap/Schedule',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      let settings =
        await ScheduleSettings.findOne({
          store: 'New Haven'
        }).lean()

      if (!settings) {
        const createdSettings =
          await ScheduleSettings.create({
            store: 'New Haven',

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
            previousScheduledHours: {}
          })

        settings =
          createdSettings.toObject()
      }

      console.log(
        'New Haven settings loaded:',
        {
          managers:
            settings.managers || [],

          associates:
            settings.associates || [],

          cashiers:
            settings.cashiers || [],

          buildEmployeeIdentifiers:
            settings.buildEmployeeIdentifiers || {},

          availability:
            settings.availability || {}
        }
      )

      return res.render(
        'New Haven Schedule.ejs',
        {
          user: req.user,
          mapId: 'New Haven',

          scheduleData: {
            store: 'New Haven',

            managers:
              settings.managers || [],

            associates:
              settings.associates || [],

            cashiers:
              settings.cashiers || [],

            availability:
              settings.availability || {},

            assignments:
              settings.assignments || {},

            attendance:
              settings.attendance || {},

            buildEmployeeIdentifiers:
              settings.buildEmployeeIdentifiers || {},

            employeeIdentifiers:
              settings.employeeIdentifiers || {},

            previousScheduledShifts:
              settings.previousScheduledShifts || {},

            previousActualShifts:
              settings.previousActualShifts || {},

            previousActualHours:
              settings.previousActualHours || {},

            previousScheduledHours:
              settings.previousScheduledHours || {}
          }
        }
      )
    } catch (err) {
      console.error(
        'New Haven schedule page error:',
        err
      )

      return res.status(500).send(
        'Error loading New Haven schedule'
      )
    }
  }
)

app.get(
  '/hamdenstoremap/schedule',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      let settings = await ScheduleSettings.findOne({
        store: 'Hamden'
      }).lean()

      if (!settings) {
        const createdSettings =
          await ScheduleSettings.create({
            store: 'Hamden',

            managers: [
              'Jason',
              'Thom',
              'Alex'
            ],

            associates: [
              'Andrew',
              'Talin',
              'Tricia',
              'Jessica',
              'Adrian'
            ],

            availability: {},
            employeeIdentifiers: {},
            buildEmployeeIdentifiers: {},
            previousScheduledShifts: {},
            previousActualShifts: {},
            previousActualHours: {},
            previousScheduledHours: {}
          })

        settings = createdSettings.toObject()
      }

      console.log(
        'Identifiers sent to EJS:',
        settings.employeeIdentifiers
      )

      res.render('Hamden Schedule', {
        scheduleData: {
          managers:
            settings.managers || [],

          associates:
            settings.associates || [],

          buildEmployeeIdentifiers: settings.buildEmployeeIdentifiers || {},

          availability:
            settings.availability || {},

          assignments:
            settings.assignments || {},

          attendance:
            settings.attendance || {},

          buildEmployeeIdentifiers:
            settings.buildEmployeeIdentifiers || {},

          employeeIdentifiers:
            settings.employeeIdentifiers || {},

          previousScheduledShifts:
            settings.previousScheduledShifts || {},

          previousActualShifts:
            settings.previousActualShifts || {},

          previousActualHours:
            settings.previousActualHours || {},

          previousScheduledHours:
            settings.previousScheduledHours || {}
        }
      })
    } catch (err) {
      console.error(
        'Hamden schedule page error:',
        err
      )

      res.status(500).send(
        'Error loading Hamden schedule'
      )
    }
  }
)

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


app.get(
  '/New-Milfordstoremap/schedule',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {

      let settings =
        await ScheduleSettings.findOne({
          store: 'New Milford'
        }).lean()

      if (!settings) {

        const createdSettings =
          await ScheduleSettings.create({
            store: 'New Milford',

            managers: [],
            associates: [],

            availability: {},
            attendance: {},
            assignments: {},

            employeeIdentifiers: {},
            buildEmployeeIdentifiers: {},

            previousScheduledShifts: {},
            previousActualShifts: {},
            previousActualHours: {},
            previousScheduledHours: {}
          })

        settings =
          createdSettings.toObject()
      }

      res.render(
        'New Milford Schedule',
        {
          scheduleData: {
            store: 'New Milford',

            managers:
              settings.managers || [],

            associates:
              settings.associates || [],

            availability:
              settings.availability || {},

            assignments:
              settings.assignments || {},

            attendance:
              settings.attendance || {},

            buildEmployeeIdentifiers:
              settings.buildEmployeeIdentifiers || {},

            employeeIdentifiers:
              settings.employeeIdentifiers || {},

            previousScheduledShifts:
              settings.previousScheduledShifts || {},

            previousActualShifts:
              settings.previousActualShifts || {},

            previousActualHours:
              settings.previousActualHours || {},

            previousScheduledHours:
              settings.previousScheduledHours || {}
          }
        }
      )

    } catch (err) {

      console.error(err)

      res.status(500).send(
        'Error loading New Milford schedule'
      )

    }
  }
)


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



app.get('/class', requireAuth, requireAdmin, (req, res) => {
  res.render('MylesJamesClass.ejs', {
    user: req.user
  });
});


app.post('/class', requireAuth, requireAdmin, async (req, res) => {
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

app.get('/Hamdenmap', requireAuth, requireAdmin, (req, res) => {
  res.render('Hamdensorter.ejs', {
    user: req.user
  });
});


app.post(
  '/api/schedule-settings',
  requireAuthApi,
  requireAdminApi,
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

            new:
              true,

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
  async (req, res) => {
    try {
      const {
        store,
        attendance
      } = req.body;

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
            new: true,
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


app.post('/api/previous-week-review', async (req, res) => {

  try {

    const {
      store,
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
        new: true
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
  requireAuthApi,
  requireAdminApi,
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
  requireAuthApi,
  requireAdminApi,
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
  requireAuthApi,
  requireAdminApi,
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
  requireAuthApi,
  requireAdminApi,
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



app.post('/api/actuals/upload', async (req, res) => {
  try {

    const {
      store,
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
        new: true
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