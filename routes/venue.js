const express = require("express");
const router = express.Router();
const { getVenues, getVenueBySlug, updateVenue, createVenue } = require("../controllers/venue");
const { createEnquiry, createManualLead, getVenueEnquiries, getEnquiryById, deleteEnquiry, checkEnquiryExists, updateEnquiry, importLeads, getImports } = require("../controllers/venueEnquiry");
const { saveAvailability, availabilityCheck } = require("../controllers/venueAvailability");
const { trackView } = require("../controllers/venueView");
const { refreshNearby } = require("../controllers/venueNearby");
const { refreshReviews } = require("../controllers/venueReviews");
const { generateLocationDescription } = require("../controllers/venueLocation");
const { getDashboardOverview } = require("../controllers/venueDashboard");
const { addInteraction, getInteractions, quickLog } = require("../controllers/venueLeadInteraction");
const { bulkAction, bulkWhatsApp } = require("../controllers/venueBulk");
const tasks = require("../controllers/venueTask");
const { getCrmOverview } = require("../controllers/venueCrmDashboard");
const { getDemandMap } = require("../controllers/venueCrmDates");
const { getCrmSettings, updateCrmSettings } = require("../controllers/venueCrmSettings");
const { listTemplates, createTemplate, updateTemplate, deleteTemplate } = require("../controllers/venueTemplate");
const { listBookings, getBooking, createBooking, updateBooking } = require("../controllers/venueBooking");
const { createQuote, listQuotes, getQuote, updateQuote, confirmBookingFromQuote, quotePdf } = require("../controllers/venueQuote");
const { createFromBooking, listInvoices, getInvoice, addPayment, approvePayment, rejectPayment, invoicePdf } = require("../controllers/venueInvoice");
const { summary: paymentsSummary } = require("../controllers/venuePayment");
const { getAnalytics } = require("../controllers/venueAnalytics");
const { getCompetitive } = require("../controllers/venueCompetitive");
const sheets = require("../controllers/venueSheetsSync");
const { listMembers, listAssignableMembers, inviteMember, updateMember, setMemberPassword, getActivity } = require("../controllers/venueTeam");
const roles = require("../controllers/venueRoles");
const cal = require("../controllers/venueCalendar");
const docs = require("../controllers/venueDocs");
const checkin = require("../controllers/venueCheckin");
const activityFeed = require("../controllers/venueActivityFeed");
const siteVisits = require("../controllers/venueSiteVisits"); // MB-V2 P1 owner side of planner walk-throughs
const { createOnboardingRequest } = require("../controllers/venueOnboarding");
const { listRooms, addRoom, updateRoom, deleteRoom } = require("../controllers/venueRooms");
const { generateContract, listContracts, updateContract, sendContract, contractPdf, getAckContract, acknowledgeContract } = require("../controllers/venueContract");
const { createAllotments, listAllotments, updateAllotment, occupancy } = require("../controllers/venueAllotment");
const { listRunsheet, createItem: createRunsheetItem, updateItem: updateRunsheetItem, deleteItem: deleteRunsheetItem, reorderRunsheet } = require("../controllers/venueRunsheetCtl");
const { venueOwnerAuth } = require("../middlewares/venueOwnerAuth");
const { requireCapability, requireCapabilityOrAdmin } = require("../middlewares/venueRole");
const { enquiryIpLimiter, enquiryPhoneLimiter, publicReadLimiter, reviewsRefreshLimiter } = require("../utils/venueEnquiryRateLimit");
const { getReviews, refreshOwnerReviews } = require("../controllers/venueOwnerReviews");
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
// D8 doc acceptance (quotes/bills) — same typed-token + rate-limit pattern.
router.get("/doc-ack/:token", publicReadLimiter, docs.getAckDoc);
router.post("/doc-ack/:token", publicReadLimiter, docs.acceptDoc);
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
// Duplicate-phone soft-warn lookup for the add-lead modal (open read).
router.get("/:slug/enquiries/exists", venueOwnerAuth, checkEnquiryExists);
// Bulk actions over selected leads (literal "bulk" segments — before /:enquiryId).
router.post("/:slug/enquiries/bulk", venueOwnerAuth, requireCapability("leads"), bulkAction);
router.post("/:slug/enquiries/bulk-whatsapp", venueOwnerAuth, requireCapability("leads"), bulkWhatsApp);
router.get("/:slug/enquiries", venueOwnerAuth, getVenueEnquiries); // read: all roles (server-side scoped when no leads_view_all)
// Single-lead read — SERVER-SIDE scoped: a member without leads_view_all cannot
// read another member's lead by direct id (declared after the literal
// /enquiries/{imports,exists,bulk,...} segments so those still match first).
router.get("/:slug/enquiries/:enquiryId", venueOwnerAuth, getEnquiryById);
router.patch("/:slug/enquiries/:enquiryId", venueOwnerAuth, requireCapability("leads"), updateEnquiry);
// Soft-delete a lead — leads_delete (Owner only by default). Scoped resolve inside.
router.delete("/:slug/enquiries/:enquiryId", venueOwnerAuth, requireCapability("leads_delete"), deleteEnquiry);
// Per-lead communication log — write=leads, read open.
router.post("/:slug/enquiries/:enquiryId/interactions", venueOwnerAuth, requireCapability("leads"), addInteraction);
router.get("/:slug/enquiries/:enquiryId/interactions", venueOwnerAuth, getInteractions);
// S0e quick-log: one-tap touch that auto-advances stage + captures next follow-up.
router.post("/:slug/enquiries/:enquiryId/quick-log", venueOwnerAuth, requireCapability("leads"), quickLog);

