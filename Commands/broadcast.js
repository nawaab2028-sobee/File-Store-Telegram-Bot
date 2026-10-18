// /broadcast, /exportusers, /importusers  (owner only)
const axios = require("axios");
const userStore = require("../userStore");

const PER_SECOND = 20; // stay below Telegram's limit (~30 msg/sec)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const errInfo = (err) => {
  const body = err && err.response && err.response.body;
  return {
    code: (body && body.error_code) || (err && err.response && err.response.statusCode),
    desc: ((body && body.description) || (err && err.message) || "").toLowerCase(),
    retryAfter: body && body.parameters && body.parameters.retry_after,
  };
};

module.exports = function (app, bot, UserModel, OWNER_ID) {
  const isOwner = (id) => id === OWNER_ID;
  let running = false;

  // forward to one user → "sent" | "blocked" | "deleted" | "failed"
  async function forwardTo(userId, fromChatId, messageId, attempt = 0) {
    try {
      await bot.forwardMessage(userId, fromChatId, messageId);
      return "sent";
    } catch (err) {
      const { code, desc, retryAfter } = errInfo(err);
      if (code === 429 && attempt < 3) {
        await sleep(((retryAfter || 5) + 1) * 1000);
        return forwardTo(userId, fromChatId, messageId, attempt + 1);
      }
      if (code === 403) {
        return desc.includes("deactivated") ? "deleted" : "blocked";
      }
      if (code === 400 && (desc.includes("chat not found") || desc.includes("deactivated"))) {
        return "deleted";
      }
      return "failed";
    }
  }

  bot.onText(/\/broadcast/, async (msg) => {
    if (!isOwner(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, "Only the owner can use this command.");
    }
    if (!msg.reply_to_message) {
      return bot.sendMessage(msg.chat.id, "Please reply to a message you want to broadcast.");
    }
    if (running) {
      return bot.sendMessage(msg.chat.id, "⏳ A broadcast is already running. Please wait.");
    }

    running = true;
    try {
      const originalId = msg.reply_to_message.message_id;
      const statusMsg = await bot.sendMessage(
        msg.chat.id,
        "📢 Broadcast started! Sending messages..."
      );

      // goes to every user in the DB (everyone who ever started the bot)
      const users = await UserModel.find({}, { telegramId: 1 }).lean();
      const total = users.length;
      const counts = { sent: 0, blocked: 0, deleted: 0, failed: 0 };
      const sentIds = [];
      const blockedIds = [];
      const deletedIds = [];
      let lastEdit = Date.now();

      for (let i = 0; i < total; i += PER_SECOND) {
        const started = Date.now();
        const chunk = users.slice(i, i + PER_SECOND);
        const results = await Promise.all(
          chunk.map((u) => forwardTo(u.telegramId, msg.chat.id, originalId))
        );
        results.forEach((r, idx) => {
          counts[r]++;
          if (r === "sent") sentIds.push(chunk[idx].telegramId);
          if (r === "blocked") blockedIds.push(chunk[idx].telegramId);
          if (r === "deleted") deletedIds.push(chunk[idx].telegramId);
        });

        if (Date.now() - lastEdit > 5000 && i + PER_SECOND < total) {
          lastEdit = Date.now();
          bot
            .editMessageText(
              `📢 Broadcasting... ${Math.min(i + PER_SECOND, total)}/${total}`,
              { chat_id: msg.chat.id, message_id: statusMsg.message_id }
            )
            .catch(() => {});
        }
        const wait = 1000 - (Date.now() - started);
        if (wait > 0) await sleep(wait);
      }

      // status sync (blocked / deleted / active again)
      try {
        if (sentIds.length)
          await UserModel.updateMany(
            { telegramId: { $in: sentIds }, status: { $ne: "active" } },
            { $set: { status: "active" } }
          );
        if (blockedIds.length)
          await UserModel.updateMany(
            { telegramId: { $in: blockedIds } },
            { $set: { status: "blocked" } }
          );
        if (deletedIds.length)
          await UserModel.updateMany(
            { telegramId: { $in: deletedIds } },
            { $set: { status: "deleted" } }
          );
      } catch (e) {
        console.error("Broadcast status sync failed:", e.message);
      }

      const failedTotal = counts.blocked + counts.deleted + counts.failed;
      await bot.sendMessage(
        msg.chat.id,
        `✅ Broadcast complete!\nSent to: ${counts.sent} users\n❌ Failed: ${failedTotal} users.\n\n` +
          `🚫 Blocked: ${counts.blocked}\n🗑 Deleted: ${counts.deleted}\n⚠️ Other: ${counts.failed}\n` +
          `👥 Total in DB: ${total}`
      );
    } catch (err) {
      console.error("Broadcast error:", err);
      bot.sendMessage(msg.chat.id, "❌ Broadcast failed: " + err.message).catch(() => {});
    } finally {
      running = false;
    }
  });

  // /exportusers → users.json file owner ko
  bot.onText(/\/exportusers/, async (msg) => {
    if (!isOwner(msg.from.id)) return;
    try {
      const users = await userStore.snapshot();
      const buf = Buffer.from(userStore.serialize(users), "utf8");
      await bot.sendDocument(
        msg.chat.id,
        buf,
        { caption: `👥 ${users.length} users backup.\nTo restore: reply to this file with /importusers.` },
        { filename: "users.json", contentType: "application/json" }
      );
    } catch (err) {
      bot.sendMessage(msg.chat.id, "❌ Export failed: " + err.message).catch(() => {});
    }
  });

  // reply to users.json with /importusers → merged into MongoDB
  bot.onText(/\/importusers/, async (msg) => {
    if (!isOwner(msg.from.id)) return;
    const doc = msg.reply_to_message && msg.reply_to_message.document;
    if (!doc) {
      return bot.sendMessage(
        msg.chat.id,
        "Reply to a users.json file with /importusers."
      );
    }
    try {
      const url = await bot.getFileLink(doc.file_id);
      const res = await axios.get(url, { responseType: "json" });
      const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
      const r = await userStore.importUsers((data && data.users) || data);
      userStore.scheduleMirror();
      bot.sendMessage(
        msg.chat.id,
        `✅ Import done\n➕ New added: ${r.added}\n♻️ Already existed: ${r.existing}\n⚠️ Invalid: ${r.invalid}`
      );
    } catch (err) {
      bot.sendMessage(msg.chat.id, "❌ Import failed: " + err.message).catch(() => {});
    }
  });
};
