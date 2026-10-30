/* Logs tab. Loaded after app.js and uses its helpers ($, h, api, toast, fill, withBusy). */

function collectLogs() {
  return {
    enabled: $("lEnabled").checked,
    messageChannelId: $("lMsgChannel").value,
    memberChannelId: $("lMemChannel").value,
    events: {
      delete: $("lDelete").checked,
      edit: $("lEdit").checked,
      join: $("lJoin").checked,
      leave: $("lLeave").checked,
    },
    ignoreBots: $("lIgnoreBots").checked,
    ignoredChannelIds: [...$("lIgnored").querySelectorAll("input:checked")].map((box) => box.value),
    newAccountDays: Number($("lNewDays").value),
  };
}

function renderIgnoreList(selected) {
  const box = $("lIgnored");
  box.replaceChildren();
  const row = (item) =>
    h("label", { class: "check" }, h("input", { type: "checkbox", value: item.id, checked: selected.includes(item.id) }), item.name);

  const categories = state.categories || [];
  const channels = state.messageChannels || [];
  if (categories.length) box.append(h("div", { class: "group" }, "Categories (ignores every channel inside)"), ...categories.map((c) => row({ id: c.id, name: c.name })));
  if (channels.length) box.append(h("div", { class: "group" }, "Channels"), ...channels.map((c) => row({ id: c.id, name: `#${c.name}` })));
  if (!categories.length && !channels.length) box.append(h("p", { class: "muted" }, "No channels found."));
}

function setLogsForm(s) {
  const channels = state.channels.map((c) => ({ id: c.id, name: `#${c.name}` }));
  $("lMsgChannel").replaceChildren(new Option("(none)", ""), ...channels.map((c) => new Option(c.name, c.id)));
  $("lMemChannel").replaceChildren(new Option("Same as the message log", ""), ...channels.map((c) => new Option(c.name, c.id)));
  $("lMsgChannel").value = s.messageChannelId;
  $("lMemChannel").value = s.memberChannelId;

  $("lEnabled").checked = s.enabled;
  $("lDelete").checked = s.events.delete;
  $("lEdit").checked = s.events.edit;
  $("lJoin").checked = s.events.join;
  $("lLeave").checked = s.events.leave;
  $("lIgnoreBots").checked = s.ignoreBots;
  $("lNewDays").value = s.newAccountDays;
  renderIgnoreList(s.ignoredChannelIds);
}

function renderLogStatus(status) {
  const box = $("lStatus");
  box.replaceChildren();
  if (!status) return;
  box.append(
    h("p", { class: "muted" }, `Remembering the last ${status.remembered} messages (kept in memory only, so deleted messages can show their text).`),
  );
  if (status.problem) box.append(h("p", { class: "form-error" }, `⚠ ${status.problem}`));
}

async function loadLogs() {
  try {
    const data = await api(`/logs/${$("guild").value}`);
    setLogsForm(data.settings);
    renderLogStatus(data.status);
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveLogs() {
  const data = await api(`/logs/${$("guild").value}`, {
    method: "PUT",
    body: JSON.stringify({ settings: collectLogs() }),
  });
  setLogsForm(data.settings);
  renderLogStatus(data.status);
  return data;
}

$("lSave").addEventListener("click", () =>
  withBusy($("lSave"), async () => {
    try {
      const data = await saveLogs();
      toast(["Saved ✅", ...data.warnings].join(" "));
    } catch (err) {
      toast(err.message, true);
    }
  }),
);

$("lTest").addEventListener("click", () =>
  withBusy($("lTest"), async () => {
    try {
      const data = await saveLogs();
      await api(`/logs/${$("guild").value}/test`, { method: "POST" });
      toast(["Sample logs sent ✅", ...data.warnings].join(" "));
    } catch (err) {
      toast(err.message, true);
      await loadLogs();
    }
  }),
);
