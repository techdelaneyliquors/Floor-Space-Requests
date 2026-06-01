const mongoose = require('mongoose');

const itemRequestSchema = new mongoose.Schema(
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
    user: {
      type: String,
      required: true,
      trim: true
    },
    brand: {
      type: String,
      required: true,
      trim: true
    },
    products: {
      type: String,
      required: true,
      trim: true
    },
    status: {
      type: String,
      required: true,
      enum: ['requested', 'reserved', 'rejected'],
      default: 'requested'
    },
    created_at: {
      type: Date,
      default: Date.now
    }
  },
  {
    versionKey: false
  }
);

// useful query indexes
itemRequestSchema.index({ map_id: 1, month: 1, status: 1 });
itemRequestSchema.index({ user: 1, created_at: -1 });
itemRequestSchema.index({ item_id: 1, month: 1, map_id: 1 });

module.exports = mongoose.model('ItemRequest', itemRequestSchema);