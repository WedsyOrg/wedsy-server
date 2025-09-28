const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const cors = require("cors");
const helmet = require("helmet");
const cron = require("node-cron");
require("dotenv").config();
const { EventCompletionChecker } = require("./utils/jobs");

//Creating Express App
const app = express();

//Applying middlewares
// app.use(cors());
app.use(cors({ origin: "*" })); //Temporary Change
app.use(helmet());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.json());

//Connecting Database
const dbUrl = process.env.DATABASE_URL;
mongoose.connect(dbUrl, { 
  useNewUrlParser: true, 
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 10000, // 10 seconds
  socketTimeoutMS: 45000, // 45 seconds
  connectTimeoutMS: 10000, // 10 seconds
  maxPoolSize: 10,
  retryWrites: true,
  w: 'majority'
}).catch((error) => {
  console.log("MongoDB connection error:", error);
  process.exit(1);
});

const database = mongoose.connection;
database.on("error", (error) => {
  console.log("Database connection error:", error);
});
database.once("connected", () => {
  console.log("--Database Connected");
});

//Adding routers
app.use("/", require("./routes/router"));

//Setting up the Ports and starting the app
let port = process.env.PORT;
if (port == null || port == "") {
  port = 8090; // Changed from 8000 to 8090 to match frontend configuration
}
app.listen(port, function () {
  console.log(`--App listening on port ${port}`);
  // EventCompletionChecker();
  // Corn Jobs
  cron.schedule("0 10 * * *", () => {
    console.log(
      "This function will run at 10 AM every day according to the local timezone"
    );
    EventCompletionChecker();
  });
});
