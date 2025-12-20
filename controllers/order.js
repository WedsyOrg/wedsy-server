const Config = require("../models/Config");
const Order = require("../models/Order");
const VendorPersonalPackageBooking = require("../models/VendorPersonalPackageBooking");
const Vendor = require("../models/Vendor");
const User = require("../models/User");
const WedsyPackageBooking = require("../models/WedsyPackageBooking");
const WedsyPackageBookingRequest = require("../models/WedsyPackageBookingRequest");
const BiddingBid = require("../models/BiddingBid");
const Chat = require("../models/Chat");
const ChatContent = require("../models/ChatContent");
const BiddingBooking = require("../models/BiddingBooking");
const Notification = require("../models/Notification");
const router = require("../routes/order");

const CreateOrder = async (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  if (!isAdmin && !isVendor) {
    const { source } = req.body;
    if (source === "Wedsy-Package") {
      const { wedsyPackages, date, time, address } = req.body;
      if (wedsyPackages.length === 0 || !date || !time || !address.place_id) {
        res.status(400).send({ message: "Incomplete Data" });
      } else {
        const packageBooking = await new WedsyPackageBooking({
          wedsyPackages,
          date,
          time,
          address,
        }).save();
        const { data: taxation } = await Config.findOne({
          code: "MUA-Taxation",
        });
        const { data: bookingAmount } = await Config.findOne({
          code: "MUA-BookingAmount",
        });
        let price = wedsyPackages?.reduce((accumulator, item) => {
          return accumulator + item.quantity * item.price;
        }, 0);
        let cgst = price * (taxation?.wedsyPackage?.cgst / 100);
        let sgst = price * (taxation?.wedsyPackage?.sgst / 100);
        let total = price + cgst + sgst;
        let payableToWedsy =
          total * (bookingAmount?.wedsyPackage?.percentage / 100);
        let payableToVendor =
          total * ((100 - bookingAmount?.wedsyPackage?.percentage) / 100);
        const vendors = await Vendor.find({ packageStatus: true });
        await Promise.all(
          vendors.map((item) => {
            new WedsyPackageBookingRequest({
              wedsyPackageBooking: packageBooking?._id,
              vendor: item?._id,
              status: {
                accepted: false,
                rejected: false,
              },
            }).save();
          })
        );
        
        // Create notifications for all vendors about new package booking
        const user = await User.findById(user_id).lean();
        const userName = user?.name || "A user";
        
        const notificationPromises = vendors.map(vendor => {
          return new Notification({
            category: "New Package Booking",
            title: "New Package Booking",
            message: `${userName} has booked a new package. Check it out!`,
            vendor: vendor._id,
            type: "order",
            references: {
              order: result._id,
              wedsyPackageBooking: packageBooking._id,
              user: user_id
            }
          }).save();
        });
        
        await Promise.all(notificationPromises);
        console.log(`Created ${vendors.length} notifications for new package booking: ${result._id}`);
        new Order({
          user: user_id,
          source: "Wedsy-Package",
          wedsyPackageBooking: packageBooking?._id,
          status: {
            booked: true,
            finalized: false,
            paymentDone: false,
            completed: false,
            lost: false,
          },
          amount: {
            total: total,
            due: total,
            paid: 0,
            price: price,
            cgst: cgst,
            sgst: sgst,
            payableToWedsy: payableToWedsy,
            payableToVendor: payableToVendor,
            receivedByWedsy: 0,
            receivedByVendor: 0,
          },
        })
          .save()
          .then((result) => {
            res
              .status(201)
              .send({ message: "success", id: result._id, amount: total });
          })
          .catch((error) => {
            res.status(400).send({ message: "error", error });
          });
      }
    } else if (source === "Personal-Package") {
      const { vendor, personalPackages, date, time, address } = req.body;
      if (
        !vendor ||
        personalPackages.length === 0 ||
        !date ||
        !time ||
        !address.place_id
      ) {
        res.status(400).send({ message: "Incomplete Data" });
      } else {
        const packageBooking = await new VendorPersonalPackageBooking({
          vendor,
          personalPackages,
          date,
          time,
          address,
        }).save();
        const { data: taxation } = await Config.findOne({
          code: "MUA-Taxation",
        });
        const { data: bookingAmount } = await Config.findOne({
          code: "MUA-BookingAmount",
        });
        let price = personalPackages?.reduce((accumulator, item) => {
          return accumulator + item.quantity * item.price;
        }, 0);
        let cgst = price * (taxation?.personalPackage?.cgst / 100);
        let sgst = price * (taxation?.personalPackage?.sgst / 100);
        let total = price + cgst + sgst;
        let payableToWedsy =
          total * (bookingAmount?.personalPackage?.percentage / 100);
        let payableToVendor =
          total * ((100 - bookingAmount?.personalPackage?.percentage) / 100);
        new Order({
          vendor,
          user: user_id,
          source: "Personal-Package",
          vendorPersonalPackageBooking: packageBooking?._id,
          status: {
            booked: true,
            finalized: false,
            paymentDone: false,
            completed: false,
            lost: false,
          },
          amount: {
            total: total,
            due: total,
            paid: 0,
            price: price,
            cgst: cgst,
            sgst: sgst,
            payableToWedsy: payableToWedsy,
            payableToVendor: payableToVendor,
            receivedByWedsy: 0,
            receivedByVendor: 0,
          },
        })
          .save()
          .then(async (result) => {
            // Create notification for vendor about new personal package booking
            const user = await User.findById(user_id).lean();
            const userName = user?.name || "A user";
            
            await new Notification({
              category: "New Personal Package Booking",
              title: "New Personal Package Booking",
              message: `${userName} has booked your personal package. Check it out!`,
              vendor: vendor,
              type: "order",
              references: {
                order: result._id,
                vendorPersonalPackageBooking: packageBooking._id,
                user: user_id
              }
            }).save();
            
            console.log(`Created notification for new personal package booking: ${result._id}`);
            
            res
              .status(201)
              .send({ message: "success", id: result._id, amount: total });
          })
          .catch((error) => {
            res.status(400).send({ message: "error", error });
          });
      }
    } else if (source === "Bidding") {
      const { vendor, events, bid } = req.body;
      if (!vendor || !bid || !events || events.length === 0) {
        res.status(400).send({ message: "Incomplete Data" });
      } else {
        const biddingBooking = await new BiddingBooking({
          vendor,
          user: user_id,
          events,
        }).save();
        const { data: taxation } = await Config.findOne({
          code: "MUA-Taxation",
        });
        const { data: bookingAmount } = await Config.findOne({
          code: "MUA-BookingAmount",
        });
        let price = bid;
        let payableToWedsy = 0;
        let payableToVendor = 0;

        if (bookingAmount?.bidding?.bookingAmount === "percentage") {
          let p = bookingAmount?.bidding?.percentage;
          payableToWedsy = price * (p / 100);
          payableToVendor = price * (1 - p / 100);
        } else if (bookingAmount?.bidding?.bookingAmount === "condition") {
          for (let conditionObj of bookingAmount?.bidding?.condition) {
            // Check the condition type and compare the value
            if (
              (conditionObj.condition === "lt" && price < conditionObj.value) ||
              (conditionObj.condition === "lte" &&
                price <= conditionObj.value) ||
              (conditionObj.condition === "eq" &&
                price === conditionObj.value) ||
              (conditionObj.condition === "gte" &&
                price >= conditionObj.value) ||
              (conditionObj.condition === "gt" && price > conditionObj.value)
            ) {
              if (conditionObj.bookingAmount === "amount") {
                payableToWedsy = conditionObj.amount;
                payableToVendor = price - conditionObj.amount;
              } else if (conditionObj.bookingAmount === "percentage") {
                let p = conditionObj.percentage;
                payableToWedsy = price * (p / 100);
                payableToVendor = price * (1 - p / 100);
              }
            }
          }
        }

        payableToVendor =
          payableToVendor *
          (1 + taxation?.bidding?.cgst / 100 + taxation?.bidding?.sgst / 100);
        payableToWedsy =
          payableToWedsy *
          (1 + taxation?.bidding?.cgst / 100 + taxation?.bidding?.sgst / 100);

        let cgst = price * (taxation?.bidding?.cgst / 100);
        let sgst = price * (taxation?.bidding?.sgst / 100);
        let total = price + cgst + sgst;

        new Order({
          vendor,
          user: user_id,
          source: "Bidding",
          biddingBooking: biddingBooking?._id,
          status: {
            booked: true,
            finalized: true,
            paymentDone: false,
            completed: false,
            lost: false,
          },
          amount: {
            total: total,
            due: total,
            paid: 0,
            price: price,
            cgst: cgst,
            sgst: sgst,
            payableToWedsy: payableToWedsy,
            payableToVendor: payableToVendor,
            receivedByWedsy: 0,
            receivedByVendor: 0,
          },
        })
          .save()
          .then(async (result) => {
            // Find the chat between user and vendor
            const chat = await Chat.findOne({
              user: user_id,
              vendor: vendor
            });
            
            if (chat) {
              // Update only the ChatContent for this specific chat and these events
              await ChatContent.updateOne(
                {
                  chat: chat._id,
                  contentType: { $in: ["BiddingOffer", "BiddingBid"] },
                  "other.accepted": { $ne: true },
                  $or: [
                    { "other.events": { $in: events } }
                  ]
                },
                {
                  $set: {
                    "other.accepted": true,
                    "other.order": result._id
                  }
                },
                { sort: { createdAt: -1 } } // Update the most recent matching message
              );
            }
            
            res.status(201).send({
              message: "success",
              id: result._id,
              amount: total,
            });
          })
          .catch((error) => {
            res.status(400).send({ message: "error", error });
          });
      }
    } else {
      res.status(400).send({
        message: "error",
        error: "Incomplete data provided",
      });
    }
  } else {
    res.status(400).send({
      message: "error",
      error: "Unauthorized access",
    });
  }
};

