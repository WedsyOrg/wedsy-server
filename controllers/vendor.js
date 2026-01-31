const Vendor = require("../models/Vendor");
const { createObjectCsvStringifier } = require("csv-writer");
const { CreateNotification } = require("../utils/notification");
const jwt = require("jsonwebtoken");
const _ = require("lodash");
const jwtConfig = require("../config/jwt");
const { VerifyOTP } = require("../utils/otp");

const CreateNew = (req, res) => {
  const {
    name,
    phone,
    email,
    gender,
    servicesOffered,
    category,
    Otp,
    ReferenceId,
    dob,
  } = req.body;
  if (
    !name ||
    !phone ||
    !email ||
    !gender ||
    !servicesOffered ||
    !category ||
    phone.length !== 13 ||
    !Otp ||
    !ReferenceId
  ) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    VerifyOTP(phone, ReferenceId, Otp)
      .then((result) => {
        if (result.Valid === true) {
          Vendor.findOne({ phone })
            .then((user) => {
              if (user) {
                res.status(400).send({ message: "Vendor already exists." });
              } else {
                new Vendor({
                  name,
                  phone,
                  email,
                  gender,
                  dob,
                  servicesOffered,
                  category,
                })
                  .save()
                  .then((result) => {
                    CreateNotification({
                      title: `New Vendor Added: ${name}`,
                      category: "Vendor",
                      references: { vendor: result._id },
                    });
                    const token = jwt.sign(
                      { _id: result._id, isVendor: true },
                      process.env.JWT_SECRET,
                      jwtConfig
                    );
                    res
                      .status(201)
                      .send({ message: "success", id: result._id, token });
                  })
                  .catch((error) => {
                    res.status(400).send({ message: "error", error });
                  });
              }
            })
            .catch((error) => {
              res.status(400).send({ message: "error", error });
            });
        } else {
          res.status(400).send({ message: "Invalid OTP" });
        }
      })
      .catch((err) => {
        res.status(400).send({ message: "error", error: err });
      });
  }
};

