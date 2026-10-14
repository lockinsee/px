// bark Messages: channels, private DMs, and voice/video calls (WebRTC, peer-to-peer).
(() => {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  // The bark Mac app listens for these to show notifications and the Dock badge.
  const bridge = window.webkit?.messageHandlers?.bark;
  if (bridge) document.getElementById("signout").hidden = true;
  const tellApp = payload => {
    try {
      bridge?.postMessage(payload);
    } catch {}
  };

  const state = {
    me: null,
    users: new Map(), // id -> { id, name, online }
    channels: [],
    convs: new Map(), // conv -> { msgs: [], more: true, loaded: false }
    current: null,
    calls: new Map(), // conv -> [member ids]
    typing: new Map(), // conv -> Map(id -> expires)
    active: true, // is the Messages screen in front?
  };

  // ---------- helpers ----------

  function storageGet(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value == null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  const lastRead = storageGet("chat.lastRead", {});

  function nameOf(id) {
    return state.users.get(id)?.name ?? "Someone";
  }

  function colorFor(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 55% 72%)`;
  }

  function avatar(id) {
    const node = el("span", "avatar", nameOf(id).slice(0, 1));
    node.style.setProperty("--avatar", colorFor(id));
    return node;
  }

  function dmFor(otherId) {
    return `dm:${[state.me.id, otherId].sort().join(":")}`;
  }

  function otherInDm(conv) {
    const parts = conv.split(":");
    return parts[1] === state.me.id ? parts[2] : parts[1];
  }

  function convTitle(conv) {
    if (conv.startsWith("ch:")) return conv.slice(3);
    return nameOf(otherInDm(conv));
  }

  function conv(convId) {
    let entry = state.convs.get(convId);
    if (!entry) {
      entry = { msgs: [], more: true, loaded: false };
      state.convs.set(convId, entry);
    }
    return entry;
  }

  function unreadCount(convId) {
    const read = lastRead[convId] ?? 0;
    return conv(convId).msgs.filter(m => m.at > read && m.from !== state.me?.id).length;
  }

  function markRead(convId) {
    const msgs = conv(convId).msgs;
    if (!msgs.length) return;
    lastRead[convId] = Math.max(lastRead[convId] ?? 0, msgs[msgs.length - 1].at);
    storageSet("chat.lastRead", lastRead);
  }

  function totalUnread() {
    let total = 0;
    for (const id of state.convs.keys()) total += unreadCount(id);
    return total;
  }

  function updateBadge() {
    const total = totalUnread();
    document.title = total ? `(${total}) Messages` : "Messages";
    tellApp({ type: "badge", count: total });
  }

  let bannerTimer;
  function banner(text, ms = 4000) {
    const node = $("banner");
    node.textContent = text;
    node.hidden = !text;
    clearTimeout(bannerTimer);
    if (text && ms) {
      bannerTimer = setTimeout(() => {
        node.hidden = true;
      }, ms);
    }
  }

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

  function linkify(text) {
    const frag = document.createDocumentFragment();
    const re = /\bhttps?:\/\/[^\s<>"']+/g;
    let last = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const url = m[0].replace(/[),.!?]+$/, "");
      const a = el("a", null, url);
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      frag.append(a);
      last = m.index + url.length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  // ---------- connection ----------

  let ws = null;
  let retry = 0;
  let stopped = false;
  let everConnected = false;
  const outbox = [];

  function wsSend(payload) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    else if (payload.t === "send") outbox.push(payload);
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/chat/ws`);
    ws.onopen = () => {
      retry = 0;
      everConnected = true;
      banner("");
    };
    ws.onmessage = event => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handlers[msg.t]?.(msg);
    };
    ws.onclose = event => {
      if (call) endCall("disconnected");
      if (event.code === 4001) {
        stopped = true;
        banner("Your access was removed.", 0);
        return;
      }
      if (stopped) return;
      // Never connected at all: probably signed out, so reload to get the sign-in page.
      if (!everConnected && retry >= 2) {
        location.reload();
        return;
      }
      retry = Math.min(retry + 1, 6);
      banner("Reconnecting…", 0);
      setTimeout(connect, 500 * 2 ** retry);
    };
  }

  const handlers = {
    ready(msg) {
      state.me = msg.me;
      state.users = new Map(msg.users.map(u => [u.id, u]));
      state.channels = msg.channels;
      state.iceServers = msg.iceServers;
      for (const [convId, msgs] of Object.entries(msg.recent)) {
        const entry = conv(convId);
        entry.msgs = mergeMessages(entry.msgs, msgs);
      }
      state.calls = new Map(msg.calls.map(c => [c.conv, c.members]));
      $("me-name").textContent = msg.me.name;
      // Open access: guests pick their own name (and can change it by clicking it).
      state.guest = msg.me.named !== undefined;
      $("me-name").classList.toggle("editable", state.guest);
      if (state.guest) {
        $("me-name").title = "Change your name";
        $("signout").hidden = true;
      }
      if (msg.me.named === false) openNameDialog();
      $("me-avatar").replaceWith(Object.assign(avatar(msg.me.id), { id: "me-avatar" }));
      // /chat?conv=… (from the Home screen) opens that conversation.
      const wanted = new URLSearchParams(location.search).get("conv");
      if (wanted && !state.current && canSee(wanted)) state.current = wanted;
      if (!state.current) state.current = storageGet("chat.current", null);
      if (!state.current || !canSee(state.current)) state.current = state.channels[0]?.id;
      for (const p of outbox.splice(0)) wsSend(p);
      renderSidebar();
      openConv(state.current, true);
    },
    me(msg) {
      state.me = msg.me;
      $("me-name").textContent = msg.me.name;
      $("me-avatar").replaceWith(Object.assign(avatar(msg.me.id), { id: "me-avatar" }));
      renderSidebar();
      renderHeader();
      if (state.current) renderMessages(false);
    },
    members(msg) {
      state.users = new Map(msg.users.map(u => [u.id, u]));
      renderSidebar();
      renderHeader();
    },
    msg(msg) {
      const entry = conv(msg.conv);
      if (msg.msg.from === state.me.id && msg.nonce) {
        const pending = entry.msgs.findIndex(m => m.nonce === msg.nonce);
        if (pending >= 0) entry.msgs.splice(pending, 1);
      }
      entry.msgs = mergeMessages(entry.msgs, [msg.msg]);
      state.typing.get(msg.conv)?.delete(msg.msg.from);
      const viewing = msg.conv === state.current && state.active && document.hasFocus();
      if (msg.conv === state.current) {
        renderMessages(true);
        if (viewing) markRead(msg.conv);
      }
      if (msg.msg.from !== state.me.id && !viewing) {
        const where = msg.conv.startsWith("ch:") ? `#${convTitle(msg.conv)}` : "";
        tellApp({ type: "notify", title: where ? `${nameOf(msg.msg.from)} in ${where}` : nameOf(msg.msg.from), body: msg.msg.text.slice(0, 200), conv: msg.conv });
      }
      renderSidebar();
      renderTyping();
    },
    deleted(msg) {
      const entry = conv(msg.conv);
      entry.msgs = entry.msgs.filter(m => m.id !== msg.id);
      if (msg.conv === state.current) renderMessages(false);
      renderSidebar();
    },
    history(msg) {
      const entry = conv(msg.conv);
      entry.loaded = true;
      entry.more = msg.more;
      const box = $("messages");
      const fromBottom = box.scrollHeight - box.scrollTop;
      entry.msgs = mergeMessages(entry.msgs, msg.msgs);
      if (msg.conv === state.current) {
        renderMessages(false);
        box.scrollTop = box.scrollHeight - fromBottom;
      }
    },
    typing(msg) {
      let map = state.typing.get(msg.conv);
      if (!map) {
        map = new Map();
        state.typing.set(msg.conv, map);
      }
      map.set(msg.from, Date.now() + 4000);
      renderTyping();
    },
    "call-state"(msg) {
      if (msg.members.length) state.calls.set(msg.conv, msg.members);
      else state.calls.delete(msg.conv);
      if (!msg.members.length && ringing?.conv === msg.conv) stopRing();
      renderSidebar();
      renderHeader();
    },
    ring(msg) {
      if (call?.conv === msg.conv) return;
      startRing(msg);
    },
    "call-joined"(msg) {
      if (!call || call.conv !== msg.conv) return;
      call.iceServers = msg.iceServers ?? state.iceServers;
      for (const id of msg.peers) peer(id, true);
      renderTiles();
    },
    "peer-joined"(msg) {
      if (call?.conv === msg.conv) {
        banner(`${nameOf(msg.id)} joined the call`);
        renderTiles();
      }
    },
    "peer-left"(msg) {
      if (call?.conv !== msg.conv) return;
      dropPeer(msg.id);
      if (msg.reason !== "moved") banner(`${nameOf(msg.id)} left the call`);
    },
    declined(msg) {
      if (call?.conv === msg.conv) banner(`${nameOf(msg.from)} declined`);
    },
    "call-ended"(msg) {
      if (call?.conv === msg.conv) {
        endCall("elsewhere");
        banner("You joined this call on another device.");
      }
    },
    signal(msg) {
      if (call?.conv === msg.conv) onSignal(msg.from, msg.data);
    },
    media(msg) {
      const p = call?.peers.get(msg.from);
      if (!p) return;
      p.audio = msg.audio;
      p.video = msg.video;
      renderTiles();
    },
    error(msg) {
      banner(msg.message);
    },
  };

  function canSee(convId) {
    if (convId.startsWith("ch:")) return state.channels.some(c => c.id === convId);
    return convId.startsWith("dm:") && convId.split(":").includes(state.me.id);
  }

  function mergeMessages(existing, incoming) {
    const byId = new Map(existing.map(m => [m.id, m]));
    for (const m of incoming) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.at - b.at);
  }

  // ---------- rendering ----------

  function convButton(convId, label, lead) {
    const li = el("li");
    const button = el("button", "conv");
    button.type = "button";
    button.append(lead, el("span", "label", label));
    if (state.calls.has(convId)) button.append(el("span", "in-call", "🔊"));
    const unread = convId === state.current ? 0 : unreadCount(convId);
    if (unread) {
      button.classList.add("unread");
      button.append(el("span", "badge", unread > 99 ? "99+" : String(unread)));
    }
    if (convId === state.current) button.classList.add("active");
    button.addEventListener("click", () => openConv(convId));
    li.append(button);
    return li;
  }

  function renderSidebar() {
    if (!state.me) return;
    const channelList = $("channel-list");
    channelList.replaceChildren(...state.channels.map(c => convButton(c.id, c.name, el("span", "hash", "#"))));

    const people = [...state.users.values()].filter(u => u.id !== state.me.id);
    // People you've talked to recently first, then everyone else alphabetically.
    const lastAt = u => conv(dmFor(u.id)).msgs.at(-1)?.at ?? 0;
    people.sort((a, b) => lastAt(b) - lastAt(a) || a.name.localeCompare(b.name));
    const dmList = $("dm-list");
    dmList.replaceChildren(
      ...people.map(u => {
        const li = convButton(dmFor(u.id), u.name, avatar(u.id));
        if (u.online) li.firstChild.classList.add("online");
        return li;
      }),
    );
    if (!people.length) dmList.append(el("li", "side-sub", "  No one else has a code yet."));
    updateBadge();
  }

  function renderHeader() {
    const convId = state.current;
    if (!convId || !state.me) return;
    const isDm = convId.startsWith("dm:");
    const icon = $("room-icon");
    icon.replaceChildren(isDm ? avatar(otherInDm(convId)) : document.createTextNode("#"));
    $("room-name").textContent = convTitle(convId);
    const other = isDm ? state.users.get(otherInDm(convId)) : null;
    $("room-status").textContent = isDm ? (other?.online ? "online" : "offline") : `${[...state.users.values()].filter(u => u.online).length} online`;

    const members = state.calls.get(convId) ?? [];
    const inThisCall = call?.conv === convId;
    const join = $("join-call");
    join.hidden = !members.length || inThisCall;
    join.textContent = `Join call · ${members.length}`;
    $("start-voice").disabled = Boolean(members.length) || inThisCall;
    $("start-video").disabled = Boolean(members.length) || inThisCall;
    $("text").placeholder = isDm ? `Message ${convTitle(convId)}` : `Message #${convTitle(convId)}`;
  }

  function renderMessages(stickToBottom) {
    const box = $("messages");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const entry = conv(state.current);
    const nodes = [];

    if (entry.more && entry.msgs.length >= 50) {
      const more = el("button", "pill load-more", "Load earlier messages");
      more.type = "button";
      more.addEventListener("click", () => wsSend({ t: "history", conv: state.current, before: entry.msgs[0]?.at }));
      nodes.push(more);
    }

    if (!entry.msgs.length) {
      const empty = el("div", "empty");
      const inner = el("div");
      const isDm = state.current.startsWith("dm:");
      inner.append(el("strong", null, isDm ? convTitle(state.current) : `#${convTitle(state.current)}`));
      inner.append(isDm ? "This is a private conversation between the two of you." : "This is the start of the channel. Everyone with a bark code can see it.");
      empty.append(inner);
      nodes.push(empty);
    }

    let group = null;
    let lastDay = "";
    for (const m of entry.msgs) {
      const day = dayFmt.format(m.at);
      if (day !== lastDay) {
        nodes.push(el("div", "day", day));
        lastDay = day;
        group = null;
      }
      if (!group || group.from !== m.from || m.at - group.lastAt > 5 * 60_000) {
        const node = el("div", "group");
        const body = el("div", "group-body");
        const head = el("div", "group-head");
        head.append(el("strong", null, nameOf(m.from)));
        const time = el("time", null, timeFmt.format(m.at));
        time.dateTime = new Date(m.at).toISOString();
        head.append(time);
        body.append(head);
        node.append(avatar(m.from), body);
        nodes.push(node);
        group = { from: m.from, lastAt: m.at, body };
      }
      group.lastAt = m.at;
      const line = el("div", m.pending ? "msg pending" : "msg");
      line.title = timeFmt.format(m.at);
      line.append(linkify(m.text));
      if (m.from === state.me.id && !m.pending) {
        const del = el("button", "delete", "Delete");
        del.type = "button";
        del.addEventListener("click", () => wsSend({ t: "delete", conv: state.current, id: m.id }));
        line.append(del);
      }
      group.body.append(line);
    }

    box.replaceChildren(...nodes);
    if (stickToBottom ? atBottom || entry.msgs.at(-1)?.from === state.me.id : true) box.scrollTop = box.scrollHeight;
  }

  function renderTyping() {
    const map = state.typing.get(state.current);
    const now = Date.now();
    const names = map ? [...map].filter(([id, until]) => until > now && id !== state.me?.id).map(([id]) => nameOf(id)) : [];
    $("typing").textContent = names.length ? `${names.join(", ")} ${names.length > 1 ? "are" : "is"} typing…` : "";
  }
  setInterval(renderTyping, 1500);

  function openConv(convId, initial = false) {
    if (!convId) return;
    state.current = convId;
    storageSet("chat.current", convId);
    const entry = conv(convId);
    if (!entry.loaded) wsSend({ t: "history", conv: convId });
    renderHeader();
    renderMessages(false);
    renderTyping();
    markRead(convId);
    renderSidebar();
    if (!initial) $("text").focus();
  }

  // ---------- composer ----------

  const text = $("text");
  let lastTypingSent = 0;

  function autosize() {
    text.style.height = "auto";
    text.style.height = `${Math.min(text.scrollHeight, 200)}px`;
  }

  text.addEventListener("input", () => {
    autosize();
    if (Date.now() - lastTypingSent > 2500 && text.value.trim()) {
      lastTypingSent = Date.now();
      wsSend({ t: "typing", conv: state.current });
    }
  });

  text.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("composer").requestSubmit();
    }
  });

  $("composer").addEventListener("submit", event => {
    event.preventDefault();
    const value = text.value.trim();
    if (!value || !state.me) return;
    const nonce = Math.random().toString(36).slice(2);
    const entry = conv(state.current);
    entry.msgs.push({ id: `pending-${nonce}`, nonce, from: state.me.id, text: value, at: Date.now(), pending: true });
    renderMessages(true);
    wsSend({ t: "send", conv: state.current, text: value, nonce });
    text.value = "";
    autosize();
    lastTypingSent = 0;
  });

  // ---------- calls ----------

  let call = null; // { conv, local: MediaStream, peers: Map(id -> {pc, stream, pending, audio, video}), mic, cam }

  async function startCall(convId, wantVideo) {
    if (call) endCall("switch");
    stopRing();
    let local;
    try {
      local = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantVideo ? { width: 1280, height: 720 } : false });
    } catch (error) {
      try {
        // No camera (or camera blocked): join with audio only.
        local = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (wantVideo) banner("Camera unavailable — joined with audio only.");
      } catch {
        banner(`Can't use your microphone: ${error.message || error.name}. Check bark's permissions in System Settings → Privacy & Security.`, 8000);
        return;
      }
    }
    call = { conv: convId, local, peers: new Map(), mic: true, cam: local.getVideoTracks().length > 0, iceServers: state.iceServers };
    if (state.current !== convId) openConv(convId);
    $("call").hidden = false;
    renderTiles();
    renderCallBar();
    renderHeader();
    wsSend({ t: "call-join", conv: convId, video: wantVideo });
    tellApp({ type: "call", active: true });
  }

  function endCall(reason) {
    if (!call) return;
    const leaving = call;
    call = null;
    for (const id of [...leaving.peers.keys()]) closePeer(leaving, id);
    for (const track of leaving.local.getTracks()) track.stop();
    if (reason !== "disconnected" && reason !== "elsewhere") wsSend({ t: "call-leave", conv: leaving.conv });
    $("call").hidden = true;
    $("tiles").replaceChildren();
    renderHeader();
    tellApp({ type: "call", active: false });
  }

  function videoSender(pc) {
    return pc.getTransceivers().find(t => t.receiver.track?.kind === "video")?.sender;
  }

  function sendMediaState() {
    if (!call) return;
    wsSend({ t: "media", conv: call.conv, audio: call.mic, video: call.cam });
  }

  // Creates the connection to one other person. The newcomer (initiator) sends the offer.
  function peer(id, initiator) {
    const existing = call.peers.get(id);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: call.iceServers ?? state.iceServers });
    const entry = { pc, stream: new MediaStream(), pending: [], audio: true, video: false, state: "connecting" };
    call.peers.set(id, entry);

    const audio = call.local.getAudioTracks()[0];
    if (audio) pc.addTrack(audio, call.local);
    if (initiator) {
      // Always set up a video slot, so cameras can be switched on later without renegotiating.
      const camTrack = call.local.getVideoTracks()[0] ?? null;
      const transceiver = pc.addTransceiver("video", { direction: "sendrecv" });
      if (camTrack) transceiver.sender.replaceTrack(camTrack);
    }

    pc.onicecandidate = event => {
      if (event.candidate) wsSend({ t: "signal", conv: call.conv, to: id, data: { candidate: event.candidate } });
    };
    pc.ontrack = event => {
      entry.stream.addTrack(event.track);
      if (event.track.kind === "video") {
        event.track.onunmute = renderTiles;
        event.track.onmute = renderTiles;
      }
      renderTiles();
    };
    pc.onconnectionstatechange = () => {
      entry.state = pc.connectionState;
      if (pc.connectionState === "failed") banner(`Couldn't connect to ${nameOf(id)}. Their network may block direct calls.`, 8000);
      renderTiles();
    };

    if (initiator) {
      (async () => {
        try {
          await pc.setLocalDescription(await pc.createOffer());
          wsSend({ t: "signal", conv: call.conv, to: id, data: { sdp: pc.localDescription } });
          sendMediaState();
        } catch (error) {
          console.error("offer failed", error);
        }
      })();
    }
    return entry;
  }

  async function onSignal(from, data) {
    const entry = peer(from, false);
    const { pc } = entry;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        for (const c of entry.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        if (data.sdp.type === "offer") {
          // Answer with our camera in the video slot the other side created.
          const sender = videoSender(pc);
          const transceiver = pc.getTransceivers().find(t => t.receiver.track?.kind === "video");
          if (transceiver) transceiver.direction = "sendrecv";
          if (sender) await sender.replaceTrack(call.local.getVideoTracks()[0] ?? null);
          await pc.setLocalDescription(await pc.createAnswer());
          wsSend({ t: "signal", conv: call.conv, to: from, data: { sdp: pc.localDescription } });
          sendMediaState();
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else entry.pending.push(data.candidate);
      }
    } catch (error) {
      console.error("signal failed", error);
    }
  }

  function closePeer(c, id) {
    const entry = c.peers.get(id);
    if (!entry) return;
    entry.pc.close();
    c.peers.delete(id);
  }

  function dropPeer(id) {
    if (!call) return;
    closePeer(call, id);
    renderTiles();
  }

  function tile(id, stream, isMe, hasVideo, audioOn, status) {
    const node = el("div", `tile${isMe ? " me" : ""}${hasVideo ? " has-video" : ""}`);
    const video = el("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isMe; // never play your own microphone back
    video.srcObject = stream;
    const shell = el("div", "tile-avatar");
    shell.append(avatar(id));
    const label = el("div", "tile-name", isMe ? "You" : nameOf(id));
    if (!audioOn) label.append(el("span", "muted", "muted"));
    node.append(video, shell, label);
    if (status) node.append(el("span", "tile-status", status));
    return node;
  }

  function renderTiles() {
    if (!call) return;
    const tiles = [tile(state.me.id, call.local, true, call.cam, call.mic, "")];
    for (const [id, entry] of call.peers) {
      const liveVideo = entry.stream.getVideoTracks().some(t => t.readyState === "live" && !t.muted);
      const status = entry.state === "connected" ? "" : entry.state === "failed" ? "couldn't connect" : "connecting…";
      tiles.push(tile(id, entry.stream, false, liveVideo && entry.video !== false, entry.audio !== false, status));
    }
    // Keep existing <video> elements playing: only rebuild when the layout actually changed.
    const box = $("tiles");
    const key = tiles.map(t => t.className + t.textContent).join("|");
    if (box.dataset.key !== key) {
      box.replaceChildren(...tiles);
      box.dataset.key = key;
    }
    $("call-label").textContent = `${call.conv.startsWith("ch:") ? `#${convTitle(call.conv)}` : convTitle(call.conv)} · ${call.peers.size + 1} in call`;
  }

  function renderCallBar() {
    if (!call) return;
    $("toggle-mic").classList.toggle("off", !call.mic);
    $("toggle-mic").title = call.mic ? "Mute" : "Unmute";
    $("toggle-cam").classList.toggle("off", !call.cam);
    $("toggle-cam").title = call.cam ? "Turn camera off" : "Turn camera on";
  }

  $("toggle-mic").addEventListener("click", () => {
    if (!call) return;
    call.mic = !call.mic;
    for (const t of call.local.getAudioTracks()) t.enabled = call.mic;
    renderCallBar();
    renderTiles();
    sendMediaState();
  });

  $("toggle-cam").addEventListener("click", async () => {
    if (!call) return;
    if (call.cam) {
      for (const t of call.local.getVideoTracks()) {
        t.stop();
        call.local.removeTrack(t);
      }
      for (const { pc } of call.peers.values()) await videoSender(pc)?.replaceTrack(null);
      call.cam = false;
    } else {
      try {
        const cam = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
        const track = cam.getVideoTracks()[0];
        call.local.addTrack(track);
        for (const { pc } of call.peers.values()) await videoSender(pc)?.replaceTrack(track);
        call.cam = true;
      } catch (error) {
        banner(`Can't use your camera: ${error.message || error.name}`, 6000);
        return;
      }
    }
    $("tiles").dataset.key = "";
    renderCallBar();
    renderTiles();
    sendMediaState();
  });

  $("leave-call").addEventListener("click", () => endCall("left"));
  $("start-voice").addEventListener("click", () => startCall(state.current, false));
  $("start-video").addEventListener("click", () => startCall(state.current, true));
  $("join-call").addEventListener("click", () => startCall(state.current, false));

  // ---------- incoming calls ----------

  let ringing = null;
  let ringTone = null;

  function startRing(msg) {
    stopRing();
    ringing = msg;
    const isDm = msg.conv.startsWith("dm:");
    $("ring-avatar").replaceWith(Object.assign(avatar(msg.from), { id: "ring-avatar" }));
    $("ring-name").textContent = isDm ? nameOf(msg.from) : `${nameOf(msg.from)} in #${convTitle(msg.conv)}`;
    $("ring-kind").textContent = msg.video ? "Video call" : "Voice call";
    $("ring").hidden = false;
    tellApp({ type: "notify", title: `${nameOf(msg.from)} is calling`, body: isDm ? (msg.video ? "Video call" : "Voice call") : `Call in #${convTitle(msg.conv)}`, conv: msg.conv, ring: true });
    playRingTone();
    ringing.timer = setTimeout(stopRing, 30_000);
  }

  function stopRing() {
    if (ringing) clearTimeout(ringing.timer);
    ringing = null;
    $("ring").hidden = true;
    if (ringTone) {
      ringTone.close().catch(() => {});
      ringTone = null;
    }
  }

  function playRingTone() {
    try {
      const ctx = new AudioContext();
      ringTone = ctx;
      const beep = start => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 660;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.08, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.4);
      };
      for (let i = 0; i < 10; i++) {
        beep(ctx.currentTime + i * 3);
        beep(ctx.currentTime + i * 3 + 0.45);
      }
    } catch {}
  }

  $("ring-join").addEventListener("click", () => {
    const msg = ringing;
    stopRing();
    if (msg) startCall(msg.conv, msg.video);
  });

  $("ring-decline").addEventListener("click", () => {
    if (ringing) wsSend({ t: "decline", conv: ringing.conv });
    stopRing();
  });

  // ---------- choosing a name ----------

  function openNameDialog() {
    $("name-input").value = state.me?.named ? state.me.name : "";
    $("name-dialog").hidden = false;
    setTimeout(() => $("name-input").focus(), 0);
  }

  $("name-form").addEventListener("submit", event => {
    event.preventDefault();
    const name = $("name-input").value.trim();
    if (!name) return;
    wsSend({ t: "set-name", name });
    $("name-dialog").hidden = true;
  });

  $("me-name").addEventListener("click", () => {
    if (state.guest) openNameDialog();
  });

  // ---------- app integration ----------

  // The Mac app tells us when Messages is the screen in front, so notifications only show
  // when you're not already looking at the conversation.
  window.barkSetActive = active => {
    state.active = Boolean(active);
    if (state.active && state.current) {
      markRead(state.current);
      renderSidebar();
    }
  };

  // Clicking a notification in the Mac app opens that conversation.
  window.barkOpenConversation = convId => {
    if (state.me && canSee(convId)) openConv(convId);
  };

  window.addEventListener("focus", () => {
    if (state.current && state.active) {
      markRead(state.current);
      renderSidebar();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (call) wsSend({ t: "call-leave", conv: call.conv });
  });

  document.addEventListener("DOMContentLoaded", () => {
    for (const node of document.querySelectorAll("[data-app-name]")) node.textContent = window.APP_CONFIG?.name || "bark";
  });

  connect();
})();
