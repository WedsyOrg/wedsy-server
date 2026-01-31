const jwt = require("jsonwebtoken");
const jwtConfig = require("../../config/jwt");
const Vendor = require("../../models/Vendor");
const { SendOTP, VerifyOTP } = require("../../utils/otp");
const { CreateNotification } = require("../../utils/notification");
const AWS = require("@aws-sdk/client-s3");

const normalizePhone = (phone) => (typeof phone === "string" ? phone.trim() : "");

const pickOtpPayload = (body = {}) => {
  // Support both new and legacy payload keys
  return {
    phone: normalizePhone(body.phone),
    otp: (body.otp ?? body.Otp ?? "").toString().trim(),
    referenceId: (body.referenceId ?? body.ReferenceId ?? "").toString().trim(),
  };
};

const sendOtp = async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone || phone.length !== 13) {
    return res.status(400).send({ message: "incorrect phone number" });
  }

  try {
    const result = await SendOTP(phone);
    return res.send({
      ...result,
      message: "OTP sent successfully",
      ReferenceId: result.ReferenceId, // legacy key
      referenceId: result.ReferenceId, // new key
    });
  } catch (err) {
    return res.status(400).send({ message: "error", error: err });
  }
};

const login = async (req, res) => {
  const { phone, otp, referenceId } = pickOtpPayload(req.body);
  if (!phone || phone.length !== 13 || !otp || !referenceId) {
    return res.status(400).send({ message: "Incomplete Data" });
  }

  // Keep existing demo bypass behavior for compatibility (can be removed later)
  const DEMO_PHONE = "+919774358212";
  const DEMO_OTP = "764587";
  if (phone === DEMO_PHONE && otp === DEMO_OTP) {
    const user = await Vendor.findOne({ phone }).catch(() => null);
    if (!user) {
      return res.status(404).send({ message: "User not found" });
    }
    if (user.deleted) {
      return res
        .status(403)
        .send({ message: "VendorDeleted", error: "Vendor account has been deleted" });
    }
    if (user.blocked) {
      return res
        .status(403)
        .send({ message: "VendorBlocked", error: "Vendor account is blocked" });
    }
    const token = jwt.sign(
      { _id: user._id, isVendor: true },
      process.env.JWT_SECRET,
      jwtConfig
    );
    return res.send({ message: "Login Successful", token });
  }

  try {
    const verified = await VerifyOTP(phone, referenceId, otp);
    if (verified?.Valid !== true) {
      return res.status(400).send({ message: "Invalid OTP" });
    }

    const user = await Vendor.findOne({ phone });
    if (!user) {
      return res.status(404).send({ message: "User not found" });
    }
    if (user.deleted) {
      return res
        .status(403)
        .send({ message: "VendorDeleted", error: "Vendor account has been deleted" });
    }
    if (user.blocked) {
      return res
        .status(403)
        .send({ message: "VendorBlocked", error: "Vendor account is blocked" });
    }

    const token = jwt.sign(
      { _id: user._id, isVendor: true },
      process.env.JWT_SECRET,
      jwtConfig
    );
    return res.send({ message: "Login Successful", token });
  } catch (err) {
    return res.status(400).send({ message: "error", error: err });
  }
};