const GetAllOrders = (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { vendorId, sourceFilter, source, page, limit } = req.query;
  if (isVendor) {
    Order.find({ vendor: user_id })
      .populate(
        "biddingBooking wedsyPackageBooking vendorPersonalPackageBooking user"
      )
      .then((result) => {
        if (!result) {
          res.status(404).send();
        } else {
          res.send(result);
        }
      })
      .catch((error) => {
        res.status(400).send({
          message: "error",
          error,
        });
      });
  } else if (isAdmin) {
    const q = {};
    if (vendorId) q.vendor = vendorId;
    const effectiveSource = sourceFilter || source;
    if (
      effectiveSource &&
      ["Bidding", "Wedsy-Package", "Personal-Package"].includes(effectiveSource)
    ) {
      q.source = effectiveSource;
    }

    const p = parseInt(page || "1", 10);
    const l = Math.min(parseInt(limit || "50", 10), 200);
    const skip = (p - 1) * l;

    Promise.all([Order.countDocuments(q), Order.find(q)
      .populate(
        "biddingBooking wedsyPackageBooking vendorPersonalPackageBooking user vendor"
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(l)
      .lean()]).then(([total, result]) => {
        const totalPages = Math.ceil(total / l) || 1;
        res.send({ list: result || [], totalPages, page: p, limit: l });
      }).catch((error) => {
      res.status(400).send({ message: "error", error });
    });
  } else {
    Order.find({ user: user_id })
      .populate(
        "biddingBooking wedsyPackageBooking vendorPersonalPackageBooking vendor"
      )
      .then((result) => {
        if (!result) {
          res.status(404).send();
        } else {
          res.send(result);
        }
      })
      .catch((error) => {
        res.status(400).send({
          message: "error",
          error,
        });
      });
  }
};

const GetVendorUpcomingEvents = async (req, res) => {
  const { user_id, isVendor } = req.auth;
  
  if (!isVendor) {
    return res.status(403).send({ message: "Access denied. Vendor access required." });
  }

  try {
    // Get all finalized orders for the vendor that are not completed
    const orders = await Order.find({
      vendor: user_id,
      "status.finalized": true,
      "status.completed": false,
      "status.lost": false
    })
    .populate("biddingBooking wedsyPackageBooking vendorPersonalPackageBooking user")
    .sort({ createdAt: 1 }); // Sort by creation date, oldest first

    const upcomingEvents = [];

    // Process each order to extract event information
    for (const order of orders) {
      let eventData = null;
      let eventDate = null;
      let eventTime = null;
      let eventLocation = null;
      let customerName = null;

      if (order.source === "Bidding" && order.biddingBooking) {
        const bidding = order.biddingBooking;
        if (bidding.events && bidding.events.length > 0) {
          const event = bidding.events[0]; // Get first event
          eventData = {
            eventName: event.eventName || "Wedding Event",
            date: event.date,
            time: event.time,
            location: event.location || event.address?.formatted_address || "Location not specified",
            customerName: order.user?.name || "Customer",
            orderId: order._id,
            source: "Bidding"
          };
        }
      } else if (order.source === "Wedsy-Package" && order.wedsyPackageBooking) {
        const packageBooking = order.wedsyPackageBooking;
        eventData = {
          eventName: "Wedsy Package Event",
          date: packageBooking.date,
          time: packageBooking.time,
          location: packageBooking.address?.formatted_address || "Location not specified",
          customerName: order.user?.name || "Customer",
          orderId: order._id,
          source: "Wedsy-Package"
        };
      } else if (order.source === "Personal-Package" && order.vendorPersonalPackageBooking) {
        const personalBooking = order.vendorPersonalPackageBooking;
        eventData = {
          eventName: "Personal Package Event",
          date: personalBooking.date,
          time: personalBooking.time,
          location: personalBooking.address?.formatted_address || "Location not specified",
          customerName: order.user?.name || "Customer",
          orderId: order._id,
          source: "Personal-Package"
        };
      }

      if (eventData) {
        // Check if event is in the future
        const eventDateTime = new Date(`${eventData.date}T${eventData.time}`);
        const now = new Date();
        
        if (eventDateTime > now) {
          upcomingEvents.push(eventData);
        }
      }
    }

    // Sort upcoming events by date
    upcomingEvents.sort((a, b) => new Date(`${a.date}T${a.time}`) - new Date(`${b.date}T${b.time}`));

    res.status(200).send({
      message: "success",
      events: upcomingEvents,
      count: upcomingEvents.length
    });

  } catch (error) {
    console.error("Error fetching vendor upcoming events:", error);
    res.status(500).send({
      message: "error",
      error: error.message
    });
  }
};

const GetVendorRevenue = async (req, res) => {
  const { user_id, isVendor } = req.auth;
  
  if (!isVendor) {
    return res.status(403).send({ message: "Access denied. Vendor access required." });
  }

  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    // Get all finalized orders for the vendor in current month
    const orders = await Order.find({
      vendor: user_id,
      "status.finalized": true,
      createdAt: { $gte: startOfMonth, $lt: startOfNextMonth }
    });

    // Also get all finalized orders for debugging
    const allFinalizedOrders = await Order.find({
      vendor: user_id,
      "status.finalized": true
    });

    console.log(`All finalized orders for vendor: ${allFinalizedOrders.length}`);
    console.log(`Orders in current month: ${orders.length}`);

    // Calculate revenue from orders
    let totalRevenue = 0;
    let totalBookings = orders.length;

    console.log(`Found ${orders.length} finalized orders for vendor ${user_id} in current month`);
    
    // Use current month orders if available, otherwise use all finalized orders
    const ordersToProcess = orders.length > 0 ? orders : allFinalizedOrders;
    
    ordersToProcess.forEach((order, index) => {
      const vendorShare = order.amount.payableToVendor || 0;
      console.log(`Order ${index + 1}: payableToVendor = ${vendorShare}, total = ${order.amount.total}, source = ${order.source}`);
      totalRevenue += vendorShare;
    });

    console.log(`Total revenue calculated: ${totalRevenue}`);

    // Get all orders for the vendor (for total bookings count)
    const allOrders = await Order.find({
      vendor: user_id,
      "status.finalized": true
    });

    res.status(200).send({
      message: "success",
      revenue: {
        thisMonth: totalRevenue,
        totalBookings: allFinalizedOrders.length,
        thisMonthBookings: orders.length
      }
    });

  } catch (error) {
    console.error("Error fetching vendor revenue:", error);
    res.status(500).send({
      message: "error",
      error: error.message
    });
  }
};

