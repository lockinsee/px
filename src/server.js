import "dotenv/config";
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

const pages = { "/": "index.html", "/browse": "browse.html", "/settings": "settings.html", "/chat": "chat.html" };
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

server.listen({ port: PORT }, () => {
  console.log(chalk.green(`🌍 ${config.name} is running on http://localhost:${PORT}`));
});
