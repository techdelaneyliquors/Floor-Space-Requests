const mongoose = require('mongoose')

// An employee's answer to "Can you work these hours?" for one store's
// approved schedule for one week: from their schedule page or the "Yes"
// link in their schedule email. One per person per week; answering again
// replaces it.

const scheduleReplySchema = new mongoose.Schema({
  store: { type: String, required: true, trim: true },
  weekStart: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

  // The employee number, or "name:<lowercase name>" for someone without one
  personKey: { type: String, required: true, trim: true, maxlength: 140 },
  employeeNumber: { type: String, trim: true, maxlength: 32, default: '' },
  employeeName: { type: String, trim: true, maxlength: 100, default: '' },

  answer: { type: String, enum: ['yes', 'no'], required: true },
  // Required for "no"
  reason: { type: String, trim: true, maxlength: 500, default: '' },

  // The shifts they answered for (lib/scheduleEmails.js shiftsSignature), so
  // a reply made before the schedule changed can be spotted
  shiftsSignature: { type: String, maxlength: 2000, default: '' },

  via: { type: String, enum: ['page', 'email'], required: true },
  answeredBy: {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: String
  },
  answeredAt: { type: Date, required: true }
}, {
  timestamps: true
})

scheduleReplySchema.index({ store: 1, weekStart: 1, personKey: 1 }, { unique: true })

module.exports = mongoose.model('ScheduleReply', scheduleReplySchema)
