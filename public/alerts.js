/* Stream alerts tab. Loaded after app.js and uses its helpers ($, h, api, toast, ...). */

const alertState = { status: null, creds: { twitch: false, youtube: false } };

const ALERT_SAMPLE = {
  streamer: "YourName",
  title: "Chill stream + chatting",
  game: "Just Chatting",
  platforms: "YouTube & Twitch",
  twitchUrl: "https://twitch.tv/yourname",
  youtubeUrl: "https://youtube.com/watch?v=…",
};

// Same look as the real toolbar on the Compose tab
$("aToolbarSlot").append(
  (() => {
    const copy = $("toolbar").cloneNode(true);
    copy.removeAttribute("id");
    bindToolbar(copy, ["aContent", "aDesc"]);
    return copy;
  })(),
);

/* ------------------------------- form <-> settings --------------------------- */

const alertRoles = () => state.allRoles || [];

function mentionToValue(m) {
  return m.type === "role" ? `role:${m.roleId}` : m.type;
}

function valueToMention(v) {
  return v.startsWith("role:") ? { type: "role", roleId: v.slice(5) } : { type: v, roleId: "" };
}

function collectAlert() {
  return {
    enabled: $("aEnabled").checked,
    channelId: $("aChannel").value,
    mention: valueToMention($("aMention").value),
    twitchLogin: $("aTwitch").value,
    youtubeChannelId: $("aYoutube").value,
    content: $("aContent").value,
    embed: $("aUseEmbed").checked
      ? {
          title: $("aTitle").value,
          description: $("aDesc").value,
          color: $("aColor").value,
          image: $("aImage").value,
          thumbnail: $("aThumb").value,
          footer: $("aFooter").value,
        }
      : null,
    liveThumbnail: $("aLiveThumb").checked,
    mainPlatform: $("aMain").value,
    youtubeButton: $("aYtLabel").value,
    twitchButton: $("aTwLabel").value,
    graceSeconds: Number($("aGrace").value),
    endAfterMinutes: Number($("aEnd").value),
  };
}

function setAlertForm(s) {
  const mentionOptions = [
    new Option("Nobody", "none"),
    new Option("@everyone", "everyone"),
    new Option("@here", "here"),
    ...alertRoles().map((r) => new Option(`@${r.name}`, `role:${r.id}`)),
  ];
  const wanted = mentionToValue(s.mention);
  if (!mentionOptions.some((o) => o.value === wanted)) mentionOptions.push(new Option("⚠ role no longer exists", wanted));
  $("aMention").replaceChildren(...mentionOptions);
  $("aMention").value = wanted;

  fill($("aChannel"), state.channels.map((c) => ({ id: c.id, name: `#${c.name}` })));
  if (s.channelId) $("aChannel").value = s.channelId;

  const e = s.embed;
  $("aEnabled").checked = s.enabled;
  $("aTwitch").value = s.twitchLogin;
  $("aYoutube").value = s.youtubeChannelId;
  $("aYoutubeHint").textContent = s.youtubeName ? `✓ ${s.youtubeName}` : "";
  $("aContent").value = s.content;
  $("aUseEmbed").checked = Boolean(e);
  $("aEmbedFields").hidden = !e;
  $("aTitle").value = e?.title || "";
  $("aDesc").value = e?.description || "";
  $("aColor").value = e?.color || "#9146ff";
  $("aImage").value = e?.image || "";
  $("aThumb").value = e?.thumbnail || "";
  $("aFooter").value = e?.footer || "";
  $("aLiveThumb").checked = s.liveThumbnail;
  $("aMain").value = s.mainPlatform || "twitch";
  $("aYtLabel").value = s.youtubeButton;
  $("aTwLabel").value = s.twitchButton;
  $("aGrace").value = s.graceSeconds;
  $("aEnd").value = s.endAfterMinutes;
  renderAlertPreview();
}

/* ----------------------------------- preview --------------------------------- */

