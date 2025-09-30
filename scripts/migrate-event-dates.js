/**
 * Script to migrate existing events to include the eventDate field
 * Run this script once on the server to update all existing events
 */

const mongoose = require("mongoose");
const Event = require("../models/Event");
require("dotenv").config();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));
db.once("open", async () => {
  console.log("Connected to MongoDB");

  try {
    // Find all events
    const events = await Event.find({});
    console.log(`Found ${events.length} events to migrate`);

    let updated = 0;

    for (const event of events) {
      // Skip events that already have an eventDate set
      if (event.eventDate) {
        console.log(
          `Event ${event._id} already has eventDate: ${event.eventDate}`
        );
        continue;
      }

      // Determine the best date to use as eventDate
      let eventDate = null;

      // First check if the event has any eventDays with dates
      if (
        event.eventDays &&
        event.eventDays.length > 0 &&
        event.eventDays[0].date
      ) {
        eventDate = event.eventDays[0].date;
        console.log(
          `Using eventDays[0].date for event ${event._id}: ${eventDate}`
        );
      }
      // Otherwise, check if date isn't the same as createdAt
      else if (
        event.date &&
        event.createdAt &&
        new Date(event.date).toDateString() !==
          new Date(event.createdAt).toDateString()
      ) {
        eventDate = event.date;
        console.log(`Using date field for event ${event._id}: ${eventDate}`);
      }
      // Last resort, use the date field anyway
      else if (event.date) {
        eventDate = event.date;
        console.log(
          `Using date field (possible creation date) for event ${event._id}: ${eventDate}`
        );
      }

      // Update the event if we found a date to use
      if (eventDate) {
        event.eventDate = eventDate;
        await event.save();
        updated++;
      } else {
        console.warn(`No suitable date found for event ${event._id}`);
      }
    }

    console.log(`Migration complete. Updated ${updated} events.`);
  } catch (error) {
    console.error("Error during migration:", error);
  } finally {
    mongoose.connection.close();
  }
});
