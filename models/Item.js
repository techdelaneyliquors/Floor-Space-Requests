const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema(
  {
    item_id: {
      type: String,
      required: true,
      unique: true,
      trim: true
    }
  },
  {
    versionKey: false
  }
);

module.exports = mongoose.model('Item', itemSchema);