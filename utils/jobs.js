const Event = require("../models/Event");

const EventCompletionChecker = () => {
  const markEventLost = (_id) => {
    Event.findOneAndUpdate(_id, {
      $set: {
        "status.lost": true,
        lostResponse: "Others",
      },
    })
      .then((result) => {})
      .catch((error) => {
        console.log(
          "Error while updating Event as Lost in Event Completion Checker.",
          error
        );
      });
  };
  const markEventCompleted = (_id) => {
    Event.findOneAndUpdate(_id, {
      $set: {
        "status.completed": true,
      },
    })
      .then((result) => {})
      .catch((error) => {
        console.log(
          "Error while updating Event as Completed in Event Completion Checker.",
          error
        );
      });
  };
  let todayDate = new Date();
  let today = `${todayDate.getFullYear()}-${String(
    todayDate.getMonth() + 1
  ).padStart(2, "0")}-${String(todayDate.getDate()).padStart(2, "0")}`;
  Event.find({
    eventDays: {
      $not: {
        $all: [
          {
            $elemMatch: {
              date: {
                $gte: today,
              },
            },
          },
        ],
      },
    },
    "status.completed": { $ne: true },
    "status.lost": { $ne: true },
  })
    .then((events) => {
      //   console.log(`Event fetched!\nTotal Events fetched: ${events.length}`);
      events.forEach((event) => {
        if (
          event.status.finalized === false ||
          event.status.approved === false
        ) {
          markEventLost(event._id);
        } else if (event.status.paymentDone === true) {
          markEventCompleted(event._id);
        } else {
          //   console.log(
          //     `Event: ${event._id} | Date: ${event.eventDays
          //       .map((i) => i.date)
          //       .join(", ")}\nPayments: ${event.amount.paid}/${
          //       event.amount.total
          //     }`
          //   );
        }
      });
    })
    .catch((error) => {
      console.log("Error fetching Events in Event Completion Checker.", error);
    });
};

module.exports = { EventCompletionChecker };
