// bark Messages: channels, private DMs and voice/video call signaling over one WebSocket.
//
// Who can use it: anyone signed in with a bark access code (see access.js); their name is the one
// next to their code in access.txt. Messages are stored on this server in DATA_DIR/chat.json.
// Calls are peer-to-peer WebRTC: this server only passes the connection setup ("signals") between
// the people in a call, so audio and video go directly between them, encrypted.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";

const MAX_TEXT = 4000;
const KEEP_PER_CONVERSATION = 2000;
const RECENT_ON_CONNECT = 50;
const HISTORY_PAGE = 50;
const MAX_CALL_SIZE = 8;
// Flood protection: each connection gets a budget of messages that refills over time.
// Normal use never comes close; a script hammering the server just gets ignored, then cut off.
const BUDGET = { size: 60, perSecond: 15 };          // chat actions (send, typing, history…)
const SIGNAL_BUDGET = { size: 400, perSecond: 120 }; // call set-up (lots of tiny messages at once)
const MAX_SOCKETS_PER_PERSON = 12;

const newId = () => randomBytes(9).toString("base64url");

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// --- storage ------------------------------------------------------------------------------

function createStore(dataDir, warn) {
  const file = path.join(dataDir, "chat.json");
  let data = { conversations: {} };
  try {
    if (existsSync(file)) data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || typeof data.conversations !== "object") data = { conversations: {} };
  } catch (error) {
    warn(`Couldn't read ${file} (${error.message}); starting with empty history.`);
  }

  let timer = null;
  function flush() {
    timer = null;
    try {
      mkdirSync(dataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, file);
    } catch (error) {
      warn(`Couldn't save chat history: ${error.message}`);
    }
  }
  const scheduleSave = () => {
    if (!timer) timer = setTimeout(flush, 1000);
  };

  function messages(conv) {
    return data.conversations[conv]?.messages ?? [];
  }

  function add(conv, message) {
    if (!data.conversations[conv]) data.conversations[conv] = { messages: [] };
    const entry = data.conversations[conv];
    entry.messages.push(message);
    if (entry.messages.length > KEEP_PER_CONVERSATION) entry.messages.splice(0, entry.messages.length - KEEP_PER_CONVERSATION);
    scheduleSave();
  }

  function remove(conv, id, from) {
    const list = data.conversations[conv]?.messages;
    const index = list?.findIndex(m => m.id === id && m.from === from) ?? -1;
    if (index < 0) return false;
    list.splice(index, 1);
    scheduleSave();
    return true;
  }

  function conversations() {
    return Object.keys(data.conversations);
  }

  return { messages, add, remove, conversations, flush };
}

// --- chat server --------------------------------------------------------------------------

