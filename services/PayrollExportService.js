const ExcelJS = require("exceljs");

// ── The finalised sheet, as a workbook ──────────────────────────────────────
//
// exceljs, streamed into a buffer. NOT Puppeteer: rendering HTML to PDF OOMs the
// t3.micro this runs on, and a spreadsheet is what an accountant wants anyway.
//
// ⚠️ THE COLUMN SET IS OURS, NOT RAZORPAY'S. Their bulk Additions/Deductions/
// Loss of Pay template is generated per-month from their dashboard and its exact
// headers are not published anywhere — so guessing them would produce a file
// that fails ingest, or worse, imports into the wrong columns. The plan is to
// take a real downloaded template and map to it; until then this exports a
// documented set of our own that a human can map by eye.
//
// WHAT RAZORPAY WILL RECOMPUTE, AND WHY IT AGREES: their default structure
// prorates LOP on total days in the month. This sheet uses gross/30 by founder
// ruling for exactly that reason, so "LOP days" sent to them lands on the same
// figure this sheet already computed. The rupee column is still the
// authoritative one — send that if the two ever disagree.
const SHEET_COLUMNS = [
  { header: "Employee ID", key: "employeeId", width: 14 },
  { header: "Name", key: "name", width: 24 },
  { header: "Email", key: "email", width: 28 },
  { header: "Annual CTC", key: "annualCtc", width: 14 },
  { header: "Monthly Gross", key: "monthlyGross", width: 14 },
  { header: "Payable Gross", key: "payableGross", width: 14 },
  { header: "Prorated", key: "prorated", width: 10 },
  { header: "Days Employed", key: "daysEmployed", width: 14 },
  { header: "Day Rate (gross/30)", key: "dayRate", width: 18 },
  { header: "Days Present", key: "present", width: 13 },
  { header: "Half Days", key: "halfDays", width: 11 },
  { header: "CL", key: "CL", width: 7 },
  { header: "SL", key: "SL", width: 7 },
  { header: "EL", key: "EL", width: 7 },
  { header: "WFH", key: "WFH", width: 7 },
  { header: "Comp-off Earned", key: "compOffEarned", width: 16 },
  { header: "Comp-off Used", key: "compOffUsed", width: 15 },
  { header: "LOP Days", key: "lopDays", width: 10 },
  { header: "LOP Deduction", key: "lopDeduction", width: 15 },
  { header: "Late Instances", key: "lateInstances", width: 15 },
  { header: "Late Fines", key: "fineDeduction", width: 12 },
  { header: "Waived Items", key: "waivedCount", width: 13 },
  { header: "Incomplete Days", key: "incompleteCount", width: 16 },
  { header: "Total Deductions", key: "totalDeductions", width: 17 },
  { header: "Net (before statutory)", key: "netBeforeStatutory", width: 21 },
  { header: "Notes", key: "notes", width: 40 },
];

const money = "#,##0.00";

const buildWorkbook = async (sheet, { month }) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Wedsy OS";
  wb.created = new Date();

  // ── Sheet 1: the payable sheet ────────────────────────────────────────
  const ws = wb.addWorksheet(`Payroll ${month}`);
  ws.columns = SHEET_COLUMNS;
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];

  for (const l of sheet.lines) {
    ws.addRow({
      employeeId: l.employeeId, name: l.name, email: l.email,
      annualCtc: l.annualCtc, monthlyGross: l.monthlyGross, payableGross: l.payableGross,
      prorated: l.prorated ? "yes" : "", daysEmployed: l.daysEmployed, dayRate: l.dayRate,
      present: l.present, halfDays: l.halfDays,
      CL: (l.leaveByType || {}).CL || 0, SL: (l.leaveByType || {}).SL || 0,
      EL: (l.leaveByType || {}).EL || 0, WFH: (l.leaveByType || {}).WFH || 0,
      compOffEarned: l.compOffEarned, compOffUsed: l.compOffUsed,
      lopDays: l.lopDays, lopDeduction: l.lopDeduction,
      lateInstances: l.lateInstances, fineDeduction: l.fineDeduction,
      waivedCount: l.waivedCount, incompleteCount: l.incompleteDays.length,
      totalDeductions: l.totalDeductions, netBeforeStatutory: l.netBeforeStatutory,
      notes: [...l.flags].join(" · "),
    });
  }
  for (const key of ["annualCtc", "monthlyGross", "payableGross", "dayRate", "lopDeduction", "fineDeduction", "totalDeductions", "netBeforeStatutory"]) {
    ws.getColumn(key).numFmt = money;
  }
  const totalRow = ws.addRow({
    name: `TOTAL (${sheet.totals.headcount})`,
    payableGross: sheet.totals.gross,
    lopDeduction: sheet.totals.lopDeduction,
    fineDeduction: sheet.totals.fineDeduction,
    totalDeductions: sheet.totals.totalDeductions,
    netBeforeStatutory: sheet.totals.netBeforeStatutory,
  });
  totalRow.font = { bold: true };

  // ── Sheet 2: the EVIDENCE behind every deduction ──────────────────────
  // A deduction nobody can explain is a dispute waiting to happen. Every LOP day
  // and fine appears here with its source, its decision and who made it —
  // including WAIVED items, which are the ones most likely to be asked about.
  const ev = wb.addWorksheet("Deduction detail");
  ev.columns = [
    { header: "Name", key: "name", width: 24 },
    { header: "Date", key: "date", width: 12 },
    { header: "Kind", key: "kind", width: 8 },
    { header: "Source / Late by", key: "source", width: 24 },
    { header: "Amount", key: "amount", width: 12 },
    { header: "Decision", key: "status", width: 11 },
    { header: "Reason", key: "reason", width: 44 },
  ];
  ev.getRow(1).font = { bold: true };
  ev.views = [{ state: "frozen", ySplit: 1 }];
  for (const l of sheet.lines) {
    for (const i of l.items) {
      ev.addRow({
        name: l.name, date: i.date, kind: i.kind,
        source: i.kind === "lop" ? i.source : `${i.lateMinutes} min late`,
        amount: i.amount, status: i.status, reason: i.reason,
      });
    }
    for (const d of l.incompleteDays) {
      ev.addRow({ name: l.name, date: d, kind: "incomplete", source: "no check-out recorded", amount: 0, status: "paid", reason: "Not deducted — needs manager confirmation" });
    }
  }
  ev.getColumn("amount").numFmt = money;

  // ── Sheet 3: how the numbers were produced ────────────────────────────
  const meta = wb.addWorksheet("Basis");
  meta.columns = [{ header: "Item", key: "k", width: 34 }, { header: "Value", key: "v", width: 60 }];
  meta.getRow(1).font = { bold: true };
  [
    ["Month", sheet.month],
    ["Day divisor", `${sheet.dayDivisor} (fixed — matches Razorpay's default LOP basis)`],
    ["Calendar days in month", sheet.daysInMonth],
    ["Working days (Mon-Sat − holidays)", `${sheet.workingDaysInMonth} — context only, NOT the pay divisor`],
    ["Late fines", "read from the policy snapshot on each attendance row, never recomputed"],
    ["Statutory", "NOT computed here — PF / ESI / PT / TDS are Razorpay's"],
    ["Net column", "gross − LOP − fines, BEFORE any statutory deduction"],
  ].forEach(([k, v]) => meta.addRow({ k, v }));

  return wb;
};

const toBuffer = async (sheet, { month }) => {
  const wb = await buildWorkbook(sheet, { month });
  return wb.xlsx.writeBuffer();
};

module.exports = { SHEET_COLUMNS, buildWorkbook, toBuffer };
