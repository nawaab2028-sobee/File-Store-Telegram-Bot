// Converts a Telegram text + message entities into Telegram-HTML, so a stored text message
// can be sent again later with its bold / italic / links / code etc. exactly as the admin wrote it.
// (Telegram entity offsets are in UTF-16 code units, which is also how JS strings are indexed.)

const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => escHtml(String(s)).replace(/"/g, "&quot;");

function tagFor(e) {
  switch (e.type) {
    case "bold":
      return ["<b>", "</b>"];
    case "italic":
      return ["<i>", "</i>"];
    case "underline":
      return ["<u>", "</u>"];
    case "strikethrough":
      return ["<s>", "</s>"];
    case "spoiler":
      return ["<tg-spoiler>", "</tg-spoiler>"];
    case "code":
      return ["<code>", "</code>"];
    case "pre":
      return e.language
        ? [`<pre><code class="language-${escAttr(e.language)}">`, "</code></pre>"]
        : ["<pre>", "</pre>"];
    case "blockquote":
      return ["<blockquote>", "</blockquote>"];
    case "expandable_blockquote":
      return ["<blockquote expandable>", "</blockquote>"];
    case "text_link":
      return e.url ? [`<a href="${escAttr(e.url)}">`, "</a>"] : null;
    case "text_mention":
      return e.user && e.user.id ? [`<a href="tg://user?id=${e.user.id}">`, "</a>"] : null;
    default:
      return null; // url, mention, hashtag, email, phone, bot_command ... are plain text
  }
}

function entitiesToHtml(text, entities) {
  text = String(text || "");
  const ents = (Array.isArray(entities) ? entities : [])
    .map((e) => ({ ...e, tag: tagFor(e), end: Math.min(e.offset + e.length, text.length) }))
    .filter((e) => e.tag && e.length > 0 && e.offset < text.length)
    .sort((a, b) => a.offset - b.offset || b.end - a.end);

  if (!ents.length) return escHtml(text);

  let out = "";
  const stack = [];
  let next = 0;

  // Close every entity that ends at position i. If an entity that is still running sits above
  // it on the stack (overlapping entities), it is closed and re-opened so the HTML stays valid.
  const closeEnded = (i) => {
    for (;;) {
      const idx = stack.findIndex((e) => e.end <= i);
      if (idx === -1) break;
      const reopen = [];
      while (stack.length > idx) {
        const e = stack.pop();
        out += e.tag[1];
        if (e.end > i) reopen.push(e);
      }
      reopen.reverse().forEach((e) => {
        out += e.tag[0];
        stack.push(e);
      });
    }
  };

  for (let i = 0; i <= text.length; i++) {
    closeEnded(i);
    while (next < ents.length && ents[next].offset === i) {
      const e = ents[next++];
      out += e.tag[0];
      stack.push(e);
    }
    if (i < text.length) out += escHtml(text[i]);
  }
  return out;
}

module.exports = { entitiesToHtml, escHtml };
