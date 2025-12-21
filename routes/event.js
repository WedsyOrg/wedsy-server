const express = require("express");
const router = express.Router();

const {
  CheckToken,
  CheckLogin,
  CheckAdminLogin,
} = require("../middlewares/auth");
const event = require("../controllers/event");
const eventShare = require("../controllers/eventShare");

router.post("/", CheckLogin, event.CreateNew);
router.get("/", CheckLogin, event.GetAll);
router.get(
  "/:_id",
  (req, res, next) => {
    if (req.query.display === "true") {
      CheckToken(req, res, next);
    } else {
      CheckLogin(req, res, next);
    }
  },
  event.Get
);
router.delete("/", CheckAdminLogin, event.DeleteEvents);
// Delete a single event (admin: any, user: own event only)
router.delete("/:_id", CheckLogin, event.DeleteEvent);
router.put("/:_id", CheckLogin, event.Update);
router.post("/:_id/send", CheckAdminLogin, event.SendEventToClient);
router.post(
  "/:_id/booking-reminder",
  CheckAdminLogin,
  event.SendEventBookingReminder
);
router.put("/:_id/event-planner", CheckAdminLogin, event.UpdateEventPlanner);
router.put("/:_id/shuffle-eventDay", CheckAdminLogin, event.ShuffleEventDays);
router.post("/:_id/eventDay", CheckLogin, event.AddEventDay);
router.put("/:_id/eventDay/:eventDay", CheckLogin, event.UpdateEventDay);
router.delete("/:_id/eventDay/:eventDay", CheckLogin, event.DeleteEventDay);
router.put("/:_id/notes/:eventDay", CheckLogin, event.UpdateEventDayNotes);
router.put("/:_id/eventDay/:eventDay/notes", CheckLogin, event.UpdateNotes);
router.post("/:_id/decor/:dayId", CheckLogin, event.AddDecorInEventDay);
router.put("/:_id/decor/:dayId", CheckLogin, event.EditDecorInEventDay);
router.put(
  "/:_id/decor/:dayId/add-ons",
  CheckLogin,
  event.EditDecorAddOnsInEventDay
);
router.put(
  "/:_id/decor/:dayId/included",
  CheckLogin,
  event.EditDecorIncludedInEventDay
);
router.put(
  "/:_id/decor/:dayId/setup-location-image",
  CheckLogin,
  event.EditDecorSetupLocationImageInEventDay
);
router.put(
  "/:_id/decor/:dayId/primary-color",
  CheckLogin,
  event.EditDecorPrimaryColorInEventDay
);
router.put(
  "/:_id/decor/:dayId/secondary-color",
  CheckLogin,
  event.EditDecorSecondaryColorInEventDay
);
router.delete("/:_id/decor/:dayId", CheckLogin, event.RemoveDecorInEventDay);
router.post(
  "/:_id/decor-package/:dayId",
  CheckLogin,
  event.AddDecorPackageInEventDay
);
router.delete(
  "/:_id/decor-package/:dayId",
  CheckLogin,
  event.RemoveDecorPackageInEventDay
);
router.post("/:_id/finalize/:dayId", CheckLogin, event.FinalizeEventDay);
router.post("/:_id/finalize", CheckLogin, event.FinalizeEvent);
router.post("/:_id/approve/:dayId", CheckAdminLogin, event.ApproveEventDay);
router.delete(
  "/:_id/approve/:dayId",
  CheckAdminLogin,
  event.RemoveEventDayApproval
);
router.post("/:_id/approve", CheckAdminLogin, event.ApproveEvent);
router.delete("/:_id/approve", CheckAdminLogin, event.RemoveEventApproval);
router.delete("/:_id/finalize", CheckAdminLogin, event.RemoveEventFinalize);
router.put(
  "/:_id/custom-items/:dayId",
  CheckAdminLogin,
  event.UpdateCustomItemsInEventDay
);
router.put(
  "/:_id/custom-items-title/:dayId",
  CheckAdminLogin,
  event.UpdateCustomItemsTitleInEventDay
);
router.put(
  "/:_id/mandatory-items/:dayId",
  CheckAdminLogin,
  event.UpdateMandatoryItemsInEventDay
);
router.post("/:_id/event-access", CheckLogin, event.AddEventAccess);
router.delete("/:_id/event-access", CheckLogin, event.RemoveEventAccess);
router.post("/:_id/lost", CheckAdminLogin, event.MarkEventLost);

// Share links (no-login view access via token)
router.get("/:_id/share", CheckAdminLogin, eventShare.ListShares);
router.post("/:_id/share", CheckAdminLogin, eventShare.CreateShare);
router.put("/:_id/share/:shareId", CheckAdminLogin, eventShare.UpdateShare);
router.delete("/:_id/share/:shareId", CheckAdminLogin, eventShare.RevokeShare);
router.post(
  "/:_id/share/:shareId/rotate",
  CheckAdminLogin,
  eventShare.RotateShareToken
);

module.exports = router;