export function createChat({ access, channels, iceServers, dataDir, log = console.log, warn = console.warn }) {
  const store = createStore(dataDir, warn);
  const channelList = (channels?.length ? channels : ["general"]).map(name => ({ id: `ch:${slug(name)}`, name: slug(name) }));
  const channelIds = new Set(channelList.map(c => c.id));

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set(); // { ws, identity, me }
  const calls = new Map(); // conv -> Map(userId -> client)

  const send = (client, payload) => {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(payload));
  };

  const onlineIds = () => new Set([...clients].map(c => c.me.id));

  function dmParts(conv) {
    const match = /^dm:([a-z0-9]+):([a-z0-9]+)$/.exec(conv);
    return match ? [match[1], match[2]] : null;
  }

  function dmId(a, b) {
    return `dm:${[a, b].sort().join(":")}`;
  }

  function canAccess(me, conv) {
    if (channelIds.has(conv)) return true;
    const parts = dmParts(conv);
    return Boolean(parts && parts[0] !== parts[1] && parts.includes(me.id));
  }

  // Everyone allowed to see a conversation who is connected right now.
  function audience(conv) {
    return [...clients].filter(c => canAccess(c.me, conv));
  }

  function broadcast(conv, payload, except = null) {
    for (const c of audience(conv)) if (c !== except) send(c, payload);
  }

  // People who turned on Do not disturb (until the server restarts or they turn it off).
  const quiet = new Set();

  function memberList() {
    const online = onlineIds();
    const byId = new Map();
    for (const m of access.members()) byId.set(m.id, { ...m, online: online.has(m.id), dnd: quiet.has(m.id) });
    for (const c of clients) if (!byId.has(c.me.id)) byId.set(c.me.id, { ...c.me, online: true, dnd: quiet.has(c.me.id) });
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function broadcastMembers() {
    const users = memberList();
    for (const c of clients) send(c, { t: "members", users });
  }

  function callState(conv) {
    const room = calls.get(conv);
    return { t: "call-state", conv, members: room ? [...room.keys()] : [] };
  }

  function leaveCall(client, conv, reason = "left") {
    const room = calls.get(conv);
    if (!room || room.get(client.me.id) !== client) return;
    room.delete(client.me.id);
    for (const other of room.values()) send(other, { t: "peer-left", conv, id: client.me.id, reason });
    if (room.size === 0) calls.delete(conv);
    broadcast(conv, callState(conv));
  }

  function joinCall(client, conv, video) {
    let room = calls.get(conv);
    const startedNow = !room || room.size === 0;
    if (!room) {
      room = new Map();
      calls.set(conv, room);
    }

    const existing = room.get(client.me.id);
    if (existing && existing !== client) {
      // Joined from another device: move the call here.
      send(existing, { t: "call-ended", conv, reason: "joined-elsewhere" });
      room.delete(client.me.id);
      for (const other of room.values()) send(other, { t: "peer-left", conv, id: client.me.id, reason: "moved" });
    }
    if (room.size >= MAX_CALL_SIZE) {
      send(client, { t: "error", message: `Calls are limited to ${MAX_CALL_SIZE} people.` });
      return;
    }

    const peers = [...room.keys()];
    room.set(client.me.id, client);
    // The newcomer sets up a connection to everyone already in the call.
    send(client, { t: "call-joined", conv, peers, iceServers });
    for (const other of room.values()) if (other !== client) send(other, { t: "peer-joined", conv, id: client.me.id });
    broadcast(conv, callState(conv));

    if (startedNow) {
      // Ring everyone else who can see this conversation.
      for (const c of audience(conv)) {
        if (c.me.id !== client.me.id) send(c, { t: "ring", conv, from: client.me.id, video: Boolean(video) });
      }
    }
  }

  function recentFor(me) {
    const recent = {};
    const convs = new Set([...channelIds, ...store.conversations()]);
    for (const conv of convs) {
      if (!canAccess(me, conv)) continue;
      const list = store.messages(conv);
      if (list.length) recent[conv] = list.slice(-RECENT_ON_CONNECT);
    }
    return recent;
  }

  function handle(client, msg) {
    const { me } = client;
    const now = Date.now();

    const conv = typeof msg.conv === "string" ? msg.conv : "";
    switch (msg.t) {
      case "send": {
        if (!canAccess(me, conv)) return;
        const text = String(msg.text ?? "")
          .replace(/\r\n/g, "\n")
          .trim()
          .slice(0, MAX_TEXT);
        // A photo uploaded through /chat/upload (only its server address is accepted).
        const image = typeof msg.image === "string" && /^\/chat\/files\/[a-f0-9]{32}\.(jpg|png|gif|webp)$/.test(msg.image) ? msg.image : null;
        if (!text && !image) return;
        const message = { id: newId(), from: me.id, text, at: now };
        if (image) {
          message.image = image;
          const w = Number(msg.w), h = Number(msg.h);
          if (w > 0 && h > 0 && w <= 10000 && h <= 10000) Object.assign(message, { w: Math.round(w), h: Math.round(h) });
        }
        store.add(conv, message);
        broadcast(conv, { t: "msg", conv, msg: message, nonce: msg.nonce ?? null });
        return;
      }
      case "delete": {
        if (canAccess(me, conv) && store.remove(conv, String(msg.id), me.id)) broadcast(conv, { t: "deleted", conv, id: String(msg.id) });
        return;
      }
      case "history": {
        if (!canAccess(me, conv)) return;
        const list = store.messages(conv);
        const before = Number(msg.before) || Number.POSITIVE_INFINITY;
        const older = list.filter(m => m.at < before);
        send(client, { t: "history", conv, msgs: older.slice(-HISTORY_PAGE), more: older.length > HISTORY_PAGE });
        return;
      }
      case "typing": {
        if (canAccess(me, conv)) broadcast(conv, { t: "typing", conv, from: me.id }, client);
        return;
      }
      case "call-join": {
        if (canAccess(me, conv)) joinCall(client, conv, msg.video);
        return;
      }
      case "call-leave": {
        leaveCall(client, conv);
        return;
      }
      case "decline": {
        const room = calls.get(conv);
        if (room && canAccess(me, conv)) for (const other of room.values()) send(other, { t: "declined", conv, from: me.id });
        return;
      }
      case "signal": {
        // Only between two people who are both in the same call.
        const room = calls.get(conv);
        if (!room || room.get(me.id) !== client) return;
        const target = room.get(String(msg.to));
        if (target) send(target, { t: "signal", conv, from: me.id, data: msg.data });
        return;
      }
      case "set-status": {
        // Do not disturb: shown to everyone as a moon on your picture.
        const on = Boolean(msg.dnd);
        if (on === quiet.has(me.id)) return;
        if (on) quiet.add(me.id);
        else quiet.delete(me.id);
        broadcastMembers();
        return;
      }
      case "set-name": {
        // Everyone can change the name others see.
        if (!access.setName?.(client.identity, msg.name)) return send(client, { t: "error", message: "Pick a name between 1 and 32 characters." });
        const updated = access.profileFor(client.identity);
        for (const c of clients) {
          if (c.identity !== client.identity) continue;
          c.me = updated;
          send(c, { t: "me", me: updated });
        }
        broadcastMembers();
        return;
      }
      case "media": {
        // Mute / camera on-off indicators for the other people in the call.
        const room = calls.get(conv);
        if (!room || room.get(me.id) !== client) return;
        for (const other of room.values()) if (other !== client) send(other, { t: "media", conv, from: me.id, audio: Boolean(msg.audio), video: Boolean(msg.video) });
        return;
      }
      default:
    }
  }

  function makeBucket({ size, perSecond }) {
    let tokens = size;
    let last = Date.now();
    return () => {
      const now = Date.now();
      tokens = Math.min(size, tokens + ((now - last) / 1000) * perSecond);
      last = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };
  }

  function connect(ws, identity) {
    // One person can't open an endless number of connections.
    if ([...clients].filter(c => c.identity === identity).length >= MAX_SOCKETS_PER_PERSON) {
      ws.close(4009, "too many connections");
      return;
    }
    access.touch?.(identity);
    const me = access.profileFor(identity);
    const client = { ws, identity, me, budget: makeBucket(BUDGET), signalBudget: makeBucket(SIGNAL_BUDGET), dropped: 0 };
    const wasOnline = onlineIds().has(me.id);
    clients.add(client);

    send(client, {
      t: "ready",
      me,
      channels: channelList,
      users: memberList(),
      recent: recentFor(me),
      calls: [...calls.keys()].filter(conv => canAccess(me, conv)).map(conv => callState(conv)),
      iceServers,
    });
    if (!wasOnline) broadcastMembers();

    ws.on("message", raw => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      const allowed = msg.t === "signal" ? client.signalBudget() : client.budget();
      if (!allowed) {
        // Way over the limit: this isn't a person typing, so disconnect.
        if (++client.dropped > 300) ws.close(4008, "slow down");
        return;
      }
      try {
        handle(client, msg);
      } catch (error) {
        warn(`Ignored a bad message: ${error.message}`);
      }
    });

    ws.on("close", () => {
      clients.delete(client);
      for (const conv of [...calls.keys()]) leaveCall(client, conv, "disconnected");
      if (!onlineIds().has(me.id)) broadcastMembers();
    });

    ws.on("error", () => {});
  }

  // Kick anyone whose code was removed from access.txt, and refresh everyone's member list.
  access.onRefresh(() => {
    for (const client of [...clients]) {
      if (!access.stillValid(client.identity)) client.ws.close(4001, "access removed");
    }
    broadcastMembers();
  });

  // Keep connections alive through proxies (Railway closes idle sockets).
  const heartbeat = setInterval(() => {
    for (const client of clients) if (client.ws.readyState === client.ws.OPEN) client.ws.ping();
  }, 25_000);
  heartbeat.unref();

  function handleUpgrade(req, socket, head, identity) {
    wss.handleUpgrade(req, socket, head, ws => connect(ws, identity));
  }

  log(`Messages ready: channels ${channelList.map(c => `#${c.name}`).join(", ")}; history in ${path.resolve(dataDir)}`);
  /** Someone changed their profile (e.g. picture): update them everywhere. */
  function refreshProfile(identity) {
    const updated = access.profileFor(identity);
    for (const c of clients) {
      if (c.identity !== identity) continue;
      c.me = updated;
      send(c, { t: "me", me: updated });
    }
    broadcastMembers();
  }

  return { handleUpgrade, dmId, flush: store.flush, refreshProfile };
}
