const express = require("express");
const router = express.Router();
const { getVenues, getVenueBySlug, updateVenue, createVenue } = require("../controllers/venue");
const { createEnquiry, createManualLead, getVenueEnquiries, getEnquiryById, deleteEnquiry, checkEnquiryExists, updateEnquiry, getWindowImpact, importLeads, getImports } = require("../controllers/venueEnquiry");
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
const { getDay } = require("../controllers/venueCrmDay");
const { getVenueAuspiciousDates } = require("../controllers/venueAuspiciousDates");
const { getCrmSettings, updateCrmSettings } = require("../controllers/venueCrmSettings");
const { listTemplates, createTemplate, updateTemplate, deleteTemplate } = require("../controllers/venueTemplate");
const { listBookings, getBooking, createBooking, updateBooking, confirmBookingFromLead, updateBookingWindow } = require("../controllers/venueBooking");
const { createQuote, listQuotes, getQuote, updateQuote, confirmBookingFromQuote, quotePdf } = require("../controllers/venueQuote");
const { createFromBooking, listInvoices, getInvoice, addPayment, approvePayment, rejectPayment, invoicePdf } = require("../controllers/venueInvoice");
const { summary: paymentsSummary } = require("../controllers/venuePayment");
const { getAnalytics } = require("../controllers/venueAnalytics");
const { getCompetitive } = require("../controllers/venueCompetitive");
const sheets = require("../controllers/venueSheetsSync");
const { listMembers, listAssignableMembers, inviteMember, updateMember, setMemberPassword, getActivity } = require("../controllers/venueTeam");
const roles = require("../controllers/venueRoles");
const quoteRounds = require("../controllers/venueQuoteRound");
const pricing = require("../controllers/venuePricing");
const terms = require("../controllers/venueTerms");
const cal = require("../controllers/venueCalendar");
const docs = require("../controllers/venueDocs");
const termsDoc = require("../controllers/venueTermsDocument");
const leadDocs = require("../controllers/venueLeadDocument");
const bookingSettings = require("../controllers/venueBookingSettings");
const leadInvoice = require("../controllers/venueLeadInvoice");
const leadPayment = require("../controllers/venueLeadPayment");
const bookingConfirm = require("../controllers/venueBookingConfirmation");
const checkin = require("../controllers/venueCheckin");
const activityFeed = require("../controllers/venueActivityFeed");
const siteVisits = require("../controllers/venueSiteVisits"); // MB-V2 P1 owner side of planner walk-throughs
const { createOnboardingRequest } = require("../controllers/venueOnboarding");
const { listRooms, addRoom, updateRoom, deleteRoom, bulkCreateRooms } = require("../controllers/venueRooms");
const roomTypes = require("../controllers/venueRoomTypes");
const { generateContract, listContracts, updateContract, sendContract, contractPdf, getAckContract, acknowledgeContract } = require("../controllers/venueContract");
const { createAllotments, listAllotments, planAllotments, updateAllotment, occupancy } = require("../controllers/venueAllotment");
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
// BUILD2 S2: dry run of a window move (functions stranded / holds left behind
// / booking that refuses it). Read-only, so it sits on the same `leads` gate as
// reading the lead itself. Registered BEFORE the :enquiryId GET so the literal
// suffix is not swallowed by the id param.
router.get("/:slug/enquiries/:enquiryId/window-impact", venueOwnerAuth, requireCapability("leads"), getWindowImpact);
router.get("/:slug/enquiries/:enquiryId", venueOwnerAuth, getEnquiryById);
router.patch("/:slug/enquiries/:enquiryId", venueOwnerAuth, requireCapability("leads"), updateEnquiry);
// Soft-delete a lead — leads_delete (Owner only by default). Scoped resolve inside.
router.delete("/:slug/enquiries/:enquiryId", venueOwnerAuth, requireCapability("leads_delete"), deleteEnquiry);
// Per-lead communication log — write=leads, read open.
router.post("/:slug/enquiries/:enquiryId/interactions", venueOwnerAuth, requireCapability("leads"), addInteraction);
router.get("/:slug/enquiries/:enquiryId/interactions", venueOwnerAuth, getInteractions);
// S0e quick-log: one-tap touch that auto-advances stage + captures next follow-up.
router.post("/:slug/enquiries/:enquiryId/quick-log", venueOwnerAuth, requireCapability("leads"), quickLog);
// ── MB-CRM-2 S2: Confirm Booking wizard — the lead graduates into a booking
// through the ONE creation path (money movement ⇒ bookings_money gate).
router.post("/:slug/enquiries/:enquiryId/confirm-booking", venueOwnerAuth, requireCapability("bookings_money"), confirmBookingFromLead);

