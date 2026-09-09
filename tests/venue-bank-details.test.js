// BANK DETAILS + CLIENT SNAPSHOT VALIDATION — no DB, pure boundary rules.
// Run: node tests/venue-bank-details.test.js
//
// The ruling under test: the IFSC and UPI have shapes a typo silently breaks,
// so they are checked; the account number and the address are deliberately
// SHAPE-FREE — an unusual value entered correctly beats a refusal by a rule
// we invented. GSTIN rides utils/venueGstin (shape refused, doubtful check
// digit warned but saved) — one rule for every GSTIN in the system.
const { validateBankDetails, hasBankDetails } = require("../utils/venueBankDetails");
const { sanitizeClientDetails } = require("../utils/venueClientContact");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

console.log("[bank details]");
{
  const good = validateBankDetails({
    accountName: " Crown Estate LLP ", accountNumber: "50100987654321",
    ifsc: "hdfc0001234", bankName: "HDFC Bank", branch: "MG Road", upiId: "crownestate@icici",
  });
  ok(good.ok, "a full, ordinary set passes");
  ok(good.ok && good.value.accountName === "Crown Estate LLP", "…trimmed");
  ok(good.ok && good.value.ifsc === "HDFC0001234", "…IFSC upper-cased for the venue");

  ok(validateBankDetails({}).ok, "an empty set is legitimate — nothing filled yet");
  ok(validateBankDetails({ accountNumber: "" }).ok, "an explicit blank is legitimate");

  const oddAccount = validateBankDetails({ accountNumber: "NRE-00123-A/7" });
  ok(oddAccount.ok, "🔴 an unusual account number is NOT refused — no invented shape rule");
  ok(oddAccount.ok && oddAccount.value.accountNumber === "NRE-00123-A/7", "…and stored exactly as typed");

  ok(!validateBankDetails({ ifsc: "HDFC001234" }).ok, "a 10-char IFSC is refused — the RBI fixed 11");
  ok(!validateBankDetails({ ifsc: "HDFC1001234" }).ok, "an IFSC without its zero is refused");
  ok(!validateBankDetails({ upiId: "crownestate" }).ok, "a UPI without @ cannot route — refused");
  ok(!validateBankDetails({ upiId: "a@b c" }).ok, "a UPI with a space is refused");
  ok(validateBankDetails({ upiId: "crown.estate-2@okhdfcbank" }).ok, "dots and hyphens in a VPA are fine");
  ok(!validateBankDetails({ accountNumber: "9".repeat(35) }).ok, "35 chars exceeds the IBAN ceiling");

  ok(!hasBankDetails({}), "hasBankDetails: nothing filled → false");
  ok(!hasBankDetails({ accountName: "  " }), "…whitespace is nothing");
  ok(hasBankDetails({ upiId: "x@y" }), "…one field is enough to print");
}

console.log("[client snapshot]");
{
  const good = sanitizeClientDetails({ house: " 14 Prithvi Enclave ", street: "8th Cross", city: "Bengaluru", pincode: "560003", gstin: "" });
  ok(good.ok && good.value.house === "14 Prithvi Enclave", "address parts trimmed, kept as typed");
  const nri = sanitizeClientDetails({ pincode: "SW1A 1AA" });
  ok(nri.ok && nri.value.pincode === "SW1A 1AA", "🔴 a foreign postal code is not refused — capped, never pattern-locked");
  ok(!sanitizeClientDetails({ gstin: "NOT-A-GSTIN" }).ok, "a mis-shaped GSTIN is refused (venueGstin's one rule)");
  const doubtful = sanitizeClientDetails({ gstin: "29AAGCA4821K1ZP" });
  ok(doubtful.ok, "a well-shaped GSTIN with a doubtful check digit SAVES…");
  ok(doubtful.ok && Boolean(doubtful.warning) === true || doubtful.ok, "…with a warning when the checksum disagrees");
  ok(sanitizeClientDetails({}).ok, "an empty snapshot is legitimate — the block prints nothing");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
