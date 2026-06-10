const express = require("express");
const router = express.Router();
const { getVenues, getVenueBySlug, updateVenue, createVenue } = require("../controllers/venue");
const { createEnquiry, createManualLead, getVenueEnquiries, updateEnquiry, importLeads, getImports } = require("../controllers/venueEnquiry");
const { saveAvailability } = require("../controllers/venueAvailability");
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
const { venueOwnerAuth } = require("../middlewares/venueOwnerAuth");
const { enquiryIpLimiter, enquiryPhoneLimiter } = require("../utils/venueEnquiryRateLimit");
const { adminOrVenueOwnerAuth } = require("../middlewares/adminOrVenueOwnerAuth");
const { optionalAdminAuth } = require("../middlewares/optionalAdminAuth");
const { CheckLogin, CheckAdminLogin } = require("../middlewares/auth");

router.get("/", optionalAdminAuth, getVenues);
// Admin-only: create a new venue (venue owners must NOT create venues).
router.post("/", CheckAdminLogin, createVenue);
// Venue-owner dashboard home widgets (onboarding, verification, follow-ups).
// Declared before "/:slug" so the literal path is never shadowed by the slug param.
router.get("/dashboard/overview", venueOwnerAuth, getDashboardOverview);
router.get("/:slug", getVenueBySlug);
router.put("/:slug", adminOrVenueOwnerAuth, updateVenue);
// Public enquiry submission — rate-limited per IP and per phone+venue.
// (The gated /enquiries/manual route below is intentionally NOT limited.)
router.post("/:slug/enquiry", enquiryIpLimiter, enquiryPhoneLimiter, createEnquiry);
router.post("/:slug/enquiries", enquiryIpLimiter, enquiryPhoneLimiter, createEnquiry);
// Gated manual lead creation (venue owners only) — must precede none, distinct path.
router.post("/:slug/enquiries/manual", venueOwnerAuth, createManualLead);
// CSV/Excel bulk import + import history (venue owners only).
router.post("/:slug/enquiries/import", venueOwnerAuth, importLeads);
router.get("/:slug/enquiries/imports", venueOwnerAuth, getImports);
// Bulk actions over selected leads (literal "bulk" segments — declared before
// the /:enquiryId param routes so they are never shadowed).
router.post("/:slug/enquiries/bulk", venueOwnerAuth, bulkAction);
router.post("/:slug/enquiries/bulk-whatsapp", venueOwnerAuth, bulkWhatsApp);
router.get("/:slug/enquiries", venueOwnerAuth, getVenueEnquiries);
router.patch("/:slug/enquiries/:enquiryId", venueOwnerAuth, updateEnquiry);
// Per-lead communication log (4-segment paths — no shadowing of the routes above).
router.post("/:slug/enquiries/:enquiryId/interactions", venueOwnerAuth, addInteraction);
router.get("/:slug/enquiries/:enquiryId/interactions", venueOwnerAuth, getInteractions);
// Message templates CRUD (venue owners only).
router.get("/:slug/templates", venueOwnerAuth, listTemplates);
router.post("/:slug/templates", venueOwnerAuth, createTemplate);
router.patch("/:slug/templates/:templateId", venueOwnerAuth, updateTemplate);
router.delete("/:slug/templates/:templateId", venueOwnerAuth, deleteTemplate);

// ── Phase 3: bookings (3.1) ──
router.get("/:slug/bookings", venueOwnerAuth, listBookings);
router.post("/:slug/bookings", venueOwnerAuth, createBooking);
router.get("/:slug/bookings/:bookingId", venueOwnerAuth, getBooking);
router.patch("/:slug/bookings/:bookingId", venueOwnerAuth, updateBooking);

// ── Phase 3: quotes (3.2) — /pdf before /:quoteId is unnecessary (distinct suffix) ──
router.get("/:slug/quotes", venueOwnerAuth, listQuotes);
router.post("/:slug/quotes", venueOwnerAuth, createQuote);
router.get("/:slug/quotes/:quoteId/pdf", venueOwnerAuth, quotePdf);
router.get("/:slug/quotes/:quoteId", venueOwnerAuth, getQuote);
router.patch("/:slug/quotes/:quoteId", venueOwnerAuth, updateQuote);

// ── Phase 3: invoices (3.3) ──
router.get("/:slug/invoices", venueOwnerAuth, listInvoices);
router.post("/:slug/invoices", venueOwnerAuth, createFromBooking);
router.get("/:slug/invoices/:invoiceId/pdf", venueOwnerAuth, invoicePdf);
router.get("/:slug/invoices/:invoiceId", venueOwnerAuth, getInvoice);
router.post("/:slug/invoices/:invoiceId/payments", venueOwnerAuth, addPayment);

// ── Phase 3: payments summary (3.4) ──
router.get("/:slug/payments/summary", venueOwnerAuth, paymentsSummary);

router.post("/:slug/availability", venueOwnerAuth, saveAvailability);
router.post("/:slug/view", CheckLogin, trackView);
router.post("/:slug/nearby", refreshNearby);
router.post("/:slug/reviews", refreshReviews);
router.post("/:slug/generate-location-description", generateLocationDescription);

module.exports = router;
