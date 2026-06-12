const express = require("express");
const router = express.Router();
const { getVenues, getVenueBySlug, updateVenue, createVenue } = require("../controllers/venue");
const { createEnquiry, createManualLead, getVenueEnquiries, updateEnquiry, importLeads, getImports } = require("../controllers/venueEnquiry");
const { saveAvailability, availabilityCheck } = require("../controllers/venueAvailability");
const { trackView } = require("../controllers/venueView");
const { refreshNearby } = require("../controllers/venueNearby");
const { refreshReviews } = require("../controllers/venueReviews");
const { generateLocationDescription } = require("../controllers/venueLocation");
const { getDashboardOverview } = require("../controllers/venueDashboard");
const { addInteraction, getInteractions } = require("../controllers/venueLeadInteraction");
const { bulkAction, bulkWhatsApp } = require("../controllers/venueBulk");
const { listTemplates, createTemplate, updateTemplate, deleteTemplate } = require("../controllers/venueTemplate");
const { listBookings, getBooking, createBooking, updateBooking } = require("../controllers/venueBooking");
const { createQuote, listQuotes, getQuote, updateQuote, quotePdf } = require("../controllers/venueQuote");
const { createFromBooking, listInvoices, getInvoice, addPayment, invoicePdf } = require("../controllers/venueInvoice");
const { summary: paymentsSummary } = require("../controllers/venuePayment");
const { getAnalytics } = require("../controllers/venueAnalytics");
const sheets = require("../controllers/venueSheetsSync");
const { listMembers, inviteMember, updateMember, getActivity } = require("../controllers/venueTeam");
const { createOnboardingRequest } = require("../controllers/venueOnboarding");
const { listRooms, addRoom, updateRoom, deleteRoom } = require("../controllers/venueRooms");
const { generateContract, listContracts, updateContract, sendContract, contractPdf, getAckContract, acknowledgeContract } = require("../controllers/venueContract");
const { createAllotments, listAllotments, updateAllotment, occupancy } = require("../controllers/venueAllotment");
const { listRunsheet, createItem: createRunsheetItem, updateItem: updateRunsheetItem, deleteItem: deleteRunsheetItem, reorderRunsheet } = require("../controllers/venueRunsheetCtl");
const { venueOwnerAuth } = require("../middlewares/venueOwnerAuth");
const { requireCapability, requireCapabilityOrAdmin } = require("../middlewares/venueRole");
const { enquiryIpLimiter, enquiryPhoneLimiter, publicReadLimiter } = require("../utils/venueEnquiryRateLimit");
const { adminOrVenueOwnerAuth } = require("../middlewares/adminOrVenueOwnerAuth");
const { optionalAdminAuth } = require("../middlewares/optionalAdminAuth");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

// Capability gating convention (integration ruling):
//   leads  → lead/booking/quote/invoice WRITES (manual, import POST, bulk POST,
//            bulk-whatsapp, PATCH enquiry, interaction POST, template writes,
//            booking/quote/invoice/payment writes)
//   open   → reads (venueOwnerAuth only): enquiries/imports/interactions/templates
//            list, bookings/quotes/invoices reads + PDFs, payments, analytics,
//            dashboard overview  [bookings/quotes/invoices reads + sheets routes are
//            NOT in the explicit ruling — left open under venueOwnerAuth; FLAGGED]
//   listing→ PUT /:slug (requireCapabilityOrAdmin)   team → team routes   availability → availability

router.get("/", optionalAdminAuth, getVenues);
// Admin-only: create a new venue (venue owners must NOT create venues).
router.post("/", CheckAdminLogin, createVenue);
// Public "list your venue" lead from the landing page — rate-limited + validated.
router.post("/onboarding-requests", publicReadLimiter, createOnboardingRequest);

