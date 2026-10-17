import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import chalk from "chalk";
import express from "express";
import config from "../config.js";
import { createAccess } from "./access.js";
import { createChat } from "./chat.js";
import { startTunnel } from "./tunnel.js";
import { createBlockVerdict, setupFiltering } from "./filtering/index.js";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_DIR = path.join(ROOT, "static");

function resolvePort() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    let flag;
    if (args[i] === "--port" || args[i] === "-p") flag = args[i + 1];
    else if (args[i].startsWith("--port=")) flag = args[i].slice("--port=".length);
    else continue;

    if (!/^\d+$/.test(flag ?? "") || Number(flag) < 1 || Number(flag) > 65535) {
      console.log(chalk.red(`Invalid port ${JSON.stringify(flag ?? null)}, expected 1-65535.`));
      process.exit(1);
    }
    return Number(flag);
  }
  return Number(process.env.PORT) || 8080;
}

const PORT = resolvePort();

// Wisp carries all proxied traffic. Block the host's own network unless explicitly allowed.
const allowPrivate = config.allowPrivateNetwork === true;
wisp.options.allow_private_ips = allowPrivate;
wisp.options.allow_loopback_ips = allowPrivate;

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const blockedSiteMatchers = config.blockedSites.map(host => new RegExp(`(^|\\.)${escapeRegExp(host.trim().toLowerCase())}$`, "i"));
wisp.options.hostname_blacklist = blockedSiteMatchers.length ? blockedSiteMatchers : null;

const filteringState = await setupFiltering({ wisp, filtering: config.filtering, allowPrivate });
const blockVerdict = createBlockVerdict({ blocklist: blockedSiteMatchers, policy: filteringState.policy });

const app = express();
app.disable("x-powered-by");

app.set("trust proxy", true); // so secure cookies work behind Render/Koyeb/nginx

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const access = createAccess({
  requireSignIn: config.requireSignIn,
  inviteOnly: config.inviteOnly,
  barkSite: config.barkSite,
  allowedEmails: config.allowedEmails,
  googleClientId: config.google.clientId,
  googleClientSecret: config.google.clientSecret,
  publicUrl: config.publicUrl,
  sessionSecret: config.sessionSecret,
  dataDir: DATA_DIR,
});
await access.start();
if (access.open) {
  console.log(chalk.green("🌍 Open access: no sign-in. Everyone gets a guest identity automatically."));
  if (!config.sessionSecret) console.log(chalk.yellow("⚠️  SESSION_SECRET isn't set: guests get new identities (and lose their names) whenever the server restarts."));
} else if (access.enabled) {
  console.log(chalk.green(config.inviteOnly ? `🔒 Sign in with Google, invite list only (${config.barkSite}/access.txt)` : "🔒 Sign in with Google: any Google account can get in"));
  if (!config.sessionSecret) console.log(chalk.yellow("⚠️  SESSION_SECRET isn't set: everyone will be signed out whenever the server restarts."));
} else {
  console.log(chalk.yellow("⚠️  REQUIRE_SIGN_IN is on but GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET aren't set: nobody can sign in."));
}

// Messages and calls. People are identified by their Google account.
function parseIceServers() {
  const servers = [{ urls: (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478").split(",") }];
  if (process.env.TURN_URLS) {
    servers.push({ urls: process.env.TURN_URLS.split(","), username: process.env.TURN_USERNAME ?? "", credential: process.env.TURN_CREDENTIAL ?? "" });
  }
  return servers;
}
const chat = access.enabled
  ? createChat({
      access,
      channels: config.chat?.channels,
      iceServers: parseIceServers(),
      dataDir: DATA_DIR,
    })
  : null;

// Pages that work before signing in: health check, the sign-in page and Google's return trip.
app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));
app.get("/signin", (_req, res) => (access.open ? res.redirect(302, "/chat") : res.sendFile(path.join(STATIC_DIR, "signin.html"))));
for (const file of ["favicon.svg", "robots.txt"]) app.get(`/${file}`, (_req, res) => res.sendFile(path.join(STATIC_DIR, file)));
access.mountRoutes(app);
app.use(access.middleware);

app.use(express.json({ limit: "1kb" }));

const jsStaticOptions = {
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath);
    if (ext === ".js" || ext === ".mjs") {
      res.type("text/javascript");
      res.setHeader("Service-Worker-Allowed", "/");
    } else if (ext === ".wasm") {
      res.type("application/wasm");
    }
  },
};

