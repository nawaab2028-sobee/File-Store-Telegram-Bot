// ─────────────────────────────────────────────────────────────────────────
// Force Subscribe
//  - Every channel in FORCE_SUB_CHANNELS (config.js) must be joined
//  - Membership is checked before /start (plain or file/batch link)
//  - Joined users are SAVED in MongoDB (collection: fsmembers)
//  - When a saved user leaves a channel, the bot DMs them immediately:
//      1) instantly, via Telegram "chat_member" updates
//      2) as a backup, via a periodic membership sweep (FORCE_SUB_SWEEP_SECONDS)
//  - Personal single-use invite links are created per user
// ─────────────────────────────────────────────────────────────────────────
const mongoose = require("mongoose");
const {
  FORCE_SUB_ENABLED,
  FORCE_SUB_EXEMPT_OWNER,
  FORCE_SUB_CHANNELS,
  FORCE_SUB_SWEEP_SECONDS,
  OWNER_ID,
} = require("./config");

const INVITE_TTL_SEC = 24 * 60 * 60; // personal invite link is valid for 24 hours
const OWNER_ALERT_GAP_MS = 6 * 60 * 60 * 1000; // same owner alert at most once per 6 hours
const LEFT_DM_GAP_MS = 10 * 60 * 1000; // never DM the same user+channel twice within 10 minutes
const SWEEP_SEC = Number(FORCE_SUB_SWEEP_SECONDS === undefined ? 60 : FORCE_SUB_SWEEP_SECONDS);
const IN_STATUSES = new Set(["creator", "administrator", "member"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── Saved "this user is joined in this channel" records ──
const memberSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  chatId: { type: Number, required: true },
  joinedAt: { type: Date, default: Date.now },
});
memberSchema.index({ userId: 1, chatId: 1 }, { unique: true });
const FsMember = mongoose.models.FsMember || mongoose.model("FsMember", memberSchema);

const markJoined = (userId, chatId) =>
  FsMember.updateOne(
    { userId, chatId },
    { $setOnInsert: { joinedAt: new Date() } },
    { upsert: true }
  ).catch((e) => {
    if (!e || e.code !== 11000) console.error("[ForceSub] save joined failed:", e && e.message);
  });

const unmark = (userId, chatId) =>
  FsMember.deleteOne({ userId, chatId }).catch((e) =>
    console.error("[ForceSub] delete record failed:", e && e.message)
  );

// ── Read channels from config (placeholder / invalid chatId are ignored) ──
const channels = [];
(function loadChannels() {
  const skipped = [];
  (Array.isArray(FORCE_SUB_CHANNELS) ? FORCE_SUB_CHANNELS : []).forEach((c, i) => {
    if (!c) return;
    const idStr = String(c.chatId === undefined ? "" : c.chatId).trim();
    if (!/^-100\d{6,}$/.test(idStr)) {
      skipped.push(c.title || `Channel ${i + 1}`);
      return;
    }
    channels.push({
      title: String(c.title || `Channel ${i + 1}`).trim(),
      link: String(c.link || "").trim(),
      chatId: Number(idStr),
    });
  });
  if (skipped.length) {
    console.warn(`[ForceSub] chatId not filled, channels ignored: ${skipped.join(", ")}`);
  }
})();

const byChatId = new Map(channels.map((c) => [c.chatId, c]));
const enabled = () => !!FORCE_SUB_ENABLED && channels.length > 0;
const isExempt = (userId) => !!FORCE_SUB_EXEMPT_OWNER && userId === OWNER_ID;

let bot = null;
let retryHandler = null; // set by start.js: (msgLike, payload) => ...
const linkCache = new Map(); // "chatId:userId" -> { url, exp }
const alertedAt = new Map(); // key -> timestamp (prevents owner alert spam)
const leftDmAt = new Map(); // "userId:chatId" -> timestamp

const errText = (err) =>
  (err && err.response && err.response.body && err.response.body.description) ||
  (err && err.message) ||
  String(err);

const isJoined = (m) =>
  !!m && (IN_STATUSES.has(m.status) || (m.status === "restricted" && m.is_member));

async function alertOwner(key, text) {
  const last = alertedAt.get(key) || 0;
  if (Date.now() - last < OWNER_ALERT_GAP_MS) return;
  alertedAt.set(key, Date.now());
  console.warn("[ForceSub]", text.replace(/<[^>]+>/g, ""));
  try {
    await bot.sendMessage(OWNER_ID, `⚠️ <b>Force Subscribe Alert</b>\n\n${text}`, {
      parse_mode: "HTML",
    });
  } catch (_) {
    /* owner has not started the bot - ignore */
  }
}

