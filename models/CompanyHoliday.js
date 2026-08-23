const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

// ── The COMPANY holiday calendar — HR's own, deliberately not PublicHoliday ──
//
// models/PublicHoliday.js answers a different question: "do the GUESTS get the
// day off", for wedding demand. It must not be read live by payroll, for five
// independent reasons, any one of which is sufficient:
//
//   1. Different question. Wedsy may work on a gazetted holiday, or close for a
//      day no gazette lists. Demand and payroll disagree by design.
//   2. Different owner. It is maintained by the VENUE team under
//      auspicious_dates_manage — an editor with no payroll accountability, who
//      would have no idea their edit had moved someone's salary.
//   3. It defaults verified:false. Its own comment says "we read this somewhere"
//      is not "this is confirmed". You cannot pay people against that.
//   4. Wrong shape. It carries national AND regional rows for the same holiday
//      on DIFFERENT dates (Diwali 2026: 8 Nov nationally, 10 Nov in Karnataka).
//      A company has one calendar for one office.
//   5. Wrong key. Midnight-UTC Date vs the IST "YYYY-MM-DD" string that
//      Attendance and every sheet calculation use.
//
// A one-way SUGGESTED import exists (services/CompanyHolidayService.suggestFrom
// PublicHolidays) so HR can seed a year quickly — but a human confirms each row,
// and nothing here ever reads that collection at decision time.
const CompanyHolidaySchema = new mongoose.Schema(
  {
    // IST calendar day "YYYY-MM-DD" — the SAME key Attendance.date uses, so the
    // sheet joins on a string compare with no timezone arithmetic anywhere.
    date: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    // Unpaid company holidays are unusual but real (a shutdown day). Explicit,
    // so the sheet never has to assume.
    paid: { type: Boolean, default: true },
    createdBy: { type: ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

// One holiday per day. Two names on one date is a naming problem, not two
// holidays — the office is either open or shut.
CompanyHolidaySchema.index({ date: 1 }, { unique: true });

module.exports =
  mongoose.models.CompanyHoliday || mongoose.model("CompanyHoliday", CompanyHolidaySchema);
