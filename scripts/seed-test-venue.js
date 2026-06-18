/**
 * scripts/seed-test-venue.js
 *
 * Idempotent LOCAL seed for the venue test harness.
 * Creates / resets one published test venue ("Test Palace", slug "test-palace"),
 * one VenueOwner (phone 9999999999), ~20 VenueEnquiry leads spread across all 8
 * stages and all sources with a mix of follow-up dates (overdue / today / future),
 * and a few VenueLeadInteractions.
 *
 * SAFETY: hard-refuses to run unless DATABASE_URL points at a local Mongo host.
 * Usage: node scripts/seed-test-venue.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Venue = require("../models/Venue");
const VenueOwner = require("../models/VenueOwner");
const VenueEnquiry = require("../models/VenueEnquiry");
const VenueLeadInteraction = require("../models/VenueLeadInteraction");
// Phase 3 collections (optional — only present on Phase 3+ branches).
let VenueBooking, VenueQuote, VenueInvoice, VenueMessageTemplate, VenueTeamMember, computeTotals;
try { VenueBooking = require("../models/VenueBooking"); } catch (_) {}
try { VenueQuote = require("../models/VenueQuote"); } catch (_) {}
try { VenueInvoice = require("../models/VenueInvoice"); } catch (_) {}
try { VenueMessageTemplate = require("../models/VenueMessageTemplate"); } catch (_) {}
try { VenueTeamMember = require("../models/VenueTeamMember"); } catch (_) {}
try { ({ computeTotals } = require("../utils/venueMoney")); } catch (_) {}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

// Stable identifiers other harness scripts (e2e) rely on.
const VENUE_SLUG = "test-palace";
const OWNER_PHONE = "9999999999";

function assertLocalMongo() {
  const url = process.env.DATABASE_URL || "";
  let host;
  try {
    host = new URL(url).hostname;
  } catch (e) {
    throw new Error(`Cannot parse DATABASE_URL to verify host: ${e.message}`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to seed: DATABASE_URL host "${host}" is not local. ` +
        `This script only runs against a local dev Mongo (127.0.0.1/localhost).`
    );
  }
  return host;
}

// Date helpers relative to "now" — script run time, not a fixed value.
const DAY = 24 * 60 * 60 * 1000;
const now = new Date();
function daysFromNow(n) {
  return new Date(now.getTime() + n * DAY);
}
function todayAt(hour) {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  return d;
}

// Deterministic 20-lead dataset. fu = followUpDate intent: "overdue" | "today" | "future" | null
// Stages: new x4, contacted x3, site_visit_scheduled x2, site_visit_done x3,
//         proposal_sent x2, negotiating x2, booked x2, lost x2  => 20 total.
const LEAD_SPECS = [
  { coupleName: "Aarav & Diya",      couplePhone: "9810000001", source: "wedsy",     stage: "new",                  fu: "overdue", estimatedValue: 450000 },
  { coupleName: "Vivaan & Anika",    couplePhone: "9810000002", source: "instagram", stage: "new",                  fu: "today",   estimatedValue: 520000 },
  { coupleName: "Aditya & Ira",      couplePhone: "9810000003", source: "referral",  stage: "new",                  fu: "future",  estimatedValue: 380000 },
  { coupleName: "Reyansh & Myra",    couplePhone: "9810000004", source: "walk_in",   stage: "new",                  fu: null,      estimatedValue: 600000 },
  { coupleName: "Arjun & Saanvi",    couplePhone: "9810000005", source: "justdial",  stage: "contacted",            fu: "overdue", estimatedValue: 710000 },
  { coupleName: "Vihaan & Aadhya",   couplePhone: "9810000006", source: "wedmegood", stage: "contacted",            fu: "today",   estimatedValue: 480000 },
  { coupleName: "Krishna & Pari",    couplePhone: "9810000007", source: "google",    stage: "contacted",            fu: "future",  estimatedValue: 550000 },
  { coupleName: "Ishaan & Anaya",    couplePhone: "9810000008", source: "other",     stage: "site_visit_scheduled", fu: "today",   estimatedValue: 640000 },
  { coupleName: "Shaurya & Aarohi",  couplePhone: "9810000009", source: "wedsy",     stage: "site_visit_scheduled", fu: "future",  estimatedValue: 720000 },
  { coupleName: "Atharv & Kiara",    couplePhone: "9810000010", source: "instagram", stage: "site_visit_done",      fu: "overdue", estimatedValue: 900000 },
  { coupleName: "Advik & Navya",     couplePhone: "9810000011", source: "referral",  stage: "site_visit_done",      fu: "today",   estimatedValue: 810000 },
  { coupleName: "Kabir & Riya",      couplePhone: "9810000012", source: "walk_in",   stage: "site_visit_done",      fu: "future",  estimatedValue: 770000 },
  { coupleName: "Aryan & Sara",      couplePhone: "9810000013", source: "justdial",  stage: "proposal_sent",        fu: "overdue", estimatedValue: 1000000 },
  { coupleName: "Dhruv & Aisha",     couplePhone: "9810000014", source: "wedmegood", stage: "proposal_sent",        fu: "future",  estimatedValue: 950000 },
  { coupleName: "Veer & Tara",       couplePhone: "9810000015", source: "google",    stage: "negotiating",          fu: "today",   estimatedValue: 1100000 },
  { coupleName: "Rudra & Mishka",    couplePhone: "9810000016", source: "other",     stage: "negotiating",          fu: "future",  estimatedValue: 1250000 },
  { coupleName: "Shivansh & Zara",   couplePhone: "9810000017", source: "wedsy",     stage: "booked",               fu: null,      estimatedValue: 1300000 },
  { coupleName: "Ayaan & Anvi",      couplePhone: "9810000018", source: "instagram", stage: "booked",               fu: null,      estimatedValue: 1450000 },
  { coupleName: "Yuvaan & Siya",     couplePhone: "9810000019", source: "referral",  stage: "lost",                 fu: null,      estimatedValue: 500000, lostReason: "too_expensive" },
  { coupleName: "Reyaan & Pihu",     couplePhone: "9810000020", source: "walk_in",   stage: "lost",                 fu: null,      estimatedValue: 470000, lostReason: "chose_competitor" },
];

function resolveFollowUp(intent) {
  if (intent === "overdue") return daysFromNow(-3);
  if (intent === "today") return todayAt(11);
  if (intent === "future") return daysFromNow(7);
  return null;
}

async function run() {
  const host = assertLocalMongo();
  await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  console.log(`[seed] connected to local Mongo @ ${host}`);

  // 1. Venue (upsert by slug). Set a handful of profile fields so the dashboard
  //    onboarding/overview endpoint returns a meaningful shape.
  let venue = await Venue.findOne({ slug: VENUE_SLUG });
  const venueDefaults = {
    name: "Test Palace",
    slug: VENUE_SLUG,
    status: "published",
    city: "Bangalore",
    venueType: "banquet_hall",
    contact: { primaryName: "Test Owner", primaryPhone: OWNER_PHONE, whatsappPhone: OWNER_PHONE, email: "owner@test-palace.local" },
    pricing: { currency: "INR", perPlate: { veg: 1500, nonVeg: 1900 }, tiers: [{ hours: 12, price: 250000 }] },
    coverPhoto: "https://example.local/test-palace-cover.jpg",
    // Phase 4.2: deterministic Google-rating fixtures (no live fetch in suites).
    googlePlaceId: "test-place-id-palace",
    googleRating: 4.6,
    googleReviewCount: 132,
    googleReviews: [{ authorName: "Asha", rating: 5, text: "Beautiful venue!", time: 1700000000 }],
    googleReviewsRefreshedAt: new Date(),
  };
  if (!venue) {
    venue = await Venue.create(venueDefaults);
    console.log(`[seed] created venue ${venue.slug} (${venue._id})`);
  } else {
    Object.assign(venue, venueDefaults);
    await venue.save();
    console.log(`[seed] reset venue ${venue.slug} (${venue._id})`);
  }

  // 2. Owner (upsert by phone). role owner, phone-verified so dashboard treats it as a real account.
  let owner = await VenueOwner.findOne({ phone: OWNER_PHONE });
  const ownerDefaults = {
    name: "Test Owner",
    phone: OWNER_PHONE,
    email: "owner@test-palace.local",
    role: "owner",
    venueId: venue._id,
    verificationStatus: "phone_verified",
    isActive: true,
  };
  if (!owner) {
    owner = await VenueOwner.create(ownerDefaults);
    console.log(`[seed] created owner ${owner.phone} (${owner._id})`);
  } else {
    Object.assign(owner, ownerDefaults);
    await owner.save();
    console.log(`[seed] reset owner ${owner.phone} (${owner._id})`);
  }

  // 3. Reset enquiries + interactions for this venue (idempotent rebuild).
  await VenueLeadInteraction.deleteMany({ venue: venue._id });
  await VenueEnquiry.deleteMany({ venueId: venue._id });
  // Clear Phase 3 collections too (keeps invoice sequences + revenue math deterministic).
  if (VenueBooking) await VenueBooking.deleteMany({ venue: venue._id });
  if (VenueQuote) await VenueQuote.deleteMany({ venue: venue._id });
  if (VenueInvoice) await VenueInvoice.deleteMany({ venue: venue._id });

  const enquiries = [];
  for (const spec of LEAD_SPECS) {
    const fu = resolveFollowUp(spec.fu);
    const doc = await VenueEnquiry.create({
      venueId: venue._id,
      coupleName: spec.coupleName,
      couplePhone: spec.couplePhone,
      name: spec.coupleName,
      phone: spec.couplePhone,
      email: `${spec.couplePhone}@leads.test-palace.local`,
      eventDate: daysFromNow(60),
      guestCount: 300,
      source: spec.source,
      stage: spec.stage,
      estimatedValue: spec.estimatedValue,
      lostReason: spec.lostReason || "",
      followUpDate: fu,
      activities: [{ type: "created", description: "Seeded lead", timestamp: now }],
    });
    enquiries.push(doc);
  }
  console.log(`[seed] created ${enquiries.length} enquiries across all 8 stages / 8 sources`);

  // 4. A few interactions on the first three leads.
  const interactionSeeds = [
    { idx: 0, type: "enquiry", note: "Inbound enquiry from website" },
    { idx: 0, type: "call", note: "Called couple, discussed dates" },
    { idx: 1, type: "whatsapp", note: "Sent brochure on WhatsApp" },
    { idx: 4, type: "site_visit", note: "Site visit scheduled for next week" },
  ];
  for (const s of interactionSeeds) {
    await VenueLeadInteraction.create({
      enquiry: enquiries[s.idx]._id,
      venue: venue._id,
      type: s.type,
      note: s.note,
      createdBy: s.type === "enquiry" ? null : owner._id,
    });
  }
  console.log(`[seed] created ${interactionSeeds.length} interactions`);

  // 5. Templates (Test Palace) — safe for the e2e (it creates/deletes its own).
  if (VenueMessageTemplate) {
    await VenueMessageTemplate.deleteMany({ venue: venue._id });
    await VenueMessageTemplate.create([
      { venue: venue._id, name: "Site visit invite", body: "Hi {{name}}, we'd love to host you for a site visit at Test Palace. When works?", createdBy: owner._id },
      { venue: venue._id, name: "Quote follow-up", body: "Hi {{name}}, following up on your quote — happy to answer any questions!", createdBy: owner._id },
    ]);
    console.log("[seed] 2 message templates (test-palace)");
  }

  // 6. Multi-identity login + team members in all 5 roles (team-derived branches).
  //    Phone 8888888888 is BOTH an OWNER of a second venue and an ACTIVE MEMBER of
  //    Test Palace → 2 identities. 9999999999 stays single.
  let venue2 = null;
  if (VenueTeamMember) {
    const MULTI_PHONE = "8888888888";
    venue2 = await Venue.findOne({ slug: "test-palace-two" });
    const v2 = { name: "Test Palace Two", slug: "test-palace-two", status: "verified", city: "Bangalore", venueType: "banquet_hall", invoicePrefix: "TP2-", gstin: "29ABCDE1234F1Z5", pan: "ABCDE1234F" };
    if (!venue2) venue2 = await Venue.create(v2);
    else { Object.assign(venue2, v2); await venue2.save(); }

    let owner2 = await VenueOwner.findOne({ phone: MULTI_PHONE });
    const o2 = { name: "Multi Identity", phone: MULTI_PHONE, role: "owner", venueId: venue2._id, verificationStatus: "phone_verified", isActive: true };
    if (!owner2) owner2 = await VenueOwner.create(o2);
    else { Object.assign(owner2, o2); await owner2.save(); }

    // Reset + seed team members across all 5 roles on Test Palace (8888888888 is the
    // shared "sales" member that drives the multi-identity scenario).
    await VenueTeamMember.deleteMany({ venueId: venue._id });
    const teamSpecs = [
      { phone: MULTI_PHONE, name: "Multi Identity", role: "sales" },
      { phone: "9700000001", name: "Maya Manager", role: "manager" },
      { phone: "9700000002", name: "Lina Listing", role: "listing_manager" },
      { phone: "9700000003", name: "Mira Marketing", role: "marketing" },
      { phone: "9700000004", name: "Otis Owner", role: "owner" },
    ];
    for (const t of teamSpecs) {
      await VenueTeamMember.create({ venueId: venue._id, ownerId: owner._id, name: t.name, phone: t.phone, role: t.role, isActive: true });
    }
    console.log(`[seed] ${teamSpecs.length} team members (all 5 roles) + multi-identity 8888888888`);
  }

  // 7. Rich Phase-3 demo data on Test Palace Two (kept OFF test-palace so the e2e
  //    money math on test-palace stays deterministic): bookings in all 4 statuses,
  //    quotes in 2 versions, invoices paid / partially_paid / unpaid.
  if (venue2 && VenueBooking && VenueQuote && VenueInvoice && computeTotals) {
    await VenueBooking.deleteMany({ venue: venue2._id });
    await VenueQuote.deleteMany({ venue: venue2._id });
    await VenueInvoice.deleteMany({ venue: venue2._id });
    await VenueEnquiry.deleteMany({ venueId: venue2._id });

    const statuses = ["confirmed", "in_progress", "completed", "cancelled"];
    const bookings = [];
    for (let i = 0; i < statuses.length; i++) {
      const enq = await VenueEnquiry.create({
        venueId: venue2._id, coupleName: `Demo Couple ${i + 1}`, couplePhone: `9760000${i}01`,
        name: `Demo Couple ${i + 1}`, phone: `9760000${i}01`, stage: "booked", source: "wedsy",
        estimatedValue: 500000 + i * 100000, eventDate: daysFromNow(40 + i * 10), guestCount: 250,
      });
      const b = await VenueBooking.create({
        venue: venue2._id, enquiry: enq._id, coupleName: enq.coupleName, couplePhone: enq.couplePhone,
        days: [{ date: daysFromNow(40 + i * 10), eventType: "Wedding", guestCount: 250, spaces: ["Main Lawn"] }],
        totalValue: 500000 + i * 100000, status: statuses[i],
        paymentSchedule: [
          { label: "Advance", dueDate: daysFromNow(-5), amount: 150000 },
          { label: "Balance", dueDate: daysFromNow(30), amount: (500000 + i * 100000) - 150000 },
        ],
        createdBy: owner._id,
      });
      bookings.push(b);
    }
    console.log(`[seed] 4 bookings (all statuses) on test-palace-two`);

    // Quotes in 2 versions for the first booking's enquiry (v1 superseded, v2 sent).
    const lineItems = [{ label: "Venue hire", category: "venue_hire", qty: 1, unitPrice: 400000 }, { label: "Catering", category: "catering", qty: 250, unitPrice: 1500, perDay: false }];
    const t1 = computeTotals(lineItems, 18, 0);
    await VenueQuote.create({ venue: venue2._id, enquiry: bookings[0].enquiry, version: 1, lineItems, gstPercent: 18, discount: 0, totals: t1, status: "superseded" });
    const t2 = computeTotals(lineItems, 18, 25000);
    await VenueQuote.create({ venue: venue2._id, enquiry: bookings[0].enquiry, version: 2, lineItems, gstPercent: 18, discount: 25000, totals: t2, status: "sent" });
    console.log(`[seed] 2 quote versions on test-palace-two`);

    // Invoices: paid / partially_paid / unpaid, with auto-incrementing numbers.
    const prefix = venue2.invoicePrefix || "INV-";
    const invSpecs = [
      { booking: bookings[0], kind: "advance", unit: 200000, pay: 236000, status: "paid" },        // 200000+18% = 236000 fully paid
      { booking: bookings[1], kind: "advance", unit: 300000, pay: 150000, status: "partially_paid" },
      { booking: bookings[2], kind: "final", unit: 400000, pay: 0, status: "unpaid" },
    ];
    for (let i = 0; i < invSpecs.length; i++) {
      const s = invSpecs[i];
      const items = [{ label: "Venue booking", category: "venue_hire", qty: 1, unitPrice: s.unit }];
      const totals = computeTotals(items, 18, 0);
      const payments = s.pay > 0 ? [{ date: daysFromNow(-2), amount: s.pay, mode: "bank_transfer", note: "Seed payment" }] : [];
      await VenueInvoice.create({
        venue: venue2._id, booking: s.booking._id, invoiceNumber: `${prefix}${String(i + 1).padStart(4, "0")}`,
        seq: i + 1, kind: s.kind, lineItems: items, gstPercent: 18, discount: 0, totals, status: s.status, payments,
      });
    }
    console.log(`[seed] 3 invoices (paid / partial / unpaid) on test-palace-two`);
  }

  console.log("[seed] DONE");
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("[seed] FAILED:", err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
