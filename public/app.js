const $ = (id) => document.getElementById(id);

const state = {
  roles: [],
  channels: [],
  image: "",
  buttons: [],
  sent: [],
  editingId: null,
  lastField: null,
};

const STYLE_NAMES = { secondary: "Gray", primary: "Blurple", success: "Green", danger: "Red" };
const MODE_NAMES = { toggle: "Toggle", give: "Give" };
const MAX_BUTTONS = 25;

const WRAPS = {
  bold: ["**", "**"],
  italic: ["*", "*"],
  underline: ["__", "__"],
  strike: ["~~", "~~"],
  code: ["`", "`"],
  spoiler: ["||", "||"],
  quote: ["> ", ""],
  link: ["[", "](https://)"],
};

/* ---------------------------------- helpers --------------------------------- */

// Tiny element builder. Text children are always added as text nodes (never HTML).
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  el.append(...children);
  return el;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = `show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), 4000);
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", "x-password": $("password").value },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function fill(select, items) {
  select.replaceChildren(...items.map((i) => new Option(i.name, i.id)));
}

function roleNames() {
  return Object.fromEntries(state.roles.map((r) => [r.id, r.name]));
}

/* ------------------------- busy guard (no double sends) ---------------------- */

async function withBusy(button, task) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    await task();
  } finally {
    button.disabled = false;
  }
}

/* ---------------------------------- image ----------------------------------- */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const imageUrls = new Map(); // uploaded file name -> blob: URL, used for previews

async function ensureImageUrl(name) {
  if (imageUrls.has(name)) return;
  const res = await fetch(`/api/images/${name}`, { headers: { "x-password": $("password").value } });
  if (!res.ok) throw new Error("Couldn't load the image. Remove it and upload it again.");
  imageUrls.set(name, URL.createObjectURL(await res.blob()));
}

function updateImageUI() {
  const thumb = $("imageThumb");
  thumb.hidden = !state.image || !imageUrls.has(state.image);
  if (!thumb.hidden) thumb.src = imageUrls.get(state.image);
  $("imageRemove").hidden = !state.image;
}

// Shows the current image; fetches its preview first if we don't have it yet
async function showImage() {
  const name = state.image;
  updateImageUI();
  if (!name) return;
  try {
    await ensureImageUrl(name);
  } catch (err) {
    toast(err.message, true);
  }
  if (state.image === name) {
    updateImageUI();
    renderPreview();
  }
}

$("imageFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > MAX_IMAGE_BYTES) return toast("That image is too big (max 10 MB)", true);

  try {
    const res = await fetch("/api/images", {
      method: "POST",
      headers: { "x-password": $("password").value, "Content-Type": file.type },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);

    imageUrls.set(data.image, URL.createObjectURL(file));
    state.image = data.image;
    updateImageUI();
    renderPreview();
  } catch (err) {
    toast(err.message, true);
  }
});

$("imageRemove").addEventListener("click", () => {
  state.image = "";
  updateImageUI();
  renderPreview();
});

/* ----------------------------------- tabs ----------------------------------- */

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("tab-compose").hidden = name !== "compose";
  $("tab-sent").hidden = name !== "sent";
  $("tab-alerts").hidden = name !== "alerts";
  $("tab-logs").hidden = name !== "logs";
  if (name === "alerts" && typeof refreshAlertStatus === "function") refreshAlertStatus();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

/* ------------------------------ form <-> config ----------------------------- */

function collectConfig() {
  return {
    content: $("content").value,
    image: state.image,
    embed: $("useEmbed").checked
      ? {
          title: $("eTitle").value,
          description: $("eDesc").value,
          color: $("eColor").value,
          image: $("eImage").value,
          thumbnail: $("eThumb").value,
          footer: $("eFooter").value,
        }
      : null,
    buttons: state.buttons.map((b) => ({ ...b })),
  };
}

function setForm(config) {
  const e = config.embed;
  $("content").value = config.content || "";
  $("useEmbed").checked = Boolean(e);
  $("eTitle").value = e?.title || "";
  $("eDesc").value = e?.description || "";
  $("eColor").value = e?.color || "#5865f2";
  $("eImage").value = e?.image || "";
  $("eThumb").value = e?.thumbnail || "";
  $("eFooter").value = e?.footer || "";
  $("embedFields").hidden = !e;
  state.image = config.image || "";
  state.buttons = (config.buttons || []).map((b) => ({ ...b }));
  renderButtonRows();
  renderPreview();
  showImage();
}

const EMPTY_CONFIG = { content: "", image: "", embed: null, buttons: [] };

/* ------------------------------ formatting bar ------------------------------ */

document.addEventListener("focusin", (e) => {
  if (e.target.matches?.("#content, #eDesc, #aContent, #aDesc")) state.lastField = e.target;
});

// fieldIds: the text boxes this toolbar formats (the one you last clicked in, else the first)
function bindToolbar(toolbar, fieldIds) {
  toolbar.addEventListener("mousedown", (e) => e.preventDefault()); // keep selection
  toolbar.addEventListener("click", (e) => {
    const kind = e.target.closest("button")?.dataset.fmt;
    if (!kind) return;
    const fields = fieldIds.map($);
    const field = fields.includes(state.lastField) ? state.lastField : fields[0];
    const [before, after] = WRAPS[kind];
    const { selectionStart: start, selectionEnd: end, value } = field;
    field.setRangeText(before + (value.slice(start, end) || "text") + after, start, end, "select");
    field.focus();
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
bindToolbar($("toolbar"), ["content", "eDesc"]);

/* --------------------------------- buttons ---------------------------------- */

function renderButtonRows() {
  const list = $("buttons");
  list.replaceChildren();
  $("buttonCount").textContent = `(${state.buttons.length}/${MAX_BUTTONS})`;
  $("addButton").disabled = state.buttons.length >= MAX_BUTTONS;

  state.buttons.forEach((b, i) => {
    const roleOptions = state.roles.map((r) => new Option(r.name, r.id, false, r.id === b.roleId));
    if (!state.roles.some((r) => r.id === b.roleId)) {
      roleOptions.unshift(new Option("⚠ role unavailable", b.roleId, true, true));
    }

    const move = (delta) => {
      const j = i + delta;
      if (j < 0 || j >= state.buttons.length) return;
      [state.buttons[i], state.buttons[j]] = [state.buttons[j], state.buttons[i]];
      renderButtonRows();
      renderPreview();
    };

    list.append(
      h(
        "div",
        { class: "btn-row" },
        h("input", { value: b.emoji, placeholder: "😀", title: "Emoji (unicode or <:name:id>)", maxLength: 64, oninput: (e) => (b.emoji = e.target.value) }),
        h("input", { value: b.label, placeholder: "Label", maxLength: 80, oninput: (e) => (b.label = e.target.value) }),
        h(
          "select",
          { title: "Color", onchange: (e) => (b.style = e.target.value) },
          ...Object.entries(STYLE_NAMES).map(([v, n]) => new Option(n, v, false, v === b.style)),
        ),
        h(
          "select",
          { title: "Toggle adds/removes the role. Give only adds it.", onchange: (e) => (b.mode = e.target.value) },
          ...Object.entries(MODE_NAMES).map(([v, n]) => new Option(n, v, false, v === b.mode)),
        ),
        h("select", { title: "Role", onchange: (e) => (b.roleId = e.target.value) }, ...roleOptions),
        h(
          "div",
          { class: "btn-actions" },
          h("button", { type: "button", class: "ghost small", title: "Move up", onclick: () => move(-1) }, "↑"),
          h("button", { type: "button", class: "ghost small", title: "Move down", onclick: () => move(1) }, "↓"),
          h(
            "button",
            {
              type: "button",
              class: "danger small",
              title: "Remove",
              onclick: () => {
                state.buttons.splice(i, 1);
                renderButtonRows();
                renderPreview();
              },
            },
            "✕",
          ),
        ),
      ),
    );
  });
}

$("addButton").addEventListener("click", () => {
  state.buttons.push({ label: "", emoji: "", style: "secondary", mode: "toggle", roleId: state.roles[0]?.id ?? "" });
  renderButtonRows();
  renderPreview();
});

/* ---------------------------------- preview --------------------------------- */

function renderPreview() {
  const cfg = collectConfig();
  const names = roleNames();
  const box = $("preview");
  box.replaceChildren();

  if (cfg.content) box.append(h("div", { class: "md", innerHTML: renderMd(cfg.content, names) }));
  if (cfg.image && imageUrls.has(cfg.image)) box.append(h("img", { class: "pv-image", src: imageUrls.get(cfg.image) }));

  const e = cfg.embed;
  if (e && (e.title || e.description || e.image || e.thumbnail || e.footer)) {
    const hideBroken = (ev) => (ev.target.hidden = true);
    box.append(
      h(
        "div",
        { class: `embed${e.thumbnail ? " has-thumb" : ""}`, style: `border-left-color:${e.color}` },
        e.title ? h("div", { class: "e-title" }, e.title) : "",
        e.description ? h("div", { class: "md", innerHTML: renderMd(e.description, names) }) : "",
        e.thumbnail ? h("img", { class: "e-thumb", src: e.thumbnail, onerror: hideBroken }) : "",
        e.image ? h("img", { class: "e-image", src: e.image, onerror: hideBroken }) : "",
        e.footer ? h("div", { class: "e-footer" }, e.footer) : "",
      ),
    );
  }

  if (cfg.buttons.length) {
    box.append(
      h(
        "div",
        { class: "pv-buttons" },
        ...cfg.buttons.map((b) =>
          h("span", { class: `pv-btn ${b.style}`, title: `${MODE_NAMES[b.mode]} · @${names[b.roleId] || "?"}` }, [b.emoji, b.label].filter(Boolean).join(" ")),
        ),
      ),
    );
  }

  if (!box.children.length) box.append(h("span", { class: "muted" }, "Your message will show up here ✨"));
}

$("tab-compose").addEventListener("input", renderPreview);
$("tab-compose").addEventListener("change", renderPreview);
$("useEmbed").addEventListener("change", () => ($("embedFields").hidden = !$("useEmbed").checked));

/* ------------------------------ sending / editing --------------------------- */

function startEditing(m) {
  state.editingId = m.messageId;
  $("channel").value = m.channelId;
  $("channel").disabled = true;
  $("editText").textContent = `Editing a message in #${m.channelName}`;
  $("editBanner").hidden = false;
  $("submit").textContent = "Save changes";
  setForm(m.config);
  showTab("compose");
}

