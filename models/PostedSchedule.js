const mongoose = require('mongoose')

// A schedule posted for one store and one week (weeks start on Monday).
//
// Managers submit a version into `pending`; an admin approves it, which
// moves it into `approved`. Employees only ever see `approved`, so a
// resubmitted week keeps showing the last approved version until the new
// one is approved.
//
// Snapshot shape (built by the Schedule page, cleaned by the server):
//   {
//     templateName,
//     groups: [{ type, label, employees: [{ name, days: { monday: [shift] } }] }],
//     adjustments: [{ day, shift, details, reason }]   // managers/admins only
//   }

const personSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  name: String
}, { _id: false })

const versionFields = {
  snapshot: Object,
  // The Schedule page's full working state when submitted (JSON text), so
  // a rejected week can be loaded back into the page and fixed
  builderStateJson: String,
  submittedBy: personSchema,
  submittedAt: Date
}

const postedScheduleSchema = new mongoose.Schema({
  store: {
    type: String,
    required: true,
    trim: true
  },

  // Monday of the week, as YYYY-MM-DD (store-local date, no time zone)
  weekStart: {
    type: String,
    required: true,
    match: /^\d{4}-\d{2}-\d{2}$/
  },

  approved: {
    ...versionFields,
    approvedBy: personSchema,
    approvedAt: Date
  },

  pending: versionFields,

  // A rejection keeps the rejected version so the manager can reload it
  lastRejection: {
    reason: String,
    rejectedBy: personSchema,
    rejectedAt: Date,
    submittedAt: Date,
    submittedBy: personSchema,
    snapshot: Object,
    builderStateJson: String
  }
}, {
  timestamps: true
})

postedScheduleSchema.index(
  { store: 1, weekStart: 1 },
  { unique: true }
)

module.exports = mongoose.model(
  'PostedSchedule',
  postedScheduleSchema
)
