const TelegramBot = require("node-telegram-bot-api");
const crypto = require("crypto");
const mongoose = require("mongoose");
const express = require("express");
const { BOT_TOKEN, MONGO_URI, OWNER_ID, ADMIN_IDS, START_IMAGE_URL } = require("./config");
const { entitiesToHtml } = require("./textFormat");
const forceSub = require("./forceSub");
const userStore = require("./userStore");
// MongoDB connection setup

mongoose.set('strictQuery', true); // or false, depending on your preference
mongoose
  .connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Schema for users
const userSchema = new mongoose.Schema({
  telegramId: { type: Number, unique: true },
  firstName: String,
  username: String,
  status: { type: String, default: "active" },
  lastInteraction: { type: Date, default: Date.now },
  // first message + time of the user (saved only once, the first time they use the bot)
  firstMessage: String,
  firstSeenAt: { type: Date, default: Date.now },
});

const UserModel = mongoose.model("User", userSchema);

// bot data schame
const botSchema = new mongoose.Schema({
  autodel: { type: String, default: "disable" },
});

const BotModel = mongoose.model("BotModel", botSchema);

// Schema for batch and single files
const fileSchema = new mongoose.Schema({
  uniqueId: String,
  fileId: String,
  type: String,
  fileName: String,
  caption: String,
  // text messages (type "text"): plain text + the same text as Telegram-HTML (keeps bold/links/etc.)
  text: String,
  html: String,
  createdBy: Number,
});

const batchSchema = new mongoose.Schema({
  batchId: String,
  files: [fileSchema],
  createdBy: Number,
});

const FileModel = mongoose.model("File", fileSchema);
const BatchModel = mongoose.model("Batch", batchSchema);

// Bot setup
const app = express();
// "chat_member" must be in allowed_updates to get join/leave events of force-sub channels.
// Telegram expects allowed_updates as a JSON STRING (a plain array gets serialized wrongly
// by the library and the chat_member updates would never arrive).
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    params: {
      allowed_updates: JSON.stringify([
        "message",
        "edited_message",
        "channel_post",
        "edited_channel_post",
        "callback_query",
        "my_chat_member",
        "chat_member",
      ]),
    },
  },
});

// Batches are kept per user, so the owner and every admin can run their own batch at the same time
const batches = new Map(); // userId -> { id, files: [] }

// Variable to temporarily store broadcast message
let broadcastMessage = null;
let broadcastType = null;

