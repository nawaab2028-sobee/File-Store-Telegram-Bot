require("dotenv").config(); // Optional: if using a .env file

const config = {
  BOT_TOKEN: process.env.BOT_TOKEN || "8876274833:AAGZHNOF1BpXTz1n8CTX5bxY8Ec3k4OX7OA",
  MONGO_URI: process.env.MONGO_URI || "mdinabano189_db_user:OExxVWuoNAHuBlFr@cluster0.yzkibwa.mongodb.net/?appName=Cluster0",
  OWNER_ID: Number(process.env.OWNER_ID || "8909902924"),
  START_IMAGE_URL: process.env.START_IMAGE_URL || "https://graph.org/file/dabc3b293f0ab07a49eab-f3d1061ff5994e7b50.jpg",

  // ═══════════════════════════ FORCE SUBSCRIBE ═══════════════════════════
  // true  = every user must first join ALL the channels below.
  // false = force subscribe is off (the bot works as before).
  FORCE_SUB_ENABLED: (process.env.FORCE_SUB_ENABLED || "true") !== "false",

  // true = the owner is exempt from force subscribe (owner does not have to join)
  FORCE_SUB_EXEMPT_OWNER: (process.env.FORCE_SUB_EXEMPT_OWNER || "true") !== "false",

  // How often (in seconds) the bot re-checks saved members to catch users who left a channel
  // (backup for the instant leave detection). 0 = off.
  FORCE_SUB_SWEEP_SECONDS: Number(process.env.FORCE_SUB_SWEEP_SECONDS || 60),

  // Add as many channels as you want (3 / 5 / 10 ... no limit).
  // Every channel has 3 fields:
  //   title  -> name shown on the button / in messages
  //   link   -> channel link (fallback; the bot also creates personal invite links itself)
  //   chatId -> the channel's chat id (the "-100..." one). The bot must be ADMIN in that channel.
  // NOTE: a channel whose chatId is still the "-100XXXXXXXXXX" placeholder is ignored.
  FORCE_SUB_CHANNELS: [
    { title: "𝆺꯭𝅥Mr Toxic Here𝆺𝅥", link: "https://t.me/+yMpFHjaghI1mOTFl", chatId: "-1002258155184" },
    { title: "Team Cinderella", link: "https://t.me/TeamCinderella", chatId: "-1003330631655" },
    { title: "PW SENSEI", link: "https://t.me/PW_SENSEI", chatId: "-1004481579061" },
    // { title: "Channel 4", link: "https://t.me/your_channel_4", chatId: "-100XXXXXXXXXX" },
    // { title: "Channel 5", link: "https://t.me/your_channel_5", chatId: "-100XXXXXXXXXX" },
    // { title: "Channel 6", link: "https://t.me/your_channel_6", chatId: "-100XXXXXXXXXX" },
    // ...add more channels below in the same way
  ],
};

// validation
if (!config.BOT_TOKEN || !config.MONGO_URI || !config.OWNER_ID) {
  console.warn(
    "⚠️ Warning: Missing required environment variables in .env file"
  );
}

module.exports = config;