// ── MB-CRM S4: CRM dashboard overview (my-day, real alerts, proof) ──
router.get("/:slug/crm/overview", venueOwnerAuth, getCrmOverview);
// ── MB-CRM S6: demand map (contested / held-expiring / booked / open) ──
router.get("/:slug/crm/dates", venueOwnerAuth, getDemandMap);
// ── Auspicious (muhurat) dates — platform reference data, read-only here.
//    No capability gate on purpose: it is neutral calendar data every role
//    needs, and the venue boundary is the only meaningful check. Writes are
//    admin-only, under /admin/auspicious-dates.
router.get("/:slug/auspicious-dates", venueOwnerAuth, getVenueAuspiciousDates);
// BUILD3 S1b: everything happening on one date. Lead ROWS are scoped inside the
// controller through utils/venueLeadScope; the `leads` capability gates the
// surface itself, matching the demand map it sits beside.
router.get("/:slug/crm/day", venueOwnerAuth, requireCapability("leads"), getDay);
// ── MB-CRM S7: owner-tunable CRM settings (auto-assign) — team capability ──
router.get("/:slug/crm/settings", venueOwnerAuth, requireCapability("team"), getCrmSettings);
router.patch("/:slug/crm/settings", venueOwnerAuth, requireCapability("team"), updateCrmSettings);

// ── Follow-ups module — lead-derived, so reads are scoped through the parent
//    lead (404 never 403) and writes need the coarse "leads" capability.
//    DELETE is leads_delete: cancel is the everyday close, delete is for rows
//    created in error only.
const followUps = require("../controllers/venueFollowUp");
router.get("/:slug/follow-ups", venueOwnerAuth, followUps.listFollowUps);
router.post("/:slug/follow-ups", venueOwnerAuth, requireCapability("leads"), followUps.createFollowUp);
router.get("/:slug/follow-ups/:followUpId", venueOwnerAuth, followUps.getFollowUp);
router.patch("/:slug/follow-ups/:followUpId", venueOwnerAuth, requireCapability("leads"), followUps.updateFollowUp);
router.post("/:slug/follow-ups/:followUpId/complete", venueOwnerAuth, requireCapability("leads"), followUps.completeFollowUp);
router.post("/:slug/follow-ups/:followUpId/cancel", venueOwnerAuth, requireCapability("leads"), followUps.cancelFollowUp);
router.post("/:slug/follow-ups/:followUpId/reopen", venueOwnerAuth, requireCapability("leads"), followUps.reopenFollowUp);
router.delete("/:slug/follow-ups/:followUpId", venueOwnerAuth, requireCapability("leads_delete"), followUps.deleteFollowUp);

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
// The booking side of the ONE event window — same edit as the lead's PATCH,
// same writer (utils/venueEventWindow), same calendar re-derivation.
router.patch("/:slug/bookings/:bookingId/window", venueOwnerAuth, requireCapability("leads"), updateBookingWindow);

// ── BUILD B: the negotiation log. Money-gated on bookings_money — the brief
//    asked for `money_negotiate`, which does not exist in this codebase, and
//    inventing a capability no role bundle grants would lock every non-owner
//    out on day one. Pricing is money; bookings_money is the money gate.
//    Scope is enforced INSIDE the controller (the parent lead resolves through
//    venueLeadScope first, 404 not 403).
router.get("/:slug/enquiries/:enquiryId/quote-rounds", venueOwnerAuth, requireCapability("bookings_money"), quoteRounds.listRounds);
router.post("/:slug/enquiries/:enquiryId/quote-rounds", venueOwnerAuth, requireCapability("bookings_money"), quoteRounds.createRound);
router.patch("/:slug/enquiries/:enquiryId/quote-rounds/:roundId", venueOwnerAuth, requireCapability("bookings_money"), quoteRounds.updateRound);
router.delete("/:slug/enquiries/:enquiryId/quote-rounds/:roundId", venueOwnerAuth, requireCapability("bookings_money"), quoteRounds.deleteRound);
// Pricing intelligence + the terms send live on the same money surface.
router.get("/:slug/enquiries/:enquiryId/pricing", venueOwnerAuth, requireCapability("bookings_money"), pricing.getPricingIntel);
router.post("/:slug/enquiries/:enquiryId/pricing/dismiss", venueOwnerAuth, requireCapability("bookings_money"), pricing.dismissPricingAdvice);
router.get("/:slug/enquiries/:enquiryId/terms/preview", venueOwnerAuth, requireCapability("bookings_money"), terms.previewTerms);
router.post("/:slug/enquiries/:enquiryId/terms/send", venueOwnerAuth, requireCapability("bookings_money"), terms.sendTerms);
router.get("/:slug/enquiries/:enquiryId/terms/pdf", venueOwnerAuth, requireCapability("bookings_money"), terms.termsPdf);

