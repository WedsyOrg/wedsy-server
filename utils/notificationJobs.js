const Order = require("../models/Order");
const BiddingBooking = require("../models/BiddingBooking");
const WedsyPackageBooking = require("../models/WedsyPackageBooking");
const VendorPersonalPackageBooking = require("../models/VendorPersonalPackageBooking");
const Vendor = require("../models/Vendor");
const { send } = require("../services/NotificationService");

const dateStr = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
};

const getOrdersByEventDate = async (targetDate) => {
  const [wsbBookings, vpbBookings, bbBookings] = await Promise.all([
    WedsyPackageBooking.find({ date: targetDate }).lean(),
    VendorPersonalPackageBooking.find({ date: targetDate }).lean(),
    BiddingBooking.find({ events: { $elemMatch: { date: targetDate } } }).lean(),
  ]);

  const wsbIds = wsbBookings.map((b) => b._id);
  const vpbIds = vpbBookings.map((b) => b._id);
  const bbIds = bbBookings.map((b) => b._id);

  if (!wsbIds.length && !vpbIds.length && !bbIds.length) return [];

  return Order.find({
    $or: [
      ...(wsbIds.length ? [{ wedsyPackageBooking: { $in: wsbIds } }] : []),
      ...(vpbIds.length ? [{ vendorPersonalPackageBooking: { $in: vpbIds } }] : []),
      ...(bbIds.length ? [{ biddingBooking: { $in: bbIds } }] : []),
    ],
    "status.lost": { $ne: true },
  })
    .populate("vendor", "phone email name businessName")
    .populate("user", "phone email name")
    .lean();
};

const remindVendorDMinus1 = async () => {
  try {
    const tomorrow = dateStr(1);
    const orders = await getOrdersByEventDate(tomorrow);
    orders.forEach((order) => {
      const v = order.vendor;
      if (v) send("mua_rmnd_dminus1", { phone: v.phone, email: v.email, name: v.businessName || v.name });
    });
    console.log(`[remindVendorDMinus1] ${orders.length} orders for ${tomorrow}`);
  } catch (err) {
    console.error("[remindVendorDMinus1] error:", err.message);
  }
};

const remindVendorDDay = async () => {
  try {
    const today = dateStr(0);
    const orders = await getOrdersByEventDate(today);
    orders.forEach((order) => {
      const v = order.vendor;
      if (v) send("mua_rmnd_d_day", { phone: v.phone, email: v.email, name: v.businessName || v.name });
    });
    console.log(`[remindVendorDDay] ${orders.length} orders for ${today}`);
  } catch (err) {
    console.error("[remindVendorDDay] error:", err.message);
  }
};

const reviewReminder = async () => {
  try {
    const yesterday = dateStr(-1);
    const orders = await getOrdersByEventDate(yesterday);
    orders.forEach((order) => {
      const u = order.user;
      if (u) send("cx_mua_review", { phone: u.phone, email: u.email, name: u.name });
    });
    console.log(`[reviewReminder] ${orders.length} orders for ${yesterday}`);
  } catch (err) {
    console.error("[reviewReminder] error:", err.message);
  }
};

const artistDetailReminder = async () => {
  try {
    const twoDaysOut = dateStr(2);
    const orders = await getOrdersByEventDate(twoDaysOut);
    orders.forEach((order) => {
      const u = order.user;
      const v = order.vendor;
      if (u && v) {
        send("cust_artist_detail", {
          phone: u.phone,
          email: u.email,
          name: u.name,
          variables: [v.businessName || v.name, v.phone || ""],
        });
      }
    });
    console.log(`[artistDetailReminder] ${orders.length} orders for ${twoDaysOut}`);
  } catch (err) {
    console.error("[artistDetailReminder] error:", err.message);
  }
};

// dob stored as "YYYY-MM-DD" string; match on MM-DD suffix
const birthdayReminder = async () => {
  try {
    const d = new Date();
    const mmdd = `-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const vendors = await Vendor.find({
      dob: { $regex: mmdd + "$" },
      deleted: { $ne: true },
      blocked: { $ne: true },
    })
      .select("phone email name businessName")
      .lean();
    vendors.forEach((v) => {
      send("mua_bday", { phone: v.phone, email: v.email, name: v.businessName || v.name });
    });
    console.log(`[birthdayReminder] ${vendors.length} vendor birthdays`);
  } catch (err) {
    console.error("[birthdayReminder] error:", err.message);
  }
};

module.exports = {
  remindVendorDMinus1,
  remindVendorDDay,
  reviewReminder,
  artistDetailReminder,
  birthdayReminder,
};
