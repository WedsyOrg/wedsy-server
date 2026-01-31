const User = require("../models/User");
const Order = require("../models/Order");
const Vendor = require("../models/Vendor");
const VendorStatLog = require("../models/VendorStatLog");
const { default: mongoose } = require("mongoose");
const Chat = require("../models/Chat");
const Payment = require("../models/Payment");

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const monthKeyFromDate = (d) => `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;

const safeDateOnly = (d) => {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  return d.toISOString().split("T")[0];
};

const parseDateString = (val) => {
  if (!val) return null;
  const d = new Date(val);
  if (!Number.isNaN(d.getTime())) return d;
  // handle common YYYY-MM-DD strings explicitly
  if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
    const d2 = new Date(`${val}T00:00:00.000Z`);
    if (!Number.isNaN(d2.getTime())) return d2;
  }
  return null;
};

const orderEffectiveDate = (order) => {
  if (!order) return null;
  if (order.source === "Wedsy-Package") {
    return parseDateString(order?.wedsyPackageBooking?.date);
  }
  if (order.source === "Personal-Package") {
    return parseDateString(order?.vendorPersonalPackageBooking?.date);
  }
  if (order.source === "Bidding") {
    const events = order?.biddingBooking?.events || [];
    let best = null;
    for (const ev of events) {
      const d = parseDateString(ev?.date);
      if (!d) continue;
      if (!best || d < best) best = d;
    }
    return best;
  }
  return null;
};

const orderAmountTotal = (order) => {
  const n = Number(order?.amount?.total ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const GetStatistics = async (req, res) => {
  const { user_id, user, isAdmin, isVendor } = req.auth;
  const { key } = req.query;
  if (isAdmin) {
    if (key === "vendor-business-monthly") {
      const { vendor } = req.query;
      try {
        const vendorInfo = await Vendor.findOne({ _id: vendor });
        const registrationDate = new Date(vendorInfo?.registrationDate);
        const currentDate = new Date();
        const stats = [];
        while (registrationDate <= currentDate) {
          // Append month to list
          stats.push({
            month: `${MONTH_NAMES[registrationDate.getMonth()]} ${registrationDate.getFullYear()}`,
            wedsyPackagesAmount: 0,
            personalPackagesAmount: 0,
            biddingAmount: 0,
            wedsyPackagesCount: 0,
            personalPackagesCount: 0,
            biddingCount: 0,
          });
          registrationDate.setMonth(registrationDate.getMonth() + 1);
        }

        // Fill real counts/amounts from vendor orders (finalized only)
        const vendorOrders = await Order.find({
          vendor: new mongoose.Types.ObjectId(vendor),
          "status.finalized": true,
        })
          .populate("wedsyPackageBooking vendorPersonalPackageBooking biddingBooking")
          .lean();

        const monthIndex = new Map(stats.map((s, idx) => [s.month, idx]));
        for (const o of vendorOrders) {
          const d = orderEffectiveDate(o);
          if (!d) continue;
          const key = monthKeyFromDate(d);
          const idx = monthIndex.get(key);
          if (idx === undefined) continue;
          const amt = orderAmountTotal(o);
          if (o.source === "Wedsy-Package") {
            stats[idx].wedsyPackagesCount += 1;
            stats[idx].wedsyPackagesAmount += amt;
          } else if (o.source === "Personal-Package") {
            stats[idx].personalPackagesCount += 1;
            stats[idx].personalPackagesAmount += amt;
          } else if (o.source === "Bidding") {
            stats[idx].biddingCount += 1;
            stats[idx].biddingAmount += amt;
          }
        }

        res.send({ message: "success", stats });
      } catch (error) {
        console.error("Error fetching vendor stats:", error);
        res.send({ message: "error", error });
      }
    } else if (key === "vendor-orders-day") {
      const { vendor, day } = req.query;
      try {
        const now = new Date();
        const target = new Date(now);
        if (day === "tomorrow") target.setDate(target.getDate() + 1);
        const targetISO = safeDateOnly(target);

        const vendorOrders = await Order.find({
          vendor: new mongoose.Types.ObjectId(vendor),
          "status.finalized": true,
          source: { $in: ["Wedsy-Package", "Personal-Package", "Bidding"] },
        })
          .populate("wedsyPackageBooking vendorPersonalPackageBooking biddingBooking")
          .lean();

        let wedsyPackages = 0;
        let personalPackages = 0;
        let bidding = 0;

        for (const o of vendorOrders) {
          const d = orderEffectiveDate(o);
          if (!d) continue;
          if (safeDateOnly(d) !== targetISO) continue;
          if (o.source === "Wedsy-Package") wedsyPackages += 1;
          else if (o.source === "Personal-Package") personalPackages += 1;
          else if (o.source === "Bidding") bidding += 1;
        }

        res.send({
          message: "success",
          stats: { wedsyPackages, personalPackages, bidding },
        });
      } catch (error) {
        console.error("Error fetching vendor day orders:", error);
        res.send({ message: "error", error });
      }
    } else if (key === "vendor-analytics") {
      const { vendor } = req.query;
      try {
        const stats = await VendorStatLog.aggregate([
          {
            $match: { vendor: new mongoose.Types.ObjectId(vendor) }, // Filter by vendor
          },
          {
            $group: {
              _id: {
                month: { $month: "$createdAt" },
                year: { $year: "$createdAt" },
              },
              calls: {
                $sum: {
                  $cond: [{ $eq: ["$statType", "call"] }, 1, 0],
                },
              },
              chats: {
                $sum: {
                  $cond: [{ $eq: ["$statType", "chat"] }, 1, 0],
                },
              },
            },
          },
          {
            $project: {
              _id: 0,
              month: "$_id.month",
              year: "$_id.year",
              calls: 1,
              chats: 1,
            },
          },
          { $sort: { year: 1, month: 1 } }, // Sort by year and month
        ]);
        res.send({ message: "success", stats });
      } catch (error) {
        console.error("Error fetching vendor stats:", error);
        res.send({ message: "error", error });
      }
    } else if (key === "total-ongoing-chats") {
      const totalOngoingChats = await Chat.countDocuments();
      res.send({ message: "success", stats: totalOngoingChats });
    } else if (key === "total-vendors") {
      const totalVendors = await Vendor.countDocuments();
      res.send({ message: "success", stats: totalVendors });
    } else if (key === "total-users") {
      const totalVendors = await User.countDocuments();
      res.send({ message: "success", stats: totalVendors });
    } else if (key === "today-order-wedsy-packages") {
      let stats = 0;
      const today = new Date().toISOString().split("T")[0];
      const finalizedOrders = await Order.find({
        source: "Wedsy-Package",
        "status.finalized": true,
      }).populate("wedsyPackageBooking");
      const finalizedForToday = finalizedOrders.filter(
        (order) =>
          order.wedsyPackageBooking &&
          new Date(order.wedsyPackageBooking.date)
            .toISOString()
            .split("T")[0] === today
      );
      stats = finalizedForToday.length;
      res.send({ message: "success", stats });
    } else if (key === "today-order-personal-packages") {
      let stats = 0;
      const today = new Date().toISOString().split("T")[0];
      const finalizedOrders = await Order.find({
        source: "Personal-Package",
        "status.finalized": true,
      }).populate("vendorPersonalPackageBooking");
      const finalizedForToday = finalizedOrders.filter(
        (order) =>
          order.vendorPersonalPackageBooking &&
          new Date(order.vendorPersonalPackageBooking.date)
            .toISOString()
            .split("T")[0] === today
      );
      stats = finalizedForToday.length;
      res.send({ message: "success", stats });
    } else if (key === "today-order-bidding") {
      let stats = 0;
      const today = new Date().toISOString().split("T")[0];
      const finalizedOrders = await Order.find({
        source: "Bidding",
        "status.finalized": true,
      }).populate("biddingBooking");
      const finalizedForToday = finalizedOrders.filter(
        (order) =>
          order.biddingBooking &&
          order.biddingBooking?.events?.some(
            (event) =>
              new Date(event.date).toISOString().split("T")[0] === today
          )
      );
      stats = finalizedForToday.length;
      res.send({ message: "success", stats });
    } else if (key === "tomorrow-order-wedsy-packages") {
      let stats = 0;
      const tomorrowDate = new Date();
      tomorrowDate.setDate(tomorrowDate.getDate() + 1);
      const tomorrow = tomorrowDate.toISOString().split("T")[0];
      const finalizedOrders = await Order.find({
        source: "Wedsy-Package",
        "status.finalized": true,
      }).populate("wedsyPackageBooking");
      const finalizedForTomorrow = finalizedOrders.filter(
        (order) =>
          order.wedsyPackageBooking &&
          new Date(order.wedsyPackageBooking.date)
            .toISOString()
            .split("T")[0] === tomorrow
      );
      stats = finalizedForTomorrow.length;
      res.send({ message: "success", stats });
    } else if (key === "tomorrow-order-personal-packages") {
      let stats = 0;
      const tomorrowDate = new Date();
      tomorrowDate.setDate(tomorrowDate.getDate() + 1);
      const tomorrow = tomorrowDate.toISOString().split("T")[0];
      const finalizedOrders = await Order.find({
        source: "Personal-Package",
        "status.finalized": true,
      }).populate("vendorPersonalPackageBooking");
      const finalizedForTomorrow = finalizedOrders.filter(
        (order) =>
          order.vendorPersonalPackageBooking &&
          new Date(order.vendorPersonalPackageBooking.date)
            .toISOString()
            .split("T")[0] === tomorrow
      );
      stats = finalizedForTomorrow.length;
      res.send({ message: "success", stats });
    } else if (key === "tomorrow-order-bidding") {
      let stats = 0;
      const tomorrowDate = new Date();
      tomorrowDate.setDate(tomorrowDate.getDate() + 1);
      const tomorrow = tomorrowDate.toISOString().split("T")[0];
      const finalizedOrders = await Order.find({
        source: "Bidding",
        "status.finalized": true,
      }).populate("biddingBooking");
      const finalizedForTomorrow = finalizedOrders.filter(
        (order) =>
          order.biddingBooking &&
          order.biddingBooking?.events?.some(
            (event) =>
              new Date(event.date).toISOString().split("T")[0] === tomorrow
          )
      );
      stats = finalizedForTomorrow.length;
      res.send({ message: "success", stats });
    } else if (key === "makeup-payments-total-today") {
      let stats = 0;
      const now = new Date();
      const startOfToday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate()
      );
      const startOfTomorrow = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1
      );
      const paymentsTotalToday = await Payment.aggregate([
        {
          $match: {
            status: "paid",
            paymentFor: "makeup-and-beauty",
            createdAt: { $gte: startOfToday, $lt: startOfTomorrow },
          },
        },
        {
          $group: { _id: null, totalAmount: { $sum: "$amountPaid" } },
        },
      ])
        .then((result) => {
          const totalToday = result[0] ? result[0].totalAmount : 0;
          return totalToday;
        })
        .catch((err) => {
          console.error(err);
        });
      stats = paymentsTotalToday / 100;
      res.send({ message: "success", stats });
    } else if (key === "makeup-payments-total-month") {
      let stats = 0;
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfNextMonth = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        1
      );
      const paymentsTotalMonth = await Payment.aggregate([
        {
          $match: {
            status: "paid",
            paymentFor: "makeup-and-beauty",
            createdAt: { $gte: startOfMonth, $lt: startOfNextMonth },
          },
        },
        {
          $group: { _id: null, totalAmount: { $sum: "$amountPaid" } },
        },
      ])
        .then((result) => {
          const totalMonth = result[0] ? result[0].totalAmount : 0;
          return totalMonth;
        })
        .catch((err) => {
          console.error(err);
        });
      stats = paymentsTotalMonth / 100;
      res.send({ message: "success", stats });
    } else if (key === "makeup-payments-total-overall") {
      let stats = 0;
      const paymentsTotalOverall = await Payment.aggregate([
        {
          $match: {
            status: "paid",
            paymentFor: "makeup-and-beauty",
          },
        },
        {
          $group: { _id: null, totalAmount: { $sum: "$amountPaid" } },
        },
      ])
        .then((result) => {
          const totalOverall = result[0] ? result[0].totalAmount : 0;
          return totalOverall;
        })
        .catch((err) => {
          console.error(err);
        });
      stats = paymentsTotalOverall / 100;
      res.send({ message: "success", stats });
    } else {
      res.send({ message: "failure" });
    }
  } else if (isVendor) {
    res.send({ message: "failure" });
  } else {
    res.send({ message: "failure" });
  }
};

const GetStatisticsList = async (req, res) => {
  const { user_id, user, isAdmin, isVendor } = req.auth;
  const { key } = req.query;
  if (isAdmin) {
    if (key === "vendor-call") {
      const { vendor } = req.query;
      try {
        const list = await VendorStatLog.find({
          vendor,
          statType: "call",
        }).populate("user", "name email phone");
        res.send({ message: "success", list });
      } catch (error) {
        console.error("Error fetching vendor stats:", error);
        res.send({ message: "error", error });
      }
    } else {
      res.send({ message: "failure" });
    }
  } else if (isVendor) {
    // Vendor can view their own call list
    if (key === "vendor-call") {
      try {
        const list = await VendorStatLog.find({
          vendor: user_id,
          statType: "call",
        }).populate("user", "name email phone");
        res.send({ message: "success", list });
      } catch (error) {
        console.error("Error fetching vendor call stats:", error);
        res.send({ message: "error", error });
      }
    } else {
      res.send({ message: "failure" });
    }
  } else {
    res.send({ message: "failure" });
  }
};

const AddStatLog = async (req, res) => {
  const { user_id, user, isAdmin, isVendor } = req.auth;
  const { key } = req.query;
  if (isAdmin) {
    res.send({ message: "failure" });
  } else if (isVendor) {
    res.send({ message: "failure" });
  } else {
    if (key === "vendor-call") {
      const { vendor } = req.body;
      new VendorStatLog({
        vendor,
        user: user_id,
        statType: "call",
      })
        .save()
        .then((result) => {
          res.status(201).send({ message: "success" });
        })
        .catch((error) => {
          res.status(400).send({ message: "error", error });
        });
    } else if (key === "vendor-chat") {
      const { vendor } = req.body;
      new VendorStatLog({
        vendor,
        user: user_id,
        statType: "chat",
      })
        .save()
        .then((result) => {
          res.status(201).send({ message: "success" });
        })
        .catch((error) => {
          res.status(400).send({ message: "error", error });
        });
    } else {
      res.send({ message: "failure" });
    }
  }
};

module.exports = { GetStatistics, AddStatLog, GetStatisticsList };
