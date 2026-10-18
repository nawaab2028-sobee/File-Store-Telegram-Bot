// ─────────────────────────────────────────────────────────────────────────
// Persistent user records
//  • The real data lives in MongoDB (survives restarts / redeploys)
//  • A JSON mirror (data/users.json) is written as well
//  • If MongoDB is empty and the JSON file exists, users are restored automatically
//  • /exportusers → sends users.json to the owner on Telegram (safe backup)
//  • /importusers → reply to that file to put the users back into MongoDB
// ─────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");

const FILE = process.env.USERS_JSON_PATH || path.join(__dirname, "data", "users.json");
const MIRROR_DELAY_MS = 5000;

let UserModel = null;
let timer = null;
let warned = false;

const FIELDS = {
  _id: 0,
  telegramId: 1,
  firstName: 1,
  username: 1,
  status: 1,
  firstMessage: 1,
  firstSeenAt: 1,
  lastInteraction: 1,
};

async function snapshot() {
  return UserModel.find({}, FIELDS).sort({ firstSeenAt: 1 }).lean();
}

function serialize(users) {
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), total: users.length, users },
    null,
    2
  );
}

async function writeMirror() {
  try {
    const users = await snapshot();
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, serialize(users));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    // May fail on a read-only filesystem (e.g. Vercel) - MongoDB still has everything
    if (!warned) {
      warned = true;
      console.warn("[UserStore] could not write JSON mirror:", err.message);
    }
  }
}

// call when a new user is added (5 sec debounce)
function scheduleMirror() {
  if (!UserModel) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(writeMirror, MIRROR_DELAY_MS);
  if (timer.unref) timer.unref();
}

// Merge a list of users (from JSON) into MongoDB. Never overwrites existing users.
async function importUsers(list) {
  const ops = [];
  let invalid = 0;
  for (const u of Array.isArray(list) ? list : []) {
    const id = Number(u && u.telegramId);
    if (!Number.isSafeInteger(id) || id === 0) {
      invalid++;
      continue;
    }
    const doc = { telegramId: id };
    if (u.firstName) doc.firstName = String(u.firstName);
    if (u.username) doc.username = String(u.username);
    if (u.firstMessage) doc.firstMessage = String(u.firstMessage);
    if (u.status) doc.status = String(u.status);
    for (const k of ["firstSeenAt", "lastInteraction"]) {
      const d = u[k] ? new Date(u[k]) : null;
      if (d && !isNaN(d)) doc[k] = d;
    }
    ops.push({
      updateOne: { filter: { telegramId: id }, update: { $setOnInsert: doc }, upsert: true },
    });
  }
  let added = 0;
  for (let i = 0; i < ops.length; i += 1000) {
    const res = await UserModel.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    added += res.upsertedCount || 0;
  }
  return { added, existing: ops.length - added, invalid };
}

async function restoreIfEmpty() {
  try {
    if ((await UserModel.estimatedDocumentCount()) > 0) return;
    if (!fs.existsSync(FILE)) return;
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const r = await importUsers(data.users || data);
    console.log(`[UserStore] MongoDB was empty - restored ${r.added} users from JSON`);
  } catch (err) {
    console.warn("[UserStore] restore skip:", err.message);
  }
}

async function init(Model) {
  UserModel = Model;
  await restoreIfEmpty();
  await writeMirror();
}

module.exports = { init, snapshot, serialize, importUsers, scheduleMirror };