// ── MB-CRM S4: CRM dashboard overview (my-day, real alerts, proof) ──
router.get("/:slug/crm/overview", venueOwnerAuth, getCrmOverview);
// ── MB-CRM S6: demand map (contested / held-expiring / booked / open) ──
router.get("/:slug/crm/dates", venueOwnerAuth, getDemandMap);
// ── MB-CRM S7: owner-tunable CRM settings (auto-assign) — team capability ──
router.get("/:slug/crm/settings", venueOwnerAuth, requireCapability("team"), getCrmSettings);
router.patch("/:slug/crm/settings", venueOwnerAuth, requireCapability("team"), updateCrmSettings);

// ── MB-CRM S0c: CRM tasks (standalone or lead-linked) ──
router.get("/:slug/tasks", venueOwnerAuth, tasks.listTasks);
router.post("/:slug/tasks", venueOwnerAuth, tasks.createTask);
router.patch("/:slug/tasks/:taskId", venueOwnerAuth, tasks.updateTask);
router.post("/:slug/tasks/:taskId/complete", venueOwnerAuth, tasks.completeTask);
router.post("/:slug/tasks/:taskId/reopen", venueOwnerAuth, tasks.reopenTask);
router.delete("/:slug/tasks/:taskId", venueOwnerAuth, tasks.deleteTask);
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
// "Quote accepted -> confirm booking" owner action (D8 review add).
router.post("/:slug/quotes/:quoteId/confirm-booking", venueOwnerAuth, requireCapability("leads"), confirmBookingFromQuote);

// ── Phase 3: invoices (3.3) — reads/PDF open (FLAGGED), writes=leads ──
router.get("/:slug/invoices", venueOwnerAuth, listInvoices);
router.post("/:slug/invoices", venueOwnerAuth, requireCapability("leads"), createFromBooking);
router.get("/:slug/invoices/:invoiceId/pdf", venueOwnerAuth, invoicePdf);
router.get("/:slug/invoices/:invoiceId", venueOwnerAuth, getInvoice);
// D7: recording money is a bookings_money capability (alias-compatible with
// legacy "billing"); owner approval decisions are owner-gated in-controller.
router.post("/:slug/invoices/:invoiceId/payments", venueOwnerAuth, requireCapability("bookings_money"), addPayment);
router.post("/:slug/invoices/:invoiceId/payments/:paymentId/approve", venueOwnerAuth, requireCapability("bookings_money"), approvePayment);
router.post("/:slug/invoices/:invoiceId/payments/:paymentId/reject", venueOwnerAuth, requireCapability("bookings_money"), rejectPayment);

// ── D8 document engine: templates + bills (documents capability) ──
router.get("/:slug/doc-templates", venueOwnerAuth, requireCapability("documents"), docs.listTemplates);
router.post("/:slug/doc-templates", venueOwnerAuth, requireCapability("documents"), docs.createTemplate);
router.patch("/:slug/doc-templates/:templateId", venueOwnerAuth, requireCapability("documents"), docs.updateTemplate);
router.delete("/:slug/doc-templates/:templateId", venueOwnerAuth, requireCapability("documents"), docs.deleteTemplate);
router.get("/:slug/bills", venueOwnerAuth, docs.listBills);
router.post("/:slug/bills", venueOwnerAuth, requireCapability("documents"), docs.createBill);
router.get("/:slug/bills/:billId/pdf", venueOwnerAuth, docs.billPdf);
router.patch("/:slug/bills/:billId", venueOwnerAuth, requireCapability("documents"), docs.updateBill);
router.post("/:slug/bills/:billId/send", venueOwnerAuth, requireCapability("documents"), docs.sendBill);
router.post("/:slug/bills/:billId/convert", venueOwnerAuth, requireCapability("documents"), docs.convertBill);
router.post("/:slug/quotes/:quoteId/send-ack", venueOwnerAuth, requireCapability("documents"), docs.sendQuoteAck);
// E3x: venue-level default for the per-document whiteLabel flag.
router.patch("/:slug/documents/settings", venueOwnerAuth, requireCapability("documents"), docs.updateDocSettings);

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

