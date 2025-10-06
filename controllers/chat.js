const mongoose = require("mongoose");
const Chat = require("../models/Chat");
const ChatContent = require("../models/ChatContent");
const Notification = require("../models/Notification");
const User = require("../models/User");
const Vendor = require("../models/Vendor");
const Order = require("../models/Order");

// const CreateNew = (req, res) => {
//   const { title } = req.body;
//   if (!title) {
//     res.status(400).send({ message: "Incomplete Data" });
//   } else {
//     new Chat({
//       title,
//     })
//       .save()
//       .then((result) => {
//         res.status(201).send({ message: "success", id: result._id });
//       })
//       .catch((error) => {
//         res.status(400).send({ message: "error", error });
//       });
//   }
// };

const GetAll = async (req, res) => {
  try {
    const { user_id, isVendor, isAdmin } = req.auth;
    console.log("GetAll - Auth details:", { user_id, isVendor, isAdmin });
    console.log("GetAll - Match query will be:", isVendor ? { vendor: "ObjectId(" + user_id + ")" } : { user: "ObjectId(" + user_id + ")" });
    
    const match = {};
    if (isVendor) {
      match.vendor = new mongoose.Types.ObjectId(user_id);
      console.log("Vendor requesting chats for vendor ID:", user_id, "converted to ObjectId:", match.vendor);
      
    } else if (!isAdmin) {
      match.user = new mongoose.Types.ObjectId(user_id);
      console.log("User requesting chats for user ID:", user_id, "converted to ObjectId:", match.user);
    }

    const pipeline = [
      { $match: match },
      {
        $lookup: {
          from: "chatcontents",
          let: { chatId: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$chat", "$$chatId"] } } },
            { $sort: { createdAt: -1 } },
            { $limit: 1 },
          ],
          as: "lastMessage",
        },
      },
      {
        $lookup: {
          from: "chatcontents",
          let: { chatId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$chat", "$$chatId"] },
                $or: [
                  { "status.viewedByUser": false },
                  { "status.viewedByVendor": false },
                ],
              },
            },
            { $count: "count" },
          ],
          as: "unread",
        },
      },
      { $addFields: { lastMessage: { $arrayElemAt: ["$lastMessage", 0] } } },
      { $addFields: { unreadCount: { $ifNull: [{ $arrayElemAt: ["$unread.count", 0] }, 0] } } },
    ];

    let results = await Chat.aggregate(pipeline);
    console.log("Raw aggregation results:", results);
    
    if (isVendor) {
      results = await Chat.populate(results, { path: "user" });
      console.log("Vendor populated results:", results);
    } else if (!isAdmin) {
      results = await Chat.populate(results, { path: "vendor" });
    } else {
      results = await Chat.populate(results, { path: "vendor user" });
    }
    
    console.log("Final results being sent:", results);
    res.send(results);
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
};

const Get = (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { _id } = req.params;
  const { read } = req.query;
  
  console.log("Get - Auth details:", { user_id, isVendor, isAdmin });
  console.log("Get - Chat ID:", _id);
  const query = { _id };
  const filter = { chat: _id };
  const setUpdate = {};
  let populate = "";
  if (isVendor) {
    query.vendor = new mongoose.Types.ObjectId(user_id);
    populate = "user";
    setUpdate["status.viewedByVendor"] = true;
  } else if (!isAdmin) {
    query.user = new mongoose.Types.ObjectId(user_id);
    populate = "vendor";
    setUpdate["status.viewedByUser"] = true;
  }
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
  const before = req.query.before ? new Date(req.query.before) : null;
  const cutoff = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  const messageQuery = { chat: _id };
  // Always filter server response to only include messages from the last 60s
  if (before) {
    messageQuery.createdAt = { $lt: before, $gte: cutoff };
  } else {
    messageQuery.createdAt = { $gte: cutoff };
  }

  console.log("Get - Query:", query);
  console.log("Get - Message query:", messageQuery);
  
  // Soft-prune messages older than retention window for this chat
  try {
    const cutoff = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    await ChatContent.deleteMany({ chat: _id, createdAt: { $lt: cutoff } });
  } catch (_) {}

  Chat.findOne(query)
    .populate(populate)
    .lean()
    .then(async (chat) => {
      console.log("Get - Found chat:", chat ? "Yes" : "No");
      if (!chat) {
        console.log("Get - Chat not found, returning 404");
        return res.status(404).send({ message: "not found" });
      }
      const messages = await ChatContent.find(messageQuery)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      console.log("Get - Found messages:", messages?.length || 0);
      if (read === "true") {
        if (Object.keys(setUpdate).length > 0) {
          await ChatContent.updateMany(filter, { $set: setUpdate });
        }
      }
      const response = {
        ...chat,
        messages: messages || [],
      };
      console.log("Get - Sending response with", response.messages.length, "messages");
      res.send(response);
    })
    .catch((error) => {
      console.error("Get - Error:", error);
      res.status(400).send({
        message: "error",
        error,
      });
    });
};

