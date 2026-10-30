// Tiny Discord-flavoured markdown renderer for the live preview.
// Everything is HTML-escaped first, so user text can never inject markup.
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMd(src, roleNames = {}) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let s = escapeHtml(src);

  // Things that must not be touched by the formatting rules below
  s = s.replace(/```(?:\w+\n)?([\s\S]*?)```/g, (_, c) => keep(`<pre>${c}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, c) => keep(`<code>${c}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) =>
    keep(`<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`),
  );
  s = s.replace(/&lt;a?:\w+:(\d+)&gt;/g, (_, id) =>
    keep(`<img class="emoji" alt="" src="https://cdn.discordapp.com/emojis/${id}.webp?size=32">`),
  );
  s = s.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) =>
    keep(`<span class="mention">@${escapeHtml(roleNames[id] || "role")}</span>`),
  );
  s = s.replace(/@(everyone|here)\b/g, (m) => keep(`<span class="mention">${m}</span>`));

  s = s
    .replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>")
    .replace(/__([\s\S]+?)__/g, "<u>$1</u>")
    .replace(/\*([^*\n]+)\*/g, "<i>$1</i>")
    .replace(/(^|\W)_([^_\n]+)_(?!\w)/g, "$1<i>$2</i>")
    .replace(/~~([\s\S]+?)~~/g, "<s>$1</s>")
    .replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler">$1</span>');

  s = s
    .split("\n")
    .map((line) => {
      const quote = line.match(/^&gt; ?(.*)$/);
      if (quote) return `<blockquote>${quote[1]}</blockquote>`;
      const heading = line.match(/^(#{1,3}) (.+)$/);
      if (heading) return `<div class="h${heading[1].length}">${heading[2]}</div>`;
      const sub = line.match(/^-# (.+)$/);
      if (sub) return `<small class="sub">${sub[1]}</small><br>`;
      return `${line}<br>`;
    })
    .join("")
    .replace(/<br>$/, "");

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

if (typeof module !== "undefined") module.exports = { renderMd, escapeHtml };
