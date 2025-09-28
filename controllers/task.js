const Task = require("../models/Task");

const CreateNew = (req, res) => {
  const { category, task, deadline, referenceId } = req.body;
  if (!category || !task || !deadline || !referenceId) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    new Task({
      category,
      task,
      deadline,
      referenceId,
      completed: false,
    })
      .save()
      .then((result) => {
        res.status(201).send({ message: "success", id: result._id });
      })
      .catch((error) => {
        res.status(400).send({ message: "error", error });
      });
  }
};

const GetAll = (req, res) => {
  const { category, referenceId } = req.query;
  const query = {};
  if (category && referenceId) {
    query.category = category;
    query.referenceId = referenceId;
  }
  Task.find(query)
    .then((result) => {
      res.send(result);
    })
    .catch((error) => {
      res.status(400).send({
        message: "error",
        error,
      });
    });
};

const Get = (req, res) => {
  const { _id } = req.params;
  Task.findById({ _id })
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
};

const Update = (req, res) => {
  const { _id } = req.params;
  const { category, task, deadline, referenceId } = req.body;
  if (!category || !task || !deadline || !referenceId) {
    res.status(400).send({ message: "Incomplete Data" });
  } else {
    Task.findByIdAndUpdate(
      { _id },
      {
        $set: {
          category,
          task,
          deadline,
          referenceId,
        },
      }
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

const CompleteTask = (req, res) => {
  const { _id } = req.params;
  Task.findByIdAndUpdate(
    { _id },
    {
      $set: {
        completed: true,
      },
    }
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
};

const Delete = (req, res) => {
  const { _id } = req.params;
  Task.findByIdAndDelete({ _id })
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

module.exports = { CreateNew, GetAll, Get, Update, Delete, CompleteTask };