const signup = async (req, res) => {
  const {
    name,
    email,
    gender,
    dob = "",
    servicesOffered: servicesOfferedRaw,
    category,
    businessAddress: businessAddressRaw,
    socialMedia: socialMediaRaw,
    documents,
    documentType,
  } = req.body || {};

  const { phone, otp, referenceId } = pickOtpPayload(req.body);

  const parseJsonMaybe = (val) => {
    if (!val) return val;
    if (typeof val !== "string") return val;
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  };

  const servicesOffered = parseJsonMaybe(servicesOfferedRaw);
  const businessAddress = parseJsonMaybe(businessAddressRaw);
  const socialMedia =
    typeof socialMediaRaw === "string" ? socialMediaRaw.trim() : "";

  if (
    !name ||
    !phone ||
    !email ||
    !gender ||
    !servicesOffered ||
    !category ||
    phone.length !== 13 ||
    !otp ||
    !referenceId
  ) {
    return res.status(400).send({ message: "Incomplete Data" });
  }

  try {
    const verified = await VerifyOTP(phone, referenceId, otp);
    if (verified?.Valid !== true) {
      return res.status(400).send({ message: "Invalid OTP" });
    }

    const existing = await Vendor.findOne({ phone }).lean();
    if (existing) {
      return res.status(400).send({ message: "Vendor already exists." });
    }

    const doc = {
      name,
      phone,
      email,
      gender,
      dob,
      servicesOffered,
      category,
    };

    // Optional: store a structured businessAddress if provided (Google place-like payload)
    if (businessAddress && typeof businessAddress === "object") {
      doc.businessAddress = businessAddress;
    }
    // Optional: store social media link as plain string
    if (socialMedia) {
      doc.socialMedia = socialMedia;
    }

    const created = await new Vendor(doc).save();

    // Documents:
    // Option A) JSON payload with URLs: documents: [{ name, front:{url}, back:{url} }]
    // Option B) Multipart upload fields: req.files.documentFront + req.files.documentBack + body.documentType
    const normalizeDocType = (t) => (typeof t === "string" ? t.trim() : "");
    const allowedDocTypes = new Set(["Aadhar Card", "Driving License", "Passport"]);

    const validateDocuments = (docs) => {
      if (!Array.isArray(docs) || docs.length === 0) {
        return { ok: false, message: "No documents provided" };
      }
      if (docs.length > 1) {
        return { ok: false, message: "Only one document is allowed per user" };
      }
      const d = docs[0];
      if (!allowedDocTypes.has(d?.name)) {
        return { ok: false, message: "Invalid document type" };
      }
      if (!d?.front?.url || !d?.back?.url) {
        return { ok: false, message: "Document must have both front and back photos" };
      }
      return { ok: true };
    };

    const uploadToS3 = async ({ file, key }) => {
      const s3Client = new AWS.S3({
        region: process.env.AWS_S3_REGION,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      });

      const extension = (file?.name || "").split(".").pop() || "jpg";
      const params = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: `${key}.${extension}`,
        Body: file.data,
        ContentType: file.mimetype,
        ACL: "public-read",
      };
      await s3Client.putObject(params);
      return `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${params.Key}`;
    };

    // If multipart files provided, upload and set Vendor.documents
    if (req.files?.documentFront && req.files?.documentBack) {
      const dt = normalizeDocType(documentType);
      if (!allowedDocTypes.has(dt)) {
        return res.status(400).send({ message: "Invalid document type" });
      }
      try {
        const baseKey = `vendor-documents/${created._id}`;
        const frontUrl = await uploadToS3({
          file: req.files.documentFront,
          key: `${baseKey}/front`,
        });
        const backUrl = await uploadToS3({
          file: req.files.documentBack,
          key: `${baseKey}/back`,
        });

        created.documents = [
          {
            name: dt,
            front: { url: frontUrl },
            back: { url: backUrl },
          },
        ];
        await created.save();
      } catch (e) {
        return res.status(400).send({ message: "AWS Upload Error", error: e });
      }
    } else if (documents) {
      // If URLs provided in JSON body, validate and store
      const docs = typeof documents === "string" ? JSON.parse(documents) : documents;
      const check = validateDocuments(docs);
      if (!check.ok) {
        return res.status(400).send({ message: check.message });
      }
      created.documents = docs;
      await created.save();
    }

    // Keep old behavior: notify admins that a new vendor was added
    try {
      CreateNotification({
        title: `New Vendor Added: ${name}`,
        category: "Vendor",
        references: { vendor: created._id },
      });
    } catch (_) {
      // don't fail signup if notification creation fails
    }

    const token = jwt.sign(
      { _id: created._id, isVendor: true },
      process.env.JWT_SECRET,
      jwtConfig
    );

    return res.status(201).send({ message: "success", id: created._id, token });
  } catch (err) {
    return res.status(400).send({ message: "error", error: err });
  }
};

module.exports = { sendOtp, login, signup };

