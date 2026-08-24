const express = require("express");
const router = express.Router();
const fileUpload = require("express-fileupload");

const controller = require("../controllers/reimbursement");
const { CheckAdminLogin } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/requirePermission");
const { MAX_BYTES } = require("../utils/receiptStore");

// -- A RECEIPTS-ONLY UPLOAD ROUTE ------------------------------------------
// Deliberately NOT POST /file. That route is gated on CheckLogin, which admits
// CUSTOMER and VENDOR tokens; it lets the caller name the S3 key, so a second
// upload silently overwrites the first; and it re-encodes images to lossy JPEG.
// All three are wrong for a document that IS the evidence.
//
// CheckAdminLogin: staff only. The service additionally enforces that a
// claimant may only write to their OWN claim, and only while it is pending.
//
// The multipart parser is mounted HERE, on this route only, with a real
// fileSize limit and abortOnLimit — the generic /file route mounts
// express-fileupload with no limits at all.
const receiptUpload = fileUpload({
  limits: { fileSize: MAX_BYTES, files: 1 },
  abortOnLimit: true,
  responseOnLimit: `That file is over the ${MAX_BYTES / 1024 / 1024} MB limit`,
  // No temp files: the buffer goes straight to S3, so nothing lands on the
  // t3.micro's disk and no cleanup job is needed.
  useTempFiles: false,
});

// Own claims. Filing and seeing your own reimbursements needs no grant, the
// same transparency rule as attendance /me and leave /me.
router.post("/", CheckAdminLogin, controller.Create);
router.get("/me", CheckAdminLogin, controller.Mine);
router.post("/:id/receipt", CheckAdminLogin, receiptUpload, controller.AddReceipt);
router.post("/:id/receipt/remove", CheckAdminLogin, controller.RemoveReceipt);
router.post("/:id/submit", CheckAdminLogin, controller.Submit);

// Seeing OTHER people's claims is scoped like attendance and leave.
router.get("/", CheckAdminLogin, requirePermission("payroll:view:all"), controller.List);

// Deciding is founder-only. Every claim goes to a founder; there is no
// approval threshold, by ruling.
router.post("/:id/decide", CheckAdminLogin, requirePermission("payroll:approve:all"), controller.Decide);

module.exports = router;
