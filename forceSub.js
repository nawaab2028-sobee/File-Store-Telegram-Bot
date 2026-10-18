// ─────────────────────────────────────────────────────────────────────────
// Force Subscribe
//  • config.js ke FORCE_SUB_CHANNELS ke saare channels join hone zaroori hain
//  • /start (simple ya file/batch link) se pehle har user ka membership check
//  • user channel chhode to turant DM: "why you left... Join Now"
//  • har user ke liye personal (single-use) invite link
// ─────────────────────────────────────────────────────────────────────────
const {
  FORCE_SUB_ENABLED,
  FORCE_SUB_EXEMPT_OWNER,
  FORCE_SUB_CHANNELS,
  OWNER_ID,
} = require("./config");

const INVITE_TTL_SEC = 24 * 60 * 60; // personal invite link 24 ghante valid
const OWNER_ALERT_GAP_MS = 6 * 60 * 60 * 1000; // same error ka owner alert 6 ghante me ek hi baar
const IN_STATUSES = new Set(["creator", "administrator", "member"]);

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── config se channels nikalna (placeholder / galat chatId ignore) ──
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
    console.warn(
      `[ForceSub] chatId fill nahi hui, ignore kiye gaye channels: ${skipped.join(", ")}`
    );
  }
})();

const byChatId = new Map(channels.map((c) => [c.chatId, c]));
const enabled = () => !!FORCE_SUB_ENABLED && channels.length > 0;

let bot = null;
let retryHandler = null; // start.js set karta hai: (msgLike, payload) => ...
const linkCache = new Map(); // "chatId:userId" -> { url, exp }
const alertedAt = new Map(); // key -> timestamp (owner alerts spam rokne ke liye)

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
    /* owner ne bot start nahi kiya ho to ignore */
  }
}

// ── personal invite link (fail ho to config wala link) ──
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
      `<b>${esc(ch.title)}</b> (<code>${ch.chatId}</code>) ka invite link nahi bana: ${esc(
        errText(err)
      )}\nBot ko channel me admin banao (Invite Users permission ke saath). Tab tak config wala link use hoga.`
    );
    return ch.link || "";
  }
}

// ── user kin channels me join NAHI hai ──
async function getMissing(userId) {
  const results = await Promise.all(
    channels.map(async (ch) => {
      try {
        const m = await bot.getChatMember(ch.chatId, userId);
        return { ch, joined: isJoined(m) };
      } catch (err) {
        // config problem (bot admin nahi / chatId galat) — users ko atkane se behtar hai skip karna
        alertOwner(
          `check:${ch.chatId}`,
          `<b>${esc(ch.title)}</b> (<code>${ch.chatId}</code>) me membership check nahi ho paya: ${esc(
            errText(err)
          )}\nBot ko us channel me admin banao aur chatId check karo. Jab tak ye theek nahi hota, ye channel skip hoga.`
        );
        return { ch, joined: true };
      }
    })
  );
  results.forEach((r) => {
    if (r.joined) linkCache.delete(`${r.ch.chatId}:${userId}`);
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
    `<i>Sabhi channels join karke 🔄 TRY AGAIN dabao.</i>`;

  const links = await Promise.all(missing.map((ch) => getJoinLink(ch, user.id)));
  const buttons = [];
  missing.forEach((ch, i) => {
    if (links[i]) buttons.push({ text: `⭐ ${ch.title}`, url: links[i] });
  });

  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));

  let cb = `fs_retry:${payload || ""}`;
  if (Buffer.byteLength(cb) > 64) cb = "fs_retry:"; // telegram limit (64 bytes)
  rows.push([{ text: "🔄 TRY AGAIN", callback_data: cb }]);

  return { text, reply_markup: { inline_keyboard: rows } };
}

// ── /start se pehle call hota hai. true = aage badho, false = roko ──
async function gate(msg, payload) {
  try {
    if (!enabled() || !bot) return true;
    const user = msg.from;
    if (!user) return true;
    if (FORCE_SUB_EXEMPT_OWNER && user.id === OWNER_ID) return true;

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
    return true; // koi unexpected error ho to bot ko band na karo
  }
}