// ── Phase 3.5 contracts: PUBLIC token-addressed acknowledgment (rate-limited,
//    no auth — the signed short-lived token is the credential) ──
router.get("/contract-ack/:token", publicReadLimiter, getAckContract);
router.post("/contract-ack/:token", publicReadLimiter, acknowledgeContract);
// Venue-owner dashboard home widgets (onboarding, verification, follow-ups).
router.get("/dashboard/overview", venueOwnerAuth, getDashboardOverview);
router.get("/:slug", getVenueBySlug);
// Listing edit: admins bypass; venue tokens need the "listing" capability.
router.put("/:slug", adminOrVenueOwnerAuth, requireCapabilityOrAdmin("listing"), updateVenue);
// Public enquiry submission — rate-limited per IP and per phone+venue (NOT capability-gated; public).
router.post("/:slug/enquiry", enquiryIpLimiter, enquiryPhoneLimiter, createEnquiry);
router.post("/:slug/enquiries", enquiryIpLimiter, enquiryPhoneLimiter, createEnquiry);
// Gated manual lead creation.
router.post("/:slug/enquiries/manual", venueOwnerAuth, requireCapability("leads"), createManualLead);
// CSV/Excel bulk import (write=leads) + import history (open read).
router.post("/:slug/enquiries/import", venueOwnerAuth, requireCapability("leads"), importLeads);
router.get("/:slug/enquiries/imports", venueOwnerAuth, getImports);
// Bulk actions over selected leads (literal "bulk" segments — before /:enquiryId).
router.post("/:slug/enquiries/bulk", venueOwnerAuth, requireCapability("leads"), bulkAction);
router.post("/:slug/enquiries/bulk-whatsapp", venueOwnerAuth, requireCapability("leads"), bulkWhatsApp);
router.get("/:slug/enquiries", venueOwnerAuth, getVenueEnquiries); // read: all roles
router.patch("/:slug/enquiries/:enquiryId", venueOwnerAuth, requireCapability("leads"), updateEnquiry);
// Per-lead communication log — write=leads, read open.
router.post("/:slug/enquiries/:enquiryId/interactions", venueOwnerAuth, requireCapability("leads"), addInteraction);
router.get("/:slug/enquiries/:enquiryId/interactions", venueOwnerAuth, getInteractions);
// Message templates — list open, writes=leads.
router.get("/:slug/templates", venueOwnerAuth, listTemplates);
router.post("/:slug/templates", venueOwnerAuth, requireCapability("leads"), createTemplate);
router.patch("/:slug/templates/:templateId", venueOwnerAuth, requireCapability("leads"), updateTemplate);
router.delete("/:slug/templates/:templateId", venueOwnerAuth, requireCapability("leads"), deleteTemplate);

// ── Phase 3: bookings (3.1) — reads open (FLAGGED: not in explicit ruling), writes=leads ──
router.get("/:slug/bookings", venueOwnerAuth, listBookings);
router.post("/:slug/bookings", venueOwnerAuth, requireCapability("leads"), createBooking);
router.get("/:slug/bookings/:bookingId", venueOwnerAuth, getBooking);
router.patch("/:slug/bookings/:bookingId", venueOwnerAuth, requireCapability("leads"), updateBooking);

// ── Phase 3: quotes (3.2) — reads/PDF open (FLAGGED), writes=leads ──
router.get("/:slug/quotes", venueOwnerAuth, listQuotes);
router.post("/:slug/quotes", venueOwnerAuth, requireCapability("leads"), createQuote);
router.get("/:slug/quotes/:quoteId/pdf", venueOwnerAuth, quotePdf);
router.get("/:slug/quotes/:quoteId", venueOwnerAuth, getQuote);
router.patch("/:slug/quotes/:quoteId", venueOwnerAuth, requireCapability("leads"), updateQuote);

// ── Phase 3: invoices (3.3) — reads/PDF open (FLAGGED), writes=leads ──
router.get("/:slug/invoices", venueOwnerAuth, listInvoices);
router.post("/:slug/invoices", venueOwnerAuth, requireCapability("leads"), createFromBooking);
router.get("/:slug/invoices/:invoiceId/pdf", venueOwnerAuth, invoicePdf);
router.get("/:slug/invoices/:invoiceId", venueOwnerAuth, getInvoice);
router.post("/:slug/invoices/:invoiceId/payments", venueOwnerAuth, requireCapability("leads"), addPayment);

// ── Phase 3.4: payments summary + Phase 4.1: analytics — open reads ──
router.get("/:slug/payments/summary", venueOwnerAuth, paymentsSummary);

// ── Phase 5 (PMS): rooms inventory (listing), allotments + runsheet (leads),
//    occupancy (open read) ──
router.get("/:slug/rooms", venueOwnerAuth, listRooms);
router.post("/:slug/rooms", venueOwnerAuth, requireCapability("listing"), addRoom);
router.patch("/:slug/rooms/:roomId", venueOwnerAuth, requireCapability("listing"), updateRoom);
router.delete("/:slug/rooms/:roomId", venueOwnerAuth, requireCapability("listing"), deleteRoom);