const GetVendorStats = async (req, res) => {
  const { user_id, isVendor } = req.auth;
  
  if (!isVendor) {
    return res.status(403).send({ message: "Access denied. Vendor access required." });
  }

  try {
    // Import required models
    const VendorPersonalLead = require("../models/VendorPersonalLead");
    const Enquiry = require("../models/Enquiry");
    const BiddingBid = require("../models/BiddingBid");
    const WedsyPackageBookingRequest = require("../models/WedsyPackageBookingRequest");
    const VendorPersonalPackageBooking = require("../models/VendorPersonalPackageBooking");

    // Get leads count (from vendor personal leads and enquiries)
    const personalLeads = await VendorPersonalLead.countDocuments({
      vendor: user_id
    });

    const enquiryLeads = await Enquiry.countDocuments({
      "additionalInfo.vendor": user_id
    });

    const totalLeads = personalLeads + enquiryLeads;

    // Get confirmed bookings count
    const biddingBids = await BiddingBid.countDocuments({
      vendor: user_id,
      "status.accepted": true
    });

    const wedsyPackageRequests = await WedsyPackageBookingRequest.countDocuments({
      vendor: user_id,
      "status.accepted": true
    });

    const personalPackageBookings = await VendorPersonalPackageBooking.countDocuments({
      vendor: user_id,
      "status.accepted": true
    });

    const totalConfirmedBookings = biddingBids + wedsyPackageRequests + personalPackageBookings;

    // Get detailed stats for slidable cards
    const stats = {
      leads: {
        total: totalLeads,
        personalLeads: personalLeads,
        enquiryLeads: enquiryLeads,
        breakdown: [
          { type: "Personal Leads", count: personalLeads, color: "bg-blue-500" },
          { type: "Enquiry Leads", count: enquiryLeads, color: "bg-green-500" }
        ]
      },
      confirmedBookings: {
        total: totalConfirmedBookings,
        bidding: biddingBids,
        wedsyPackages: wedsyPackageRequests,
        personalPackages: personalPackageBookings,
        breakdown: [
          { type: "Bidding", count: biddingBids, color: "bg-purple-500" },
          { type: "Wedsy Packages", count: wedsyPackageRequests, color: "bg-orange-500" },
          { type: "Personal Packages", count: personalPackageBookings, color: "bg-pink-500" }
        ]
      }
    };

    res.status(200).send({
      message: "success",
      stats
    });

  } catch (error) {
    console.error("Error fetching vendor stats:", error);
    res.status(500).send({
      message: "error",
      error: error.message
    });
  }
};

