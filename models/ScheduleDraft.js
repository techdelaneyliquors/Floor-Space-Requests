const mongoose = require('mongoose')

// A store's in-progress schedule from the Schedule page's "Save Progress"
// button: one per store, shared by its managers, and cleared once a
// schedule is submitted. The page reloads it when it next opens.

const scheduleDraftSchema = new mongoose.Schema({
  store: {
    type: String,
    required: true,
    trim: true,
    unique: true
  },

  // The page's full working state (JSON text, same shape as a submission's)
  builderStateJson: {
    type: String,
    required: true
  },

  // The week chosen under "Post this schedule", YYYY-MM-DD
  weekStart: String,

  // Set when the progress is a fix of a rejected week, so the rejection
  // reason comes back with it
  rejection: {
    weekStart: String,
    reason: String,
    rejectedBy: String,
    rejectedAt: Date
  },

  savedBy: {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    name: String
  },

  savedAt: Date
}, {
  timestamps: true
})

module.exports = mongoose.model(
  'ScheduleDraft',
  scheduleDraftSchema
)
