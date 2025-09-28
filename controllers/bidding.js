const Bidding = require("../models/Bidding");
const BiddingBid = require("../models/BiddingBid");
const Vendor = require("../models/Vendor");
const Chat = require("../models/Chat");
const ChatContent = require("../models/ChatContent");
const Order = require("../models/Order");
const VendorReview = require("../models/VendorReview");
const Notification = require("../models/Notification");
const User = require("../models/User");

/**
 * CreateNew - Creates a new bidding and sends it to ALL vendors
 * Removed vendor matching logic - now all vendors with biddingStatus: true receive bids
 */
const CreateNew = (req, res) => {
  const { user_id, isAdmin, isVendor } = req.auth;
  const { events, requirements } = req.body;
  if (
    !(events.length > 0 && requirements !== undefined) &&
    !isAdmin &&
    !isVendor
  ) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new Bidding({
      events,
      requirements,
      user: user_id,
      status: { active: true, finalized: false, lost: false },
    })
      .save()
      .then(async (result) => {
        // Remove vendor matching logic - send to ALL vendors
        const query = { biddingStatus: true };
        const vendors = await Vendor.find(query);
        
        console.log(`Found ${vendors.length} vendors with biddingStatus: true`);
        
        // Create BiddingBid for ALL vendors
        const biddingBidPromises = vendors.map((item) => {
          return new BiddingBid({
            bidding: result?._id,
            vendor: item?._id,
            status: {
              accepted: false,
              rejected: false,
            },
          }).save();
        });
        
        await Promise.all(biddingBidPromises);
        console.log(`Created ${vendors.length} BiddingBid records for bidding: ${result._id}`);
        
        // Get user details for notification
        const user = await User.findById(user_id).lean();
        const userName = user?.name || "A user";
        
        // Create notifications for all vendors
        const notificationPromises = vendors.map(vendor => {
          return new Notification({
            category: "Bidding Request",
            title: "New Bidding Request",
            message: `${userName} has sent you a new bidding request. Check it out!`,
            vendor: vendor._id,
            type: "bidding",
            references: {
              bidding: result._id,
              user: user_id
            }
          }).save();
        });
        
        await Promise.all(notificationPromises);
        console.log(`Created ${vendors.length} notifications for bidding: ${result._id}`);
        
        res.status(201).send({ message: "success", id: result._id });
      })
      .catch((error) => {
        console.error("Error creating bidding:", error);
        res.status(400).send({ message: "error", error });
      });
  }
};

const GetAll = (req, res) => {
  const { user_id, isAdmin, isVendor } = req.auth;
  if (isAdmin) {
    Bidding.find({})
      .then((result) => {
        res.send(result);
      })
      .catch((error) => {
        res.status(400).send({
          message: "error",
          error,
        });
      });
  } else if (isVendor) {
  } else {
    Bidding.find({ user: user_id })
      .then((result) => {
        res.send(result);
      })
      .catch((error) => {
        res.status(400).send({
          message: "error",
          error,
        });
      });
  }
};

