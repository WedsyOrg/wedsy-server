const PayrollService = require("../services/PayrollService");
const PayrollExportService = require("../services/PayrollExportService");

const respondErr = (res, error, label) => {
  const status = error && error.status ? error.status : 500;
  if (status >= 500) console.error(`[${label}]`, error && error.message, error);
  const body = { message: (error && error.message) || "error" };
  for (const k of ["code", "blocked"]) if (error && error[k] !== undefined) body[k] = error[k];
  return res.status(status).send(body);
};

const SetSalary = async (req, res) => {
  try {
    const { adminId, annualCtc, effectiveFrom, note } = req.body || {};
    return res.status(201).send({ message: "saved", salary: await PayrollService.setSalary({ adminId, annualCtc, effectiveFrom, note }, req.auth.user_id) });
  } catch (error) { return respondErr(res, error, "Payroll:SetSalary"); }
};

const SalaryHistory = async (req, res) => {
  try { return res.send({ list: await PayrollService.salaryHistory(req.params.adminId) }); }
  catch (error) { return respondErr(res, error, "Payroll:SalaryHistory"); }
};

const Sheet = async (req, res) => {
  try { return res.send(await PayrollService.getSheet(req.params.month, req.auth.user_id)); }
  catch (error) { return respondErr(res, error, "Payroll:Sheet"); }
};

const ActOnItem = async (req, res) => {
  try {
    const { adminId, kind, date, action, reason } = req.body || {};
    return res.send(await PayrollService.actOnItem(req.params.month, { adminId, kind, date, action, reason }, req.auth.user_id));
  } catch (error) { return respondErr(res, error, "Payroll:ActOnItem"); }
};

const ConvertIncomplete = async (req, res) => {
  try {
    const { adminId, date } = req.body || {};
    return res.send(await PayrollService.convertIncompleteToLop(req.params.month, { adminId, date }, req.auth.user_id));
  } catch (error) { return respondErr(res, error, "Payroll:ConvertIncomplete"); }
};

const Finalise = async (req, res) => {
  try { return res.send({ message: "finalised", ...(await PayrollService.finalise(req.params.month, req.auth.user_id)) }); }
  catch (error) { return respondErr(res, error, "Payroll:Finalise"); }
};

const ListRuns = async (req, res) => {
  try { return res.send({ list: await PayrollService.listRuns() }); }
  catch (error) { return respondErr(res, error, "Payroll:ListRuns"); }
};

// Export is deliberately allowed on a draft too — an accountant reviewing before
// sign-off is a normal thing to want — but the workbook says which it is.
const Export = async (req, res) => {
  try {
    const { sheet, frozen } = await PayrollService.getSheet(req.params.month, req.auth.user_id);
    const buffer = await PayrollExportService.toBuffer(sheet, { month: req.params.month });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="payroll-${req.params.month}${frozen ? "" : "-DRAFT"}.xlsx"`);
    return res.send(Buffer.from(buffer));
  } catch (error) { return respondErr(res, error, "Payroll:Export"); }
};

module.exports = { SetSalary, SalaryHistory, Sheet, ActOnItem, ConvertIncomplete, Finalise, ListRuns, Export };
