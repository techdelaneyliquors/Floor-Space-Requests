const mongoose = require('mongoose')

// A time-off request from an employee or manager: a date or date range,
// all day or between two times each day. Managers of any linked store (or
// an admin) approve or deny it; approved time off shows on those stores'
// Schedule pages and assigning the person during it raises a warning.

const personSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: String
}, { _id: false })

const timeOffRequestSchema = new mongoose.Schema({
  user: personSchema,

  // The requester's roster links when they asked (which stores it affects)
  links: [{
    _id: false,
    store: String,
    employeeNumber: String
  }],

  // YYYY-MM-DD, store-local dates
  startDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  endDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

  allDay: { type: Boolean, default: true },
  // HH:MM (24-hour), only when not all day; applies to every day in range
  startTime: String,
  endTime: String,

  note: String,

  status: {
    type: String,
    enum: ['pending', 'approved', 'denied', 'cancelled'],
    default: 'pending'
  },

  review: {
    by: personSchema,
    at: Date,
    note: String
  }
}, { timestamps: true })

timeOffRequestSchema.index({ 'user.userId': 1, startDate: -1 })
timeOffRequestSchema.index({ 'links.store': 1, status: 1, endDate: 1 })

module.exports = mongoose.model('TimeOffRequest', timeOffRequestSchema)
