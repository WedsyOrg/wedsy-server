const Notification = require("../models/Notification");

const CreateNotification = ({ category, title, references }) => {
  if (category && title) {
    new Notification({
      category,
      title,
      references,
    })
      .save()
      .then((result) => {
        console.log(`Notification Created: ${result._id}`);
      })
      .catch((error) => {
        console.log("Error creating notification.", error);
      });
  }
};

module.exports = { CreateNotification };