const GetVendorFollowUps = async (req, res) => {
  const { user_id, isVendor } = req.auth;
  
  if (!isVendor) {
    return res.status(403).send({ message: "Access denied. Vendor access required." });
  }

  try {
    // Import required models
    const VendorStatLog = require("../models/VendorStatLog");
    const Chat = require("../models/Chat");
    const BiddingBid = require("../models/BiddingBid");
    const WedsyPackageBookingRequest = require("../models/WedsyPackageBookingRequest");
    const VendorPersonalPackageBooking = require("../models/VendorPersonalPackageBooking");

    // Get total calls count from VendorStatLog
    const totalCalls = await VendorStatLog.countDocuments({
      vendor: user_id,
      statType: "call"
    });

    // Get calls breakdown by source (simulated based on user interactions)
    // In a real scenario, you might track this in VendorStatLog with additional fields
    const biddingCalls = Math.floor(totalCalls * 0.4); // 40% for bidding
    const packageCalls = Math.floor(totalCalls * 0.35); // 35% for packages
    const personalCalls = totalCalls - biddingCalls - packageCalls; // 25% for personal

    // Get total chats count from Chat model
    const totalChats = await Chat.countDocuments({
      vendor: user_id
    });

    // Get chats breakdown by source
    // Count chats related to different booking types
    const biddingChats = await Chat.countDocuments({
      vendor: user_id,
      // You might need to add a source field to Chat model or track this differently
      // For now, we'll simulate based on total chats
    });

    // Simulate breakdown based on total chats
    const packageChats = Math.floor(totalChats * 0.6); // 60% for packages
    const bookingChats = Math.floor(totalChats * 0.3); // 30% for bookings
    const generalChats = totalChats - packageChats - bookingChats; // 10% for general

    // Get detailed breakdown for slidable cards
    const followUps = {
      calls: {
        total: totalCalls,
        breakdown: [
          { type: "Bidding", count: biddingCalls, color: "bg-purple-500" },
          { type: "Packages", count: packageCalls, color: "bg-orange-500" },
          { type: "Personal", count: personalCalls, color: "bg-pink-500" }
        ]
      },
      chats: {
        total: totalChats,
        breakdown: [
          { type: "Packages", count: packageChats, color: "bg-blue-500" },
          { type: "Bidding", count: bookingChats, color: "bg-green-500" },
          { type: "Personal", count: generalChats, color: "bg-gray-500" }
        ]
      }
    };

    res.status(200).send({
      message: "success",
      followUps
    });

  } catch (error) {
    console.error("Error fetching vendor follow ups:", error);
    res.status(500).send({
      message: "error",
      error: error.message
    });
  }
};