const CreateNewChatContent = async (req, res) => {
  try {
    const { user_id, isVendor, isAdmin } = req.auth;
    const { _id } = req.params;
    const { contentType, content, other } = req.body;

    if (!contentType) {
      return res.status(400).send({ message: "Incomplete Data" });
    }

    if (!isVendor && !isAdmin && contentType === "Text") {
      const latestOffer = await ChatContent.findOne(
        {
          chat: _id,
          contentType: {
            $in: ["BiddingOffer", "BiddingBid", "PersonalPackageAccepted"],
          },
        },
        {},
        { sort: { createdAt: -1 } }
      ).lean();

      if (latestOffer) {
        const { contentType, other = {} } = latestOffer;

        let paymentOutstanding = false;

        if (contentType === "PersonalPackageAccepted") {
          if (!other?.order) {
            paymentOutstanding = true;
          } else {
            const order = await Order.findById(other.order)
              .select("amount due amount.due amount.paid status.paymentDone")
              .lean();
            const dueAmount =
              order?.amount?.due ?? order?.due ?? Number.POSITIVE_INFINITY;
            const paymentDone = Boolean(order?.status?.paymentDone);
            paymentOutstanding = !order || (!paymentDone && dueAmount > 0);
          }
        } else if (["BiddingOffer", "BiddingBid"].includes(contentType)) {
          const accepted = Boolean(other.accepted);
          const rejected = Boolean(other.rejected);
          
          // Check if payment is done for accepted bids
          if (accepted && other?.order) {
            const order = await Order.findById(other.order)
              .select("amount.due amount.paid status.paymentDone")
              .lean();
            const dueAmount =
              order?.amount?.due ?? Number.POSITIVE_INFINITY;
            const paymentDone = Boolean(order?.status?.paymentDone);
            paymentOutstanding = !order || (!paymentDone && dueAmount > 0);
          } else {
            paymentOutstanding = !accepted && !rejected;
          }
        }

        if (paymentOutstanding) {
          return res.status(403).send({
            message: "payment_required",
            error:
              "Complete the payment for the latest offer to continue chatting.",
          });
        }
      }
    }

    // Prune messages older than retention window whenever a new message is created
    try {
      const cutoff = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      await ChatContent.deleteMany({ chat: _id, createdAt: { $lt: cutoff } });
    } catch (_) {}

    if (contentType === "Text" && content) {
      const result = await new ChatContent({
        chat: _id,
        contentType,
        content,
        sender: {
          id: user_id,
          role: isVendor ? "vendor" : isAdmin ? "admin" : "user",
        },
        status: {
          viewedByUser: !isVendor && !isAdmin,
          viewedByVendor: isVendor,
        },
      }).save();

      if (result) {
        return res.status(200).send({ message: "success" });
      }

      return res.status(404).send({ message: "error" });
    }

    if (contentType === "BiddingOffer") {
      const result = await new ChatContent({
        chat: _id,
        contentType,
        content,
        other,
        sender: {
          id: user_id,
          role: isVendor ? "vendor" : isAdmin ? "admin" : "user",
        },
        status: {
          viewedByUser: !isVendor && !isAdmin,
          viewedByVendor: isVendor,
        },
      }).save();

      if (result) {
        return res.status(200).send(result);
      }

      return res.status(404).send({ message: "error" });
    }

    return res.status(400).send({ message: "Unsupported content type" });
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
};

const UpdateChatContent = (req, res) => {
  const { _id, cId } = req.params;
  const { other } = req.body;
  const updates = {};
  if (!other) {
    return res.status(400).send({ message: "Incomplete Data" });
  }
  if (other) {
    updates.other = other;
  }
  ChatContent.findOneAndUpdate({ _id: cId, chat: _id }, { $set: updates })
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
};

// Mark all messages in a chat as read for a role
const MarkRead = async (req, res) => {
  try {
    const { _id } = req.params;
    const { isVendor, isAdmin } = req.auth;
    const setUpdate = {};
    if (isVendor) setUpdate["status.viewedByVendor"] = true;
    else if (!isAdmin) setUpdate["status.viewedByUser"] = true;
    else return res.status(400).send({ message: "invalid role" });

    await ChatContent.updateMany({ chat: _id }, { $set: setUpdate });
    res.send({ message: "success" });
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
};

// const Update = (req, res) => {
//   const { _id } = req.params;
//   const { title } = req.body;
//   if (!title) {
//     res.status(400).send({ message: "Incomplete Data" });
//   } else {
//     Chat.findByIdAndUpdate(
//       { _id },
//       {
//         $set: {
//           title,
//         },
//       }
//     )
//       .then((result) => {
//         if (result) {
//           res.status(200).send({ message: "success" });
//         } else {
//           res.status(404).send({ message: "not found" });
//         }
//       })
//       .catch((error) => {
//         res.status(400).send({ message: "error", error });
//       });
//   }
// };

// const Delete = (req, res) => {
//   const { _id } = req.params;
//   Chat.findByIdAndDelete({ _id })
//     .then((result) => {
//       if (result) {
//         res.status(200).send({ message: "success" });
//       } else {
//         res.status(404).send({ message: "not found" });
//       }
//     })
//     .catch((error) => {
//       res.status(400).send({ message: "error", error });
//     });
// };

module.exports = { GetAll, Get, CreateNewChatContent, UpdateChatContent, MarkRead };
