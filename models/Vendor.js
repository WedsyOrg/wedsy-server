const mongoose = require("mongoose");
const ObjectId = mongoose.Schema.Types.ObjectId;

const VendorSchema = new mongoose.Schema(
  {
    razorPay_accountId: { type: String, default: "" },
    razorPay_productId: { type: String, default: "" },
    razporPay_info: { type: Object, default: {} },
    razporPay_product_info: { type: Object, default: {} },
    razporPay_product_status: { type: String, default: "" },
    razorPay_setup_completed: { type: Boolean, default: false },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String, required: true },
    gender: { type: String, required: true },
    dob: { type: String, required: false, default: "" },
    blocked: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },
    // Store original data before deletion for restore capability
    originalName: { type: String, default: "" },
    originalEmail: { type: String, default: "" },
    originalPhone: { type: String, default: "" },
    profileCompleted: { type: Boolean, default: false },
    paymentCompleted: { type: Boolean, default: false },
    profileVerified: { type: Boolean, default: false },
    profileVisibility: { type: Boolean, default: false },
    packageStatus: { type: Boolean, default: false },
    biddingStatus: { type: Boolean, default: false },
    registrationDate: { type: Date, default: Date.now() },
    businessName: { type: String, default: "" },
    businessDescription: { type: String, default: "" },
    businessAddress: {
      // state: { type: String, default: "" },
      // city: { type: String, default: "" },
      // area: { type: String, default: "" },
      // pincode: { type: String, default: "" },
      // address: { type: String, default: "" },
      // googleMaps: { type: String, default: "" },
      place_id: {
        type: String,
        default: "",
      },
      formatted_address: {
        type: String,
        default: "",
      },
      address_components: {
        type: [
          {
            long_name: String,
            short_name: String,
            types: [String],
          },
        ],
        default: [],
      },
      city: {
        type: String,
        default: "",
      },
      postal_code: {
        type: String,
        default: "",
      },
      locality: {
        type: String,
        default: "",
      },
      state: {
        type: String,
        default: "",
      },
      country: {
        type: String,
        default: "",
      },
      geometry: {
        location: {
          lat: { type: Number, default: 0 },
          lng: { type: Number, default: 0 },
        },
      },
    },
    other: {
      groomMakeup: { type: Boolean, default: false },
      lgbtqMakeup: { type: Boolean, default: false },
      onlyHairStyling: { type: Boolean, default: false },
      experience: { type: String, default: "" },
      clients: { type: String, default: "" },
      usp: { type: String, default: "" },
      makeupProducts: { type: [String], default: [] },
      awards: { type: [{ title: String, certificate: String }], default: [] },
    },
    documents: [
      {
        name: {
          type: String,
          enum: ["Aadhar Card", "Driving License", "Passport"],
        },
        front: {
          url: { type: String, default: "" },
          uploadedAt: { type: Date, default: Date.now() },
          fileSize: Number,
        },
        back: {
          url: { type: String, default: "" },
          uploadedAt: { type: Date, default: Date.now() },
          fileSize: Number,
        },
        status: {
          type: String,
          enum: ["pending","approved","rejected"],
          default: "pending",

        },
        verifiedAt: { type: Date, default: null },
        rejectionReason: { type: String, default: "" },

      }
    ],

    speciality: { type: String, default: "" },
    servicesOffered: { type: [String], default: [] },
    notes: {
      type: [{ text: String, createdAt: { type: Date, default: Date.now() } }],
      default: [],
    },
    category: { type: String, required: true },
    tag: { type: String, default: "" },
    notifications: {
      bidding: { type: Boolean, default: true },
      packages: { type: Boolean, default: true },
      upcomingEvents: { type: Boolean, default: true },
      booking: { type: Boolean, default: true },
      payment: { type: Boolean, default: true },
    },
    accountDetails: {
      bankName: { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      ifscCode: { type: String, default: "" },
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      default: 3,
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer value",
      },
    },
    prices: {
      party: {
        type: Number,
        default: 0,
      },
      bridal: {
        type: Number,
        default: 0,
      },
      groom: {
        type: Number,
        default: 0,
      },
    },
    gallery: {
      coverPhoto: { type: String, default: "" },
      photos: { type: [String], default: [] },
    },
    lastActive: {
      type: Date,
      default: Date.now(),
    },
  },

  { timestamps: true }
);

module.exports = mongoose.model("Vendor", VendorSchema);