// ── Personal invite link (falls back to the config link) ──
async function getJoinLink(ch, userId, fresh = false) {
  const key = `${ch.chatId}:${userId}`;
  const cached = linkCache.get(key);
  if (!fresh && cached && cached.exp > Date.now() + 60 * 1000) return cached.url;

  try {
    const expire = Math.floor(Date.now() / 1000) + INVITE_TTL_SEC;
    const res = await bot.createChatInviteLink(ch.chatId, {
      name: `u${userId}`.slice(0, 32),
      expire_date: expire,
      member_limit: 1,
    });
    if (linkCache.size > 5000) {
      const now = Date.now();
      for (const [k, v] of linkCache) if (v.exp < now) linkCache.delete(k);
    }
    linkCache.set(key, { url: res.invite_link, exp: expire * 1000 });
    return res.invite_link;
  } catch (err) {
    alertOwner(
      `invite:${ch.chatId}`,
      `Could not create an invite link for <b>${esc(ch.title)}</b> (<code>${ch.chatId}</code>): ${esc(
        errText(err)
      )}\nMake the bot an admin there with the "Invite Users" permission. Until then the link from config.js is used.`
    );
    return ch.link || "";
  }
}

// ── Which channels has this user NOT joined? (also saves/removes joined records) ──
async function getMissing(userId) {
  const results = await Promise.all(
    channels.map(async (ch) => {
      try {
        const m = await bot.getChatMember(ch.chatId, userId);
        return { ch, joined: isJoined(m) };
      } catch (err) {
        // Config problem (bot not admin / wrong chatId): skip the channel instead of locking everyone out
        alertOwner(
          `check:${ch.chatId}`,
          `Could not check membership in <b>${esc(ch.title)}</b> (<code>${ch.chatId}</code>): ${esc(
            errText(err)
          )}\nMake the bot an admin in that channel and verify the chatId. This channel is skipped until it is fixed.`
        );
        return { ch, joined: true, failed: true };
      }
    })
  );
  results.forEach((r) => {
    if (r.failed) return;
    if (r.joined) {
      linkCache.delete(`${r.ch.chatId}:${userId}`);
      markJoined(userId, r.ch.chatId);
    } else {
      unmark(userId, r.ch.chatId);
    }
  });
  return results.filter((r) => !r.joined).map((r) => r.ch);
}

// ── "JOIN OUR CHANNELS FIRST" message + buttons ──
async function buildPrompt(user, payload, missing) {
  const name = esc(user.first_name || "User");
  const line = payload
    ? "YOUR LINK IS READY ‼️ JOIN OUR CHANNELS FIRST"
    : "JOIN OUR CHANNELS FIRST ‼️ THEN USE THE BOT";
  const text =
    `<blockquote><b>HEY ${name}</b></blockquote>\n\n` +
    `<b>${line}</b>\n\n` +
    `<i>Join all the channels below, then press 🔄 TRY AGAIN.</i>`;

  const links = await Promise.all(missing.map((ch) => getJoinLink(ch, user.id)));
  const buttons = [];
  missing.forEach((ch, i) => {
    if (links[i]) buttons.push({ text: `⭐ ${ch.title}`, url: links[i] });
  });

  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));

  let cb = `fs_retry:${payload || ""}`;
  if (Buffer.byteLength(cb) > 64) cb = "fs_retry:"; // Telegram limit (64 bytes)
  rows.push([{ text: "🔄 TRY AGAIN", callback_data: cb }]);

  return { text, reply_markup: { inline_keyboard: rows } };
}

// ── Called before /start. true = continue, false = blocked ──
async function gate(msg, payload) {
  try {
    if (!enabled() || !bot) return true;
    const user = msg.from;
    if (!user) return true;
    if (isExempt(user.id)) return true;

    const missing = await getMissing(user.id);
    if (!missing.length) return true;

    const { text, reply_markup } = await buildPrompt(user, payload, missing);
    await bot.sendMessage(msg.chat.id, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup,
    });
    return false;
  } catch (err) {
    console.error("[ForceSub] gate error:", errText(err));
    return true; // on an unexpected error, never take the whole bot down
  }
}

// ── TRY AGAIN button ──
async function onRetry(q) {
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;
  const payload = q.data.slice("fs_retry:".length);

  const missing = enabled() && !isExempt(q.from.id) ? await getMissing(q.from.id) : [];

  if (missing.length) {
    await bot
      .answerCallbackQuery(q.id, {
        text: "❗ Join all the channels first, then press TRY AGAIN.",
        show_alert: true,
      })
      .catch(() => {});
    try {
      const { text, reply_markup } = await buildPrompt(q.from, payload, missing);
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup,
      });
    } catch (_) {
      /* "message is not modified" - ignore */
    }
    return;
  }

  await bot.answerCallbackQuery(q.id, { text: "✅ Thanks for joining!" }).catch(() => {});
  await bot.deleteMessage(chatId, messageId).catch(() => {});
  if (retryHandler) {
    await retryHandler({ from: q.from, chat: q.message.chat }, payload);
  }
}