// ── The Documents tab: generated documents, versioned and immutable ─────────
// Gated on `documents`, not `bookings_money`. Generating a T&C document is the
// same act as uploading the terms it wraps (/terms-document, above) and belongs
// to the same capability — which is also why the founder moved the button out of
// Money. `documents` is a real capability held by the Manager and Accounts
// bundles, so this does not lock anyone out the way an invented one would.
// Scope is enforced INSIDE the controller: the parent lead resolves through
// venueLeadScope first, so a miss is 404 and never 403.
router.get("/:slug/enquiries/:enquiryId/documents", venueOwnerAuth, requireCapability("documents"), leadDocs.listLeadDocuments);
router.post("/:slug/enquiries/:enquiryId/documents/terms", venueOwnerAuth, requireCapability("documents"), leadDocs.generateTermsDocument);
// CLIENT documents — what the client gives US (address proof, and anything
// collected later). Same `documents` capability as every other document
// surface, and deliberately so: these are identity documents, so the gate
// must not be LOOSER than the one on a T&C PDF. It is not tied to
// bookings_money either — collecting a proof is a records job, and a member
// who files paperwork should not need the capability that lets them see what
// the booking is worth.
router.post("/:slug/enquiries/:enquiryId/documents/client", venueOwnerAuth, requireCapability("documents"), leadDocs.uploadClientDocument);
router.get("/:slug/enquiries/:enquiryId/documents/:documentId/download", venueOwnerAuth, requireCapability("documents"), leadDocs.downloadLeadDocument);

// ── BOOKING ENGINE S5: invoices raised from the lead ────────────────────────
// bookings_money, not `documents`: an invoice is a money instrument and the GST
// choice is a money decision, so it takes the same gate as every other money
// surface. The rendered PDF still lands in the Documents tab, whose own read is
// `documents`-gated — a member who may raise an invoice but not read documents
// gets the record without the file, which is the correct split rather than an
// accident. Scope is enforced INSIDE the controller (venueLeadScope, 404 never 403).
router.get("/:slug/enquiries/:enquiryId/invoices", venueOwnerAuth, requireCapability("bookings_money"), leadInvoice.listLeadInvoices);
router.post("/:slug/enquiries/:enquiryId/invoices", venueOwnerAuth, requireCapability("bookings_money"), leadInvoice.createLeadInvoice);

// ── BOOKING ENGINE S4: recording payments against the schedule ──────────────
router.get("/:slug/enquiries/:enquiryId/payments", venueOwnerAuth, requireCapability("bookings_money"), leadPayment.getLeadPayments);
// The preview writes nothing but reads the schedule, so it sits behind the
// SAME capability as recording — "where would this money go" is a money read.
router.post("/:slug/enquiries/:enquiryId/payments/preview", venueOwnerAuth, requireCapability("bookings_money"), leadPayment.previewPayment);
router.post("/:slug/enquiries/:enquiryId/payments", venueOwnerAuth, requireCapability("bookings_money"), leadPayment.recordPayment);
// Approve/reject are OWNER-ONLY, enforced inside the handler with isOwnerActor
// rather than by a capability: a `payments_approve` nobody holds is a migration
// and a permissions row for no live benefit. The capability here is still
// bookings_money, so a member cannot even see the queue they cannot act on.
router.post("/:slug/enquiries/:enquiryId/payments/:paymentId/approve", venueOwnerAuth, requireCapability("bookings_money"), leadPayment.approveLeadPayment);
router.post("/:slug/enquiries/:enquiryId/payments/:paymentId/reject", venueOwnerAuth, requireCapability("bookings_money"), leadPayment.rejectLeadPayment);
// Additional billing is money owed, so it sits behind the same capability as
// the rest of the schedule and the same lead scope (404, never 403).
router.post("/:slug/enquiries/:enquiryId/additional-billing", venueOwnerAuth, requireCapability("bookings_money"), leadPayment.addAdditionalBilling);
router.delete("/:slug/enquiries/:enquiryId/additional-billing/:rowId", venueOwnerAuth, requireCapability("bookings_money"), leadPayment.removeAdditionalBilling);

