const mongoose = require('mongoose')

// Hours totals for one store's week, for the Scheduling Review page. Kept
// for good (unlike PreviousWeekReview, which only keeps 4 weeks): just the
// totals per person, not the shifts, so it stays small (about 2 KB a week).
//
// People with an employee ID come from the Previous Week review (scheduled
// and worked from the Paychex upload, plus paid sick hours). People without
// one can't punch in, so their scheduled hours on the approved schedule
// count as worked too.

const employeeSchema = new mongoose.Schema({
  // employeeNumber, or "name:<lowercase name>" without one
  key: { type: String, required: true },
  name: { type: String, required: true },
  employeeNumber: { type: String, default: '' },
  // false: no employee ID, so worked = scheduled
  canPunch: { type: Boolean, default: true },
  scheduled: { type: Number, default: 0 },
  worked: { type: Number, default: 0 }
}, { _id: false })

const weeklyHoursSchema = new mongoose.Schema({
  store: { type: String, required: true, trim: true },

  // Monday of the week (YYYY-MM-DD)
  weekStart: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

  // The week counts toward the month, season and year its Thursday is in
  // (where most of its days are)
  month: { type: String, required: true },   // 2026-11
  season: { type: String, required: true },  // 2026-fall; Dec–Feb is "<Dec's year>-winter"
  year: { type: String, required: true },    // 2026

  employees: { type: [employeeSchema], default: [] },

  totals: {
    scheduled: { type: Number, default: 0 },
    worked: { type: Number, default: 0 },
    // Of those, the hours of people without an employee ID
    noIdHours: { type: Number, default: 0 }
  },

  // The week's hours budget when it was recorded (null: none set)
  budgetHours: { type: Number, default: null },

  // Without an approved schedule, people without an ID have no hours
  hasApprovedSchedule: { type: Boolean, default: false }
}, {
  timestamps: true
})

weeklyHoursSchema.index({ store: 1, weekStart: 1 }, { unique: true })

module.exports = mongoose.model('WeeklyHours', weeklyHoursSchema)
