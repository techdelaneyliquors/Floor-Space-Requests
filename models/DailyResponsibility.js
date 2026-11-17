const mongoose = require('mongoose')

// One employee's tasks for one day, from the store's daily task board
// (uploaded through PUT /api/daily-responsibilities). Shown to the employee
// next to their shift on their schedule page. Uploading a week replaces
// that week's records for the store.

const itemSchema = new mongoose.Schema({
  // "Opening", "Throughout the day", "Closing", "Scheduled for today"
  section: { type: String, trim: true, maxlength: 60, default: '' },
  task: { type: String, trim: true, maxlength: 200, required: true },
  // As the board shows it, e.g. "8:45 AM" or "Before close"
  time: { type: String, trim: true, maxlength: 60, default: '' },
  note: { type: String, trim: true, maxlength: 500, default: '' },
  // e.g. "Lead" for a department lead or the meeting lead
  role: { type: String, trim: true, maxlength: 60, default: '' }
}, { _id: false })

const dailyResponsibilitySchema = new mongoose.Schema({
  store: { type: String, required: true, trim: true },

  // Monday of the week, and the day itself (YYYY-MM-DD)
  weekStart: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

  // Matches the schedule roster's employee number
  employeeNumber: { type: String, required: true, trim: true, maxlength: 32 },
  employeeName: { type: String, trim: true, maxlength: 100, default: '' },

  items: { type: [itemSchema], default: [] }
}, {
  timestamps: true
})

dailyResponsibilitySchema.index({ store: 1, weekStart: 1, employeeNumber: 1 })
dailyResponsibilitySchema.index({ store: 1, date: 1, employeeNumber: 1 }, { unique: true })

module.exports = mongoose.model('DailyResponsibility', dailyResponsibilitySchema)
