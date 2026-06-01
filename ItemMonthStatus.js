const mongoose = require('mongoose');

const itemMonthStatusSchema = new mongoose.Schema(
  {
    map_id: {
      type: String,
      required: true,
      trim: true
    },
    item_id: {
      type: String,
      required: true,
      trim: true
    },
    month: {
      type: String,
      required: true,
      trim: true
      // format like "2026-05"
    },
    status: {
      type: String,
      required: true,
      enum: ['reserved'],
      default: 'reserved'
    },
    updated_at: {
      type: Date,
      default: Date.now
    }
  },
  {
    versionKey: false
  }
);

// equivalent to PRIMARY KEY (map_id, item_id, month)
itemMonthStatusSchema.index(
  { map_id: 1, item_id: 1, month: 1 },
  { unique: true }
);

// auto-refresh updated_at on save
itemMonthStatusSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

module.exports = mongoose.model('ItemMonthStatus', itemMonthStatusSchema);
``