app.get("/app-config.js", (_req, res) => {
  res.type("text/javascript").set("Cache-Control", "no-cache").send(`window.APP_CONFIG=${JSON.stringify({ name: config.name })};`);
});

app.post("/filter/verdict", async (req, res) => {
  const host = typeof req.body?.host === "string" ? req.body.host.slice(0, 254) : "";
  res.set("Cache-Control", "no-store").json(await blockVerdict(host));
});

// The Mac app's tunnel: sidebar apps send their traffic through this server (see src/tunnel.js).
// On Railway: Settings → Networking → TCP Proxy → port 8081. Railway then sets
// RAILWAY_TCP_PROXY_DOMAIN / RAILWAY_TCP_PROXY_PORT, which tell the app where to connect.
const TUNNEL_PORT = Number(process.env.TUNNEL_PORT) || 8081;
const tunnelHost = process.env.TUNNEL_PUBLIC_HOST || process.env.RAILWAY_TCP_PROXY_DOMAIN || "";
const tunnelPort = Number(process.env.TUNNEL_PUBLIC_PORT || process.env.RAILWAY_TCP_PROXY_PORT) || 0;
if (TUNNEL_PORT === PORT) {
  // Both on one port would crash the server, so the website wins and the tunnel stays off.
  console.log(chalk.red(`⚠️  The tunnel and the website both want port ${PORT}. Set PORT=8080 in Railway's Variables so the tunnel can use ${TUNNEL_PORT}.`));
} else if (access.enabled && process.env.TUNNEL !== "off") {
  startTunnel({ port: TUNNEL_PORT, readKey: access.readTunnelKey, allowPrivate, log: msg => console.log(chalk.green(`🔐 ${msg}`)) });
  if (!tunnelHost || !tunnelPort) console.log(chalk.yellow("⚠️  The Mac app's tunnel has no public address yet: add a TCP Proxy for port 8081 in Railway (Settings → Networking)."));
}
app.get("/auth/tunnel", (req, res) => {
  res.set("Cache-Control", "no-store");
  const identity = access.identify(req);
  if (!identity) return res.status(401).json({ available: false });
  if (!tunnelHost || !tunnelPort) return res.json({ available: false });
  res.json({ available: true, host: tunnelHost, port: tunnelPort, username: "bark", password: access.tunnelKey(identity) });
});

// Photos in Messages. Only real JPEG/PNG/GIF/WebP files (checked by their first bytes), up to 8 MB,
// saved under DATA_DIR/uploads with unguessable names. Only signed-in people can upload or view them.
const UPLOADS = path.join(DATA_DIR, "uploads");
const imageKind = buf => {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 6 && (buf.subarray(0, 6).toString("latin1") === "GIF87a" || buf.subarray(0, 6).toString("latin1") === "GIF89a")) return "gif";
  if (buf.length > 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
};
// Limits so nobody can fill the server's disk: a total cap on stored photos (UPLOAD_CAP_MB,
// default 2000 MB) and a per-person limit on how many they upload in a short time.
const UPLOAD_CAP = (Number(process.env.UPLOAD_CAP_MB) || 2000) * 1024 * 1024;
let uploadedBytes = 0;
fs.promises
  .readdir(path.join(DATA_DIR, "uploads"))
  .then(async names => {
    for (const n of names) uploadedBytes += (await fs.promises.stat(path.join(DATA_DIR, "uploads", n)).catch(() => ({ size: 0 }))).size;
  })
  .catch(() => {});