const GetAll = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  if (isAdmin) {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const {
      search,
      sort,
      tag,
      state,
      city,
      area,
      pincode,
      profileVerified,
      profileVisibility,
      packageStatus,
      biddingStatus,
      servicesOffered,
      startDate,
      endDate,
      registrationDate,
      download,
    } = req.query;
    const query = {};
    const sortQuery = {};
    if (search) {
      query.$or = [
        { name: { $regex: new RegExp(search, "i") } },
        { phone: { $regex: new RegExp(search, "i") } },
        { email: { $regex: new RegExp(search, "i") } },
        { city: { $regex: new RegExp(search, "i") } },
      ];
    }
    if (tag) {
      query.tags = tag;
    }
    if (state) {
      query["businessAddress.state"] = state;
    }
    if (city) {
      query["businessAddress.city"] = city;
    }
    if (area) {
      query["businessAddress.area"] = area;
    }
    if (pincode) {
      query["businessAddress.pincode"] = pincode;
    }
    if (servicesOffered && servicesOffered !== "Both") {
      query.servicesOffered = servicesOffered;
    }
    if (profileVerified === "true") {
      query.profileVerified = true;
    } else if (profileVerified === "false") {
      query.profileVerified = false;
    }
    if (profileVisibility === "true") {
      query.profileVisibility = true;
    } else if (profileVisibility === "false") {
      query.profileVisibility = false;
    }
    if (packageStatus === "true") {
      query.packageStatus = true;
    } else if (packageStatus === "false") {
      query.packageStatus = false;
    }
    if (biddingStatus === "true") {
      query.biddingStatus = true;
    } else if (biddingStatus === "false") {
      query.biddingStatus = false;
    }
    if (registrationDate) {
      const filterDate = new Date(registrationDate);
      const startFilterDate = new Date(filterDate.setHours(0, 0, 0, 0));
      const endFilterDate = new Date(filterDate.setHours(23, 59, 59, 999));
      query["registrationDate"] = {
        $gte: startFilterDate,
        $lt: endFilterDate,
      };
    }
    if (startDate && endDate) {
      const startFilterDate = new Date(
        new Date(startDate).setHours(0, 0, 0, 0)
      );
      const endFilterDate = new Date(
        new Date(endDate).setHours(23, 59, 59, 999)
      );
      query["registrationDate"] = {
        $gte: startFilterDate,
        $lt: endFilterDate,
      };
    }
    if (sort) {
      if (sort === "Orders (Highest to Lowest)") {
        // sortQuery.createdAt = -1;
        // --PendingWork--
      } else if (sort === "Newest (Registration)") {
        // sortQuery.createdAt = 1;
        // --PendingWork--
      } else if (sort === "Newest (Registration)") {
        sortQuery.registrationDate = -1;
      } else if (sort === "Older (Registration)") {
        sortQuery.registrationDate = 1;
      } else if (sort === "Alphabetical Order") {
        sortQuery["name"] = -1;
      }
    } else {
      sortQuery.createdAt = -1;
    }
    if (download === "csv") {
      Vendor.find(query)
        .sort(sortQuery)
        .populate("")
        .lean()
        .exec()
        .then((result) => {
          try {
            const csvStringifier = createObjectCsvStringifier({
              header: [
                { id: "name", title: "Name" },
                { id: "phone", title: "Phone" },
                { id: "email", title: "Email" },
                { id: "gender", title: "Gender" },
                { id: "registrationDate", title: "Registration Date" },
                { id: "businessName", title: "Business Name" },
                { id: "businessDescription", title: "Business Description" },
                {
                  id: "businessAddress.formatted_address",
                  title: "Business Address",
                },
                { id: "speciality", title: "Speciality" },
                { id: "category", title: "Category" },
                { id: "tag", title: "Tag" },
              ],
            });
            const header = csvStringifier.getHeaderString();
            const records = csvStringifier.stringifyRecords(result);
            const csvData = header + records;
            res.setHeader(
              "Content-disposition",
              "attachment; filename=vendors.csv"
            );
            res.set("Content-Type", "text/csv");
            res.status(200).send(csvData);
          } catch (error) {
            console.error("Error fetching data and creating CSV:", error);
            res.status(500).send("Internal Server Error");
          }
        })
        .catch((error) => {
          res.status(400).send({
            message: "error",
            error,
          });
        });
    } else {
      Vendor.countDocuments(query)
        .then((total) => {
          const totalPages = Math.ceil(total / limit);
          const skip = (page - 1) * limit;
          Vendor.find(query)
            .sort(sortQuery)
            .skip(skip)
            .limit(limit)
            .populate("")
            .exec()
            .then((result) => {
              res.send({ list: result, totalPages, page, limit });
            })
            .catch((error) => {
              res.status(400).send({
                message: "error",
                error,
              });
            });
        })
        .catch((error) => {
          res.status(400).send({
            message: "error",
            error,
          });
        });
    }
  } else {
    // Regular user: apply filters for public-facing vendor listing
    const {
      search,
      locality,
      rating,
      speciality,
      servicesOffered,
      groomMakeup,
      gender,
    } = req.query;

    const query = { profileVisibility: true };

    // Search filter - search by name
    if (search) {
      query.$or = [
        { name: { $regex: new RegExp(search, "i") } },
        { businessName: { $regex: new RegExp(search, "i") } },
      ];
    }

    // Locality filter - match against businessAddress.locality
    if (locality) {
      const localityValues = locality.split(",").map((l) => l.trim());
      // Map locality names to search patterns
      const localityPatterns = localityValues.map((loc) => {
        // Handle "North Bangalore", "South Bangalore" etc.
        if (loc.includes("Bangalore")) {
          const direction = loc.replace(" Bangalore", "").trim();
          return new RegExp(direction, "i");
        }
        return new RegExp(loc, "i");
      });
      query["businessAddress.locality"] = { $in: localityPatterns };
    }

    // Rating filter - support for different rating thresholds
    if (rating) {
      const ratingValues = rating.split(",").map((r) => r.trim());
      const ratingConditions = [];

      ratingValues.forEach((r) => {
        if (r === "<4") {
          ratingConditions.push({ rating: { $lt: 4 } });
        } else if (r === "4+") {
          ratingConditions.push({ rating: { $gte: 4 } });
        } else if (r === "4.5+") {
          ratingConditions.push({ rating: { $gte: 4.5 } });
        } else if (r === "4.8+") {
          ratingConditions.push({ rating: { $gte: 4.8 } });
        }
      });

      if (ratingConditions.length > 0) {
        if (query.$or) {
          // If $or already exists from search, use $and to combine
          query.$and = query.$and || [];
          query.$and.push({ $or: ratingConditions });
        } else {
          query.$or = ratingConditions;
        }
      }
    }

    // Speciality filter
    if (speciality) {
      const specialityValues = speciality.split(",").map((s) => s.trim());
      query.speciality = { $in: specialityValues.map((s) => new RegExp(s, "i")) };
    }

    // Services offered filter
    if (servicesOffered) {
      const servicesValues = servicesOffered.split(",").map((s) => s.trim());
      // Handle special case for "Both Makeup & Hairstyle"
      if (servicesValues.includes("MUA") && servicesValues.includes("Hairstylist")) {
        query.servicesOffered = { $all: ["MUA", "Hairstylist"] };
      } else {
        query.servicesOffered = { $in: servicesValues };
      }
    }

    // Groom makeup filter
    if (groomMakeup) {
      const groomValues = groomMakeup.split(",").map((g) => g.trim().toLowerCase());
      if (groomValues.includes("yes") && !groomValues.includes("no")) {
        query["other.groomMakeup"] = true;
      } else if (groomValues.includes("no") && !groomValues.includes("yes")) {
        query["other.groomMakeup"] = false;
      }
      // If both "yes" and "no" selected, don't filter by groom makeup
    }

    // Gender filter
    if (gender) {
      const genderValues = gender.split(",").map((g) => g.trim());
      query.gender = { $in: genderValues.map((g) => new RegExp(`^${g}$`, "i")) };
    }

    Vendor.find(query)
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

const GetVendorLastActive = (req, res) => {
  const { _id } = req.params;
  Vendor.findById(_id)
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send({ lastActive: result?.lastActive || "" });
      }
    })
    .catch((error) => {
      res.status(400).send({
        message: "error",
        error,
      });
    });
};