router.get("/:slug/bookings/:bookingId/allotments", venueOwnerAuth, listAllotments);
router.post("/:slug/bookings/:bookingId/allotments", venueOwnerAuth, requireCapability("leads"), createAllotments);
router.patch("/:slug/allotments/:allotmentId", venueOwnerAuth, requireCapability("leads"), updateAllotment);
router.get("/:slug/occupancy", venueOwnerAuth, occupancy);

router.get("/:slug/bookings/:bookingId/runsheet", venueOwnerAuth, listRunsheet);
router.post("/:slug/bookings/:bookingId/runsheet", venueOwnerAuth, requireCapability("leads"), createRunsheetItem);
router.post("/:slug/bookings/:bookingId/runsheet/reorder", venueOwnerAuth, requireCapability("leads"), reorderRunsheet);
router.patch("/:slug/runsheet/:itemId", venueOwnerAuth, requireCapability("leads"), updateRunsheetItem);
router.delete("/:slug/runsheet/:itemId", venueOwnerAuth, requireCapability("leads"), deleteRunsheetItem);

// ── Phase 3.5 contracts (booking surface -> leads capability) ──
router.get("/:slug/bookings/:bookingId/contracts", venueOwnerAuth, listContracts);
router.post("/:slug/bookings/:bookingId/contracts", venueOwnerAuth, requireCapability("leads"), generateContract);
router.patch("/:slug/contracts/:contractId", venueOwnerAuth, requireCapability("leads"), updateContract);
router.post("/:slug/contracts/:contractId/send", venueOwnerAuth, requireCapability("leads"), sendContract);
router.get("/:slug/contracts/:contractId/pdf", venueOwnerAuth, contractPdf);

router.get("/:slug/analytics", venueOwnerAuth, getAnalytics);

// Google Sheets integration — ALL routes require the "leads" capability (ruling),
// since the sync brings leads in. callback is public — authorized by the signed
// OAuth state (Google's redirect carries no Bearer token).
router.get("/:slug/integrations/google-sheets", venueOwnerAuth, requireCapability("leads"), sheets.getIntegration);
router.get("/:slug/integrations/google-sheets/connect", venueOwnerAuth, requireCapability("leads"), sheets.connect);
// Public OAuth redirect target — authorized by the signed `state` JWT; add a
// per-IP rate limiter on top so the unauthenticated endpoint can't be flooded.
router.get("/:slug/integrations/google-sheets/callback", publicReadLimiter, sheets.callback);
router.post("/:slug/integrations/google-sheets/disconnect", venueOwnerAuth, requireCapability("leads"), sheets.disconnect);
router.get("/:slug/integrations/google-sheets/sheets", venueOwnerAuth, requireCapability("leads"), sheets.listSheets);
router.post("/:slug/integrations/google-sheets/mapping", venueOwnerAuth, requireCapability("leads"), sheets.saveMapping);
router.post("/:slug/integrations/google-sheets/sync", venueOwnerAuth, requireCapability("leads"), sheets.syncNow);

// ── Team members — team capability ──
router.get("/:slug/team", venueOwnerAuth, requireCapability("team"), listMembers);
router.post("/:slug/team", venueOwnerAuth, requireCapability("team"), inviteMember);
router.get("/:slug/team/activity", venueOwnerAuth, requireCapability("team"), getActivity);
router.patch("/:slug/team/:memberId", venueOwnerAuth, requireCapability("team"), updateMember);

// Availability — availability capability.
router.post("/:slug/availability", venueOwnerAuth, requireCapability("availability"), saveAvailability);
// Public view beacon (fire-and-forget, rate-limited, no PII) + single-date availability read.
router.post("/:slug/view", publicReadLimiter, trackView);
router.get("/:slug/availability-check", publicReadLimiter, availabilityCheck);
// Pre-existing public enrichment routes — now rate-limited per IP. The last one
// invokes the Anthropic API unauthenticated (cost-abuse surface), so the limiter
// matters most there (it also short-circuits to a cached result per venue).
router.post("/:slug/nearby", publicReadLimiter, refreshNearby);
router.post("/:slug/reviews", publicReadLimiter, refreshReviews);
router.post("/:slug/generate-location-description", publicReadLimiter, generateLocationDescription);

module.exports = router;
