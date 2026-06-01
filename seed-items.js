const mongoose = require('mongoose');
require('dotenv').config();

const Item = require('./models/Item');

async function seedItems() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Mongo connected ✅');

    const ids = ['FloorSpace'];

    for (let i = 1; i <= 108; i++) {
      ids.push(`FloorSpace${i}`);
    }

    const ops = ids.map(item_id => ({
      updateOne: {
        filter: { item_id },
        update: { $setOnInsert: { item_id } },
        upsert: true
      }
    }));

    await Item.bulkWrite(ops);
    console.log(`Seeded ${ids.length} item IDs ✅`);

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

seedItems();