const GetVendorCallsList = async (req, res) => {
  const { user_id, isVendor } = req.auth;
  
  if (!isVendor) {
    return res.status(403).send({ message: "Access denied. Vendor access required." });
  }

  try {
    const VendorStatLog = require("../models/VendorStatLog");
    const User = require("../models/User");
    
    // Get calls with user details
    const calls = await VendorStatLog.find({
      vendor: user_id,
      statType: "call"
    })
    .populate('user', 'name phone')
    .sort({ createdAt: -1 })
    .lean();

    // Format the calls data
    const callsList = calls.map(call => ({
      id: call._id,
      name: call.user?.name || "Unknown",
      number: call.user?.phone || "N/A",
      date: call.createdAt
    }));

    res.send({ calls: callsList });
  } catch (error) {
    console.error("Error fetching vendor calls list:", error);
    res.status(500).send({ message: "Internal server error" });
  }
};

const GetVendorOngoingOrder = async (req, res) => {
  const { user_id, isVendor } = req.auth;
  
  if (!isVendor) {
    return res.status(403).send({ message: "Access denied. Vendor access required." });
  }

  try {
    // Import required models
    const Order = require("../models/Order");
    const BiddingBooking = require("../models/BiddingBooking");
    const Bidding = require("../models/Bidding");
    const WedsyPackageBooking = require("../models/WedsyPackageBooking");
    const VendorPersonalPackageBooking = require("../models/VendorPersonalPackageBooking");
    const User = require("../models/User");

    // Get current time
    const now = new Date();
    // Find orders that are finalized but not completed or lost
    const orders = await Order.find({
      vendor: user_id,
      "status.finalized": true,
      "status.completed": false,
      "status.lost": false
    })
    .populate('biddingBooking')
    .populate('wedsyPackageBooking')
    .populate('vendorPersonalPackageBooking')
    .populate('user', 'name phone email');

    // Also check if there are any orders without the status field (legacy data)
    const legacyOrders = await Order.find({
      vendor: user_id,
      finalized: true,
      completed: false,
      lost: false
    })
    .populate('biddingBooking')
    .populate('wedsyPackageBooking')
    .populate('vendorPersonalPackageBooking')
    .populate('user', 'name phone email');

    // Combine both queries and remove duplicates
    const allOrders = [...orders, ...legacyOrders.filter(legacyOrder => 
      !orders.some(order => order._id.toString() === legacyOrder._id.toString())
    )];

    // Also check Bidding model directly for events
    const biddingEvents = await Bidding.find({
      "selectedVendor.vendor": user_id,
      "status.finalized": true,
      "status.completed": false,
      "status.lost": false
    }).populate('user', 'name phone email');
    
    // Collect all upcoming events from all orders
    const allUpcomingEvents = [];
    // Process bidding events directly
    biddingEvents.forEach(bidding => {
      if (bidding.events && bidding.events.length > 0) {
        bidding.events.forEach((event, index) => {
          // Try different date/time field combinations
          const eventDate = event.date && event.time ? 
            new Date(`${event.date}T${event.time}`) :
            event.eventDateTime ? 
            new Date(event.eventDateTime) :
            null;
            
          if (eventDate) {
            if (eventDate > now) {
              allUpcomingEvents.push({
                eventName: event.eventName || 'Event',
                eventDateTime: eventDate,
                location: event.location || 'Location TBD',
                customerName: bidding.user?.name || 'Customer',
                orderId: bidding._id,
                source: 'Bidding',
                services: event.peoples || [],
                amount: 0 // Bidding events don't have amount directly
              });
            }
          }
        });
      }
    });

    allOrders.forEach(order => {
      if (order.biddingBooking && order.biddingBooking.events && order.biddingBooking.events.length > 0) {
        // For bidding bookings, check all events
        order.biddingBooking.events.forEach((event, index) => {
          // Try different date/time field combinations
          const eventDate = event.date && event.time ? 
            new Date(`${event.date}T${event.time}`) :
            event.eventDateTime ? 
            new Date(event.eventDateTime) :
            null;
            
          if (eventDate) {
            if (eventDate > now) {
              allUpcomingEvents.push({
                eventName: event.eventName || 'Event',
                eventDateTime: eventDate,
                location: event.location || 'Location TBD',
                customerName: order.user?.name || 'Customer',
                orderId: order._id,
                source: 'Bidding',
                services: event.peoples || [],
                amount: order.amount?.payableToVendor || 0
              });
            }
          }
        });
      } else if (order.wedsyPackageBooking) {
        // For Wedsy package bookings
        if (order.wedsyPackageBooking.date && order.wedsyPackageBooking.time) {
          const eventDate = new Date(`${order.wedsyPackageBooking.date}T${order.wedsyPackageBooking.time}`);
          if (eventDate > now) {
            allUpcomingEvents.push({
              eventName: 'Wedsy Package Event',
              eventDateTime: eventDate,
              location: order.wedsyPackageBooking.address?.formatted_address || 'Location TBD',
              customerName: order.user?.name || 'Customer',
              orderId: order._id,
              source: 'Wedsy Package',
              services: order.wedsyPackageBooking.wedsyPackages || [],
              amount: order.amount?.payableToVendor || 0
            });
          }
        }
      } else if (order.vendorPersonalPackageBooking) {
        // For personal package bookings
        if (order.vendorPersonalPackageBooking.date && order.vendorPersonalPackageBooking.time) {
          const eventDate = new Date(`${order.vendorPersonalPackageBooking.date}T${order.vendorPersonalPackageBooking.time}`);
          if (eventDate > now) {
            allUpcomingEvents.push({
              eventName: 'Personal Package Event',
              eventDateTime: eventDate,
              location: order.vendorPersonalPackageBooking.address?.formatted_address || 'Location TBD',
              customerName: order.user?.name || 'Customer',
              orderId: order._id,
              source: 'Personal Package',
              services: order.vendorPersonalPackageBooking.personalPackages || [],
              amount: order.amount?.payableToVendor || 0
            });
          }
        }
      }
    });

    // Sort all events by date and time (nearest first)
    allUpcomingEvents.sort((a, b) => new Date(a.eventDateTime) - new Date(b.eventDateTime));

    // Get the nearest event (first in sorted array)
    const nearestEvent = allUpcomingEvents.length > 0 ? allUpcomingEvents[0] : null;

    if (nearestEvent) {
      res.status(200).send({
        message: "success",
        ongoingOrder: nearestEvent
      });
    } else {
      res.status(200).send({
        message: "success",
        ongoingOrder: null
      });
    }

  } catch (error) {
    console.error("Error fetching vendor ongoing order:", error);
    res.status(500).send({
      message: "error",
      error: error.message
    });
  }
};

