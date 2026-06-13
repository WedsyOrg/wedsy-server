/* Browser-suite fixtures (wedsy-os Playwright e2e drives a real backend).
 *
 * setup    → creates a founder admin (all perms), a WhatsApp lead + live
 *            ai-mode conversation with an open 24h window and two messages,
 *            then prints ONE LINE of JSON: { token, leadId, conversationId }.
 * teardown → removes everything the marker identifies. Idempotent.
 *
 * Usage: node scripts/browser-e2e-fixtures.js setup|teardown
 */
require("dotenv").config();
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const MARKER = "BROWSER-E2E";
const LEAD_PHONE = "919180000001";
const ADMIN_PHONE = "919180000002";

(async () => {
  const cmd = process.argv[2];
  if (!["setup", "teardown"].includes(cmd)) {
    console.error("usage: node scripts/browser-e2e-fixtures.js setup|teardown");
    process.exit(1);
  }
  await mongoose.connect(process.env.DATABASE_URL);
  const Enquiry = require("../models/Enquiry");
  const WAConversation = require("../models/WAConversation");
  const WAAgentMessage = require("../models/WAAgentMessage");
  const LeadInternalEvent = require("../models/LeadInternalEvent");
  const Admin = require("../models/Admin");
  const Role = require("../models/Role");
  const Department = require("../models/Department");

  const teardown = async () => {
    const lead = await Enquiry.findOne({ phone: LEAD_PHONE }).lean();
    if (lead) await LeadInternalEvent.deleteMany({ leadId: lead._id });
    await Enquiry.deleteMany({ phone: LEAD_PHONE });
    await WAConversation.deleteMany({ phone: LEAD_PHONE });
    await WAAgentMessage.deleteMany({ phone: LEAD_PHONE });
    await Admin.deleteMany({ phone: ADMIN_PHONE });
    await Role.deleteMany({ name: `${MARKER} Founder` });
    await Department.deleteMany({ name: `${MARKER} Dept` });
  };

  if (cmd === "teardown") {
    await teardown();
    await mongoose.disconnect();
    console.log(JSON.stringify({ ok: true }));
    return;
  }

  await teardown(); // clean slate even after a crashed previous run

  const dept = await Department.create({ name: `${MARKER} Dept` });
  const role = await Role.create({
    name: `${MARKER} Founder`,
    departmentId: dept._id,
    permissions: ["*:*:all"],
  });
  const admin = await Admin.create({
    name: "Browser Founder",
    email: `browser-e2e-${Date.now()}@test.local`,
    phone: ADMIN_PHONE,
    password: "browser-e2e-not-a-real-password",
    roles: ["crm"],
    roleId: role._id,
    departmentId: dept._id,
    status: "active",
  });
  const token = jwt.sign({ _id: String(admin._id), isAdmin: true }, process.env.JWT_SECRET);

  const lead = await Enquiry.create({
    name: "Browser E2E Lead",
    phone: LEAD_PHONE,
    verified: false,
    source: "whatsapp",
    additionalInfo: {},
    stage: "new",
    assignedTo: admin._id,
  });
  const now = new Date();
  const conversation = await WAConversation.create({
    phone: LEAD_PHONE,
    normalizedPhone: LEAD_PHONE.slice(-10),
    enquiryId: lead._id,
    mode: "ai",
    status: "active",
    lastInboundAt: now, // 24h window OPEN — the send flow must work
    lastMessageAt: now,
    lastMessagePreview: "Hi! Planning my wedding",
    unreadCount: 1,
  });
  await WAAgentMessage.create([
    { phone: LEAD_PHONE, role: "user", message: "Hi! Planning my wedding" },
    { phone: LEAD_PHONE, role: "assistant", message: "How lovely! Tell me more ✦" },
  ]);

  await mongoose.disconnect();
  console.log(
    JSON.stringify({ token, leadId: String(lead._id), conversationId: String(conversation._id) })
  );
})();