const Get = (req, res) => {
  const { isAdmin } = req.auth;
  const { _id } = req.params;
  const { fetchSimilar } = req.query;
  Vendor.findOne(isAdmin ? { _id } : { _id, profileVisibility: true })
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        Vendor.find({})
          .limit(4)
          .then((similar) => {
            res.send({ ...result.toObject(), similarVendors: similar });
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
};


const verifyDocument = (documents) => {
  // If no documents provided
  if (!documents || documents.length === 0) {
    return {
      message: "No documents provided",
      valid: false,
    };
  }

  // Check if only one document is uploaded
  if (documents.length > 1) {
    return {
      message: "Only one document is allowed per user",
      valid: false,
    };
  }

  const validDocumentTypes = ["Aadhar Card", "Driving License", "Passport"];
  const document = documents[0];

  // Check if document type is valid
  if (!validDocumentTypes.includes(document.name)) {
    return {
      message: "Invalid document type",
      valid: false,
    };
  }

  // Check if document has both front and back
  if (!document.front?.url || !document.back?.url) {
    return {
      message: "Document must have both front and back photos",
      valid: false,
    };
  }

  return {
    message: "Document uploaded successfully",
    documents,
    valid: true,
  };
}


//update vendor profile details
const Update = (req, res) => {
  const { _id } = req.params;
  const { user_id, isAdmin, isVendor } = req.auth;
  const { updateKey } = req.query;
  if (isAdmin && _id) {
    if (updateKey && updateKey === "profileVerified") {
      const { profileVerified } = req.body;
      Vendor.findByIdAndUpdate(
        { _id },
        {
          $set: {
            profileVerified,
          },
        }
      )
        .then((result) => {
          if (result) {
            CreateNotification({
              title: profileVerified
                ? `Vendor Profile marked as Verified`
                : `Vendor Profile marked as not Verified`,
              category: "Vendor",
              references: { vendor: _id },
            });
            res.status(200).send({ message: "success" });
          } else {
            res.status(404).send({ message: "not found" });
          }
        })
        .catch((error) => {
          res.status(400).send({ message: "error", error });
        });
    } else if (updateKey && updateKey === "profileVisibility") {
      const { profileVisibility } = req.body;
      Vendor.findOneAndUpdate(
        { _id, profileVerified: true },
        {
          $set: {
            profileVisibility,
          },
        }
      )
        .then((result) => {
          if (result) {
            CreateNotification({
              title: profileVisibility
                ? `Vendor Profile marked as Visible`
                : `Vendor Profile marked as not Visible`,
              category: "Vendor",
              references: { vendor: _id },
            });
            res.status(200).send({ message: "success" });
          } else {
            res.status(404).send({ message: "not found" });
          }
        })
        .catch((error) => {
          res.status(400).send({ message: "error", error });
        });
    } else if (updateKey && updateKey === "packageStatus") {
      const { packageStatus } = req.body;
      Vendor.findOneAndUpdate(
        { _id, profileVerified: true },
        {
          $set: {
            packageStatus,
          },
        }
      )
        .then((result) => {
          if (result) {
            CreateNotification({
              title: packageStatus
                ? `Enabled Vendor Package Status`
                : `Disabled Vendor Package Status`,
              category: "Vendor",
              references: { vendor: _id },
            });
            res.status(200).send({ message: "success" });
          } else {
            res.status(404).send({ message: "not found" });
          }
        })
        .catch((error) => {
          res.status(400).send({ message: "error", error });
        });
    } else if (updateKey && updateKey === "biddingStatus") {
      const { biddingStatus } = req.body;
      Vendor.findOneAndUpdate(
        { _id, profileVerified: true },
        {
          $set: {
            biddingStatus,
          },
        }
      )
        .then((result) => {
          if (result) {
            CreateNotification({
              title: biddingStatus
                ? `Enabled Vendor Bidding Status`
                : `Disabled Vendor Bidding Status`,
              category: "Vendor",
              references: { vendor: _id },
            });
            res.status(200).send({ message: "success" });
          } else {
            res.status(404).send({ message: "not found" });
          }
        })
        .catch((error) => {
          res.status(400).send({ message: "error", error });
        });
    } else if (updateKey && updateKey === "rating") {
      const { rating } = req.body;
      const nextRating = parseInt(rating);
      if (![1, 2, 3, 4, 5].includes(nextRating)) {
        return res.status(400).send({ message: "Invalid rating" });
      }
      Vendor.findByIdAndUpdate(
        { _id },
        {
          $set: {
            rating: nextRating,
          },
        }
      )
        .then((result) => {
          if (result) {
            CreateNotification({
              title: `Vendor Rating Updated to ${nextRating}`,
              category: "Vendor",
              references: { vendor: _id },
            });
            res.status(200).send({ message: "success" });
          } else {
            res.status(404).send({ message: "not found" });
          }
        })
        .catch((error) => {
          res.status(400).send({ message: "error", error });
        });
    } else {
      // Allow explicit gallery clears (coverPhoto="" or photos=[])
      const galleryPayload = req.body && req.body.gallery ? req.body.gallery : undefined;
      const hasExplicitGalleryChange =
        !!galleryPayload && (Object.prototype.hasOwnProperty.call(galleryPayload, "coverPhoto") ||
        Object.prototype.hasOwnProperty.call(galleryPayload, "photos"));
      const {
        name,
        tag,
        businessAddress,
        businessName,
        businessDescription,
        servicesOffered,
        speciality,
        gallery,
        other,
        rating,
        documents,
      } = req.body;
      if (
        !name &&
        !tag &&
        !businessAddress?.state &&
        !businessAddress?.city &&
        !businessAddress?.area &&
        !businessAddress?.pincode &&
        !businessAddress?.address &&
        !businessAddress?.googleMaps &&
        !businessName &&
        !businessDescription &&
        servicesOffered?.length === 0 &&
        documents?.length === 0 &&
        !speciality &&
        (other.groomMakeup === undefined || other.groomMakeup === null) &&
        (other?.lgbtqMakeup === undefined || other?.lgbtqMakeup === null) &&
        !other?.experience &&
        !other?.clients &&
        !other?.usp &&
        other?.makeupProducts?.length === 0 &&
        other?.awards?.length === 0 &&
        /* No minimum gallery photo requirement */
        ![1, 2, 3, 4, 5].includes(rating)
      ) {
        if (hasExplicitGalleryChange) {
          // Proceed to allow clearing gallery values
        } else {
        res.status(400).send({ message: "Incomplete Data" });
          return;
        }
      } else {
        Vendor.findById(_id)
          .then((vendor) => {
            if (!vendor) {
              res.status(404).send({ message: "Vendor not found" });
            } else {
              const updates = {};
              const notifications = [];
              // Apply gallery cover photo update whenever key is present (allow no-op and deletions)
              if (gallery && Object.prototype.hasOwnProperty.call(gallery, "coverPhoto")) {
                updates["gallery.coverPhoto"] = gallery?.coverPhoto;
                notifications.push({
                  title: `${vendor?.name} Gallery (coverPhoto) Changed`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              // Apply gallery photos update whenever key is present (allow empty array and no-op)
              if (gallery && Object.prototype.hasOwnProperty.call(gallery, "photos")) {
                updates["gallery.photos"] = gallery?.photos || [];
                notifications.push({
                  title: `${vendor?.name} Gallery (photos) Updated`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (rating && rating !== vendor.rating) {
                updates.rating = rating;
                notifications.push({
                  title: `${vendor?.rating} Rating Changed: ${
                    vendor.rating || ""
                  } to ${rating}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (name && name !== vendor.name) {
                updates.name = name;
                notifications.push({
                  title: `${vendor?.name} Name Changed: ${
                    vendor.name || ""
                  } to ${name}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (tag && tag !== vendor.tag) {
                updates.tag = tag;
                notifications.push({
                  title: `${vendor?.name} Tag Changed: ${
                    vendor.tag || ""
                  } to ${tag}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (documents && documents.length > 0 && JSON.stringify(documents) !== JSON.stringify(vendor?.documents)) {
                const { valid, message, documents: uploadedDocuments } = verifyDocument(documents);
                if (valid) {
                  updates.documents = documents;
                } else {
                  return res.status(400).send({ message });
                }
                notifications.push({
                  title: `${vendor?.name} Documents Updated`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (speciality && speciality !== vendor.speciality) {
                updates.speciality = speciality;
                notifications.push({
                  title: `${vendor?.name} Speciality Changed: ${
                    vendor.speciality || ""
                  } to ${speciality}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                servicesOffered &&
                servicesOffered.length > 0 &&
                JSON.stringify(servicesOffered) !==
                  JSON.stringify(vendor.servicesOffered)
              ) {
                updates.servicesOffered = servicesOffered;
                notifications.push({
                  title: `${vendor?.name} Services Offered Changed: ${
                    vendor.servicesOffered.join(", ") || ""
                  } to ${servicesOffered.join(", ")}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                other?.makeupProducts &&
                other?.makeupProducts.length > 0 &&
                JSON.stringify(other?.makeupProducts) !==
                  JSON.stringify(vendor?.other?.makeupProducts)
              ) {
                updates["other.makeupProducts"] = other?.makeupProducts;
                notifications.push({
                  title: `${vendor?.name} Makeup Products Updated`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                other?.awards &&
                other?.awards.length > 0 &&
                JSON.stringify(other?.awards) !==
                  JSON.stringify(vendor?.other?.awards)
              ) {
                updates["other.awards"] = other?.awards;
                notifications.push({
                  title: `${vendor?.name} Awards Updated`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                other?.experience &&
                other?.experience !== vendor?.other?.experience
              ) {
                updates["other.experience"] = other?.experience;
                notifications.push({
                  title: `${vendor?.name} Experience Changed: ${
                    vendor?.other?.experience || ""
                  } to ${other?.experience}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (other?.clients && other?.clients !== vendor?.other?.clients) {
                updates["other.clients"] = other?.clients;
                notifications.push({
                  title: `${vendor?.name} Clients Changed: ${vendor?.other?.clients} to ${other?.clients}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (other?.usp && other.usp !== vendor?.other?.usp) {
                updates["other.usp"] = other?.usp;
                notifications.push({
                  title: `${vendor?.name} Usp Changed: ${vendor?.other.usp} to ${other?.usp}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                !(
                  other?.groomMakeup === undefined ||
                  other?.groomMakeup === null
                ) &&
                other?.groomMakeup !== vendor?.other?.groomMakeup
              ) {
                updates["other.groomMakeup"] = other.groomMakeup;
                notifications.push({
                  title: `${vendor?.name} Groom Makeup Status Changed: ${
                    vendor.other.groomMakeup ? "True" : "False"
                  } to ${other.groomMakeup ? "True" : "False"}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                !(
                  other?.lgbtqMakeup === undefined ||
                  other?.lgbtqMakeup === null
                ) &&
                other?.lgbtqMakeup !== vendor?.other?.lgbtqMakeup
              ) {
                updates["other.lgbtqMakeup"] = other.lgbtqMakeup;
                notifications.push({
                  title: `${vendor?.name} LGBTQ Makeup Status Changed: ${
                    vendor.other.lgbtqMakeup ? "True" : "False"
                  } to ${other.lgbtqMakeup ? "True" : "False"}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (businessName && businessName !== vendor.businessName) {
                updates.businessName = businessName;
                notifications.push({
                  title: `${vendor?.name} Business Name Changed: ${
                    vendor.businessName || ""
                  } to ${businessName}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                businessDescription &&
                businessDescription !== vendor.businessDescription
              ) {
                updates.businessDescription = businessDescription;
                notifications.push({
                  title: `${vendor?.name} Business Description Changed: ${
                    vendor.businessDescription || ""
                  } to ${businessDescription}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                businessAddress?.state &&
                businessAddress?.state !== vendor?.businessAddress?.state
              ) {
                updates["businessAddress.state"] = businessAddress?.state;
                notifications.push({
                  title: `${vendor?.name} State Changed: ${
                    vendor?.businessAddress?.state || ""
                  } to ${businessAddress?.state}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                businessAddress?.city &&
                businessAddress?.city !== vendor?.businessAddress?.city
              ) {
                updates["businessAddress.city"] = businessAddress?.city;
                notifications.push({
                  title: `${vendor?.name} City Changed: ${
                    vendor?.businessAddress?.city || ""
                  } to ${businessAddress?.city}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                businessAddress?.area &&
                businessAddress?.area !== vendor?.businessAddress?.area
              ) {
                updates["businessAddress.area"] = businessAddress?.area;
                notifications.push({
                  title: `${vendor?.name} Area Changed: ${
                    vendor?.businessAddress?.area || ""
                  } to ${businessAddress?.area}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                businessAddress?.pincode &&
                businessAddress?.pincode !== vendor?.businessAddress?.pincode
              ) {
                updates["businessAddress.pincode"] = businessAddress?.pincode;
                notifications.push({
                  title: `${vendor?.name} Pincode Changed: ${
                    vendor?.businessAddress?.pincode || ""
                  } to ${businessAddress?.pincode}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                businessAddress?.address &&
                businessAddress?.address !== vendor?.businessAddress?.address
              ) {
                updates["businessAddress.address"] = businessAddress?.address;
                notifications.push({
                  title: `${vendor?.name} Address Changed: ${
                    vendor?.businessAddress?.address || ""
                  } to ${businessAddress?.address}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                businessAddress?.googleMaps &&
                businessAddress?.googleMaps !==
                  vendor?.businessAddress?.googleMaps
              ) {
                updates["businessAddress.googleMaps"] =
                  businessAddress?.googleMaps;
                notifications.push({
                  title: `${vendor?.name} Google Maps Link Changed: ${
                    vendor?.businessAddress?.googleMaps || ""
                  } to ${businessAddress?.googleMaps}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              // If only gallery keys were sent but values equal, still allow success (idempotent)
              if (Object.keys(updates).length === 0) {
                return res.status(200).send({ message: "success" });
              }
              Vendor.findByIdAndUpdate(_id, { $set: updates }, { new: true })
                .then((result) => {
                  if (result) {
                    notifications.forEach((notification) =>
                      CreateNotification(notification)
                    );
                    res.status(200).send({ message: "success" });
                  } else {
                    res.status(404).send({ message: "not found" });
                  }
                })
                .catch((error) => {
                  res.status(400).send({ message: "error", error });
                });
            }
          })
          .catch((error) => {
            res.status(400).send({ message: "error", error });
          });
      }
    }
  } else if (isVendor) {
    const {
      name,
      businessAddress,
      businessName,
      businessDescription,
      servicesOffered,
      speciality,
      notifications,
      accountDetails,
      prices,
      gallery,
      other,
      profileCompleted,
      documents,
    } = req.body;
    // Detect explicit gallery updates, even if values are empty (used for deletions)
    const galleryPayloadVendor = req.body && req.body.gallery ? req.body.gallery : undefined;
    const hasExplicitGalleryChangeVendor =
      !!galleryPayloadVendor && (Object.prototype.hasOwnProperty.call(galleryPayloadVendor, "coverPhoto") ||
      Object.prototype.hasOwnProperty.call(galleryPayloadVendor, "photos"));
    if (
      !name &&
      // !businessAddress?.state &&
      // !businessAddress?.city &&
      // !businessAddress?.area &&
      // !businessAddress?.pincode &&
      // !businessAddress?.address &&
      // !businessAddress?.googleMaps &&
      !(
        _.has(req.body, "businessAddress") &&
        _.isPlainObject(req?.body?.businessAddress)
      ) &&
      !businessName &&
      !businessDescription &&
      servicesOffered?.length === 0 &&
      !speciality &&
      !prices?.party &&
      !prices?.bridal &&
      !prices?.groom &&
      /* No minimum gallery photo requirement */
      documents?.length === 0 &&
      [
        notifications?.bidding,
        notifications?.packages,
        notifications?.upcomingEvents,
        notifications?.booking,
        notifications?.payment,
      ].filter((i) => i === null || i === undefined)?.length >= 0 &&
      !accountDetails?.bankName &&
      !accountDetails?.accountNumber &&
      !accountDetails?.ifscCode &&
      (other?.groomMakeup === undefined || other?.groomMakeup === null) &&
      (other?.lgbtqMakeup === undefined || other?.lgbtqMakeup === null) &&
      !other?.experience &&
      !other?.clients &&
      !other?.usp &&
      other?.makeupProducts?.length === 0 &&
      other?.awards?.length === 0 &&
      documents?.length === 0
    ) {
      if (!hasExplicitGalleryChangeVendor) {
        res.status(400).send({ message: "Incomplete Data" });
        return;
      }
    } else {
      Vendor.findById({ _id: user_id })
        .then((vendor) => {
          try {
            if (!vendor) {
              res.status(404).send({ message: "Vendor not found" });
            } else {
              const updates = {};
              const notificationsList = [];
              if (profileCompleted === true) {
                // Check if at least one document is uploaded
                // If client didn't send documents, fallback to already-saved vendor.documents
                const docsToCheck =
                  Array.isArray(documents) && documents.length > 0
                    ? documents
                    : vendor?.documents || [];
                const hasDocuments =
                  Array.isArray(docsToCheck) &&
                  docsToCheck.length > 0 &&
                  docsToCheck.some(
                    (doc) => doc?.front?.url && doc?.back?.url
                  );
                
                if (!hasDocuments) {
                  return res.status(400).send({ 
                    message: "At least one address proof document (Aadhaar Card, Driving License, or Passport) is required to complete your profile." 
                  });
                }
                
                updates.profileCompleted = true;
                if (notifications?.bidding !== vendor?.notifications?.bidding) {
                  notificationsList.push({
                    title: `${vendor?.name} Profile Completed`,
                    category: "Vendor",
                    references: { vendor: vendor._id },
                  });
                }
              }
              if (
                [
                  notifications?.bidding,
                  notifications?.packages,
                  notifications?.upcomingEvents,
                  notifications?.booking,
                  notifications?.payment,
                ].filter((i) => i === null || i === undefined)?.length === 0 &&
                (notifications?.bidding !== vendor?.notifications?.bidding ||
                  notifications?.packages !== vendor?.notifications?.packages ||
                  notifications?.upcomingEvents !==
                    vendor?.notifications?.upcomingEvents ||
                  notifications?.booking !== vendor?.notifications?.booking ||
                  notifications?.payment !== vendor?.notifications?.payment)
              ) {
                updates.notifications = {
                  bidding: notifications?.bidding,
                  packages: notifications?.packages,
                  upcomingEvents: notifications?.upcomingEvents,
                  booking: notifications?.booking,
                  payment: notifications?.payment,
                };
                if (notifications?.bidding !== vendor?.notifications?.bidding) {
                  notificationsList.push({
                    title: `${
                      vendor?.name
                    } Bidding Notification Status Changed: ${
                      vendor?.notifications?.bidding
                        ?.toString()
                        .toUpperCase() || ""
                    } to ${
                      notifications?.bidding?.toString().toUpperCase() || ""
                    }`,
                    category: "Vendor",
                    references: { vendor: vendor._id },
                  });
                }
                if (
                  notifications?.packages !== vendor?.notifications?.packages
                ) {
                  notificationsList.push({
                    title: `${
                      vendor?.name
                    } Packages Notification Status Changed: ${
                      vendor?.notifications?.packages
                        ?.toString()
                        .toUpperCase() || ""
                    } to ${
                      notifications?.packages?.toString().toUpperCase() || ""
                    }`,
                    category: "Vendor",
                    references: { vendor: vendor._id },
                  });
                }
                if (
                  notifications?.upcomingEvents !==
                  vendor?.notifications?.upcomingEvents
                ) {
                  notificationsList.push({
                    title: `${
                      vendor?.name
                    } Upcoming Events Notification Status Changed: ${
                      vendor?.notifications?.upcomingEvents
                        ?.toString()
                        .toUpperCase() || ""
                    } to ${
                      notifications?.upcomingEvents?.toString().toUpperCase() ||
                      ""
                    }`,
                    category: "Vendor",
                    references: { vendor: vendor._id },
                  });
                }
                if (notifications?.booking !== vendor?.notifications?.booking) {
                  notificationsList.push({
                    title: `${
                      vendor?.name
                    } Booking Notification Status Changed: ${
                      vendor?.notifications?.booking
                        ?.toString()
                        .toUpperCase() || ""
                    } to ${
                      notifications?.booking?.toString().toUpperCase() || ""
                    }`,
                    category: "Vendor",
                    references: { vendor: vendor._id },
                  });
                }
                if (notifications?.payment !== vendor?.notifications?.payment) {
                  notificationsList.push({
                    title: `${
                      vendor?.name
                    } Payment Notification Status Changed: ${
                      vendor?.notifications?.payment
                        ?.toString()
                        .toUpperCase() || ""
                    } to ${
                      notifications?.payment?.toString().toUpperCase() || ""
                    }`,
                    category: "Vendor",
                    references: { vendor: vendor._id },
                  });
                }
              }
              // Apply gallery cover photo update whenever key is present (allow no-op and deletions)
              if (gallery && Object.prototype.hasOwnProperty.call(gallery, "coverPhoto")) {
                updates["gallery.coverPhoto"] = gallery?.coverPhoto;
                notificationsList.push({
                  title: `${vendor?.name} Gallery (coverPhoto) Changed`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              // Apply gallery photos update whenever key is present (allow empty array and no-op)
              if (gallery && Object.prototype.hasOwnProperty.call(gallery, "photos")) {
                updates["gallery.photos"] = gallery?.photos || [];
                notificationsList.push({
                  title: `${vendor?.name} Gallery (photos) Updated`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (documents && documents.length > 0 && JSON.stringify(documents) !== JSON.stringify(vendor?.documents)) {
                const { valid, message, documents: uploadedDocuments } = verifyDocument(documents);
                if (valid) {
                  updates.documents = documents;
                } else {
                  return res.status(400).send({ message });
                }
                notificationsList.push({
                  title: `${vendor?.name} Documents Updated`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                other?.makeupProducts &&
                other?.makeupProducts.length > 0 &&
                JSON.stringify(other?.makeupProducts) !==
                  JSON.stringify(vendor?.other?.makeupProducts)
              ) {
                updates["other.makeupProducts"] = other?.makeupProducts;
                notificationsList.push({
                  title: `${vendor?.name} Makeup Products Updated`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                other?.awards &&
                other?.awards.length > 0 &&
                JSON.stringify(other?.awards) !==
                  JSON.stringify(vendor?.other?.awards)
              ) {
                updates["other.awards"] = other?.awards;
                notificationsList.push({
                  title: `${vendor?.name} Awards Updated`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                other?.experience &&
                other?.experience !== vendor?.other?.experience
              ) {
                updates["other.experience"] = other?.experience;
                notificationsList.push({
                  title: `${vendor?.name} Experience Changed: ${
                    vendor?.other?.experience || ""
                  } to ${other?.experience}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (other?.clients && other?.clients !== vendor?.other?.clients) {
                updates["other.clients"] = other?.clients;
                notificationsList.push({
                  title: `${vendor?.name} Clients Changed: ${vendor?.other?.clients} to ${other?.clients}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (other?.usp && other.usp !== vendor?.other?.usp) {
                updates["other.usp"] = other?.usp;
                notificationsList.push({
                  title: `${vendor?.name} Usp Changed: ${vendor?.other.usp} to ${other?.usp}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                !(
                  other?.groomMakeup === undefined ||
                  other?.groomMakeup === null
                ) &&
                other?.groomMakeup !== vendor?.other?.groomMakeup
              ) {
                updates["other.groomMakeup"] = other.groomMakeup;
                notificationsList.push({
                  title: `${vendor?.name} Groom Makeup Status Changed: ${
                    vendor.other.groomMakeup ? "True" : "False"
                  } to ${other.groomMakeup ? "True" : "False"}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                !(
                  other?.lgbtqMakeup === undefined ||
                  other?.lgbtqMakeup === null
                ) &&
                other?.lgbtqMakeup !== vendor?.other?.lgbtqMakeup
              ) {
                updates["other.lgbtqMakeup"] = other.lgbtqMakeup;
                notificationsList.push({
                  title: `${vendor?.name} LGBTQ Makeup Status Changed: ${
                    vendor.other.lgbtqMakeup ? "True" : "False"
                  } to ${other.lgbtqMakeup ? "True" : "False"}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                gallery?.coverPhoto &&
                gallery?.coverPhoto !== vendor?.gallery?.coverPhoto
              ) {
                updates["gallery.coverPhoto"] = gallery?.coverPhoto;
                notificationsList.push({
                  title: `${vendor?.name} Gallery (coverPhoto) Changed`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                gallery?.photos &&
                gallery?.photos.length > 0 &&
                JSON.stringify(gallery?.photos) !==
                  JSON.stringify(vendor?.gallery?.photos)
              ) {
                updates["gallery.photos"] = gallery?.photos;
                notificationsList.push({
                  title: `${vendor?.name} Gallery (photos) Updated`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (prices?.party && prices?.party !== vendor?.prices?.party) {
                updates["prices.party"] = prices?.party;
                notificationsList.push({
                  title: `${vendor?.name} Prices (Party) Changed: ${
                    vendor?.prices?.party || ""
                  } to ${prices?.party}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (prices?.bridal && prices?.bridal !== vendor?.prices?.bridal) {
                updates["prices.bridal"] = prices?.bridal;
                notificationsList.push({
                  title: `${vendor?.name} Prices (Bridal) Changed: ${
                    vendor?.prices?.bridal || ""
                  } to ${prices?.bridal}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (prices?.groom && prices?.groom !== vendor?.prices?.groom) {
                updates["prices.groom"] = prices?.groom;
                notificationsList.push({
                  title: `${vendor?.name} Prices (Groom) Changed: ${
                    vendor?.prices?.groom || ""
                  } to ${prices?.groom}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                accountDetails?.bankName &&
                accountDetails?.bankName !== vendor?.accountDetails?.bankName
              ) {
                updates["accountDetails.bankName"] = accountDetails?.bankName;
                notificationsList.push({
                  title: `${vendor?.name} Account Details Bank Name Changed: ${
                    vendor?.accountDetails?.bankName || ""
                  } to ${accountDetails?.bankName}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                accountDetails?.accountNumber &&
                accountDetails?.accountNumber !==
                  vendor?.accountDetails?.accountNumber
              ) {
                updates["accountDetails.accountNumber"] =
                  accountDetails?.accountNumber;
                notificationsList.push({
                  title: `${
                    vendor?.name
                  } Account Details Account Number Changed: ${
                    vendor?.accountDetails?.accountNumber || ""
                  } to ${accountDetails?.accountNumber}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                accountDetails?.ifscCode &&
                accountDetails?.ifscCode !== vendor?.accountDetails?.ifscCode
              ) {
                updates["accountDetails.ifscCode"] = accountDetails?.ifscCode;
                notificationsList.push({
                  title: `${vendor?.name} Account Details IFSC Code Changed: ${
                    vendor?.accountDetails?.ifscCode || ""
                  } to ${accountDetails?.ifscCode}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (name && name !== vendor?.name) {
                updates.name = name;
                notificationsList.push({
                  title: `${vendor?.name} Name Changed: ${
                    vendor?.name || ""
                  } to ${name}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (speciality && speciality !== vendor?.speciality) {
                updates.speciality = speciality;
                notificationsList.push({
                  title: `${vendor?.name} Speciality Changed: ${
                    vendor?.speciality || ""
                  } to ${speciality}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                servicesOffered &&
                servicesOffered.length > 0 &&
                JSON.stringify(servicesOffered) !==
                  JSON.stringify(vendor?.servicesOffered)
              ) {
                updates.servicesOffered = servicesOffered;
                notificationsList.push({
                  title: `${vendor?.name} Services Offered Changed: ${
                    vendor?.servicesOffered.join(", ") || ""
                  } to ${servicesOffered.join(", ")}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (businessName && businessName !== vendor?.businessName) {
                updates.businessName = businessName;
                notificationsList.push({
                  title: `${vendor?.name} Business Name Changed: ${
                    vendor?.businessName || ""
                  } to ${businessName}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (
                businessDescription &&
                businessDescription !== vendor?.businessDescription
              ) {
                updates.businessDescription = businessDescription;
                notificationsList.push({
                  title: `${vendor?.name} Business Description Changed: ${
                    vendor?.businessDescription || ""
                  } to ${businessDescription}`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              if (!_.isEqual(businessAddress, vendor?.businessAddress)) {
                updates["businessAddress"] = businessAddress;
                notificationsList.push({
                  title: `${vendor?.name} Business Address Changed`,
                  category: "Vendor",
                  references: { vendor: vendor._id },
                });
              }
              // if (
              //   businessAddress?.state &&
              //   businessAddress?.state !== vendor?.businessAddress?.state
              // ) {
              //   updates["businessAddress.state"] = businessAddress?.state;
              //   notificationsList.push({
              //     title: `Vendor State Changed: ${
              //       vendor?.businessAddress?.state || ""
              //     } to ${businessAddress?.state}`,
              //     category: "Vendor",
              //     references: { vendor: vendor._id },
              //   });
              // }
              // if (
              //   businessAddress?.city &&
              //   businessAddress?.city !== vendor?.businessAddress?.city
              // ) {
              //   updates["businessAddress.city"] = businessAddress?.city;
              //   notificationsList.push({
              //     title: `Vendor City Changed: ${
              //       vendor?.businessAddress?.city || ""
              //     } to ${businessAddress?.city}`,
              //     category: "Vendor",
              //     references: { vendor: vendor._id },
              //   });
              // }
              // if (
              //   businessAddress?.area &&
              //   businessAddress?.area !== vendor?.businessAddress?.area
              // ) {
              //   updates["businessAddress.area"] = businessAddress?.area;
              //   notificationsList.push({
              //     title: `Vendor Area Changed: ${
              //       vendor?.businessAddress?.area || ""
              //     } to ${businessAddress?.area}`,
              //     category: "Vendor",
              //     references: { vendor: vendor._id },
              //   });
              // }
              // if (
              //   businessAddress?.pincode &&
              //   businessAddress?.pincode !== vendor?.businessAddress?.pincode
              // ) {
              //   updates["businessAddress.pincode"] = businessAddress?.pincode;
              //   notificationsList.push({
              //     title: `Vendor Pincode Changed: ${
              //       vendor?.businessAddress?.pincode || ""
              //     } to ${businessAddress?.pincode}`,
              //     category: "Vendor",
              //     references: { vendor: vendor._id },
              //   });
              // }
              // if (
              //   businessAddress?.address &&
              //   businessAddress?.address !== vendor?.businessAddress?.address
              // ) {
              //   updates["businessAddress.address"] = businessAddress?.address;
              //   notificationsList.push({
              //     title: `Vendor Address Changed: ${
              //       vendor?.businessAddress?.address || ""
              //     } to ${businessAddress?.address}`,
              //     category: "Vendor",
              //     references: { vendor: vendor._id },
              //   });
              // }
              // if (
              //   businessAddress?.googleMaps &&
              //   businessAddress?.googleMaps !==
              //     vendor?.businessAddress?.googleMaps
              // ) {
              //   updates["businessAddress.googleMaps"] =
              //     businessAddress?.googleMaps;
              //   notificationsList.push({
              //     title: `Vendor Google Maps Link Changed: ${
              //       vendor?.businessAddress?.googleMaps || ""
              //     } to ${businessAddress?.googleMaps}`,
              //     category: "Vendor",
              //     references: { vendor: vendor._id },
              //   });
              // }
              if (Object.keys(updates).length === 0) {
                return res.status(200).send({ message: "success" });
              }
              Vendor.findByIdAndUpdate(
                { _id: user_id },
                { $set: updates },
                { new: true }
              )
                .then((result) => {
                  if (result) {
                    notificationsList.forEach((notification) =>
                      CreateNotification(notification)
                    );
                    res.status(200).send({ message: "success" });
                  } else {
                    res.status(404).send({ message: "not found" });
                  }
                })
                .catch((error) => {
                  res.status(400).send({ message: "error", error });
                });
            }
          } catch (error) {
            res.status(400).send({ message: "error", error });
          }
        })
        .catch((error) => {
          res.status(400).send({ message: "error", error });
        });
    }
  }
};

const Delete = (req, res) => {
  const { _id } = req.params;
  Vendor.findByIdAndDelete({ _id })
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

const DeleteVendors = (req, res) => {
  const { vendorIds } = req.body;
  Vendor.deleteMany({ _id: { $in: vendorIds } })
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send({ message: "success" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const AddNotes = (req, res) => {
  const { _id } = req.params;
  const { text } = req.body;
  Vendor.findByIdAndUpdate(
    { _id },
    { $addToSet: { notes: { text, createdAt: Date.now() } } }
  )
    .then((result) => {
      if (!result) {
        res.status(404).send();
      } else {
        res.send({ message: "success" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

module.exports = {
  CreateNew,
  GetAll,
  Get,
  Update,
  Delete,
  DeleteVendors,
  AddNotes,
  GetVendorLastActive,
};