const Get = (req, res) => {
  const { _id } = req.params;
  const { user_id, isAdmin, isVendor } = req.auth;
  if (isAdmin) {
    Bidding.findById({ _id })
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
  } else if (isVendor) {
    // For vendors, return the bidding data with events but without bids
    Bidding.findById({ _id })
      .then((result) => {
        if (!result) {
          res.status(404).send();
        } else {
          // Return just the bidding data with events for vendors
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
    Bidding.findOne({ _id, user: user_id })
      .then((result) => {
        if (!result) {
          res.status(404).send();
        } else {
          BiddingBid.find({
            bidding: _id,
            "status.accepted": true,
            bid: { $gt: 0 },
          })
            .populate("vendor")
            .then(async (bids) => {
              const enrichedBids = await Promise.all(
                bids.map(async (bidDoc) => {
                  const plainBid = bidDoc.toObject();
                  const vendorObj = plainBid.vendor;
                  if (vendorObj?._id) {
                    const [reviewsCount, ordersDone] = await Promise.all([
                      VendorReview.countDocuments({ vendor: vendorObj._id }),
                      Order.countDocuments({ vendor: vendorObj._id, "status.completed": true }),
                    ]);
                    plainBid.vendor = {
                      ...vendorObj,
                      reviewsCount,
                      ordersDone,
                    };
                  }
                  return plainBid;
                })
              );
              res.send({ ...result.toObject(), bids: enrichedBids });
            })
            .catch((error) => {
              res.status(400).send({
                message: "error",
                error,
              });
            });
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

const UserViewBiddingBid = (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { _id, bidId } = req.params;
  if (!isVendor && !isAdmin) {
    BiddingBid.findOneAndUpdate(
      { _id: bidId, bidding: _id },
      { $set: { "status.userViewed": true } }
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
      error: {},
    });
  }
};

const UserAcceptBiddingBid = async (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { _id, bidId } = req.params;
  
  if (!isVendor && !isAdmin) {
    try {
      const result = await BiddingBid.findOneAndUpdate(
        { _id: bidId, bidding: _id },
        { $set: { "status.userAccepted": true } },
        { new: true }
      ).populate('vendor');
      
      if (result) {
        // Find or create chat
        let chat = await Chat.findOne({
          user: user_id,
          vendor: result?.vendor?._id,
        });
        
        if (!chat) {
          chat = await new Chat({
            user: user_id,
            vendor: result?.vendor?._id,
          }).save();
          console.log("Created new chat:", chat._id, "for user:", user_id, "and vendor:", result?.vendor?._id);
        }
        
        // Create chat content with proper sender information
        const chatContent = await new ChatContent({
          chat: chat?._id,
          contentType: "BiddingBid",
          content: result?.bid,
          other: { 
            bidding: _id, 
            biddingBid: bidId,
            accepted: true,
            vendor: result?.vendor?._id
          },
          sender: {
            id: user_id,
            role: "user"
          },
          status: {
            viewedByUser: true,
            viewedByVendor: false,
          },
        }).save();
        
        console.log("Created chat content:", chatContent._id);
        
        // Create notification for vendor
        const vendorNotification = await new Notification({
          category: "Bidding Accepted",
          title: "Your Bid Was Accepted!",
          message: `Great news! Your bid of ₹${result?.bid} has been accepted. Start chatting with the client now!`,
          vendor: result?.vendor?._id,
          type: "bidding",
          references: {
            chat: chat?._id,
            bidding: _id,
            biddingBid: bidId,
            user: user_id
          }
        }).save();
        
        console.log("Created vendor notification:", vendorNotification._id);
        
        res.status(200).send({ message: "success", chat: chat?._id });
      } else {
        res.status(404).send({ message: "Bidding bid not found" });
      }
    } catch (error) {
      console.error("Error in UserAcceptBiddingBid:", error);
      res.status(400).send({ message: "error", error: error.message });
    }
  } else {
    res.status(403).send({
      message: "Access denied - only users can accept bids",
    });
  }
};

const UserRejectBiddingBid = (req, res) => {
  const { user_id, isVendor, isAdmin } = req.auth;
  const { _id, bidId } = req.params;
  if (!isVendor && !isAdmin) {
    BiddingBid.findOneAndUpdate(
      { _id: bidId, bidding: _id },
      { $set: { "status.userRejected": true } }
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
      error: {},
    });
  }
};

const Update = (req, res) => {
  const { _id } = req.params;
  const { user_id, isAdmin, isVendor } = req.auth;
  const { events, requirements } = req.body;

  if (events === undefined && requirements === undefined) {
    return res.status(400).send({ message: "Incomplete Data" });
  }

  const setPayload = {};
  if (events !== undefined) setPayload.events = events;
  if (requirements !== undefined) setPayload.requirements = requirements;

  // Only owner can update (or admin)
  const filter = isAdmin ? { _id } : { _id, user: user_id };

  Bidding.findOneAndUpdate(filter, { $set: setPayload }, { new: true })
    .then((result) => {
      if (result) {
        res.status(200).send({ message: "success", bidding: result });
      } else {
        res.status(404).send({ message: "not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const Delete = (req, res) => {
  const { _id } = req.params;
  Bidding.findByIdAndDelete({ _id })
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

/**
 * CreateBiddingBidsForExisting - Manually create BiddingBid records for existing biddings
 * Useful for testing or fixing existing biddings that don't have vendor bids
 */
const CreateBiddingBidsForExisting = async (req, res) => {
  const { biddingId } = req.params;
  const { user_id, isAdmin, isVendor } = req.auth;
  
  // Allow both users and admins to create bids for existing biddings
  if (isVendor) {
    return res.status(403).send({ message: "Vendors cannot create bidding bids" });
  }
  
  try {
    const bidding = await Bidding.findById(biddingId);
    if (!bidding) {
      return res.status(404).send({ message: "Bidding not found" });
    }
    
    // Check if BiddingBid records already exist
    const existingBids = await BiddingBid.find({ bidding: biddingId });
    if (existingBids.length > 0) {
      return res.status(400).send({ 
        message: "BiddingBid records already exist", 
        count: existingBids.length 
      });
    }
    
    // Find all vendors with biddingStatus: true
    const vendors = await Vendor.find({ biddingStatus: true });
    console.log(`Found ${vendors.length} vendors for existing bidding: ${biddingId}`);
    
    // Create BiddingBid for ALL vendors
    const biddingBidPromises = vendors.map((item) => {
      return new BiddingBid({
        bidding: biddingId,
        vendor: item?._id,
        status: {
          accepted: false,
          rejected: false,
        },
      }).save();
    });
    
    await Promise.all(biddingBidPromises);
    console.log(`Created ${vendors.length} BiddingBid records for existing bidding: ${biddingId}`);
    
    res.status(200).send({ 
      message: "success", 
      biddingId: biddingId,
      vendorsCount: vendors.length,
      bidsCreated: vendors.length
    });
    
  } catch (error) {
    console.error("Error creating bidding bids for existing:", error);
    res.status(500).send({ message: "error", error: error.message });
  }
};

module.exports = {
  CreateNew,
  GetAll,
  Get,
  Update,
  Delete,
  UserAcceptBiddingBid,
  UserRejectBiddingBid,
  UserViewBiddingBid,
  CreateBiddingBidsForExisting,
};
