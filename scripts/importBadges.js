const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const { Badge } = require('../backend/models/Badge');

// require('dotenv').config({ path: path.resolve(__dirname, `../.env.${process.env.NODE_ENV || 'dev'}`) });

// get dotenv path from .env file
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const BADGES_JSON_PATH = path.resolve(__dirname, '../seed/badges.json');
const MONGO_URI = process.env.BASE_URL;

const strip = ({ _id, createdAt, updatedAt, __v, ...rest }) => rest;

async function main() {
  if (!MONGO_URI) {
    console.error('Missing BASE_URL in environment variables.');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);

  const badgeCount = await Badge.countDocuments();
  if (badgeCount > 0) {
    console.log('Badge collection is not empty. No action taken.');
    await mongoose.disconnect();
    return;
  }

  let badgesData;
  try {
    badgesData = JSON.parse(fs.readFileSync(BADGES_JSON_PATH, 'utf-8'));
  } catch (err) {
    console.error('Failed to read or parse badges.json:', err);
    await mongoose.disconnect();
    process.exit(1);
  }

  badgesData = badgesData.map(badge => {
    const clean = strip(badge);
    if (Array.isArray(clean.options)) clean.options = clean.options.map(strip);
    return clean;
  });

  try {
    await Badge.insertMany(badgesData);
    console.log('Badges imported successfully.');
  } catch (err) {
    console.error('Failed to insert badges:', err);
  } finally {
    await mongoose.disconnect();
  }
}

main();
