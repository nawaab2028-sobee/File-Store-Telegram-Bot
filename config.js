require("dotenv").config(); // Optional: if using a .env file

const config = {
  BOT_TOKEN: process.env.BOT_TOKEN || "8876274833:AAGZHNOF1BpXTz1n8CTX5bxY8Ec3k4OX7OA",
  MONGO_URI: process.env.MONGO_URI || "mongodb+srv://mdinabano189_db_user:OExxVWuoNAHuBlFr@cluster0.yzkibwa.mongodb.net/?appName=Cluster0",
  OWNER_ID: Number(process.env.OWNER_ID || "8909902924"),
  START_IMAGE_URL: process.env.START_IMAGE_URL || "https://graph.org/file/dabc3b293f0ab07a49eab-f3d1061ff5994e7b50.jpg",

  // ═══════════════════════════ FORCE SUBSCRIBE ═══════════════════════════
  // true  = har user ko pehle neeche ke saare channels join karne padenge.
  // false = force subscribe band (bot pehle jaisa chalega).
  FORCE_SUB_ENABLED: (process.env.FORCE_SUB_ENABLED || "true") !== "false",

  // true = owner ko force subscribe se chhoot (owner ko join nahi karna padega)
  FORCE_SUB_EXEMPT_OWNER: (process.env.FORCE_SUB_EXEMPT_OWNER || "true") !== "false",

  // Jitne channels chahiye utne add karo (3 / 5 / 10 ... koi limit nahi).
  // Har channel ke 3 fields:
  //   title  -> button / message me dikhne wala naam
  //   link   -> channel ka link (backup; bot khud bhi personal invite link banata hai)
  //   chatId -> channel ki chat id ("-100..." wali). Bot ko us channel me ADMIN banana zaroori hai.
  // NOTE: jab tak chatId "-100XXXXXXXXXX" placeholder hai, wo channel ignore hota hai.
  FORCE_SUB_CHANNELS: [
    { title: "𝆺꯭𝅥Mr Toxic Here𝆺𝅥", link: "https://t.me/+yMpFHjaghI1mOTFl", chatId: "-1002258155184" },
    { title: "Team Cinderella", link: "https://t.me/TeamCinderella", chatId: "-1003330631655" },
    { title: "PW SENSEI", link: "https://t.me/PW_SENSEI", chatId: "-1004481579061" },
    // { title: "Channel 4", link: "https://t.me/your_channel_4", chatId: "-100XXXXXXXXXX" },
    // { title: "Channel 5", link: "https://t.me/your_channel_5", chatId: "-100XXXXXXXXXX" },
    // { title: "Channel 6", link: "https://t.me/your_channel_6", chatId: "-100XXXXXXXXXX" },
    // ...aur chahiye to isi tarah neeche add karte jao
  ],
};

// validation
if (!config.BOT_TOKEN || !config.MONGO_URI || !config.OWNER_ID) {
  console.warn(
    "⚠️ Warning: Missing required environment variables in .env file"
  );
}

module.exports = config;