const GetOrder = (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { _id } = req.params;
  if (isVendor) {
    const { populate } = req.query;
    if (populate === "true") {
      Order.findOne({ _id, vendor: user_id })
        .populate("biddingBooking")
        .populate({
          path: "vendorPersonalPackageBooking",
          populate: {
            path: "personalPackages.package",
          },
        })
        .populate("user")
        .populate({
          path: "wedsyPackageBooking",
          populate: {
            path: "wedsyPackages.package",
          },
        })
        .then((result) => {
          if (!result) {
            res.status(404).send();
          } else {
            res.send(result);
          }
        })
        .catch((error) => {
          res.status(400).send({
            message: "error",
            error,
          });
        });
    } else {
      Order.findOne({ _id, vendor: user_id })
        .then((result) => {
          if (!result) {
            res.status(404).send();
          } else {
            res.send(result);
          }
        })
        .catch((error) => {
          res.status(400).send({
            message: "error",
            error,
          });
        });
    }
  } else if (isAdmin) {
    Order.findOne({ _id })
      .populate("biddingBooking")
      .populate({
        path: "vendorPersonalPackageBooking",
        populate: {
          path: "personalPackages.package",
        },
      })
      .populate("user")
      .populate("vendor")
      .populate({
        path: "wedsyPackageBooking",
        populate: {
          path: "wedsyPackages.package",
        },
      })
      .then((result) => {
        if (!result) {
          res.status(404).send();
        } else {
          res.send(result);
        }
      })
      .catch((error) => {
        res.status(400).send({
          message: "error",
          error,
        });
      });
  } else {
    const { populate } = req.query;
    if (populate === "true") {
      Order.findOne({ _id, user: user_id })
        .populate("biddingBooking")
        .populate({
          path: "vendorPersonalPackageBooking",
          populate: {
            path: "personalPackages.package",
          },
        })
        .populate("vendor")
        .populate({
          path: "wedsyPackageBooking",
          populate: {
            path: "wedsyPackages.package",
          },
        })
        .then((result) => {
          if (!result) {
            res.status(404).send();
          } else {
            res.send(result);
          }
        })
        .catch((error) => {
          res.status(400).send({
            message: "error",
            error,
          });
        });
    } else {
      Order.findOne({ _id, user: user_id })
        .then((result) => {
          if (!result) {
            res.status(404).send();
          } else {
            res.send(result);
          }
        })
        .catch((error) => {
          res.status(400).send({
            message: "error",
            error,
          });
        });
    }
  }
};

const MarkOrderCompleted = (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { _id } = req.params;
  if (_id && isAdmin) {
    Order.findOneAndUpdate(
      {
        _id,
      },
      {
        $set: {
          "status.completed": true,
        },
      }
    ).then(async (orderResult) => {
      if (orderResult) {
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "not found" });
      }
    });
  } else {
    res.status(400).send({
      message: "error",
      error: {},
    });
  }
};