// ── TRY AGAIN button ──
async function onRetry(q) {
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;
  const payload = q.data.slice("fs_retry:".length);

  const exempt = FORCE_SUB_EXEMPT_OWNER && q.from.id === OWNER_ID;
  const missing = enabled() && !exempt ? await getMissing(q.from.id) : [];

  if (missing.length) {
    await bot
      .answerCallbackQuery(q.id, {
        text: "❗ Pehle sabhi channels join karo, phir TRY AGAIN dabao.",
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
      /* "message is not modified" — ignore */
    }
    return;
  }

  await bot.answerCallbackQuery(q.id, { text: "✅ Thanks for joining!" }).catch(() => {});
  await bot.deleteMessage(chatId, messageId).catch(() => {});
  if (retryHandler) {
    await retryHandler({ from: q.from, chat: q.message.chat }, payload);
  }
}

// ── user ne channel chhoda → turant DM ──
async function onChatMember(upd) {
  try {
    const ch = upd && upd.chat && byChatId.get(upd.chat.id);
    if (!ch || !enabled()) return;

    const oldM = upd.old_chat_member;
    const newM = upd.new_chat_member;
    if (!oldM || !newM || !newM.user) return;
    const user = newM.user;
    if (user.is_bot) return;

    // user join hua → purana invite link hata do
    if (isJoined(newM)) {
      linkCache.delete(`${ch.chatId}:${user.id}`);
      return;
    }

    // sirf "left" case (join tha, ab nahi hai). Ban/kick pe message nahi.
    const wasIn = isJoined(oldM);
    const nowLeft =
      newM.status === "left" || (newM.status === "restricted" && !newM.is_member);
    if (!wasIn || !nowLeft) return;
    if (FORCE_SUB_EXEMPT_OWNER && user.id === OWNER_ID) return;

    linkCache.delete(`${ch.chatId}:${user.id}`);
    const link = await getJoinLink(ch, user.id, true);
    const text =
      `😡 <b>Dude, why you left from this ${esc(ch.title)}?</b>\n\n` +
      `Join it again, otherwise you can't use me.`;
    const opts = { parse_mode: "HTML", disable_web_page_preview: true };
    if (link) {
      opts.reply_markup = {
        inline_keyboard: [[{ text: `✅ Join Now - ${ch.title}`, url: link }]],
      };
    }
    await bot.sendMessage(user.id, text, opts);
  } catch (err) {
    // user ne bot start nahi kiya / bot block hai → DM nahi ja sakta, ignore
    console.log("[ForceSub] leave DM skipped:", errText(err));
  }
}

// ── bot.js se ek baar call hota hai ──
async function init(botInstance) {
  bot = botInstance;
  if (!FORCE_SUB_ENABLED) {
    console.log("[ForceSub] disabled (FORCE_SUB_ENABLED=false)");
    return;
  }
  if (!channels.length) {
    console.log("[ForceSub] koi valid channel configured nahi — force subscribe off");
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

  // startup par check: bot har channel me admin hai ya nahi
  try {
    const me = await bot.getMe();
    for (const ch of channels) {
      try {
        const m = await bot.getChatMember(ch.chatId, me.id);
        if (m.status !== "administrator" && m.status !== "creator") {
          await alertOwner(
            `admin:${ch.chatId}`,
            `Bot <b>${esc(ch.title)}</b> (<code>${ch.chatId}</code>) me admin nahi hai. Admin banao, warna check aur invite link kaam nahi karenge.`
          );
        } else {
          console.log(`[ForceSub] OK: ${ch.title} (${ch.chatId})`);
        }
      } catch (err) {
        await alertOwner(
          `admin:${ch.chatId}`,
          `<b>${esc(ch.title)}</b> (<code>${ch.chatId}</code>) access nahi ho raha: ${esc(
            errText(err)
          )}\nchatId sahi hai? Bot channel me admin hai?`
        );
      }
    }
  } catch (err) {
    console.error("[ForceSub] startup check failed:", errText(err));
  }
  console.log(`[ForceSub] enabled with ${channels.length} channel(s)`);
}

module.exports = {
  init,
  gate,
  isEnabled: enabled,
  setRetryHandler: (fn) => {
    retryHandler = fn;
  },
};