// Helper function to check if the user is the owner
const isOwner = (userId) => userId === OWNER_ID;
// Owner + admins: only they can use the bot's commands / upload content
const isStaff = (userId) => userId === OWNER_ID || ADMIN_IDS.includes(userId);
const SHARE_BASE = "https://t.me/Testbro786Bot?start=";
const USELESS_WARNING = "<b>🤨 Do not send any useless message in this bot.</b>";
// Get bot information asynchronously
bot
  .getMe()
  .then(async (botInfo) => {
    // Now we have the botInfo object
    const botUsername = botInfo.username;

    // Ensure a BotModel settings document always exists.
    // (Root cause of the /settings command not working: no document was ever
    // created, so botData.autodel would crash with "Cannot read properties of null".)
    let botSettingsDoc = await BotModel.findOne();
    if (!botSettingsDoc) {
      botSettingsDoc = new BotModel({ autodel: "disable" });
      await botSettingsDoc.save();
      console.log("Initialized default BotModel settings document.");
    }

    bot.setMyCommands([{ command: "start", description: "Start the bot" }]);

    // Middleware to track users
    bot.on("message", async (msg) => {
      if (msg.from) {
        try {
          const { id: telegramId, first_name: firstName, username } = msg.from;
          const user = await UserModel.findOne({ telegramId });

          if (!user) {
            // If the user is not found, create a new user record
            // (the first message is saved too - only once in a lifetime)
            const firstMessage =
              msg.text || msg.caption || (msg.document ? "[document]" : msg.photo ? "[photo]" : msg.video ? "[video]" : "[message]");
            await new UserModel({ telegramId, firstName, username, firstMessage }).save();
            userStore.scheduleMirror(); // JSON mirror update
          } else {
            // If the user exists, update the last interaction timestamp and status
            user.lastInteraction = Date.now();
            user.status = "active";
            await user.save();
          }
        } catch (err) {
          // e.g. duplicate key (2 messages of the same new user at once) must never crash the bot
          if (!(err && err.code === 11000)) console.error("User tracking error:", err.message);
        }
      }
    });

    // Access control: everything except /start is only for the owner and admins.
    // (Their handlers below stay silent for other users - this is the single place that replies.)
    const lastWarnAt = new Map();
    bot.on("message", (msg) => {
      if (!msg.from || msg.from.is_bot || !msg.chat || msg.chat.type !== "private") return;
      if (isStaff(msg.from.id)) return;
      if (/\/start(.*)/.test(msg.text || "")) return; // same pattern as the /start handler
      const now = Date.now();
      if (now - (lastWarnAt.get(msg.from.id) || 0) < 1500) return; // do not flood the user
      lastWarnAt.set(msg.from.id, now);
      bot
        .sendMessage(msg.chat.id, USELESS_WARNING, { parse_mode: "HTML" })
        .catch(() => {});
    });

    // Function to delete the message from user's chat after a specified timeout
    /*    const deleteMessageAfterTimeout = async (chatId, messageId, timeout) => {
      setTimeout(async () => {
        try {
          await bot.telegram.deleteMessage(chatId, messageId);
          console.log(
            `Message with ID ${messageId} deleted from chat ${chatId}.`
          );
        } catch (error) {
          console.error(
            `Failed to delete message with ID ${messageId}:`,
            error
          );
        }
      }, timeout);
    }; */

    // Command to start a batch
    bot.onText(/\/batch/, (msg) => {
      const userId = msg.from.id;
      if (!isStaff(userId)) return; // other users get the "useless message" warning

      // Start a new batch for this user
      batches.set(userId, { id: crypto.randomBytes(8).toString("hex"), files: [] });

      // Inform the user that the batch has started
      bot.sendMessage(msg.chat.id, "Batch started! Send files (or text messages) for the batch.");
    });

    // One place for everything an owner/admin sends: file, photo, video, audio or text.
    // Inside a batch it is added to the batch, otherwise it is saved and a link is generated.
    const handleIncoming = async (msg, file, label) => {
      const userId = msg.from.id;
      if (!isStaff(userId)) return;

      const batch = batches.get(userId);
      if (batch) {
        batch.files.push(file);
        return bot.sendMessage(
          msg.chat.id,
          `${label} added to the batch.\n\nSend next file or click /finishbatch for End and Get batch link`
        );
      }

      const uniqueId = crypto.randomBytes(8).toString("hex");
      await new FileModel({ uniqueId, ...file, createdBy: userId }).save();
      return bot.sendMessage(
        msg.chat.id,
        `${label} saved! Shareable link: ${SHARE_BASE}${uniqueId}`
      );
    };
    const safeHandle = (msg, file, label) =>
      handleIncoming(msg, file, label).catch((err) =>
        console.error(`Failed to store ${label}:`, err.message)
      );

    // Handle document uploads
    bot.on("document", (msg) =>
      safeHandle(
        msg,
        {
          fileId: msg.document.file_id,
          type: "document",
          fileName: msg.document.file_name || "File",
          caption: msg.caption || "",
        },
        "File"
      )
    );

    // Handle photo uploads
    bot.on("photo", (msg) => {
      const largestPhoto = msg.photo[msg.photo.length - 1]; // choose highest resolution photo
      safeHandle(
        msg,
        {
          fileId: largestPhoto.file_id,
          type: "photo",
          fileName: "Photo",
          caption: msg.caption || "",
        },
        "Photo"
      );
    });

    // Handle video uploads
    bot.on("video", (msg) =>
      safeHandle(
        msg,
        {
          fileId: msg.video.file_id,
          type: "video",
          fileName: msg.video.file_name || "Video",
          caption: msg.caption || "",
        },
        "Video"
      )
    );

    // Handle audio uploads
    bot.on("audio", (msg) =>
      safeHandle(
        msg,
        {
          fileId: msg.audio.file_id,
          type: "audio",
          fileName: msg.audio.file_name || "Audio",
          caption: msg.caption || "",
        },
        "Audio"
      )
    );

    // Handle plain text messages (commands are ignored): text can be stored + shared like a file
    bot.on("text", (msg) => {
      if (!msg.text || msg.text.startsWith("/")) return;
      if (!isStaff(msg.from.id)) return;
      safeHandle(
        msg,
        {
          type: "text",
          fileName: msg.text.replace(/\s+/g, " ").slice(0, 40),
          caption: "",
          text: msg.text,
          html: entitiesToHtml(msg.text, msg.entities),
        },
        "Text"
      );
    });

    // Command to finish the batch
    bot.onText(/\/finishbatch/, async (msg) => {
      const telegramId = msg.from.id;
      if (!isStaff(telegramId)) return; // other users get the "useless message" warning

      // Check if the batch is active and has files
      const batch = batches.get(telegramId);
      if (batch && batch.files.length > 0) {
        // Save the batch data to the database
        const batchData = new BatchModel({
          batchId: batch.id,
          files: batch.files,
          createdBy: telegramId,
        });
        await batchData.save();

        // Generate the shareable link
        bot.sendMessage(
          msg.chat.id,
          `Batch saved successfully! Shareable link: ${SHARE_BASE}${batch.id}`
        );

        // Reset this user's batch
        batches.delete(telegramId);
      } else {
        bot.sendMessage(
          msg.chat.id,
          "No active batch or no files have been added."
        );
      }
    });

    // Command to show users data
    bot.onText(/\/users/, async (msg) => {
      const telegramId = msg.from.id;

      // Owner + admins only
      if (!isStaff(telegramId)) return;

      // Fetch all users from the database
      const users = await UserModel.find();
      let activeUsers = 0;
      let blockedUsers = 0;
      let deletedUsers = 0;

      // Check each user's status
      for (const user of users) {
        try {
          const chat = await bot.getChat(user.telegramId);
          if (chat && chat.id) {
            activeUsers++;
          }
        } catch (error) {
          if (error.response && error.response.error_code === 400) {
            deletedUsers++;
            user.status = "deleted";
            await user.save();
          } else if (error.response && error.response.error_code === 403) {
            blockedUsers++;
            user.status = "blocked";
            await user.save();
          }
        }
      }

      const totalUsers = users.length;

      // Send a summary of users
      bot.sendMessage(
        msg.chat.id,
        `👥 Total Users: ${totalUsers}\n✅ Active Users: ${activeUsers}\n🚫 Blocked Users: ${blockedUsers}\n❌ Deleted Accounts: ${deletedUsers}`
      );
    });

    // /broadcast, /exportusers, /importusers now live in Commands/broadcast.js

    require("./Commands/commands.js")(
      app,
      bot,
      UserModel,
      OWNER_ID,
      BotModel,
      botUsername,
      START_IMAGE_URL,
      FileModel,
      BatchModel
    );
    // Users JSON mirror/restore + Force Subscribe start
    userStore.init(UserModel).catch((e) => console.error("userStore init error:", e.message));
    forceSub.init(bot).catch((e) => console.error("forceSub init error:", e.message));

    // Express web server. Hosts like Render/Railway give the port in the PORT env variable
    // and must find it open, otherwise the deploy keeps "scanning for open port".
    app.get("/", (req, res) => res.send("Bot is running"));
    app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));
    const PORT = Number(process.env.PORT) || 3000;
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Bot is Running (web server on port ${PORT})`);
    });

    console.log(`Bot username: @${botUsername}`);

    // You can now use botUsername for generating links or other purposes
  })
  .catch((error) => {
    console.error("Error fetching bot info:", error);
  });
