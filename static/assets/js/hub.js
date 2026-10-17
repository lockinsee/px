// bark Home screen. Talks to the Messages server for who's around and the newest messages.
// In the bark Mac app, buttons ask the app to switch apps (window.webkit.messageHandlers.bark);
// in a normal browser they're plain links.
(() => {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const svg = markup => {
    const wrap = document.createElement("span");
    wrap.innerHTML = markup;
    return wrap.firstElementChild;
  };

  const bridge = window.webkit?.messageHandlers?.bark;
  const tellApp = payload => {
    try {
      bridge?.postMessage(payload);
    } catch {}
  };

  const store = {
    get(key, fallback) {
      try {
        const value = localStorage.getItem(key);
        return value == null ? fallback : JSON.parse(value);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
  };

  const ICONS = {
    messages:
      '<svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A2.5 2.5 0 0 1 3 13.5"/><path d="M8.5 9.5h.01M12 9.5h.01M15.5 9.5h.01"/></svg>',
    browser:
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/></svg>',
    games:
      '<svg viewBox="0 0 24 24"><path d="M7 8h10a5 5 0 0 1 4.6 7l-.7 1.6a2.4 2.4 0 0 1-4 .5L15 15H9l-1.9 2.1a2.4 2.4 0 0 1-4-.5L2.4 15A5 5 0 0 1 7 8Z"/><path d="M8 10.5v3M6.5 12h3"/><path d="M15.5 11.5h.01M17.5 12.5h.01"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/></svg>',
  };

  // The apps in bark's sidebar. The Mac app sends its own list (including any you added).
  const DEFAULT_APPS = [
    { id: "tiktok", name: "TikTok", url: "https://www.tiktok.com/" },
    { id: "instagram", name: "Instagram", url: "https://www.instagram.com/" },
    { id: "snapchat", name: "Snapchat", url: "https://web.snapchat.com/" },
    { id: "messages", name: "Messages" },
    { id: "browser", name: "Browser" },
  ];

  const state = {
    apps: DEFAULT_APPS,
    last: store.get("home.last", "tiktok"),
    dnd: store.get("home.dnd", false),
    me: null,
    users: new Map(),
    channels: [],
    convs: new Map(), // conv -> messages (oldest first)
  };

  // ---------- header ----------

  function renderHeader() {
    const now = new Date();
    $("date").textContent = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    const hour = now.getHours();
    const part = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    const first = state.me?.name?.trim().split(/\s+/)[0];
    $("greeting").textContent = first ? `${part}, ${first}` : part;
  }

  // ---------- apps ----------

  function domainOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  // The site's own icon (fetched by the bark server), or the first letter if there isn't one.
  function appIcon(app) {
    if (ICONS[app.id]) return svg(ICONS[app.id]);
    const letter = el("span", "letter", (app.name || "?").slice(0, 1).toUpperCase());
    const domain = app.url && domainOf(app.url);
    if (!domain) return letter;
    const img = new Image();
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = `/icon?domain=${encodeURIComponent(domain)}`;
    img.onerror = () => img.replaceWith(letter);
    return img;
  }

  const openApp = calm(app => reallyOpenApp(app));
  function reallyOpenApp(app) {
    if (!app) return;
    if (app.id !== "messages" && app.id !== "browser") {
      state.last = app.id;
      store.set("home.last", app.id);
    }
    if (bridge) return tellApp({ type: "open", app: app.id });
    if (!app.url && app.id !== "messages" && app.id !== "browser") return;
    if (app.id === "messages") location.href = "/chat";
    else if (app.id === "browser") location.href = "/browse";
    else location.href = `/open?url=${encodeURIComponent(app.url)}`;
  }

  function renderApps() {
    const apps = state.apps;
    const last = apps.find(a => a.id === state.last) || apps.find(a => a.url) || apps[0];
    if (last) {
      $("last-icon").replaceChildren(appIcon(last));
      $("last-name").textContent = last.name;
      $("last-open").textContent = `Open ${last.name}`;
      $("last-open").onclick = () => openApp(last);
    }
    $("tiles").replaceChildren(
      ...apps.map(app => {
        const tile = el("button", "tile");
        tile.append(appIcon(app), el("span", null, app.name));
        tile.title = app.name;
        tile.onclick = () => openApp(app);
        return tile;
      }),
    );
  }

  // ---------- people ----------

  function nameOf(id) {
    return state.users.get(id)?.name ?? "Someone";
  }

  function avatar(id, small = false) {
    const node = el("span", small ? "avatar small" : "avatar", nameOf(id).slice(0, 1).toUpperCase());
    const pic = (id === state.me?.id ? state.me?.avatar : null) || state.users.get(id)?.avatar;
    if (pic) {
      const img = el("img", "avatar-img");
      img.src = pic;
      img.alt = "";
      img.onerror = () => img.remove();
      node.append(img);
    }
    return node;
  }

  // Ignores repeat clicks for a moment, so a double-click doesn't open things twice.
  function calm(fn, ms = 600) {
    let last = 0;
    return (...args) => {
      const now = Date.now();
      if (now - last < ms) return;
      last = now;
      return fn(...args);
    };
  }

  function dmWith(otherId) {
    return `dm:${[state.me.id, otherId].sort().join(":")}`;
  }

  function openConv(conv) {
    if (bridge) return tellApp({ type: "open", conv });
    location.href = `/chat?conv=${encodeURIComponent(conv)}`;
  }

  function renderPeople() {
    const box = $("people");
    if (!state.me) return;
    const around = [...state.users.values()].filter(u => u.online || u.id === state.me.id);
    // You first, then everyone else by name.
    around.sort((a, b) => (a.id === state.me.id ? -1 : b.id === state.me.id ? 1 : a.name.localeCompare(b.name)));
    const others = around.filter(u => u.id !== state.me.id);
    const shown = around.slice(0, 10).map(u => {
      const person = el("button", "person");
      const pic = avatar(u.id);
      const dot = el("span", u.dnd ? "dot dnd" : "dot");
      if (u.dnd) dot.append(svg(ICONS.moon));
      pic.append(dot);
      person.title = u.id === state.me.id ? "You" : u.dnd ? `${u.name} (do not disturb)` : `Message ${u.name}`;
      person.append(pic, el("span", "name", u.id === state.me.id ? "You" : u.name));
      person.onclick = () => (u.id === state.me.id ? null : openConv(dmWith(u.id)));
      return person;
    });
    if (around.length > 10) shown.push(el("p", "quiet", `+${around.length - 10} more`));
    if (!others.length) shown.push(el("p", "quiet", "Nobody else is around right now."));
    box.replaceChildren(...shown);
  }

  // ---------- messages ----------

  function convName(conv) {
    if (conv.startsWith("dm:")) {
      const parts = conv.split(":");
      return nameOf(parts[1] === state.me.id ? parts[2] : parts[1]);
    }
    const channel = state.channels.find(c => c.id === conv);
    return `#${channel?.name ?? conv.replace(/^ch:/, "")}`;
  }

  function ago(at) {
    const s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
    return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  // Same read markers the Messages screen keeps. Conversations you've never opened only count
  // the last day as new.
  function unread(conv, msgs) {
    const read = store.get("chat.lastRead", {})[conv] ?? Date.now() - 86400000;
    return msgs.filter(m => m.at > read && m.from !== state.me.id).length;
  }

  let topSeen = null; // the newest message shown, so a new arrival can glow once

  function renderConvs() {
    if (!state.me) return;
    const list = [...state.convs.entries()]
      .filter(([, msgs]) => msgs.length)
      .sort((a, b) => b[1][b[1].length - 1].at - a[1][a[1].length - 1].at);
    let totalNew = 0;
    const rows = list.slice(0, 5).map(([conv, msgs]) => {
      const lastMsg = msgs[msgs.length - 1];
      const count = unread(conv, msgs);
      const isDm = conv.startsWith("dm:");
      const who = lastMsg.from === state.me.id ? "You" : nameOf(lastMsg.from).split(/\s+/)[0];
      const body = lastMsg.text || (lastMsg.image ? "📷 Photo" : "");
      const preview = isDm && lastMsg.from !== state.me.id ? body : `${who}: ${body}`;
      const row = el("button", count ? "conv unread" : "conv");
      const pic = isDm ? avatar(conv.split(":").find(p => p !== "dm" && p !== state.me.id), true) : el("span", "avatar small", "#");
      const text = el("span", "conv-text");
      text.append(el("span", "conv-name", convName(conv)), el("span", "conv-preview", preview.replace(/\s+/g, " ")));
      row.append(pic, text, el("span", "conv-time", ago(lastMsg.at)));
      row.onclick = () => openConv(conv);
      const li = el("li");
      li.append(row);
      return li;
    });
    for (const [conv, msgs] of list) totalNew += unread(conv, msgs);
    const top = list[0]?.[1].at(-1)?.id ?? null;
    if (topSeen && top && top !== topSeen) rows[0]?.firstChild?.classList.add("fresh");
    topSeen = top;
    if (!rows.length) rows.push(el("li", "quiet", "No messages yet. Say hi in #general."));
    $("convs").replaceChildren(...rows);
    $("new-count").hidden = !totalNew;
    $("new-count").textContent = `${totalNew > 99 ? "99+" : totalNew} new`;
  }

  // ---------- Messages server ----------

  let ws = null;
  let retry = 1000;

  function wsSend(payload) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function connect() {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/chat/ws`);
    ws.onopen = () => {
      retry = 1000;
    };
    ws.onmessage = event => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === "ready") {
        state.me = msg.me;
        state.users = new Map(msg.users.map(u => [u.id, u]));
        state.channels = msg.channels;
        state.convs = new Map(Object.entries(msg.recent));
        if (state.dnd) wsSend({ t: "set-status", dnd: true });
        renderAll();
      } else if (msg.t === "me") {
        state.me = msg.me;
        renderAll();
      } else if (msg.t === "members") {
        state.users = new Map(msg.users.map(u => [u.id, u]));
        renderPeople();
        renderConvs();
      } else if (msg.t === "msg") {
        const list = state.convs.get(msg.conv) ?? [];
        if (!list.some(m => m.id === msg.msg.id)) list.push(msg.msg);
        state.convs.set(msg.conv, list.slice(-50));
        renderConvs();
      } else if (msg.t === "deleted") {
        const list = state.convs.get(msg.conv);
        if (list) state.convs.set(msg.conv, list.filter(m => m.id !== msg.id));
        renderConvs();
      }
    };
    ws.onclose = event => {
      // Signed out: the app shows its sign-in screen; on the web, go sign in.
      if (event.code === 4001 || event.code === 1008) {
        if (!bridge) location.href = "/signin?return=/home";
        return;
      }
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30000);
    };
  }

  // ---------- buttons ----------

  function renderDnd() {
    $("dnd").setAttribute("aria-pressed", String(state.dnd));
    $("dnd-label").textContent = state.dnd ? "Do not disturb is on" : "Do not disturb";
  }

  $("dnd").onclick = calm(() => {
    state.dnd = !state.dnd;
    store.set("home.dnd", state.dnd);
    wsSend({ t: "set-status", dnd: state.dnd });
    tellApp({ type: "dnd", on: state.dnd });
    renderDnd();
  });

  $("compose").onclick = () => {
    if (bridge) tellApp({ type: "open", app: "messages" });
    else location.href = "/chat";
  };

  if (bridge) {
    $("appearance").onclick = () => tellApp({ type: "appearance" });
    $("edit-apps").onclick = () => tellApp({ type: "edit-apps" });
  } else {
    // On the web these are bark Mac app settings.
    $("appearance").onclick = () => {
      location.href = "/settings";
    };
    $("edit-apps").hidden = true;
  }

  // ---------- update banner (the Mac app tells us about new versions) ----------
  let update = null;
  function renderUpdate() {
    const box = $("update");
    if (!update || !bridge) {
      if (!box.hidden) {
        box.classList.add("leaving");
        setTimeout(() => { box.hidden = true; box.classList.remove("leaving"); }, 220);
      }
      return;
    }
    const busy = update.stage === "downloading" || update.stage === "installing";
    const pct = Math.round(Math.max(0, Math.min(1, Number(update.progress) || 0)) * 100);
    $("update-title").textContent =
      update.stage === "downloading" ? `Downloading bark ${update.version}…` :
      update.stage === "installing" ? "Installing… bark will reopen in a moment" :
      update.stage === "failed" ? "The update didn't work" :
      `bark ${update.version} is available`;
    $("update-sub").textContent =
      update.stage === "failed" ? update.problem || "Try again in a bit." :
      busy ? (update.stage === "downloading" ? `${pct}%` : "Hang tight.") :
      update.notes ? update.notes : `You have ${update.current}. Updating takes a few seconds and keeps you signed in.`;
    $("update-bar").hidden = !busy;
    $("update-fill").style.width = `${update.stage === "installing" ? 100 : pct}%`;
    $("update-go").textContent = update.stage === "failed" ? "Try again" : "Update now";
    $("update-go").disabled = busy;
    $("update-later").hidden = busy;
    $("update-go").hidden = busy;
    box.classList.toggle("busy", busy);
    box.classList.toggle("failed", update.stage === "failed");
    box.hidden = false;
  }
  $("update-go").onclick = calm(() => tellApp({ type: "update-install" }), 1500);
  $("update-later").onclick = calm(() => tellApp({ type: "update-later" }), 800);

  function renderAll() {
    renderUpdate();
    renderHeader();
    renderApps();
    renderPeople();
    renderConvs();
    renderDnd();
  }

  // The Mac app calls this whenever Home is shown: its app list, what you opened last and
  // whether Do not disturb is on.
  window.barkHome = info => {
    if (Array.isArray(info?.apps) && info.apps.length) state.apps = info.apps;
    if (typeof info?.last === "string" && info.last) state.last = info.last;
    if (info && "update" in info) update = info.update && typeof info.update.version === "string" ? info.update : null;
    if (typeof info?.dnd === "boolean" && info.dnd !== state.dnd) {
      state.dnd = info.dnd;
      store.set("home.dnd", state.dnd);
      wsSend({ t: "set-status", dnd: state.dnd });
    }
    renderAll();
  };

  // Keep times and the greeting fresh, and pick up messages read in the Messages screen.
  setInterval(() => {
    renderHeader();
    renderConvs();
  }, 30000);
  window.addEventListener("focus", renderConvs);
  document.addEventListener("visibilitychange", () => document.hidden || renderConvs());

  renderAll();
  connect();
  tellApp({ type: "home-ready" });
})();
