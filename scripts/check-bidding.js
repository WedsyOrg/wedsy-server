const mongoose = require("mongoose");

async function main() {
  const uri = process.env.DATABASE_URL || process.env.MONGODB_URI || process.env.MONGODB_URL || "mongodb+srv://admin:8yKMdZMD17PRwAmtNN@wedsycluster.yevfhwp.mongodb.net/dev?retryWrites=true&w=majority";

  await mongoose.connect(uri);

  const biddingBidSchema = new mongoose.Schema({}, {
    collection: "biddingbids",
    strict: false,
  });

  const biddingSchema = new mongoose.Schema({}, {
    collection: "biddings",
    strict: false,
  });

  const vendorSchema = new mongoose.Schema({}, {
    collection: "vendors",
    strict: false,
  });

  const BiddingBid = mongoose.model("TempBiddingBid", biddingBidSchema);
  const Bidding = mongoose.model("TempBidding", biddingSchema);
  const Vendor = mongoose.model("TempVendor", vendorSchema);

  const [biddingId, flag] = process.argv.slice(2);

  if (!biddingId || biddingId === "--all") {
    const totalBids = await BiddingBid.countDocuments();
    const totalVendors = await Vendor.countDocuments();
    const activeVendors = await Vendor.countDocuments({ biddingStatus: true });
    console.log(`Total bids: ${totalBids}`);
    console.log(`Vendors: ${totalVendors} (biddingStatus=true => ${activeVendors})`);
    if (totalBids > 0) {
      const sample = await BiddingBid.find().sort({ createdAt: -1 }).limit(3).lean();
      console.log("Sample bids:", JSON.stringify(sample, null, 2));
    }
    await mongoose.disconnect();
    return;
  }

  const bids = await BiddingBid.find({ bidding: biddingId }).lean();
  console.log(`Found ${bids.length} bidding bids for bidding ${biddingId}`);

  if (bids.length > 0) {
    const vendorIds = bids.map((bid) => bid.vendor.toString());
    console.log("Sample bid:", JSON.stringify(bids[0], null, 2));
    console.log("Vendor IDs:", vendorIds.join(", "));

    const vendors = await Vendor.find({ _id: { $in: vendorIds } }).lean();
    console.log("Vendors count:", vendors.length);
    vendors.forEach((vendor) => {
      console.log(`${vendor._id}: ${vendor.businessName || vendor.name || vendor.phone} | biddingStatus=${vendor.biddingStatus}`);
    });
  }

  const biddingDoc = await Bidding.findById(biddingId).lean();
  if (biddingDoc) {
    console.log("Bidding events sample:");
    biddingDoc.events?.forEach((event, idx) => {
      const totalPeople = (event.peoples || []).reduce((acc, person) => {
        return acc + (Number(person.noOfPeople) || 0);
      }, 0);
      console.log(`Event ${idx + 1}: totalPeople=${totalPeople}`, JSON.stringify(event.peoples, null, 2));
    });
  } else {
    console.log("Bidding document not found");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

