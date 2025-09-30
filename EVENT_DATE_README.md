# Event Date Migration

This project has been updated to better handle event dates. A new field `eventDate` has been added to the Event model to explicitly store the actual date of the event.

## Changes Made

1. Added `eventDate` field to the Event model
2. Updated `CreateNew` function in event controller to explicitly set the `eventDate` field
3. Enhanced date handling utilities to prioritize the `eventDate` field
4. Created a migration script to update existing events with the correct `eventDate` field
5. Updated API responses to always include the `eventDate` field

## Running the Migration Script

To update all existing events with the correct `eventDate` field, run the migration script:

```bash
cd wedsy-server
node scripts/migrate-event-dates.js
```

This will add the `eventDate` field to all existing events based on the best available date information.

## Technical Details

The date handling logic now follows this priority order:

1. Use `eventDate` field if available (highest priority)
2. Use `eventDays[0].date` if available and `date` appears to be a creation date
3. Use `date` field if it doesn't match the creation date
4. Fallback to `date` field even if it might be the creation date
5. Fallback to `createdAt` as last resort

This ensures that events are always displayed with their actual event date rather than their creation date, and events are sorted correctly based on when they will occur rather than when they were created.
