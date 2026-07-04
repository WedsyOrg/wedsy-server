const mongoose = require("mongoose");
const Enquiry = require("../models/Enquiry");
const BillingDocService = require("../services/BillingDocService");

const respond = (res, error) => {
  const status = error.status || 500;
  if (status === 500) console.error("[billingDoc]", error);
  res.status(status).json({ message: status === 500 ? "Server error" : error.message });
};

// Owner/manager scope — documents carry money, so NO roster fallback here.
const assertScoped = async (leadId, scopeFilter) => {
  if (!mongoose.Types.ObjectId.isValid(String(leadId)))
    throw Object.assign(new Error("Invalid lead id"), { status: 400 });
  const inScope = await Enquiry.findOne({ $and: [{ _id: leadId }, scopeFilter || {}] }, { _id: 1 }).lean();
  if (!inScope) throw Object.assign(new Error("Out of your scope"), { status: 403 });
};

const stream = (res, filename, buffer) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.status(200).send(buffer);
};

// GET /enquiry/:_id/agreement.pdf
const AgreementPdf = async (req, res) => {
  try {
    await assertScoped(req.params._id, req.scopeFilter);
    const buffer = await BillingDocService.agreementPdf(req.params._id);
    stream(res, `agreement-${req.params._id}.pdf`, buffer);
  } catch (error) {
    respond(res, error);
  }
};

// GET /enquiry/:_id/payments/:paymentId/invoice.pdf?type=gst|simple
const InvoicePdf = async (req, res) => {
  try {
    await assertScoped(req.params._id, req.scopeFilter);
    const { buffer, invoiceNumber } = await BillingDocService.invoicePdf(
      req.params._id,
      req.params.paymentId,
      { type: req.query.type || "simple" }
    );
    stream(res, `${invoiceNumber || "receipt"}-${req.params.paymentId}.pdf`, buffer);
  } catch (error) {
    respond(res, error);
  }
};

module.exports = { AgreementPdf, InvoicePdf };
