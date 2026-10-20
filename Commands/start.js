const forceSub = require("../forceSub");

module.exports = function ( app, bot, UserModel, OWNER_ID, BotModel, botUsername, START_IMAGE_URL, FileModel, BatchModel ) {
  // Per-user 10 second cooldown between file requests (see /start handler below).
  // In-memory is fine here since it's just a UX rate-limit, not critical data.
  const lastFileRequestAt = new Map();
  const FILE_REQUEST_COOLDOWN_MS = 10000; // 10 seconds

  const esc = (str) =>
    String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Welcome message: normal greeting with the user mentioned (clickable)
  const welcomeCaption = (user) =>
    `Hello, <a href="tg://user?id=${user.id}">${esc(user.first_name || "there")}</a>! 👋\n\n` +
    `Welcome to the File Store Bot.\n\n` +
    `Open a shared link to get your files and lectures instantly.`;
  const welcomeButtons = [
    [
      { text: "About", callback_data: "about" },
      { text: "👨‍💻 Cʀᴇᴀᴛᴏʀ", callback_data: "OwnerInfo" },
    ],
  ];

  // Sends a stored text item (keeps its formatting; falls back to plain text if HTML fails)
  const sendTextItem = async (chatId, item) => {
    if (item.html) {
      try {
        return await bot.sendMessage(chatId, item.html, { parse_mode: "HTML" });
      } catch (e) {
        /* fall back to plain text below */
      }
    }
    return bot.sendMessage(chatId, item.text || item.fileName || "");
  };

  // Enhanced /start command with greeting, info, and buttons
  const handleStart = async (msg, payloadRaw) => {
    const telegramId = msg.from.id;
    const firstName = msg.from.first_name;

    const botData = await BotModel.findOne();

    const payload = (payloadRaw || "").trim(); // Extracting any start payload (remove any surrounding spaces)

    // Force Subscribe: stop here unless the user has joined all required channels
    // (applies to plain /start and to every file/batch link)
    if (!(await forceSub.gate(msg, payload))) return;

    if (payload) {
      // 10 second cooldown: a user must wait 10s after getting a file before
      // they can request the next one via a new link.
      const now = Date.now();
      const lastAt = lastFileRequestAt.get(telegramId) || 0;
      const elapsed = now - lastAt;

      if (elapsed < FILE_REQUEST_COOLDOWN_MS) {
        const remainingSec = Math.ceil((FILE_REQUEST_COOLDOWN_MS - elapsed) / 1000);
        return bot.sendMessage(
          msg.chat.id,
          `⏳ Please wait ${remainingSec} second${remainingSec > 1 ? "s" : ""} for the next file.\n\nThis feature ensures a smooth experience for every user.`
        );
      }

      // If there's a payload, try to fetch file or batch data
      const fileData =
        (await FileModel.findOne({ uniqueId: payload })) ||
        (await BatchModel.findOne({ batchId: payload }));

      if (fileData) {
        if (fileData.type === "text") {
          // A stored text message
          const sentMessage = await sendTextItem(msg.chat.id, fileData);
          lastFileRequestAt.set(telegramId, Date.now());

          if (botData.autodel === "disable") return;

          bot.sendMessage(
            msg.chat.id,
            "🚨 Note: \n\nThis message will be deleted after 10 minutes. Please save or forward it to your personal saved messages to avoid losing it!"
          );
          setTimeout(() => {
            bot.deleteMessage(msg.chat.id, sentMessage.message_id).catch((err) => {
              console.error("Failed to delete message:", err);
            });
          }, 600000); // 10 minutes
          return;
        }
        if (fileData.fileId) {
          if (fileData.type === "photo") {
            const sentMessage = await bot.sendPhoto(
              msg.chat.id,
              fileData.fileId,
              {
                caption: fileData.caption || fileData.fileName,
              }
            );
            lastFileRequestAt.set(telegramId, Date.now());
            return;
          }
          // Send a single file
          const sentMessage = await bot.sendDocument(
            msg.chat.id,
            fileData.fileId,
            {
              caption: fileData.caption || fileData.fileName,
            }
          );
          lastFileRequestAt.set(telegramId, Date.now());

          if (botData.autodel === "disable") return;

          // Send a message about deletion and set a timeout to delete the message
          bot.sendMessage(
            msg.chat.id,
            "🚨 Note: \n\nThis media message will be deleted after 10 minutes. Please save or forward it to your personal saved messages to avoid losing it!"
          );

          setTimeout(() => {
            bot
              .deleteMessage(msg.chat.id, sentMessage.message_id)
              .catch((err) => {
                console.error("Failed to delete message:", err);
              });
          }, 600000); // 10 minutes
        } else if (fileData.files) {
          const sentMessages = [];

          for (const file of fileData.files) {
            const sentMsg =
              file.type === "text"
                ? await sendTextItem(msg.chat.id, file)
                : await bot.sendDocument(msg.chat.id, file.fileId, {
                    caption: file.caption || file.fileName,
                  });
            sentMessages.push(sentMsg.message_id);
            // Auto-share the next file after 10 seconds — user can't manually
            // request each file individually inside a batch, so this is done
            // automatically, except after the last one.
            if (file.type !== "text") await new Promise((resolve) => setTimeout(resolve, 10000));
          }

          lastFileRequestAt.set(telegramId, Date.now());
          bot.sendMessage(msg.chat.id, "successfully Sent all Files of Batch.");

          if (botData.autodel !== "disable") {
            bot.sendMessage(
              msg.chat.id,
              "🚨 Note: \n\nThese media messages will be deleted after 10 minutes. Please save or forward them to your personal saved messages to avoid losing them!"
            );

            // Delete all messages after 10 minutes
            setTimeout(() => {
              sentMessages.forEach((messageId) => {
                bot.deleteMessage(msg.chat.id, messageId).catch((err) => {
                  console.error("Failed to delete message:", err);
                });
              });
            }, 600000); // 10 minutes
          }
        }
      } else {
        bot.sendMessage(msg.chat.id, "Invalid or expired link.");
      }
    } else {
      // If no payload, send the welcome message with inline buttons
      await bot.sendPhoto(msg.chat.id, START_IMAGE_URL, {
        caption: welcomeCaption(msg.from),
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: welcomeButtons },
      });
    }
  };

  bot.onText(/\/start(.*)/, (msg, match) => handleStart(msg, match[1]));
  // Lets the force-sub "TRY AGAIN" button re-run the same /start after the user has joined
  forceSub.setRetryHandler(handleStart);

  const OwnerInfo = `
  <b>🌟 Oᴡɴᴇʀ Dᴇᴛᴀɪʟs 🌟</b>
  
  <b>🧑‍💻 Nᴀᴍᴇ:</b> Smarty MS
  
  <b>📱 Tɢ Uѕᴇʀɴᴀᴍᴇ:</b> <b>@SmartBoy_ApnaMS</b> 
  
  <b>✨ Cᴏɴnᴇᴄᴛ tᴏ mᴏʀᴇ cʀᴇᴀᴛɪvᴇ jᴏᴜʀɴᴇʏ✨</b> 
  `;
  const aboutMessage = `
  <blockquote><b>🎥 Mʏ Nᴀᴍᴇ: <a href='https://t.me/${botUsername}'>File-Store-Bot</a></b></blockquote>
  <blockquote><b>👨‍💻 Cʀᴇᴀᴛᴏʀ: <a href='https://t.me/SmartBoy_ApnaMS'>MS Bro</a></b></blockquote>
  <blockquote><b>👑 Owner: <a href='https://t.me/Mr_Toxic_1'>Owner 👑</a></b></blockquote>
  <blockquote><b>💜 Supporter: <a href='https://t.me/Lapata_786'>Sistu 💜</a></b></blockquote>
  <blockquote><b>🤝 Brother: <a href='https://t.me/Mk_khan001'>MK Bro</a></b></blockquote>
  <blockquote><b>💾 Bᴏᴛ Sᴇʀᴠᴇʀ: <a href='https://vercel.com'>Vercel 😁</a></b></blockquote>
  `;

  // Handle callback query for Developer Info
  bot.on("callback_query", (query) => {
    const firstName = query.from.first_name;
    const messageId = query.message.message_id;
    const chatId = query.message.chat.id;
    // Check if the callback data is 'developer_info'
    if (query.data === "OwnerInfo") {
      // Edit the message to show the About message along with the new image
      bot.editMessageMedia(
        {
          type: "photo",
          media: START_IMAGE_URL,
          caption: OwnerInfo, // The updated caption with the About information
          parse_mode: "HTML",
        },
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [[{ text: "⬅️ Bᴀᴄᴋ", callback_data: "back" }]],
          },
        }
      );
    }
    if (query.data === "about") {
      // Edit the message to show the About message along with the new image
      bot.editMessageMedia(
        {
          type: "photo",
          media: START_IMAGE_URL,
          caption: aboutMessage, // The updated caption with the About information
          parse_mode: "HTML",
        },
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [[{ text: "⬅️ Bᴀᴄᴋ", callback_data: "back" }]],
          },
        }
      );
    }
    if (query.data === "back") {
      // Revert back to the original greeting image and message
      bot.editMessageMedia(
        {
          type: "photo",
          media: START_IMAGE_URL, // The same image as the original one
          caption: welcomeCaption(query.from), // The original greeting caption
          parse_mode: "HTML",
        },
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: welcomeButtons },
        }
      );
    }
  });
};
