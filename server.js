const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require('express-rate-limit');
const cron = require("node-cron");
const { createServer } = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const { EventCompletionChecker } = require("./utils/jobs");
const {
  remindVendorDMinus1,
  remindVendorDDay,
  reviewReminder,
  artistDetailReminder,
  birthdayReminder,
} = require("./utils/notificationJobs");
const { runDailyFollowUpReminders } = require("./utils/venueReminderJob");
const socketStore = require("./utils/socket");
const Chat = require("./models/Chat");
const { runScheduledSheetSync } = require("./controllers/venueSheetsSync");

//Creating Express App
const app = express();
// Behind nginx on EC2 (sets X-Forwarded-For) — trust the first proxy hop so
// express-rate-limit reads the real client IP instead of throwing
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR (its trust-proxy validation error).
app.set('trust proxy', 1);

//Applying middlewares
// app.use(cors());
app.use(cors({ origin: "*" })); //Temporary Change
app.use(helmet());
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));
app.use(bodyParser.json({
  limit: "50mb",
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));

//Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.ip === '127.0.0.1', // skip localhost
});
app.use(limiter);

//Connecting Database
const dbUrl = process.env.DATABASE_URL;
mongoose.connect(dbUrl, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 10000,
  maxPoolSize: 10,
  retryWrites: true,
  w: "majority",
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

//Upgrading to HTTP server with Socket.io
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
socketStore.set(io);

//Socket.io JWT authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("No token"));
  try {
    const result = jwt.verify(token, process.env.JWT_SECRET);
    const { _id, isVendor = false, isAdmin = false } = result;
    socket.data.userId = _id;
    socket.data.isVendor = isVendor;
    socket.data.isAdmin = isAdmin;
    next();
  } catch (err) {
    next(new Error("Invalid token"));
  }
});

//Socket.io connection handling
io.on("connection", (socket) => {
  const { userId, isVendor } = socket.data;
  const room = isVendor ? `vendor:${userId}` : `user:${userId}`;
  socket.join(room);

  socket.on("typing:start", async ({ chatId }) => {
    try {
      const chat = await Chat.findById(chatId).select("vendor user").lean();
      if (!chat) return;
      const targetRoom = isVendor ? `user:${chat.user}` : `vendor:${chat.vendor}`;
      socket.to(targetRoom).emit("typing:start", { chatId });
    } catch (_) {}
  });

  socket.on("typing:stop", async ({ chatId }) => {
    try {
      const chat = await Chat.findById(chatId).select("vendor user").lean();
      if (!chat) return;
      const targetRoom = isVendor ? `user:${chat.user}` : `vendor:${chat.vendor}`;
      socket.to(targetRoom).emit("typing:stop", { chatId });
    } catch (_) {}
  });

  socket.on("disconnect", () => {
    socket.broadcast.emit("user:offline", { room, userId });
  });
});

//Setting up the Ports and starting the app
let port = process.env.PORT;
if (port == null || port == "") {
  port = 8090; // Changed from 8000 to 8090 to match frontend configuration
}
httpServer.listen(port, function () {
  console.log(`--App listening on port ${port}`);
  // EventCompletionChecker();
  // Cron Jobs
  cron.schedule("0 10 * * *", () => {
    console.log(
      "This function will run at 10 AM every day according to the local timezone"
    );
    EventCompletionChecker();
  });

  // Notification jobs (all times IST via Asia/Kolkata timezone)
  const IST = { timezone: "Asia/Kolkata" };

  // D-1 reminder to vendor — 1pm IST
  cron.schedule("0 13 * * *", () => { remindVendorDMinus1(); }, IST);

  // Day-of reminder to vendor — 7am and 2pm IST
  cron.schedule("0 7,14 * * *", () => { remindVendorDDay(); }, IST);

  // Review nudge to user (event was yesterday) — 12pm, 2pm, 4pm, 6pm IST
  cron.schedule("0 12,14,16,18 * * *", () => { reviewReminder(); }, IST);

  // Artist name + contact to user (event in 2 days) — every 6 hours
  cron.schedule("0 */6 * * *", () => { artistDetailReminder(); }, IST);

  // Vendor birthday message — 9am IST
  cron.schedule("0 9 * * *", () => { birthdayReminder(); }, IST);

  // Venue owner follow-up reminders (Phase 1.4) — 9am IST. Env-gated + log-only
  // by default (REMINDERS_LOG_ONLY); no-ops gracefully without WhatsApp creds.
  cron.schedule("0 9 * * *", () => { runDailyFollowUpReminders(); }, IST);

  // Google Sheets one-way sync (sheet → leads) for every connected venue — every 15 min.
  // No-op when Google creds aren't configured (runScheduledSheetSync guards internally).
  cron.schedule("*/15 * * * *", () => { runScheduledSheetSync(); }, IST);
});