// ── D6 per-wedding room workflow — rooms_checkin capability (tablet flow) ──
router.post("/:slug/allotments/:allotmentId/check-in", venueOwnerAuth, requireCapability("rooms_checkin"), checkin.checkInAllotment);
router.post("/:slug/allotments/:allotmentId/check-out", venueOwnerAuth, requireCapability("rooms_checkin"), checkin.checkOutAllotment);
router.get("/:slug/allotments/:allotmentId/settlement-slip", venueOwnerAuth, checkin.settlementSlip);
router.post("/:slug/allotments/:allotmentId/archive", venueOwnerAuth, requireCapability("rooms_checkin"), checkin.archiveAllotment);

// ── D10 activity spine — owner-side read of their own trail (no write route
//    exists; the model enforces append-only) ──
router.get("/:slug/activity", venueOwnerAuth, activityFeed.listActivity);
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
// Phase 4.3 competitor insights — venue vs anonymized zone-cohort (24h cache).
router.get("/:slug/competitive", venueOwnerAuth, getCompetitive);

// ── Phase 4.2 reviews: owner-facing display/monitor (24h venue-doc cache);
//    manual refresh is rate-limited to protect the Places quota ──
router.get("/:slug/reviews", venueOwnerAuth, getReviews);
router.post("/:slug/reviews/refresh", venueOwnerAuth, reviewsRefreshLimiter, refreshOwnerReviews);

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
// Lightweight assignable-member roster for the CRM Assign-To dropdown — leads
// capability (declared BEFORE the param-free /team so it is not shadowed).
router.get("/:slug/team/assignable", venueOwnerAuth, requireCapability("leads"), listAssignableMembers);
router.get("/:slug/team", venueOwnerAuth, requireCapability("team"), listMembers);
router.post("/:slug/team", venueOwnerAuth, requireCapability("team"), inviteMember);
router.get("/:slug/team/activity", venueOwnerAuth, requireCapability("team"), getActivity);
router.patch("/:slug/team/:memberId", venueOwnerAuth, requireCapability("team"), updateMember);
// Password set/reset is additionally owner-gated inside the controller (D5:
// owner is king — team capability alone can't rotate credentials).
router.post("/:slug/team/:memberId/password", venueOwnerAuth, requireCapability("team"), setMemberPassword);

// ── RBAC v2 roles (owner-editable capability bundles) — team capability ──
router.get("/:slug/roles", venueOwnerAuth, requireCapability("team"), roles.listRoles);
router.post("/:slug/roles", venueOwnerAuth, requireCapability("team"), roles.createRole);
router.patch("/:slug/roles/:roleId", venueOwnerAuth, requireCapability("team"), roles.updateRole);
router.delete("/:slug/roles/:roleId", venueOwnerAuth, requireCapability("team"), roles.deleteRole);

// ── MB-V2 P1: planner site visits, owner side (leads capability) ──
router.get("/:slug/site-visits", venueOwnerAuth, requireCapability("leads"), siteVisits.listOwnSiteVisits);
router.patch("/:slug/site-visits/:visitId", venueOwnerAuth, requireCapability("leads"), siteVisits.updateOwnSiteVisit);

// ── D3 date-inventory + holds ──
// Create accepts BOTH tokens: admin JWT = wedsy-side concierge request,
// venue token = owner-raised hold (availability capability). Everything else
// is owner-side; decisions (approve/decline/release/convert) + block/unblock
// are availability-gated writes, calendar/demand are open venue reads.
router.post("/:slug/holds", adminOrVenueOwnerAuth, requireCapabilityOrAdmin("availability"), cal.createHold);
router.get("/:slug/holds", venueOwnerAuth, requireCapability("availability"), cal.listHolds);
router.post("/:slug/holds/:holdId/approve", venueOwnerAuth, requireCapability("availability"), cal.approveHold);
router.post("/:slug/holds/:holdId/decline", venueOwnerAuth, requireCapability("availability"), cal.declineHold);
router.post("/:slug/holds/:holdId/release", venueOwnerAuth, requireCapability("availability"), cal.releaseHold);
router.post("/:slug/holds/:holdId/convert", venueOwnerAuth, requireCapability("availability"), cal.convertHold);
router.post("/:slug/calendar/block", venueOwnerAuth, requireCapability("availability"), cal.blockDates);
router.post("/:slug/calendar/unblock", venueOwnerAuth, requireCapability("availability"), cal.unblockDates);
router.get("/:slug/calendar", venueOwnerAuth, cal.getCalendar);
router.get("/:slug/calendar/demand", venueOwnerAuth, cal.demandHeat);
router.patch("/:slug/calendar/settings", venueOwnerAuth, requireCapability("availability"), cal.updateCalendarSettings);

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
