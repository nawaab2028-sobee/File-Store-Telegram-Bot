const TelegramBot = require("node-telegram-bot-api");
const crypto = require("crypto");
const mongoose = require("mongoose");
const express = require("express");
const { BOT_TOKEN, MONGO_URI, OWNER_ID, START_IMAGE_URL } = require("./config");
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
  // pehli baar bot use karte waqt ka message + time (sirf ek baar save hota hai)
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
// chat_member updates (user ne channel chhoda/join kiya) ke liye allowed_updates me "chat_member" zaroori hai
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    params: {
      allowed_updates: [
        "message",
        "edited_message",
        "channel_post",
        "edited_channel_post",
        "callback_query",
        "my_chat_member",
        "chat_member",
      ],
    },
  },
});

let isBatchActive = false;
let batchFiles = [];
let currentBatchId = null;

// Variable to temporarily store broadcast message
let broadcastMessage = null;
let broadcastType = null;

// Helper function to check if the user is the owner
const isOwner = (userId) => userId === OWNER_ID;
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

    bot.setMyCommands([
      { command: "start", description: "Start the bot" },
      { command: "batch", description: "Start a batch upload" },
      { command: "finishbatch", description: "Finish current batch" },
      { command: "users", description: "Show all users (owner only)" },
      { command: "broadcast", description: "Broadcast message (owner only)" },
      { command: "exportusers", description: "Export users backup (owner only)" },
      { command: "importusers", description: "Import users backup (owner only)" },
      { command: "settings", description: "Bot Settings (owner only)" },
      { command: "help", description: "Show help information" },
      { command: "about", description: "About this bot" },
      { command: "legal", description: "Legal disclaimer & usage terms" },
    ]);

    // Middleware to track users
    bot.on("message", async (msg) => {
      if (msg.from) {
        try {
          const { id: telegramId, first_name: firstName, username } = msg.from;
          const user = await UserModel.findOne({ telegramId });

          if (!user) {
            // If the user is not found, create a new user record
            // (pehla message bhi save hota hai — life me sirf ek baar)
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
          // duplicate key (ek hi user ke 2 message ek saath) jaise errors se bot crash na ho
          if (!(err && err.code === 11000)) console.error("User tracking error:", err.message);
        }
      }
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
      const chatId = msg.from.id;

      // Check if the user is the owner
      if (!isOwner(chatId)) {
        bot.sendMessage(chatId, "Only the owner can start a batch.");
        return;
      }

      // Start a new batch
      isBatchActive = true;
      currentBatchId = crypto.randomBytes(8).toString("hex");
      batchFiles = [];

      // Inform the user that the batch has started
      bot.sendMessage(chatId, "Batch started! Send files for the batch.");
    });

    // Handle document uploads
    bot.on("document", async (msg) => {
      const file = {
        fileId: msg.document.file_id,
        type: "document",
        fileName: msg.document.file_name || "File",
        caption: msg.caption || "",
      };

      if (isBatchActive && isOwner(msg.from.id)) {
        batchFiles.push(file);
        bot.sendMessage(
          msg.chat.id,
          "File added to the batch.\n\nSend next file or click /finishbatch for End and Get batch link"
        );
      } else if (!isBatchActive && isOwner(msg.from.id)) {
        const uniqueId = crypto.randomBytes(8).toString("hex");
        const singleFile = new FileModel({
          uniqueId,
          ...file,
          createdBy: msg.from.id,
        });

        await singleFile.save();
        const shareLink = `https://t.me/PWSENSEI_FileStoreBot?start=${uniqueId}`;
        bot.sendMessage(
          msg.chat.id,
          `File saved! Shareable link: ${shareLink}`
        );
      } else if (!isOwner(msg.from.id)) {
        bot.sendMessage(
          msg.chat.id,
          "Sorry you can't use this feature\nPowerd By: @PW_SENSEI"
        );
      }
    });

    // Handle document uploads
    bot.on("photo", async (msg) => {
      const photoSizes = msg.photo;
      const largestPhoto = photoSizes[photoSizes.length - 1]; // choose highest resolution photo

      const file = {
        fileId: largestPhoto.file_id,
        type: "photo",
        fileName: "Photo",
        caption: msg.caption || "",
      };

      if (isBatchActive && isOwner(msg.from.id)) {
        batchFiles.push(file);
        bot.sendMessage(
          msg.chat.id,
          "Photo added to the batch.\n\nSend next file or click /finishbatch for End and Get batch link."
        );
      } else if (!isBatchActive && isOwner(msg.from.id)) {
        const uniqueId = crypto.randomBytes(8).toString("hex");
        const singleFile = new FileModel({
          uniqueId,
          ...file,
          createdBy: msg.from.id,
        });

        await singleFile.save();
        const shareLink = `https://t.me/PWSENSEI_FileStoreBot?start=${uniqueId}`;
        bot.sendMessage(
          msg.chat.id,
          `File saved! Shareable link: ${shareLink}`
        );
      } else if (!isOwner(msg.from.id)) {
        bot.sendMessage(
          msg.chat.id,
          "Sorry you can't use this feature\nPowerd By: @PW_SENSEI"
        );
      }
    });

    // Handle video uploads
    bot.on("video", async (msg) => {
      const file = {
        fileId: msg.video.file_id,
        type: "video",
        fileName: msg.video.file_name || "Video",
        caption: msg.caption || "",
      };

      if (isBatchActive && isOwner(msg.from.id)) {
        batchFiles.push(file);
        bot.sendMessage(
          msg.chat.id,
          "Video added to the batch.\n\nSend next file or click /finishbatch for End and Get batch link"
        );
      } else if (!isBatchActive && isOwner(msg.from.id)) {
        const uniqueId = crypto.randomBytes(8).toString("hex");
        const singleFile = new FileModel({
          uniqueId,
          ...file,
          createdBy: msg.from.id,
        });

        await singleFile.save();
        const shareLink = `https://t.me/PWSENSEI_FileStoreBot?start=${uniqueId}`;
        bot.sendMessage(
          msg.chat.id,
          `Video saved! Shareable link: ${shareLink}`
        );
      } else if (!isOwner(msg.from.id)) {
        bot.sendMessage(
          msg.chat.id,
          "Sorry you can't use this feature\nPowerd By: @PW_SENSEI"
        );
      }
    });

    // Handle audio uploads
    bot.on("audio", async (msg) => {
      const file = {
        fileId: msg.audio.file_id,
        type: "audio",
        fileName: msg.audio.file_name || "Audio",
        caption: msg.caption || "",
      };

      if (isBatchActive && isOwner(msg.from.id)) {
        batchFiles.push(file);
        bot.sendMessage(
          msg.chat.id,
          "Audio added to the batch.\n\nSend next file or click /finishbatch for End and Get batch link."
        );
      } else if (!isBatchActive && isOwner(msg.from.id)) {
        const uniqueId = crypto.randomBytes(8).toString("hex");
        const singleFile = new FileModel({
          uniqueId,
          ...file,
          createdBy: msg.from.id,
        });

        await singleFile.save();
        const shareLink = `https://t.me/PWSENSEI_FileStoreBot?start=${uniqueId}`;
        bot.sendMessage(
          msg.chat.id,
          `Audio saved! Shareable link: ${shareLink}`
        );
      } else if (!isOwner(msg.from.id)) {
        bot.sendMessage(
          msg.chat.id,
          "Sorry you can't use this feature\nPowerd By: @PW_SENSEI"
        );
      }
    });

    // Command to finish the batch
    bot.onText(/\/finishbatch/, async (msg) => {
      const telegramId = msg.from.id;

      // Check if the user is the owner
      if (!isOwner(telegramId)) {
        bot.sendMessage(msg.chat.id, "Only the owner can finish the batch.");
        return;
      }

      // Check if the batch is active and has files
      if (isBatchActive && batchFiles.length > 0) {
        // Save the batch data to the database
        const batchData = new BatchModel({
          batchId: currentBatchId,
          files: batchFiles,
          createdBy: telegramId,
        });
        await batchData.save();

        // Generate the shareable link
        const shareLink = `https://t.me/PWSENSEI_FileStoreBot?start=${currentBatchId}`;
        bot.sendMessage(
          msg.chat.id,
          `Batch saved successfully! Shareable link: ${shareLink}`
        );

        // Reset batch-related variables
        isBatchActive = false;
        batchFiles = [];
        currentBatchId = null;
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

      // Check if the user is the owner
      if (!isOwner(telegramId)) {
        return bot.sendMessage(
          msg.chat.id,
          "Only the owner can use this command."
        );
      }

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

    // /broadcast, /exportusers, /importusers ab Commands/broadcast.js me hain

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
    // Users ka JSON mirror/restore + Force Subscribe start
    userStore.init(UserModel).catch((e) => console.error("userStore init error:", e.message));
    forceSub.init(bot).catch((e) => console.error("forceSub init error:", e.message));

    // Express server for webhook or other purposes
    app.listen(3000, () => {
      console.log("Bot is Running");
    });

    console.log(`Bot username: @${botUsername}`);

    // You can now use botUsername for generating links or other purposes
  })
  .catch((error) => {
    console.error("Error fetching bot info:", error);
  });