function stopEditing() {
  state.editingId = null;
  $("channel").disabled = false;
  $("editBanner").hidden = true;
  $("submit").textContent = "Send message";
  setForm(EMPTY_CONFIG);
}

$("cancelEdit").addEventListener("click", stopEditing);

$("submit").addEventListener("click", () => withBusy($("submit"), async () => {
  try {
    const config = collectConfig();
    if (state.editingId) {
      await api(`/messages/${state.editingId}`, { method: "PUT", body: JSON.stringify({ config }) });
      toast("Changes saved ✅");
      stopEditing();
      await loadMessages();
      showTab("sent");
    } else {
      await api("/messages", {
        method: "POST",
        body: JSON.stringify({ guildId: $("guild").value, channelId: $("channel").value, config }),
      });
      toast("Sent! ✅");
      await loadMessages();
    }
  } catch (err) {
    toast(err.message, true);
    if (state.editingId) await loadMessages().catch(() => {});
  }
}));

/* -------------------------------- sent messages ----------------------------- */

async function loadMessages() {
  state.sent = await api(`/messages?guildId=${encodeURIComponent($("guild").value)}`);
  renderSent();
}

async function removeMessage(m) {
  if (!confirm("Delete this message from Discord?")) return;
  try {
    await api(`/messages/${m.messageId}`, { method: "DELETE" });
    if (state.editingId === m.messageId) stopEditing();
    toast("Deleted 🗑️");
    await loadMessages();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderSent() {
  const list = $("sentList");
  list.replaceChildren();
  $("sentCount").textContent = state.sent.length ? `(${state.sent.length})` : "";

  if (!state.sent.length) {
    list.append(h("p", { class: "muted" }, "Nothing here yet. Messages you send from this panel will show up here."));
    return;
  }

  for (const m of state.sent) {
    const c = m.config;
    const snippet = c.embed?.title || c.content || c.embed?.description || "(no text)";
    list.append(
      h(
        "article",
        { class: "panel" },
        h("div", { class: "sent-head" }, h("strong", {}, `#${m.channelName}`), h("span", { class: "muted" }, ` · updated ${new Date(m.updatedAt).toLocaleString()}`)),
        h("p", { class: "snippet" }, snippet.slice(0, 160)),
        h("div", { class: "chips" }, c.image ? h("span", { class: "chip" }, "🖼️ image") : "", ...c.buttons.map((b) => h("span", { class: "chip" }, `${[b.emoji, b.label].filter(Boolean).join(" ")} · ${b.mode}`))),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", onclick: () => startEditing(m) }, "Edit"),
          h("button", { type: "button", class: "ghost", onclick: () => openCopy(m) }, "Send to another channel"),
          h("a", { class: "linkbtn", href: m.url, target: "_blank", rel: "noreferrer" }, "Open in Discord"),
          h("button", { type: "button", class: "danger", onclick: () => removeMessage(m) }, "Delete"),
        ),
      ),
    );
  }
}

/* ---------------------------- send to another channel ----------------------- */

let copySource = null;

function openCopy(m) {
  const options = state.channels.filter((c) => c.id !== m.channelId).map((c) => ({ id: c.id, name: `#${c.name}` }));
  if (!options.length) return toast("There's no other channel to send it to", true);

  copySource = m;
  fill($("copyChannel"), options);
  $("copyInfo").textContent = `Posts a copy of this message from #${m.channelName}. The original stays where it is.`;
  $("copyError").textContent = "";
  $("copyDialog").showModal();
}

$("copyCancel").addEventListener("click", () => $("copyDialog").close());

$("copyConfirm").addEventListener("click", () =>
  withBusy($("copyConfirm"), async () => {
    try {
      const target = $("copyChannel").selectedOptions[0].text;
      await api(`/messages/${copySource.messageId}/copy`, {
        method: "POST",
        body: JSON.stringify({ channelId: $("copyChannel").value }),
      });
      $("copyDialog").close();
      toast(`Sent to ${target} ✅`);
      await loadMessages();
    } catch (err) {
      $("copyError").textContent = err.message; // the toast would hide behind the dialog
    }
  }),
);

/* ---------------------------------- startup --------------------------------- */

async function loadGuild() {
  const id = $("guild").value;
  if (!id) return;
  const info = await api(`/guilds/${id}/info`);
  state.roles = info.roles;
  state.channels = info.channels;
  state.allRoles = info.allRoles || [];
  state.categories = info.categories || [];
  state.messageChannels = info.messageChannels || [];
  fill($("channel"), info.channels.map((c) => ({ id: c.id, name: `#${c.name}` })));
  renderButtonRows();
  renderPreview();
  await loadMessages();
  if (typeof loadAlerts === "function") await loadAlerts();
  if (typeof loadLogs === "function") await loadLogs();
}

$("connect").addEventListener("click", async () => {
  try {
    sessionStorage.setItem("rynata-pw", $("password").value);
    const guilds = await api("/guilds");
    if (!guilds.length) return toast("Rynata isn't in any server yet", true);
    fill($("guild"), guilds);
    await loadGuild();
    toast("Connected ✨");
  } catch (err) {
    toast(err.message, true);
  }
});

$("guild").addEventListener("change", async () => {
  try {
    if (state.editingId) stopEditing();
    await loadGuild();
  } catch (err) {
    toast(err.message, true);
  }
});

$("password").value = sessionStorage.getItem("rynata-pw") || "";
setForm(EMPTY_CONFIG);