// ── BOOKING ENGINE S3: the booking confirmation document ────────────────────
// `documents`, matching every other document generator — it produces a
// VenueLeadDocument and lands in the same Documents tab.
router.get("/:slug/enquiries/:enquiryId/booking-confirmation/options", venueOwnerAuth, requireCapability("documents"), bookingConfirm.getConfirmationOptions);
router.post("/:slug/enquiries/:enquiryId/booking-confirmation", venueOwnerAuth, requireCapability("documents"), bookingConfirm.generateBookingConfirmation);

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
// The venue's uploaded T&C PDF. Same capability as the document templates it
// sits beside — an owner who may author terms may upload them.
router.get("/:slug/terms-document", venueOwnerAuth, termsDoc.getTermsDocument);
router.put("/:slug/terms-document", venueOwnerAuth, requireCapability("documents"), termsDoc.putTermsDocument);
router.delete("/:slug/terms-document", venueOwnerAuth, requireCapability("documents"), termsDoc.deleteTermsDocument);

// ── BOOKING ENGINE S1: venue-level configuration the engine reads ────────────
// Gated on `documents` for the two document surfaces (brief, cancellation
// policy) — the same capability that already gates /terms-document and the doc
// templates they sit beside. Payment slabs are money configuration, so they take
// `bookings_money`, matching every other money surface. The GET is open to any
// authenticated venue user because the wizard needs it to pre-populate and a
// member who can confirm a booking must be able to read the shapes.
router.get("/:slug/booking-settings", venueOwnerAuth, bookingSettings.getBookingSettings);
router.put("/:slug/booking-settings/brief", venueOwnerAuth, requireCapability("documents"), bookingSettings.putBrief);
router.delete("/:slug/booking-settings/brief", venueOwnerAuth, requireCapability("documents"), bookingSettings.deleteBrief);
router.put("/:slug/booking-settings/cancellation-policy", venueOwnerAuth, requireCapability("documents"), bookingSettings.putCancellationPolicy);
router.put("/:slug/booking-settings/payment-slabs", venueOwnerAuth, requireCapability("bookings_money"), bookingSettings.putPaymentSlabs);
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
router.post("/:slug/rooms/bulk", venueOwnerAuth, requireCapability("listing"), bulkCreateRooms);
router.patch("/:slug/rooms/:roomId", venueOwnerAuth, requireCapability("listing"), updateRoom);
router.delete("/:slug/rooms/:roomId", venueOwnerAuth, requireCapability("listing"), deleteRoom);
// ROOMS 2 — the room TYPE as a real entity. Reads open to any venue identity,
// writes on the same `listing` capability the rooms inventory uses.
router.get("/:slug/room-types", venueOwnerAuth, roomTypes.listRoomTypes);
router.post("/:slug/room-types", venueOwnerAuth, requireCapability("listing"), roomTypes.addRoomType);
router.patch("/:slug/room-types/:typeId", venueOwnerAuth, requireCapability("listing"), roomTypes.updateRoomType);
router.delete("/:slug/room-types/:typeId", venueOwnerAuth, requireCapability("listing"), roomTypes.deleteRoomType);
// …and the per-room amenity library the types and rooms reference by key.
router.get("/:slug/room-amenities", venueOwnerAuth, roomTypes.listRoomAmenities);
router.post("/:slug/room-amenities", venueOwnerAuth, requireCapability("listing"), roomTypes.addRoomAmenity);
router.patch("/:slug/room-amenities/:key", venueOwnerAuth, requireCapability("listing"), roomTypes.updateRoomAmenity);
router.delete("/:slug/room-amenities/:key", venueOwnerAuth, requireCapability("listing"), roomTypes.deleteRoomAmenity);

router.get("/:slug/bookings/:bookingId/allotments", venueOwnerAuth, listAllotments);
router.post("/:slug/bookings/:bookingId/allotments", venueOwnerAuth, requireCapability("leads"), createAllotments);
// Booking→Rooms handoff: propose free rooms covering the lead's accommodation
// requirement across the real stay window. Read-only — the owner posts the plan
// back to POST /allotments above, so there stays exactly ONE creation path.
router.get("/:slug/bookings/:bookingId/allotments/plan", venueOwnerAuth, requireCapability("leads"), planAllotments);
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

// ── Site visits: planner-created AND owner-created, full lifecycle. Reads are
//    scoped through the parent lead (a visit carries the couple's name/phone),
//    writes need "leads", delete needs leads_delete (cancel is the everyday
//    close and keeps history).
router.get("/:slug/site-visits", venueOwnerAuth, requireCapability("leads"), siteVisits.listOwnSiteVisits);
router.post("/:slug/site-visits", venueOwnerAuth, requireCapability("leads"), siteVisits.createOwnSiteVisit);
router.patch("/:slug/site-visits/:visitId", venueOwnerAuth, requireCapability("leads"), siteVisits.updateOwnSiteVisit);
router.delete("/:slug/site-visits/:visitId", venueOwnerAuth, requireCapability("leads_delete"), siteVisits.deleteOwnSiteVisit);

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
