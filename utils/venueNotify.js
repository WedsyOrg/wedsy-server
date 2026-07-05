/**
 * utils/venueNotify.js — MB-V2 P3 notification-mesh emitter.
 *
 * notify() writes one row to the mesh table and logs it. Delivery is LOG-ONLY:
 * no external channel (WhatsApp/SMS/email) is ever contacted here — that stays
 * gated for a future wiring (VENUE_NOTIFY_LOG_ONLY, default true). Persistence
 * of the mesh row can be turned off entirely with VENUE_NOTIFY_PERSIST=false
 * (kept on by default — the insert is cheap and the table is the point).
 *
 * Fire-and-forget: never throws to the caller, never blocks the response.
 */
const VenueNotification = require("../models/VenueNotification");

function notify({ venue, type, title, body, meta } = {}) {
  const logOnly = process.env.VENUE_NOTIFY_LOG_ONLY !== "false"; // default true
  console.log(
    `[venueNotify]${logOnly ? " (log-only)" : ""} type=${type} venue=${venue || "-"} title=${JSON.stringify(title || "")}`
  );
  if (process.env.VENUE_NOTIFY_PERSIST === "false") return;
  // Fire-and-forget — do not await in the request path.
  VenueNotification.create({
    venue: venue || undefined,
    type,
    title: title || "",
    body: body || "",
    channel: "log",
    meta: meta || {},
  }).catch((err) => console.warn(`[venueNotify] persist failed (ignored): ${err.message}`));
}

module.exports = { notify };
