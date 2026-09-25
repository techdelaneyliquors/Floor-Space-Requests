const mongoose = require('mongoose')

// A person's regular weekly availability, one document per account.
// Changes go into `pending` until a manager of a linked store (or an admin)
// approves them; the Schedule page uses `approved` and warns about shifts
// outside it.
//
// A week pattern is { monday: { mode, start, end }, ... } where mode is
// 'all' (available all day), 'none' (not available) or 'hours' (only
// between start and end, HH:MM 24-hour).

const personSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: String
}, { _id: false })

const employeeAvailabilitySchema = new mongoose.Schema({
  user: personSchema,

  approved: {
    pattern: Object,
    by: personSchema,
    at: Date
  },

  pending: {
    pattern: Object,
    note: String,
    submittedAt: Date,
    // The requester's roster links when submitted (who can approve it)
    links: [{ _id: false, store: String, employeeNumber: String }]
  },

  lastDecision: {
    decision: { type: String, enum: ['approved', 'denied'] },
    by: personSchema,
    at: Date,
    note: String
  }
}, { timestamps: true })

employeeAvailabilitySchema.index({ 'user.userId': 1 }, { unique: true })

module.exports = mongoose.model('EmployeeAvailability', employeeAvailabilitySchema)