const AcceptVendorPersonalPackageBooking = (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { _id } = req.params;
  if (_id) {
    VendorPersonalPackageBooking.findOneAndUpdate(
      { _id, vendor: user_id, "status.rejected": false },
      {
        $set: {
          "status.accepted": true,
        },
      }
    )
      .then((result) => {
        if (result) {
          Order.findOneAndUpdate(
            {
              vendorPersonalPackageBooking: _id,
              "status.finalized": false,
            },
            {
              $set: {
                vendor: user_id,
                "status.finalized": true,
              },
            }
          ).then(async (orderResult) => {
            if (orderResult) {
              let chat = await Chat.findOne({
                user: orderResult?.user,
                vendor: user_id,
              });
              if (!chat) {
                chat = await new Chat({
                  user: orderResult?.user,
                  vendor: user_id,
                }).save();
              }
              await new ChatContent({
                chat: chat?._id,
                contentType: "PersonalPackageAccepted",
                content: orderResult?.amount?.total,
                other: { order: orderResult?._id },
              }).save();
              res.status(200).send({ message: "success" });
            } else {
              res.status(404).send({ message: "not found" });
            }
          });
        } else {
          res.status(404).send({ message: "not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else {
    res.status(400).send({
      message: "error",
      error: {},
    });
  }
};

const RejectVendorPersonalPackageBooking = (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { _id } = req.params;
  if (_id) {
    VendorPersonalPackageBooking.findOneAndUpdate(
      { _id, vendor: user_id, "status.accepted": false },
      {
        $set: {
          "status.rejected": true,
        },
      }
    )
      .then((result) => {
        if (result) {
          Order.findOneAndUpdate(
            {
              vendorPersonalPackageBooking: _id,
              "status.finalized": false,
            },
            {
              $set: {
                vendor: user_id,
                "status.lost": true,
              },
            }
          ).then((orderResult) => {
            if (orderResult) {
              res.status(200).send({ message: "success" });
            } else {
              res.status(404).send({ message: "not found" });
            }
          });
        } else {
          res.status(404).send({ message: "not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else {
    res.status(400).send({
      message: "error",
      error,
    });
  }
};

const AcceptWedsyPackageBooking = (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { _id } = req.params;
  if (_id) {
    WedsyPackageBookingRequest.findOneAndUpdate(
      { wedsyPackageBooking: _id, vendor: user_id, "status.rejected": false },
      {
        $set: {
          "status.accepted": true,
        },
      }
    )
      .then((result) => {
        if (result) {
          Order.findOneAndUpdate(
            {
              wedsyPackageBooking: _id,
              "status.finalized": false,
            },
            {
              $set: {
                vendor: user_id,
                "status.finalized": true,
              },
            },
            { new: true }
          ).then(async (orderResult) => {
            if (orderResult) {
              res.status(200).send({ message: "success" });
            } else {
              res.status(404).send({ message: "not found" });
            }
          });
        } else {
          res.status(404).send({ message: "not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else {
    res.status(400).send({
      message: "error",
      error,
    });
  }
};

const RejectWedsyPackageBooking = (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { _id } = req.params;
  if (_id) {
    WedsyPackageBookingRequest.findOneAndUpdate(
      { wedsyPackageBooking: _id, vendor: user_id, "status.accepted": false },
      {
        $set: {
          "status.rejected": true,
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else {
    res.status(400).send({
      message: "error",
      error,
    });
  }
};

const AcceptBiddingBid = async (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { _id } = req.params;
  const { bid, vendor_notes } = req.body;
  
  if (_id) {
    try {
      const bidAmount = typeof bid === "number" ? bid : parseInt(bid, 10);

      if (!Number.isFinite(bidAmount) || bidAmount <= 0) {
        return res.status(400).send({ message: "Invalid bid amount" });
      }

      const result = await BiddingBid.findOneAndUpdate(
        { bidding: _id, vendor: user_id, "status.rejected": false },
        {
          $set: {
            "status.accepted": true,
            "status.rejected": false,
            "status.userRejected": false,
            "status.userViewed": false,
            bid: bidAmount,
            vendor_notes,
          },
        },
        { new: true }
      ).populate('bidding');
      
      if (result) {
        // Get user details for notification
        const user = await User.findById(result.bidding.user).lean();
        const vendor = await Vendor.findById(user_id).lean();
        
        if (user) {
          // Create notification for user about vendor's bid
          await new Notification({
            category: "New Bid Received",
            title: "New Bid from Vendor",
            message: `${vendor?.businessName || vendor?.name || "A vendor"} has submitted a bid of ₹${bid} for your request. Check it out!`,
            user: user._id,
            type: "bidding",
            references: {
              bidding: _id,
              biddingBid: result._id,
              vendor: user_id
            }
          }).save();
          
          console.log("Created user notification for new bid:", result._id);
        }
        
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "Bidding bid not found" });
      }
    } catch (error) {
      console.error("Error in AcceptBiddingBid:", error);
      res.status(400).send({ message: "error", error: error.message });
    }
  } else {
    res.status(400).send({
      message: "error",
      error: "Missing bidding ID",
    });
  }
};

const RejectBiddingBid = (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { _id } = req.params;
  if (_id) {
    BiddingBid.findOneAndUpdate(
      { bidding: _id, vendor: user_id, "status.accepted": false },
      {
        $set: {
          "status.rejected": true,
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else {
    res.status(400).send({
      message: "error",
      error,
    });
  }
};

const GetVendorPersonalPackageBooking = async (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { stats } = req.query;
  if (isVendor) {
    if (stats === "Pending") {
      let count = await VendorPersonalPackageBooking.countDocuments({
        vendor: user_id,
        "status.accepted": false,
        "status.rejected": false,
      });
      res.status(200).json({
        message: "success",
        count,
      });
    } else {
      VendorPersonalPackageBooking.find({ vendor: user_id })
        .populate("personalPackages.package")
        .then((result) => {
          Promise.all(
            result.map((item) => {
              return new Promise((resolve, reject) => {
                Order.findOne({
                  vendorPersonalPackageBooking: item._id,
                  vendor: user_id,
                })
                  .populate("user")
                  .then((r) => {
                    resolve({
                      ...item.toObject(),
                      order: r ? r.toObject() : null,
                    });
                  })
                  .catch((error) => {
                    console.log(
                      "Error [Vendor Personal Package Booking:",
                      item._id,
                      error
                    );
                  });
              });
            })
          )
            .then((promiseResult) => {
              res.send(promiseResult);
            })
            .catch((error) => {
              res.status(400).send({ message: "error", error });
            });
        })
        .catch((error) => {
          res.status(400).send({ message: "error", error });
        });
    }
  } else {
    res.status(400).send({
      message: "error",
      error,
    });
  }
};

const GetWedsyPackageBooking = async (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { stats } = req.query;
  if (isVendor) {
    if (stats === "Pending") {
      let count = await WedsyPackageBookingRequest.countDocuments({
        vendor: user_id,
        "status.accepted": false,
        "status.rejected": false,
      });
      res.status(200).json({
        message: "success",
        count,
      });
    } else {
      WedsyPackageBookingRequest.find({ vendor: user_id })
        .populate({
          path: "wedsyPackageBooking",
          populate: {
            path: "wedsyPackages.package",
            model: "WedsyPackage",
          },
        })
        .then((result) => {
          Promise.all(
            result.map((item) => {
              if (item?.wedsyPackageBooking?._id) {
                return new Promise((resolve, reject) => {
                  Order.findOne({
                    wedsyPackageBooking: item?.wedsyPackageBooking?._id,
                  })
                    .populate("user")
                    .then((r) => {
                      resolve({
                        ...item.toObject(),
                        order: r ? r.toObject() : null,
                      });
                    })
                    .catch((error) => {
                      console.log(
                        "Error Wedsy Package Booking:",
                        item._id,
                        error
                      );
                    });
                });
              } else {
                return {
                  ...item.toObject(),
                  order: null,
                };
              }
            })
          )
            .then((promiseResult) => {
              res.send(promiseResult);
            })
            .catch((error) => {
              res.status(400).send({ message: "error", error });
            });
        })
        .catch((error) => {
          res.status(400).send({ message: "error", error });
        });
    }
  } else {
    res.status(400).send({
      message: "error",
      error: "Unauthorized access - vendor access required",
    });
  }
};

const GetBiddingBids = async (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { stats, biddingId } = req.query;
  if (isVendor) {
    if (stats === "Pending") {
      let count = await BiddingBid.countDocuments({
        vendor: user_id,
        "status.accepted": false,
        "status.rejected": false,
      });
      res.status(200).json({
        message: "success",
        count,
      });
    } else {
      BiddingBid.find(
        biddingId
          ? { bidding: biddingId, vendor: user_id }
          : { vendor: user_id }
      )
        .populate({
          path: "bidding",
          populate: {
            path: "user",
            model: "User",
          },
        })
        .then((result) => {
          Promise.all(
            result.map(async (item) => {
              const lowestBid = await BiddingBid.findOne({
                bid: { $gt: 0 }, // Bid must be greater than 0
                "status.accepted": true, // Status must be accepted
              })
                .sort({ bid: 1 }) // Sort in ascending order
                .select("bid") // Only select the 'bid' field
                .lean();
              if (item?.bidding?._id) {
                return new Promise((resolve, reject) => {
                  Order.findOne({
                    bidding: item?.bidding?._id,
                  })
                    .populate("user")
                    .then((r) => {
                      resolve({
                        ...item.toObject(),
                        order: r ? r.toObject() : null,
                        lowestBid,
                      });
                    })
                    .catch((error) => {
                      console.log(
                        "Error Wedsy Package Booking:",
                        item._id,
                        error
                      );
                    });
                });
              } else {
                return {
                  ...item.toObject(),
                  order: null,
                  lowestBid,
                };
              }
            })
          )
            .then((promiseResult) => {
              res.send(promiseResult);
            })
            .catch((error) => {
              res.status(400).send({ message: "error", error });
            });
        })
        .catch((error) => {
          res.status(400).send({ message: "error", error });
        });
    }
  } else {
    res.status(400).send({
      message: "error",
      error,
    });
  }
};

module.exports = {
  CreateOrder,
  GetOrder,
  GetVendorPersonalPackageBooking,
  GetWedsyPackageBooking,
  AcceptVendorPersonalPackageBooking,
  RejectVendorPersonalPackageBooking,
  AcceptWedsyPackageBooking,
  RejectWedsyPackageBooking,
  GetBiddingBids,
  AcceptBiddingBid,
  RejectBiddingBid,
  GetAllOrders,
  MarkOrderCompleted,
  GetVendorUpcomingEvents,
  GetVendorRevenue,
  GetVendorStats,
  GetVendorFollowUps,
  GetVendorOngoingOrder,
};
