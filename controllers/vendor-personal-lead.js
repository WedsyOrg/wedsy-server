const VendorPersonalLead = require("../models/VendorPersonalLead");
const Enquiry = require("../models/Enquiry");
const { SendUpdate } = require("../utils/update");

const CreateNew = (req, res) => {
  const { user_id } = req.auth;
  const { name, phone, notes, eventType, eventInfo, tasks, payment } = req.body;
  if (!name || !phone) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    // Check if enquiry already exists
    Enquiry.findOne({ phone })
      .then((existingEnquiry) => {
        if (existingEnquiry) {
          // Update existing enquiry instead of creating duplicate
          Enquiry.findByIdAndUpdate(
            existingEnquiry._id,
            {
              $set: {
                name,
                source: existingEnquiry.source || "Vendor Personal Leads",
                additionalInfo: {
                  ...existingEnquiry.additionalInfo,
                  vendor: user_id,
                },
              },
            }
          )
            .then(() => {
              // Create or update vendor personal lead
              VendorPersonalLead.findOne({ vendor: user_id, phone })
                .then((existingLead) => {
                  if (existingLead) {
                    VendorPersonalLead.findByIdAndUpdate(
                      existingLead._id,
                      {
                        $set: {
                          name,
                          phone,
                          notes,
                          eventType,
                          eventInfo,
                          tasks,
                          payment,
                        },
                      }
                    )
                      .then((result) => {
                        res.status(200).send({ message: "success", id: result._id });
                      })
                      .catch((error) => {
                        res.status(400).send({ message: "error", error });
                      });
                  } else {
                    new VendorPersonalLead({
                      vendor: user_id,
                      name,
                      phone,
                      notes,
                      eventType,
                      eventInfo,
                      tasks,
                      payment,
                    })
                      .save()
                      .then((result) => {
                        res.status(201).send({ message: "success", id: result._id });
                      })
                      .catch((error) => {
                        res.status(400).send({ message: "error", error });
                      });
                  }
                })
                .catch((error) => {
                  res.status(400).send({ message: "error", error });
                });
            })
            .catch((error) => {
              res.status(400).send({ message: "error", error });
            });
        } else {
          // No existing enquiry, create new one
          new VendorPersonalLead({
            vendor: user_id,
            name,
            phone,
            notes,
            eventType,
            eventInfo,
            tasks,
            payment,
          })
            .save()
            .then((result) => {
              new Enquiry({
                name,
                phone,
                email: "",
                verified: false,
                source: "Vendor Personal Leads",
                additionalInfo: { vendor: user_id },
              })
                .save()
                .then((r) => {
                  res.status(201).send({ message: "success", id: result._id });
                })
                .catch((error) => {
                  res.status(400).send({ message: "error", error });
                });
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
};

const GetAll = (req, res) => {
  const { user_id, isAdmin, isVendor } = req.auth;
  const { vendorId } = req.query;
  if (!isAdmin && !isVendor) {
    res.status(401).send({ message: "Unauthorized access" });
  } else {
    VendorPersonalLead.find(
      isAdmin ? (vendorId ? { vendor: vendorId } : {}) : { vendor: user_id }
    )
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
  const { user_id, isAdmin, isVendor } = req.auth;
  const { _id } = req.params;
  if (!isAdmin && !isVendor) {
    res.status(401).send({ message: "Unauthorized access" });
  } else {
    VendorPersonalLead.findOne(isAdmin ? { _id } : { _id, vendor: user_id })
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

/**
 * Calendar endpoint: returns flattened personal-lead event entries for a vendor
 *
 * GET /vendor-personal-lead/calendar?date=YYYY-MM-DD
 * GET /vendor-personal-lead/calendar?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *
 * Admin can pass vendorId=... to query a specific vendor's personal leads.
 */
const GetCalendarEvents = (req, res) => {
  const { user_id, isAdmin, isVendor } = req.auth;
  const { vendorId, date, startDate, endDate } = req.query;

  if (!isAdmin && !isVendor) {
    return res.status(401).send({ message: "Unauthorized access" });
  }

  // Determine vendor scope
  const baseFilter = isAdmin
    ? vendorId
      ? { vendor: vendorId }
      : {}
    : { vendor: user_id };

  // Validate query params
  const hasSingleDate = typeof date === "string" && date.trim().length > 0;
  const hasRange =
    typeof startDate === "string" &&
    startDate.trim().length > 0 &&
    typeof endDate === "string" &&
    endDate.trim().length > 0;

  if (!hasSingleDate && !hasRange) {
    return res.status(400).send({
      message: "error",
      error: "Provide either `date` or (`startDate` and `endDate`) query params",
    });
  }

  // Build eventInfo filter (string dates assumed in YYYY-MM-DD format)
  const filter = { ...baseFilter };
  if (hasSingleDate) {
    filter.eventInfo = { $elemMatch: { date: date.trim() } };
  } else {
    const s = startDate.trim();
    const e = endDate.trim();
    filter.eventInfo = { $elemMatch: { date: { $gte: s, $lte: e } } };
  }

  VendorPersonalLead.find(filter)
    .select("_id name phone notes eventInfo")
    .lean()
    .then((leads) => {
      const list = [];

      (leads || []).forEach((lead) => {
        const events = Array.isArray(lead?.eventInfo) ? lead.eventInfo : [];
        events.forEach((ev) => {
          const evDate = (ev?.date || "").trim();
          if (!evDate) return;

          if (hasSingleDate) {
            if (evDate !== date.trim()) return;
          } else {
            const s = startDate.trim();
            const e = endDate.trim();
            if (evDate < s || evDate > e) return;
          }

          list.push({
            type: "personal-lead",
            leadId: lead?._id,
            name: lead?.name || "",
            phone: lead?.phone || "",
            notes: lead?.notes || "",
            date: evDate,
            time: (ev?.time || "").trim(),
          });
        });
      });

      // Sort by date then time
      list.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return (a.time || "").localeCompare(b.time || "");
      });

      res.send({ message: "success", list });
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const Update = (req, res) => {
  const { _id } = req.params;
  const { user_id } = req.auth;
  const { name, phone, notes, eventType, eventInfo, tasks, payment } = req.body;
  if (
    !name &&
    !phone &&
    !notes &&
    eventType === undefined &&
    ![eventInfo, tasks, payment].filter((i) => i !== null && i !== undefined)
      ?.length > 0
  ) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    const updates = {};
    if (name) {
      updates.name = name;
    }
    if (phone) {
      updates.phone = phone;
    }
    if (notes) {
      updates.notes = notes;
    }
    if (eventType !== null && eventType !== undefined) {
      updates.eventType = eventType;
    }
    if (payment !== null && payment !== undefined) {
      updates.payment = payment;
    }
    if (tasks !== null && tasks !== undefined) {
      updates.tasks = tasks;
    }
    if (eventInfo !== null && eventInfo !== undefined) {
      updates.eventInfo = eventInfo;
    }

    VendorPersonalLead.findOneAndUpdate(
      { _id, vendor: user_id },
      { $set: updates },
      { new: true }
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
  }
};

const UpdateAdminNotes = (req, res) => {
  const { _id } = req.params;
  const { admin_notes } = req.body;
  if (!admin_notes) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    VendorPersonalLead.findByIdAndUpdate({ _id }, { $set: { admin_notes } })
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
  }
};

const Delete = (req, res) => {
  const { user_id } = req.auth;
  const { _id } = req.params;
  VendorPersonalLead.findOneAndDelete({ _id, vendor: user_id })
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

// Delete a single payment transaction from a personal lead (vendor only)
// DELETE /vendor-personal-lead/:_id/transactions/:transactionId
const DeleteTransaction = async (req, res) => {
  const { user_id } = req.auth;
  const { _id, transactionId } = req.params;

  try {
    const lead = await VendorPersonalLead.findOne({ _id, vendor: user_id }).lean();
    if (!lead) return res.status(404).send({ message: "not found" });

    const txns = lead?.payment?.transactions || [];
    const exists = txns.some((t) => String(t?._id) === String(transactionId));
    if (!exists) return res.status(404).send({ message: "transaction not found" });

    const updatedTxns = txns.filter((t) => String(t?._id) !== String(transactionId));
    const received = updatedTxns.reduce((sum, t) => sum + (Number(t?.amount) || 0), 0);

    await VendorPersonalLead.updateOne(
      { _id, vendor: user_id },
      {
        $set: {
          "payment.transactions": updatedTxns,
          "payment.received": received,
        },
      }
    );

    res.status(200).send({ message: "success", received, transactionsCount: updatedTxns.length });
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
};

// Send WhatsApp payment reminder + persist reminder count/log (vendor only)
// POST /vendor-personal-lead/:_id/payment-reminder
const SendPaymentReminder = async (req, res) => {
  const { user_id } = req.auth;
  const { _id } = req.params;
  const { notes = "" } = req.body || {};

  try {
    const lead = await VendorPersonalLead.findOne({ _id, vendor: user_id });
    if (!lead) return res.status(404).send({ message: "not found" });

    const rawPhone = String(lead.phone || "").trim();
    if (!rawPhone) return res.status(400).send({ message: "error", error: "Lead phone missing" });

    // Normalize phone for WhatsApp provider
    const phone =
      rawPhone.startsWith("+") ? rawPhone : rawPhone.length === 10 ? `+91${rawPhone}` : rawPhone;

    const total = Number(lead?.payment?.total || 0);
    const received = Number(lead?.payment?.received || 0);
    const due = Math.max(0, total - received);

    // Attempt sending WhatsApp message (non-blocking: still track attempt)
    SendUpdate({
      channels: ["Whatsapp"],
      message: "Vendor Payment Reminder",
      parameters: {
        name: lead.name || "Customer",
        phone,
        total,
        received,
        due,
      },
    });

    lead.payment.remindersSentCount = Number(lead?.payment?.remindersSentCount || 0) + 1;
    lead.payment.lastReminderAt = new Date();
    lead.payment.reminders = [
      ...(Array.isArray(lead.payment.reminders) ? lead.payment.reminders : []),
      { sentAt: new Date(), channel: "Whatsapp", status: "sent", notes: String(notes || "") },
    ];

    await lead.save();

    res.status(200).send({
      message: "success",
      remindersSentCount: lead.payment.remindersSentCount,
      lastReminderAt: lead.payment.lastReminderAt,
      due,
    });
  } catch (error) {
    res.status(400).send({ message: "error", error });
  }
};

module.exports = {
  CreateNew,
  GetAll,
  Get,
  GetCalendarEvents,
  Update,
  Delete,
  UpdateAdminNotes,
  DeleteTransaction,
  SendPaymentReminder,
};
