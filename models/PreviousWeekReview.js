const mongoose = require('mongoose')

// The last 4 weeks of previous-week reviews, kept per store and week so earlier
// weeks can be looked at again on the Previous Week tab. ScheduleSettings
// still holds the latest one (what the page opens with); this is the history.
// Uploading the same week again replaces that week's record; older weeks
// are deleted (see WEEK_HISTORY_WEEKS in compiledbuild.js).

const previousWeekReviewSchema = new mongoose.Schema({
  store: {
    type: String,
    required: true,
    trim: true
  },

  // Monday of the reviewed week (YYYY-MM-DD)
  weekStart: {
    type: String,
    required: true,
    match: /^\d{4}-\d{2}-\d{2}$/
  },

  previousWeekStart: Date,
  previousWeekEnd: Date,

  // Same shapes as on ScheduleSettings
  employeeIdentifiers: { type: Object, default: {} },
  previousScheduledShifts: { type: Object, default: {} },
  previousActualShifts: { type: Object, default: {} },
  previousActualHours: { type: Object, default: {} },
  previousScheduledHours: { type: Object, default: {} },

  // Who sent the latest upload for this week (a person or a store workbook)
  uploadedBy: {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    name: String
  }
}, {
  timestamps: true,
  minimize: false
})

previousWeekReviewSchema.index(
  { store: 1, weekStart: 1 },
  { unique: true }
)

module.exports = mongoose.model('PreviousWeekReview', previousWeekReviewSchema)