// ── The user left a force-sub channel: DM them right away ──
async function notifyLeft(ch, userId) {
  const key = `${userId}:${ch.chatId}`;
  if (Date.now() - (leftDmAt.get(key) || 0) < LEFT_DM_GAP_MS) return;
  leftDmAt.set(key, Date.now());
  try {
    linkCache.delete(`${ch.chatId}:${userId}`);
    const link = await getJoinLink(ch, userId, true);
    const text =
      `😡 <b>Dude, why you left from this channel ${esc(ch.title)}?</b>\n\n` +
      `Please join it again, otherwise you can't use me.`;
    const opts = { parse_mode: "HTML", disable_web_page_preview: true };
    if (link) {
      opts.reply_markup = {
        inline_keyboard: [[{ text: `✅ Join Now - ${ch.title}`, url: link }]],
      };
    }
    await bot.sendMessage(userId, text, opts);
    console.log(`[ForceSub] left-DM sent: user ${userId} left ${ch.title}`);
  } catch (err) {
    // The user never started the bot or has blocked it - the DM cannot be delivered
    console.log("[ForceSub] left-DM skipped:", errText(err));
  }
}

// ── Instant detection through Telegram "chat_member" updates ──
async function onChatMember(upd) {
  try {
    const ch = upd && upd.chat && byChatId.get(upd.chat.id);
    if (!ch || !enabled()) return;

    const oldM = upd.old_chat_member;
    const newM = upd.new_chat_member;
    if (!oldM || !newM || !newM.user) return;
    const user = newM.user;
    if (user.is_bot) return;
    console.log(`[ForceSub] chat_member: user ${user.id} ${oldM.status} -> ${newM.status} in ${ch.title}`);

    // User joined: save it
    if (isJoined(newM)) {
      linkCache.delete(`${ch.chatId}:${user.id}`);
      if (!isExempt(user.id)) await markJoined(user.id, ch.chatId);
      return;
    }

    // User is no longer in the channel: remove the saved record
    await unmark(user.id, ch.chatId);

    // DM only for a real "left" (not for ban/kick)
    const nowLeft =
      newM.status === "left" || (newM.status === "restricted" && !newM.is_member);
    if (!nowLeft || !isJoined(oldM) || isExempt(user.id)) return;
    await notifyLeft(ch, user.id);
  } catch (err) {
    console.error("[ForceSub] chat_member error:", errText(err));
  }
}

// ── Backup detection: re-check every saved joined user periodically ──
let sweeping = false;
async function sweep() {
  if (sweeping || !enabled()) return;
  sweeping = true;
  try {
    const ids = channels.map((c) => c.chatId);
    const cursor = FsMember.find({ chatId: { $in: ids } }).lean().cursor();
    let n = 0;
    for await (const rec of cursor) {
      const ch = byChatId.get(rec.chatId);
      if (!ch || isExempt(rec.userId)) continue;
      try {
        const m = await bot.getChatMember(rec.chatId, rec.userId);
        if (!isJoined(m)) {
          await unmark(rec.userId, rec.chatId);
          const kicked = m && m.status === "kicked";
          if (!kicked) await notifyLeft(ch, rec.userId);
        }
      } catch (_) {
        /* temporary API error - try again in the next sweep */
      }
      if (++n % 20 === 0) await sleep(1000); // stay under Telegram rate limits
    }
  } catch (err) {
    console.error("[ForceSub] sweep error:", errText(err));
  } finally {
    sweeping = false;
  }
}

// ── Called once from bot.js ──
async function init(botInstance) {
  bot = botInstance;
  if (!FORCE_SUB_ENABLED) {
    console.log("[ForceSub] disabled (FORCE_SUB_ENABLED=false)");
    return;
  }
  if (!channels.length) {
    console.log("[ForceSub] no valid channel configured - force subscribe is off");
    return;
  }

  bot.on("callback_query", (q) => {
    if (q && q.data && q.data.startsWith("fs_retry:") && q.message) {
      onRetry(q).catch((e) => console.error("[ForceSub] retry error:", errText(e)));
    }
  });
  bot.on("chat_member", (upd) => {
    onChatMember(upd);
  });

  // Startup check: is the bot an admin in every channel?
  try {
    const me = await bot.getMe();
    for (const ch of channels) {
      try {
        const m = await bot.getChatMember(ch.chatId, me.id);
        if (m.status !== "administrator" && m.status !== "creator") {
          await alertOwner(
            `admin:${ch.chatId}`,
            `The bot is not an admin in <b>${esc(ch.title)}</b> (<code>${ch.chatId}</code>). Make it an admin, otherwise membership checks and invite links will not work.`
          );
        } else {
          console.log(`[ForceSub] OK: ${ch.title} (${ch.chatId})`);
        }
      } catch (err) {
        await alertOwner(
          `admin:${ch.chatId}`,
          `Cannot access <b>${esc(ch.title)}</b> (<code>${ch.chatId}</code>): ${esc(
            errText(err)
          )}\nIs the chatId correct? Is the bot an admin of the channel?`
        );
      }
    }
  } catch (err) {
    console.error("[ForceSub] startup check failed:", errText(err));
  }

  if (SWEEP_SEC > 0) {
    setInterval(sweep, SWEEP_SEC * 1000);
    console.log(`[ForceSub] leave-sweep every ${SWEEP_SEC}s`);
  }
  console.log(`[ForceSub] enabled with ${channels.length} channel(s)`);
}

module.exports = {
  init,
  gate,
  sweep, // exported for testing
  isEnabled: enabled,
  setRetryHandler: (fn) => {
    retryHandler = fn;
  },
};
