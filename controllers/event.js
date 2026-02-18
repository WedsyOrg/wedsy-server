const Event = require("../models/Event");
const User = require("../models/User");
const { SendUpdate } = require("../utils/update");
const EventShare = require("../models/EventShare");
const { sha256 } = require("./eventShare");

const CreateNew = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { name, community, eventDay, date, time, venue, user } = req.body;
  if (!name || !community || !eventDay || !date || !time || !venue) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    // Store the provided date both as date and eventDate to ensure consistency
    new Event({
      user: isAdmin ? user : user_id,
      name,
      community,
      eventDate: date, // Add the eventDate field explicitly
      eventDays: [{ name: eventDay, date, time, venue }],
    })
      .save()
      .then((result) => {
        res.status(200).send({ message: "success", _id: result._id });
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const Update = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id } = req.params;
  const { name, community, eventNotes, eventType, eventDate } = req.body;

  const hasMetaUpdate =
    name !== undefined ||
    community !== undefined ||
    eventType !== undefined ||
    eventDate !== undefined;

  if (eventNotes === undefined && !hasMetaUpdate) {
    res.status(400).send({ message: "Incomplete Data" });
  } else if (eventNotes !== undefined) {
    Event.findOneAndUpdate(
      isAdmin ? { _id } : { _id, user: user_id },
      {
        $set: { eventNotes },
      }
    )
      .then((result) => {
        res.status(200).send({ message: "success" });
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else if (hasMetaUpdate) {
    const update = {};
    if (name !== undefined) update.name = name;
    if (community !== undefined) update.community = community;
    if (eventType !== undefined) update.eventType = eventType;
    if (eventDate !== undefined) update.eventDate = eventDate;

    Event.findOneAndUpdate(
      isAdmin ? { _id } : { _id, user: user_id },
      { $set: update },
      { new: true }
    )
      .then((result) => {
        res.status(200).send({ message: "success" });
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  } else {
    res.status(400).send({ message: "Incomplete Data" });
  }
};

// Delete a single event
// - Admin: can delete any event
// - User: can delete only own event, and only if not finalized/approved
const DeleteEvent = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id } = req.params;

  const filter = isAdmin
    ? { _id }
    : {
      _id,
      user: user_id,
      "status.finalized": false,
      "status.approved": false,
    };

  Event.findOneAndDelete(filter)
    .then((result) => {
      if (result) {
        res.status(200).send({ message: "success" });
      } else {
        // Either not found or user not allowed (finalized/approved)
        res.status(404).send({ message: "not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const UpdateEventPlanner = (req, res) => {
  const { _id } = req.params;
  const { eventPlanner } = req.body;
  if (!eventPlanner) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Event.findOneAndUpdate(
      { _id },
      {
        eventPlanner,
      }
    )
      .then((result) => {
        res.status(200).send({ message: "success" });
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const ShuffleEventDays = async (req, res) => {
  const { _id } = req.params;
  const { eventDayId, direction } = req.body;
  if (!["up", "down"].includes(direction)) {
    return res
      .status(400)
      .json({ error: "Invalid direction. Use 'up' or 'down'." });
  }

  try {
    // Find the event by ID
    const event = await Event.findById(_id);
    if (!event) {
      return res.status(404).json({ error: "Event not found." });
    }

    const eventDays = event.eventDays;
    const index = eventDays.findIndex(
      (day) => day._id.toString() === eventDayId
    );

    if (index === -1) {
      return res.status(404).json({ error: "Event day not found." });
    }

    // Calculate the new index
    const newIndex = direction === "up" ? index - 1 : index + 1;

    if (newIndex < 0 || newIndex >= eventDays.length) {
      return res.status(400).json({ error: "Cannot shuffle beyond bounds." });
    }

    // Swap the event days
    [eventDays[index], eventDays[newIndex]] = [
      eventDays[newIndex],
      eventDays[index],
    ];

    // Save the updated event
    await event.save();

    res.status(200).json({ message: "success", event });
  } catch (error) {
    console.error("Error shuffling event days:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const AddEventDay = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id } = req.params;
  const { name, date, time, venue, eventSpace, location } = req.body;
  const computedVenue = venue || location?.formatted_address;
  if (!name || !date || !time || !computedVenue) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Event.findOneAndUpdate(isAdmin ? { _id } : { _id, user: user_id }, {
      $addToSet: {
        eventDays: {
          name,
          date,
          time,
          venue: computedVenue,
          eventSpace: eventSpace || "",
          location: location || {},
          decorItems: [],
          status: {
            finalized: false,
            approved: false,
            paymentDone: false,
            completed: false,
          },
        },
      },
    })
      .then((result) => {
        res.status(200).send({ message: "success" });
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const UpdateEventDayNotes = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id, eventDay } = req.params;
  const { notes } = req.body;
  if (notes === null || notes === undefined) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Event.findOneAndUpdate(
      isAdmin
        ? { _id, "eventDays._id": eventDay }
        : { _id, user: user_id, "eventDays._id": eventDay },
      {
        $set: {
          "eventDays.$.notes": notes,
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "Event not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const UpdateEventDay = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id, eventDay } = req.params;
  const { name, date, time, venue, eventSpace, location } = req.body;
  const computedVenue = venue || location?.formatted_address;
  if (!name || !date || !time || !computedVenue || !eventDay) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Event.findOneAndUpdate(
      isAdmin
        ? { _id, "eventDays._id": eventDay }
        : { _id, user: user_id, "eventDays._id": eventDay },
      {
        $set: {
          "eventDays.$.name": name,
          "eventDays.$.date": date,
          "eventDays.$.time": time,
          "eventDays.$.venue": computedVenue,
          "eventDays.$.eventSpace": eventSpace || "",
          "eventDays.$.location": location || {},
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "Event not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const DeleteEventDay = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id, eventDay } = req.params;
  Event.findOneAndUpdate(
    isAdmin
      ? { _id, "eventDays._id": eventDay, "status.approved": false }
      : {
        _id,
        user: user_id,
        "eventDays._id": eventDay,
        "status.finalized": false,
      },
    {
      $pull: {
        eventDays: { _id: eventDay },
      },
    }
  )
    .then((result) => {
      if (result) {
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "Event not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const UpdateNotes = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id, eventDay } = req.params;
  const { user, decor_id, package_id, admin_notes, user_notes, notes } = req.body;
  if (!decor_id && !package_id) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    if (decor_id) {
      Event.updateOne(
        isAdmin
          ? { _id, eventDays: { $elemMatch: { _id: eventDay } } }
          : {
            _id,
            user: user_id,
            eventDays: { $elemMatch: { _id: eventDay } },
          },
        {
          $set: isAdmin
            ? {
              "eventDays.$.decorItems.$[x].admin_notes": admin_notes,
              "eventDays.$.decorItems.$[x].user_notes": user_notes,
              "eventDays.$.decorItems.$[x].notes": notes,
            }
            : {
              "eventDays.$.decorItems.$[x].user_notes": user_notes,
            },
        },
        { arrayFilters: [{ "x.decor": decor_id }] }
      )
        .then((result) => {
          if (result) {
            res.status(200).send({ message: "success" });
          } else {
            res.status(404).send({ message: "Event not found" });
          }
        })
        .catch((error) => {
          res.status(400).send({ message: "error", error });
        });
    } else if (package_id) {
      Event.updateOne(
        isAdmin
          ? { _id, eventDays: { $elemMatch: { _id: eventDay } } }
          : {
            _id,
            user: user_id,
            eventDays: { $elemMatch: { _id: eventDay } },
          },
        {
          $set: isAdmin
            ? {
              "eventDays.$.packages.$[x].admin_notes": admin_notes,
              "eventDays.$.packages.$[x].user_notes": user_notes,
            }
            : {
              "eventDays.$.packages.$[x].user_notes": user_notes,
            },
        },
        { arrayFilters: [{ "x.package": package_id }] }
      )
        .then((result) => {
          if (result) {
            res.status(200).send({ message: "success" });
          } else {
            res.status(404).send({ message: "Event not found" });
          }
        })
        .catch((error) => {
          res.status(400).send({ message: "error", error });
        });
    }
  }
};

const UpdateCustomItemsInEventDay = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id, dayId } = req.params;
  const { customItems } = req.body;
  if (customItems === undefined || customItems === null) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Event.findOneAndUpdate(
      isAdmin
        ? { _id, eventDays: { $elemMatch: { _id: dayId } } }
        : { _id, user: user_id, eventDays: { $elemMatch: { _id: dayId } } },
      {
        $set: {
          "eventDays.$.customItems": customItems,
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "Event not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const UpdateCustomItemsTitleInEventDay = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id, dayId } = req.params;
  const { customItemsTitle } = req.body;
  if (customItemsTitle === undefined || customItemsTitle === null) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Event.findOneAndUpdate(
      isAdmin
        ? { _id, eventDays: { $elemMatch: { _id: dayId } } }
        : { _id, user: user_id, eventDays: { $elemMatch: { _id: dayId } } },
      {
        $set: {
          "eventDays.$.customItemsTitle": customItemsTitle,
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "Event not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const UpdateMandatoryItemsInEventDay = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id, dayId } = req.params;
  const { mandatoryItems } = req.body;
  if (mandatoryItems === undefined || mandatoryItems === null) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Event.findOneAndUpdate(
      isAdmin
        ? { _id, eventDays: { $elemMatch: { _id: dayId } } }
        : { _id, user: user_id, eventDays: { $elemMatch: { _id: dayId } } },
      {
        $set: {
          "eventDays.$.mandatoryItems": mandatoryItems,
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "Event not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const AddDecorInEventDay = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id, dayId } = req.params;
  const {
    decor,
    platform,
    flooring,
    dimensions,
    price,
    category,
    variant,
    quantity,
    unit,
    platformRate,
    flooringRate,
    decorPrice,
    included,
    productVariant,
    priceModifier,
  } = req.body;
  if (!decor || !category || !variant || !price || platform === undefined) {
    res.status(400).send({
      message: "Incomplete Data",
    });
  } else {
    Event.findOneAndUpdate(
      isAdmin
        ? { _id, eventDays: { $elemMatch: { _id: dayId } } }
        : { _id, user: user_id, eventDays: { $elemMatch: { _id: dayId } } },
      {
        $addToSet: {
          "eventDays.$.decorItems": {
            quantity,
            unit,
            decor,
            platform,
            flooring,
            dimensions,
            price,
            category,
            variant,
            platformRate,
            flooringRate,
            decorPrice,
            included,
            productVariant,
            priceModifier,
          },
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "Event not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const EditDecorInEventDay = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id, dayId } = req.params;
  const {
    decor_id,
    platform,
    flooring,
    dimensions,
    price,
    category,
    variant,
    quantity,
    unit,
    platformRate,
    flooringRate,
    decorPrice,
    productVariant,
    priceModifier,
  } = req.body;
  if (!decor_id || !category || !variant || !price || platform === undefined) {
    res.status(400).send({
      message: "Incomplete Data",
    });
  } else {
    Event.findOneAndUpdate(
      isAdmin
        ? { _id, eventDays: { $elemMatch: { _id: dayId } } }
        : { _id, user: user_id, eventDays: { $elemMatch: { _id: dayId } } },
      {
        $set: {
          "eventDays.$.decorItems.$[x].price": price,
          "eventDays.$.decorItems.$[x].quantity": quantity,
          "eventDays.$.decorItems.$[x].unit": unit,
          "eventDays.$.decorItems.$[x].platform": platform,
          "eventDays.$.decorItems.$[x].flooring": flooring,
          "eventDays.$.decorItems.$[x].dimensions": dimensions,
          "eventDays.$.decorItems.$[x].category": category,
          "eventDays.$.decorItems.$[x].variant": variant,
          "eventDays.$.decorItems.$[x].platformRate": platformRate,
          "eventDays.$.decorItems.$[x].flooringRate": flooringRate,
          "eventDays.$.decorItems.$[x].decorPrice": decorPrice,
          "eventDays.$.decorItems.$[x].productVariant": productVariant,
          "eventDays.$.decorItems.$[x].priceModifier": priceModifier,
        },
      },
      { arrayFilters: [{ "x.decor": decor_id }] }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "Event not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const EditDecorAddOnsInEventDay = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id, dayId } = req.params;
  const { decor_id, addOns, price } = req.body;
  if (!decor_id || addOns === undefined) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Event.findOneAndUpdate(
      isAdmin
        ? { _id, eventDays: { $elemMatch: { _id: dayId } } }
        : { _id, user: user_id, eventDays: { $elemMatch: { _id: dayId } } },
      {
        $set: {
          "eventDays.$.decorItems.$[x].addOns": addOns,
          "eventDays.$.decorItems.$[x].price": price,
        },
      },
      { arrayFilters: [{ "x.decor": decor_id }] }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "Event not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const EditDecorIncludedInEventDay = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id, dayId } = req.params;
  const { decor_id, included } = req.body;
  if (!decor_id || included === undefined) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Event.findOneAndUpdate(
      isAdmin
        ? { _id, eventDays: { $elemMatch: { _id: dayId } } }
        : { _id, user: user_id, eventDays: { $elemMatch: { _id: dayId } } },
      {
        $set: {
          "eventDays.$.decorItems.$[x].included": included,
        },
      },
      { arrayFilters: [{ "x.decor": decor_id }] }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "Event not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const EditDecorSetupLocationImageInEventDay = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id, dayId } = req.params;
  const { decor_id, setupLocationImage } = req.body;
  if (!decor_id || !setupLocationImage) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Event.findOneAndUpdate(
      isAdmin
        ? { _id, eventDays: { $elemMatch: { _id: dayId } } }
        : { _id, user: user_id, eventDays: { $elemMatch: { _id: dayId } } },
      {
        $set: {
          "eventDays.$.decorItems.$[x].setupLocationImage": setupLocationImage,
        },
      },
      { arrayFilters: [{ "x.decor": decor_id }] }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "Event not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const EditDecorPrimaryColorInEventDay = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id, dayId } = req.params;
  const { decor_id, primaryColor } = req.body;
  if (!decor_id || !primaryColor) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Event.findOneAndUpdate(
      isAdmin
        ? { _id, eventDays: { $elemMatch: { _id: dayId } } }
        : { _id, user: user_id, eventDays: { $elemMatch: { _id: dayId } } },
      {
        $set: {
          "eventDays.$.decorItems.$[x].primaryColor": primaryColor,
        },
      },
      { arrayFilters: [{ "x.decor": decor_id }] }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "Event not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const EditDecorSecondaryColorInEventDay = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id, dayId } = req.params;
  const { decor_id, secondaryColor } = req.body;
  if (!decor_id || !secondaryColor) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Event.findOneAndUpdate(
      isAdmin
        ? { _id, eventDays: { $elemMatch: { _id: dayId } } }
        : { _id, user: user_id, eventDays: { $elemMatch: { _id: dayId } } },
      {
        $set: {
          "eventDays.$.decorItems.$[x].secondaryColor": secondaryColor,
        },
      },
      { arrayFilters: [{ "x.decor": decor_id }] }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "Event not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const RemoveDecorInEventDay = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id, dayId } = req.params;
  const { decor } = req.body;
  if (!decor) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Event.findOneAndUpdate(
      isAdmin
        ? { _id, eventDays: { $elemMatch: { _id: dayId } } }
        : { _id, user: user_id, eventDays: { $elemMatch: { _id: dayId } } },
      {
        $pull: {
          "eventDays.$.decorItems": {
            decor,
          },
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "Event not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const AddDecorPackageInEventDay = (req, res) => {
  const { user_id } = req.auth;
  const { _id, dayId } = req.params;
  const { package, price, variant, decorItems } = req.body;
  if (!package || !variant || !price) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Event.findOneAndUpdate(
      { _id, user: user_id, eventDays: { $elemMatch: { _id: dayId } } },
      {
        $addToSet: {
          "eventDays.$.packages": {
            package,
            price,
            variant,
            decorItems,
          },
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "Event not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const RemoveDecorPackageInEventDay = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id, dayId } = req.params;
  const { package } = req.body;
  if (!package) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Event.findOneAndUpdate(
      isAdmin
        ? { _id, eventDays: { $elemMatch: { _id: dayId } } }
        : { _id, user: user_id, eventDays: { $elemMatch: { _id: dayId } } },
      {
        $pull: {
          "eventDays.$.packages": {
            package,
          },
        },
      }
    )
      .then((result) => {
        if (result) {
          res.status(200).send({ message: "success" });
        } else {
          res.status(404).send({ message: "Event not found" });
        }
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const GetAll = async (req, res) => {
  const { user_id, isAdmin } = req.auth;
  if (isAdmin) {
    if (req.query.stats === "upcoming") {
      //
    } else if (req.query.stats === "pending_approval") {
      // Aggregate to count finalized event days
      const result = await Event.aggregate([
        // { $unwind: "$eventdays" }, // Split the array into separate documents
        // // { $match: { "status.finalized": true } }, // Filter documents with status "finalized"
        // { $group: { _id: null, count: { $sum: 1 } } }, // Count the matching documents
        {
          $project: {
            count: {
              $size: {
                $filter: {
                  input: "$eventDays",
                  cond: { $eq: ["$$this.status.finalized", true] },
                },
              },
            },
          },
        },
        { $group: { _id: null, count: { $sum: "$count" } } },
      ]);
      // Extract the count from the result
      const count = result.length > 0 ? result[0].count : 0;
      res.send({ pending_approval: count });
    } else {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const {
        search,
        sort,
        status,
        community,
        eventType,
        startDate,
        endDate,
        eventDate,
      } = req.query;
      const query = {};
      const sortQuery = {};
      if (community) {
        query.community = community;
      }
      if (eventType) {
        query.eventType = eventType;
      }
      if (search) {
        query.$or = [
          { name: { $regex: new RegExp(search, "i") } },
          { venue: { $regex: new RegExp(search, "i") } },
          { community: { $regex: new RegExp(search, "i") } },
        ];
        query.$or.push({
          user: {
            $in: await User.find({
              $or: [
                { name: { $regex: new RegExp(search, "i") } },
                { phone: { $regex: new RegExp(search, "i") } },
                { email: { $regex: new RegExp(search, "i") } },
              ],
            }).distinct("_id"),
          },
        });
      }
      if (status) {
        if (status === "Finalized") {
          query["status.finalized"] = true;
          query["status.approved"] = false;
          query["status.paymentDone"] = false;
          query["status.completed"] = false;
        } else if (status === "Approved") {
          query["status.finalized"] = true;
          query["status.approved"] = true;
          query["status.paymentDone"] = false;
          query["status.completed"] = false;
        } else if (status === "Payment Done") {
          query["status.finalized"] = true;
          query["status.approved"] = true;
          query["status.paymentDone"] = true;
          query["status.completed"] = false;
        } else if (status === "Completed") {
          query["status.finalized"] = true;
          query["status.approved"] = true;
          query["status.paymentDone"] = true;
          query["status.completed"] = true;
        } else if (status === "Booked") {
          query["status.finalized"] = true;
          query["status.approved"] = true;
          query["status.paymentDone"] = false;
          query.$expr = {
            $eq: ["$amount.paid", { $multiply: ["$amount.total", 0.2] }],
          };
        } else if (status === "Partially Paid") {
          query["status.finalized"] = true;
          query["status.approved"] = true;
          query["status.paymentDone"] = false;
          query.$and = [
            {
              $expr: {
                $gt: ["$amount.paid", { $multiply: ["$amount.total", 0.2] }],
              },
            },
            {
              $expr: {
                $lt: ["$amount.paid", "$amount.total"],
              },
            },
          ];
        } else if (status === "Completely Paid") {
          query["status.finalized"] = true;
          query["status.approved"] = true;
          query["status.paymentDone"] = true;
          query.$expr = {
            $eq: ["$amount.paid", "$amount.total"],
          };
        } else if (status === "Event Lost") {
          query["status.lost"] = true;
        }
      }
      if (eventDate) {
        query["eventDays.date"] = eventDate;
      }
      if (startDate && endDate) {
        query["eventDays.date"] = { $gte: startDate, $lte: endDate };
      }
      if (sort) {
        if (sort === "Newest (Creation)") {
          sortQuery.createdAt = -1;
        } else if (sort === "Older (Creation)") {
          sortQuery.createdAt = 1;
        } else if (sort === "Closest (Event Date)") {
          sortQuery["eventDays.date"] = 1;
        } else if (sort === "Farthest (Event Date)") {
          sortQuery["eventDays.date"] = -1;
        }
      } else {
        sortQuery.createdAt = -1;
      }
      Event.countDocuments(query)
        .then((total) => {
          const totalPages = Math.ceil(total / limit);
          const skip = (page - 1) * limit;
          Event.find(query)
            .sort(sortQuery)
            .skip(skip)
            .limit(limit)
            .populate(
              "user eventDays.decorItems.decor eventDays.packages.package eventDays.packages.decorItems.decor"
            )
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
    Event.find({ user: user_id })
      .exec()
      .then((events) => {
        // For each event, ensure eventDate field exists
        const result = events.map((event) => {
          const eventObj = event.toObject();

          // If eventDate doesn't exist, set it based on best available date
          if (!eventObj.eventDate) {
            if (
              eventObj.eventDays &&
              eventObj.eventDays.length > 0 &&
              eventObj.eventDays[0].date
            ) {
              eventObj.eventDate = eventObj.eventDays[0].date;
            } else if (eventObj.date) {
              eventObj.eventDate = eventObj.date;
            }
          }

          return eventObj;
        });

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

const MarkEventLost = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id } = req.params;
  const { lostResponse } = req.body;
  Event.findOneAndUpdate(
    isAdmin
      ? {
        _id,
      }
      : {
        _id,
        user: user_id,
      },
    {
      $set: {
        "status.lost": true,
        lostResponse,
      },
    }
  )
    .then((result) => {
      if (result) {
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "Event not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const FinalizeEventDay = (req, res) => {
  const { user_id } = req.auth;
  const { _id, dayId } = req.params;
  Event.findOneAndUpdate(
    { _id, user: user_id, eventDays: { $elemMatch: { _id: dayId } } },
    {
      $set: {
        "eventDays.$.status.finalized": true,
      },
    }
  )
    .then((result) => {
      if (result) {
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "Event not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const FinalizeEvent = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id } = req.params;
  Event.findOne(
    isAdmin
      ? {
        _id,
        "status.finalized": false,
        "status.approved": false,
      }
      : {
        _id,
        user: user_id,
        "status.finalized": false,
        "status.approved": false,
      }
  )
    .then((event) => {
      if (event?._id) {
        let summary = event.eventDays.map((tempEventDay) => {
          let tempDecorItems = tempEventDay?.decorItems.reduce(
            (accumulator, currentValue) => {
              return accumulator + currentValue.price;
            },
            0
          );
          let tempPackages = tempEventDay?.packages.reduce(
            (accumulator, currentValue) => {
              return accumulator + currentValue.price;
            },
            0
          );
          let tempCustomItems = tempEventDay?.customItems.reduce(
            (accumulator, currentValue) => {
              return accumulator + currentValue.price;
            },
            0
          );
          let tempMandatoryItems = tempEventDay?.mandatoryItems.reduce(
            (accumulator, currentValue) => {
              return accumulator + currentValue.price;
            },
            0
          );
          let tempTotal =
            tempDecorItems +
            tempPackages +
            tempCustomItems +
            tempMandatoryItems;
          return {
            eventDayId: tempEventDay._id,
            decorItems: tempDecorItems,
            packages: tempPackages,
            customItems: tempCustomItems,
            mandatoryItems: tempMandatoryItems,
            total: tempTotal,
            costPrice: 0,
            sellingPrice: tempTotal,
          };
        });
        let finalTotal = summary.reduce((accumulator, currentValue) => {
          return accumulator + currentValue.total;
        }, 0);
        Event.findOneAndUpdate(
          isAdmin
            ? {
              _id,
              "status.finalized": false,
              "status.approved": false,
            }
            : {
              _id,
              user: user_id,
              "status.finalized": false,
              "status.approved": false,
            },
          {
            $set: {
              amount: {
                total: finalTotal,
                due: finalTotal,
                paid: 0,
                discount: 0,
                preTotal: finalTotal,
                costPrice: 0,
                sellingPrice: finalTotal,
                summary,
              },
              "status.finalized": true,
              "eventDays.$[elem].status.finalized": true,
            },
          },
          {
            arrayFilters: [
              { "elem._id": { $in: summary.map((i) => i.eventDayId) } },
            ],
          }
        )
          .then((result) => {
            if (result) {
              res.status(200).send({ message: "success" });
            } else {
              res.status(404).send({ message: "Event not found" });
            }
          })
          .catch((error) => {
            res.status(400).send({ message: "error", error });
          });
      } else {
        res.status(404).send({ message: "Event not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const ApproveEventDay = (req, res) => {
  const { user_id } = req.auth;
  const { _id, dayId } = req.params;
  Event.findOneAndUpdate(
    {
      _id,
      "status.finalized": true,
      "status.approved": false,
      eventDays: { $elemMatch: { _id: dayId, "status.finalized": true } },
    },
    {
      $set: {
        "eventDays.$.status.approved": true,
      },
    }
  )
    .then((result) => {
      if (result) {
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "Event not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const RemoveEventDayApproval = (req, res) => {
  const { user_id } = req.auth;
  const { _id, dayId } = req.params;
  Event.findOneAndUpdate(
    {
      _id,
      "status.finalized": true,
      "status.approved": false,
      eventDays: {
        $elemMatch: {
          _id: dayId,
          "status.finalized": true,
          "status.approved": true,
        },
      },
    },
    {
      $set: {
        "eventDays.$.status.approved": false,
      },
    }
  )
    .then((result) => {
      if (result) {
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "Event not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const ApproveEvent = (req, res) => {
  const { user_id } = req.auth;
  const { _id } = req.params;
  const { discount } = req.body;
  Event.findOne({ _id, "status.finalized": true, "status.approved": false })
    .populate("user")
    .exec()
    .then((event) => {
      if (event._id) {
        let summary = event.eventDays.map((tempEventDay) => {
          let tempDecorItems = tempEventDay?.decorItems.reduce(
            (accumulator, currentValue) => {
              return accumulator + currentValue.price;
            },
            0
          );
          let tempPackages = tempEventDay?.packages.reduce(
            (accumulator, currentValue) => {
              return accumulator + currentValue.price;
            },
            0
          );
          let tempCustomItems = tempEventDay?.customItems.reduce(
            (accumulator, currentValue) => {
              return accumulator + currentValue.price;
            },
            0
          );
          let tempMandatoryItems = tempEventDay?.mandatoryItems.reduce(
            (accumulator, currentValue) => {
              return accumulator + currentValue.price;
            },
            0
          );
          let tempTotal =
            tempDecorItems +
            tempPackages +
            tempCustomItems +
            tempMandatoryItems;
          return {
            eventDayId: tempEventDay._id,
            decorItems: tempDecorItems,
            packages: tempPackages,
            customItems: tempCustomItems,
            mandatoryItems: tempMandatoryItems,
            total: tempTotal,
            costPrice: 0,
            sellingPrice: tempTotal,
          };
        });
        let finalPreTotal = summary.reduce((accumulator, currentValue) => {
          return accumulator + currentValue.total;
        }, 0);
        const tempDiscount = discount || 0;
        let finalTotal = finalPreTotal - tempDiscount;
        Event.findOneAndUpdate(
          { _id, "status.finalized": true, "status.approved": false },
          {
            $set: {
              amount: {
                total: finalTotal,
                due: finalTotal,
                paid: 0,
                discount: tempDiscount,
                preTotal: finalPreTotal,
                costPrice: 0,
                sellingPrice: finalTotal,
                summary,
              },
              "status.approved": true,
              "eventDays.$[elem].status.approved": true,
            },
          },
          {
            arrayFilters: [
              { "elem._id": { $in: summary.map((i) => i.eventDayId) } },
            ],
          }
        )
          .then((result) => {
            if (result) {
              SendUpdate({
                channels: ["Whatsapp"],
                message: "Event Approved",
                parameters: {
                  name: event?.user?.name,
                  phone: event?.user?.phone,
                },
              });
              res.status(200).send({ message: "success" });
            } else {
              res.status(404).send({ message: "Event not found" });
            }
          })
          .catch((error) => {
            res.status(400).send({ message: "error", error });
          });
      } else {
        res.status(404).send({ message: "Event not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const RemoveEventApproval = (req, res) => {
  const { user_id } = req.auth;
  const { _id } = req.params;
  Event.findOneAndUpdate(
    { _id, "status.finalized": true, "status.approved": true },
    {
      $set: {
        "status.approved": false,
      },
    }
  )
    .then((result) => {
      if (result) {
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "Event not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const RemoveEventFinalize = (req, res) => {
  const { user_id } = req.auth;
  const { _id } = req.params;
  Event.findOneAndUpdate(
    { _id, "status.finalized": true, "status.approved": false },
    {
      $set: {
        "status.finalized": false,
      },
    }
  )
    .then((result) => {
      if (result) {
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "Event not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const Get = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id } = req.params;
  const { populate, display, share } = req.query;
  let query = Event.findById(
    isAdmin || display == "true" ? { _id } : { _id, user: user_id }
  );
  if (populate === "true") {
    query = query.populate(
      isAdmin
        ? "eventDays.decorItems.decor eventDays.packages.package eventDays.packages.decorItems.decor user"
        : "eventDays.decorItems.decor eventDays.packages.package eventDays.packages.decorItems.decor"
    );
  }
  query
    .then(async (result) => {
      if (!result) {
        res.status(404).send();
      } else {
        // Convert to object for manipulation
        const eventObj = result.toObject();

        // If eventDate doesn't exist, set it based on best available date
        if (!eventObj.eventDate) {
          if (
            eventObj.eventDays &&
            eventObj.eventDays.length > 0 &&
            eventObj.eventDays[0].date
          ) {
            eventObj.eventDate = eventObj.eventDays[0].date;
          } else if (eventObj.date) {
            eventObj.eventDate = eventObj.date;
          }
        }

        if (display == "true" && !isAdmin) {
          const isOwner = user_id && String(user_id) === String(result.user);
          let hasShareAccess = false;

          if (share) {
            try {
              const tokenHash = sha256(share);
              const shareDoc = await EventShare.findOne({
                event: _id,
                tokenHash,
                active: true,
              }).lean();
              hasShareAccess = !!shareDoc;
            } catch (_) {
              hasShareAccess = false;
            }
          }

          if (!isOwner && !hasShareAccess) {
            return res
              .status(403)
              .send({ message: "error", error: "Forbidden" });
          }

          res.send({ ...eventObj, userAccess: isOwner });
        } else {
          res.send(eventObj);
        }
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const SendEventToClient = (req, res) => {
  const { _id } = req.params;
  // Event.findOne({ _id, "status.finalized": true, "status.approved": false })
  Event.findOne({ _id })
    .populate("user")
    .exec()
    .then((event) => {
      if (event._id) {
        SendUpdate({
          channels: ["Whatsapp"],
          message: "Event Planner",
          parameters: {
            name: event?.user?.name,
            phone: event?.user?.phone,
            link: `${process.env.USER_APP_ORIGIN || "https://www.wedsy.in"}/event/${event?._id}/view`,
          },
        });
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "Event not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const SendEventBookingReminder = (req, res) => {
  const { _id } = req.params;
  // Event.findOne({ _id, "status.finalized": true, "status.approved": false })
  Event.findOne({ _id })
    .populate("user")
    .exec()
    .then((event) => {
      if (event._id) {
        SendUpdate({
          channels: ["Whatsapp"],
          message: "Booking Reminder",
          parameters: {
            name: event?.user?.name,
            phone: event?.user?.phone,
          },
        });
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "Event not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const AddEventAccess = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id } = req.params;
  const { phone } = req.body;
  Event.findOneAndUpdate(isAdmin ? { _id } : { _id, user: user_id }, {
    $addToSet: {
      eventAccess: phone,
    },
  })
    .then((result) => {
      if (result) {
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "Event not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const RemoveEventAccess = (req, res) => {
  const { user_id, isAdmin } = req.auth;
  const { _id } = req.params;
  const { phone } = req.body;
  Event.findOneAndUpdate(isAdmin ? { _id } : { _id, user: user_id }, {
    $pull: {
      eventAccess: phone,
    },
  })
    .then((result) => {
      if (result) {
        res.status(200).send({ message: "success" });
      } else {
        res.status(404).send({ message: "Event not found" });
      }
    })
    .catch((error) => {
      res.status(400).send({ message: "error", error });
    });
};

const DeleteEvents = (req, res) => {
  const { eventIds } = req.body;
  Event.deleteMany({ _id: { $in: eventIds } })
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
  DeleteEvents,
  CreateNew,
  Update,
  GetAll,
  Get,
  DeleteEvent,
  AddEventDay,
  AddDecorInEventDay,
  EditDecorInEventDay,
  EditDecorAddOnsInEventDay,
  EditDecorIncludedInEventDay,
  EditDecorSetupLocationImageInEventDay,
  EditDecorPrimaryColorInEventDay,
  EditDecorSecondaryColorInEventDay,
  RemoveDecorInEventDay,
  AddDecorPackageInEventDay,
  RemoveDecorPackageInEventDay,
  FinalizeEventDay,
  FinalizeEvent,
  UpdateEventDay,
  DeleteEventDay,
  UpdateNotes,
  UpdateCustomItemsInEventDay,
  UpdateMandatoryItemsInEventDay,
  UpdateCustomItemsTitleInEventDay,
  ApproveEvent,
  RemoveEventApproval,
  RemoveEventDayApproval,
  RemoveEventFinalize,
  ApproveEventDay,
  SendEventToClient,
  SendEventBookingReminder,
  AddEventAccess,
  RemoveEventAccess,
  MarkEventLost,
  UpdateEventPlanner,
  ShuffleEventDays,
  UpdateEventDayNotes,
};