function renderAlertPreview() {
  const s = collectAlert();
  const roleNames = Object.fromEntries(alertRoles().map((r) => [r.id, r.name]));
  const mention = s.mention.type === "role" ? `<@&${s.mention.roleId}>` : s.mention.type === "none" ? "" : `@${s.mention.type}`;
  const vars = { ...ALERT_SAMPLE, mention };
  const fillText = (t) => t.replace(/\{(\w+)\}/g, (whole, key) => (Object.hasOwn(vars, key) ? vars[key] : whole));

  let content = fillText(s.content).trim();
  if (mention && !s.content.includes("{mention}")) content = `${mention} ${content}`.trim();

  const box = $("aPreview");
  box.replaceChildren();
  if (content) box.append(h("div", { class: "md", innerHTML: renderMd(content, roleNames) }));

  const e = s.embed;
  if (e) {
    const title = fillText(e.title);
    const description = fillText(e.description);
    const footer = fillText(e.footer);
    const hideBroken = (ev) => (ev.target.hidden = true);
    box.append(
      h(
        "div",
        { class: `embed${e.thumbnail ? " has-thumb" : ""}`, style: `border-left-color:${e.color}` },
        title ? h("div", { class: "e-title" }, title) : "",
        description ? h("div", { class: "md", innerHTML: renderMd(description, roleNames) }) : "",
        e.thumbnail ? h("img", { class: "e-thumb", src: e.thumbnail, onerror: hideBroken }) : "",
        s.liveThumbnail
          ? h("div", { class: "pv-thumb-note" }, `The ${s.mainPlatform === "youtube" ? "YouTube" : "Twitch"} stream thumbnail shows here`)
          : e.image
            ? h("img", { class: "e-image", src: e.image, onerror: hideBroken })
            : "",
        footer ? h("div", { class: "e-footer" }, footer) : "",
      ),
    );
  }

  box.append(
    h(
      "div",
      { class: "pv-buttons" },
      h("span", { class: "pv-btn link" }, s.youtubeButton || "Watch on YouTube"),
      h("span", { class: "pv-btn link" }, s.twitchButton || "Watch on Twitch"),
    ),
  );
}

$("tab-alerts").addEventListener("input", renderAlertPreview);
$("tab-alerts").addEventListener("change", renderAlertPreview);
$("aUseEmbed").addEventListener("change", () => ($("aEmbedFields").hidden = !$("aUseEmbed").checked));

/* ----------------------------------- status ---------------------------------- */

function renderAlertStatus() {
  const box = $("aStatus");
  box.replaceChildren();
  const st = alertState.status;
  if (!st) return;

  const line = (name, p) => {
    const text = {
      off: "not used",
      waiting: "waiting for the first check…",
      offline: "offline",
      live: `LIVE: ${p.detail}`,
      error: `problem: ${p.detail}`,
    }[p.state];
    return h("div", { class: "status-line" }, h("span", { class: `dot ${p.state}` }), h("strong", {}, name), h("span", {}, text));
  };
  box.append(line("Twitch", st.twitch), line("YouTube", st.youtube));

  if (st.twitch.state !== "off" && !alertState.creds.twitch) {
    box.append(h("p", { class: "form-error" }, "Twitch keys are missing: add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env and restart."));
  }
  if (st.youtube.state !== "off" && !alertState.creds.youtube) {
    box.append(h("p", { class: "form-error" }, "YouTube key is missing: add YOUTUBE_API_KEY to .env and restart."));
  }
  if (st.problem) box.append(h("p", { class: "form-error" }, `⚠ ${st.problem}`));

  box.append(
    h(
      "p",
      { class: "muted" },
      st.checkedAt ? `Last checked ${new Date(st.checkedAt).toLocaleTimeString()}.` : "Not checked yet. Checks run about once a minute while alerts are on.",
    ),
  );
  if (st.session.posted) {
    box.append(h("p", {}, "An alert is out for the current stream. ", h("a", { href: st.session.url, target: "_blank", rel: "noreferrer" }, "Open it")));
  }
}

async function refreshAlertStatus() {
  const guildId = $("guild").value;
  if (!guildId) return;
  try {
    const data = await api(`/alerts/${guildId}`);
    alertState.status = data.status;
    alertState.creds = data.credentials;
    renderAlertStatus();
  } catch {
    /* the next refresh will try again */
  }
}

setInterval(() => {
  if (!$("tab-alerts").hidden) refreshAlertStatus();
}, 15_000);

/* --------------------------------- load / save -------------------------------- */

async function loadAlerts() {
  try {
    const data = await api(`/alerts/${$("guild").value}`);
    alertState.status = data.status;
    alertState.creds = data.credentials;
    setAlertForm(data.settings);
    renderAlertStatus();
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveAlerts() {
  const data = await api(`/alerts/${$("guild").value}`, {
    method: "PUT",
    body: JSON.stringify({ settings: collectAlert() }),
  });
  alertState.status = data.status;
  setAlertForm(data.settings);
  renderAlertStatus();
  return data;
}

$("aSave").addEventListener("click", () =>
  withBusy($("aSave"), async () => {
    try {
      const data = await saveAlerts();
      toast(["Saved ✅", ...data.warnings].join(" "));
    } catch (err) {
      toast(err.message, true);
    }
  }),
);

$("aTest").addEventListener("click", () =>
  withBusy($("aTest"), async () => {
    try {
      await saveAlerts();
      await api(`/alerts/${$("guild").value}/test`, { method: "POST" });
      toast("Test alert sent ✅ (nobody was pinged)");
    } catch (err) {
      toast(err.message, true);
    }
  }),
);

$("aReset").addEventListener("click", async () => {
  if (!confirm("Forget the current stream? If you're live right now, the next check posts a new alert.")) return;
  try {
    await api(`/alerts/${$("guild").value}/session`, { method: "DELETE" });
    toast("Forgot the current stream 🧹");
    await refreshAlertStatus();
  } catch (err) {
    toast(err.message, true);
  }
});