const recentUploads = new Map(); // identity -> upload times in the last 10 minutes
function allowUpload(identity, max = 40) {
  const now = Date.now();
  const times = (recentUploads.get(identity) ?? []).filter(t => now - t < 10 * 60_000);
  if (times.length >= max) return false;
  times.push(now);
  recentUploads.set(identity, times);
  if (recentUploads.size > 5000) recentUploads.clear();
  return true;
}

app.post("/chat/upload", express.raw({ type: "image/*", limit: "8mb" }), async (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const kind = imageKind(body);
  if (!kind) return res.status(415).json({ error: "Only JPEG, PNG, GIF or WebP images can be sent." });
  if (!allowUpload(access.identify(req))) return res.status(429).json({ error: "You're sending photos very fast. Wait a few minutes and try again." });
  if (uploadedBytes + body.length > UPLOAD_CAP) return res.status(507).json({ error: "The bark server is out of space for photos right now." });
  try {
    await fs.promises.mkdir(UPLOADS, { recursive: true });
    const name = `${crypto.randomBytes(16).toString("hex")}.${kind}`;
    await fs.promises.writeFile(path.join(UPLOADS, name), body);
    uploadedBytes += body.length;
    res.json({ url: `/chat/files/${name}` });
  } catch (error) {
    console.error("Couldn't save an upload:", error.message);
    res.status(500).json({ error: "Couldn't save the image." });
  }
});
app.get("/chat/files/:name", (req, res) => {
  if (!/^[a-f0-9]{32}\.(jpg|png|gif|webp)$/.test(req.params.name)) return res.status(404).end();
  res.set("Cache-Control", "private, max-age=31536000, immutable");
  res.set("X-Content-Type-Options", "nosniff");
  res.sendFile(path.join(UPLOADS, req.params.name), err => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// Profile pictures: small square images (the app shrinks them to 256px before sending),
// at most 1 MB, one per person; a new one replaces the old.
const AVATARS = path.join(DATA_DIR, "avatars");
app.post("/chat/avatar", express.raw({ type: "image/*", limit: "1mb" }), async (req, res) => {
  const identity = access.identify(req);
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const kind = imageKind(body);
  if (!kind || kind === "gif") return res.status(415).json({ error: "Use a JPEG, PNG or WebP picture." });
  if (!allowUpload(`avatar:${identity}`, 20)) return res.status(429).json({ error: "You've changed your picture a lot. Try again in a few minutes." });
  try {
    await fs.promises.mkdir(AVATARS, { recursive: true });
    const id = access.profileFor(identity)?.id ?? "x";
    const name = `${id}-${crypto.randomBytes(6).toString("hex")}.${kind}`;
    await fs.promises.writeFile(path.join(AVATARS, name), body);
    const old = access.setAvatar(identity, name);
    if (old && old !== name) fs.promises.unlink(path.join(AVATARS, old)).catch(() => {});
    chat?.refreshProfile(identity);
    res.json({ avatar: `/chat/avatars/${name}` });
  } catch (error) {
    console.error("Couldn't save a profile picture:", error.message);
    res.status(500).json({ error: "Couldn't save the picture." });
  }
});
app.delete("/chat/avatar", (req, res) => {
  const identity = access.identify(req);
  const old = access.setAvatar(identity, null);
  if (old) fs.promises.unlink(path.join(AVATARS, old)).catch(() => {});
  chat?.refreshProfile(identity);
  res.json({ avatar: null });
});
app.get("/chat/avatars/:name", (req, res) => {
  if (!/^[a-z0-9]+-[a-f0-9]{12}\.(jpg|png|webp)$/.test(req.params.name)) return res.status(404).end();
  res.set("Cache-Control", "private, max-age=31536000, immutable");
  res.set("X-Content-Type-Options", "nosniff");
  res.sendFile(path.join(AVATARS, req.params.name), err => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// Site icons for the Home screen and the Mac app's sidebar. The server fetches them (so your Mac
// never contacts the site just to draw an icon) and keeps them for a day.
const iconCache = new Map();
app.get("/icon", async (req, res) => {
  const domain = String(req.query.domain ?? "").toLowerCase().replace(/^www\./, "");
  if (domain.length > 200 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return res.status(400).end();
  const send = hit => res.type(hit.type).set("Cache-Control", "private, max-age=86400").send(hit.body);
  const hit = iconCache.get(domain);
  if (hit && hit.until > Date.now()) return send(hit);
  try {
    const response = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`, {
      signal: AbortSignal.timeout(8000),
    });
    const type = response.headers.get("content-type") || "";
    if (!response.ok || !type.startsWith("image/")) throw new Error(`no icon (${response.status})`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > 300_000) throw new Error("icon too large");
    if (iconCache.size > 500) iconCache.clear();
    const entry = { body, type, until: Date.now() + 86_400_000 };
    iconCache.set(domain, entry);
    send(entry);
  } catch {
    res.status(404).set("Cache-Control", "no-store").end();
  }
});

const pages = { "/": "index.html", "/home": "hub.html", "/browse": "browse.html", "/settings": "settings.html", "/chat": "chat.html", "/open": "open.html" };
for (const [route, file] of Object.entries(pages)) {
  app.get(route, (_req, res) => res.sendFile(path.join(STATIC_DIR, file)));
}

app.use(express.static(STATIC_DIR, { ...jsStaticOptions, dotfiles: "ignore" }));

const { epoxyPath } = require("@mercuryworkshop/epoxy-transport");
const { baremuxPath } = require("@mercuryworkshop/bare-mux/node");
const { libcurlPath } = require("@mercuryworkshop/libcurl-transport");
const { uvPath } = require("@titaniumnetwork-dev/ultraviolet");
const { scramjetPath } = require("@mercuryworkshop/scramjet/path");

app.use("/epoxy/", express.static(epoxyPath, jsStaticOptions));
app.use("/libcurl/", express.static(libcurlPath, jsStaticOptions));
app.use("/baremux/", express.static(baremuxPath, jsStaticOptions));
app.use("/assets/ultraviolet/", express.static(uvPath, jsStaticOptions));
app.use("/assets/scramjet/", express.static(scramjetPath, jsStaticOptions));

app.use((_req, res) => {
  res.status(404).sendFile(path.join(STATIC_DIR, "404.html"));
});

app.use((err, _req, res, _next) => {
  // Too-big uploads and bad requests get a clear answer instead of a crash report.
  const status = Number(err.status || err.statusCode) || 500;
  if (status === 413) return res.status(413).json({ error: "That file is too big." });
  if (status >= 400 && status < 500) return res.status(status).json({ error: "Bad request." });
  console.error(err.stack);
  res.status(500).type("text/plain").send("Internal server error");
});

const server = http.createServer(app);

// WebSockets must come from pages on this same site, so other websites can't connect as you.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser (e.g. a script with your login)
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

server.on("upgrade", (req, socket, head) => {
  if (!sameOrigin(req)) return socket.destroy();
  if (req.url?.startsWith("/wisp/")) {
    if (!access.allowsUpgrade(req)) return socket.destroy();
    return wisp.routeRequest(req, socket, head);
  }
  if (req.url?.split("?")[0] === "/chat/ws" && chat) {
    const identity = access.identify(req);
    if (!identity) return socket.destroy();
    return chat.handleUpgrade(req, socket, head, identity);
  }
  socket.destroy();
});

// Save chat history before the host stops the server (e.g. on redeploy).
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    chat?.flush();
    process.exit(0);
  });
}

// Slow or stuck requests are dropped instead of tying up the server.
server.headersTimeout = 30_000;
server.requestTimeout = 120_000;
server.keepAliveTimeout = 65_000;
server.maxHeadersCount = 200;

// One bad request should never take the whole server down: log it and keep going.
process.on("uncaughtException", error => console.error("Unexpected error (server kept running):", error));
process.on("unhandledRejection", error => console.error("Unhandled promise (server kept running):", error));

server.listen({ port: PORT }, () => {
  console.log(chalk.green(`🌍 ${config.name} is running on http://localhost:${PORT}`));
});
