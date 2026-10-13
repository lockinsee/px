// Who may use the proxy.
//
// 1. bark access codes: the server downloads access.txt from the bark website (the same list the
//    Mac app checks) and accepts any Basic Auth login whose password is a valid code. Removing a
//    line from access.txt locks that person out within a few minutes.
// 2. AUTH_USERS: optional fixed "user:password" pairs, e.g. for an admin account.
//
// After a successful login the server sets a signed session cookie, which is what the Wisp
// WebSocket checks (browsers don't reliably send Basic Auth on WebSocket connections).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const REFRESH_MS = 5 * 60 * 1000;
const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE = "bark_session";

const sha256hex = value => createHash("sha256").update(value).digest("hex");
const digest = value => createHash("sha256").update(value).digest();

export function normalizeCode(code) {
  return String(code ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function hashCode(code) {
  return sha256hex(`bark:${normalizeCode(code)}`);
}

export function parseAccessList(text) {
  const list = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    const colon = line.lastIndexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim() || "Member";
    const hash = line
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    if (/^[0-9a-f]{64}$/.test(hash)) list.set(hash, name);
  }
  return list;
}

function parseUsers(raw) {
  const users = new Map();
  for (const entry of String(raw || "").split(",")) {
    const index = entry.indexOf(":");
    if (index < 1) continue;
    const name = entry.slice(0, index).trim();
    const password = entry.slice(index + 1);
    if (name && password) users.set(name, password);
  }
  return users;
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

export function createAccess({ barkSite, authUsers, sessionSecret, log = console.log, warn = console.warn, fetchText }) {
  const users = parseUsers(authUsers);
  const site = barkSite ? String(barkSite).replace(/\/+$/, "") : "";
  const secret = sessionSecret || randomBytes(32).toString("hex");
  const enabled = Boolean(site) || users.size > 0;
  let codes = null; // Map<hash, name>, null until first successful download

  const download =
    fetchText ??
    (async url => {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    });

  async function refresh() {
    if (!site) return;
    try {
      const text = await download(`${site}/access.txt?t=${Date.now()}`);
      codes = parseAccessList(text);
      log(`bark access list loaded: ${codes.size} code${codes.size === 1 ? "" : "s"}`);
    } catch (error) {
      warn(`Couldn't download ${site}/access.txt: ${error.message}${codes ? " (keeping the previous list)" : ""}`);
    }
  }

  let timer = null;
  async function start() {
    await refresh();
    if (site) {
      timer = setInterval(refresh, REFRESH_MS);
      timer.unref();
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
  }

  // Returns an identity string for a valid login, or null.
  function checkLogin(username, password) {
    if (users.has(username)) {
      const ok = timingSafeEqual(digest(password), digest(users.get(username)));
      if (ok) return `user:${username}`;
    }
    if (codes && normalizeCode(password)) {
      const hash = hashCode(password);
      if (codes.has(hash)) return `code:${hash}`;
    }
    return null;
  }

  // Identities stay valid only while their code is still on the list.
  function stillValid(identity) {
    if (identity.startsWith("user:")) return users.has(identity.slice(5));
    if (identity.startsWith("code:")) return Boolean(codes?.has(identity.slice(5)));
    return false;
  }

  const sign = payload => createHmac("sha256", secret).update(payload).digest("base64url");

  function makeSession(identity) {
    const payload = `${Buffer.from(identity).toString("base64url")}.${Date.now() + SESSION_MS}`;
    return `${payload}.${sign(payload)}`;
  }

  function readSession(value) {
    const parts = String(value ?? "").split(".");
    if (parts.length !== 3) return null;
    const payload = `${parts[0]}.${parts[1]}`;
    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(parts[2]);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    if (Number(parts[1]) < Date.now()) return null;
    const identity = Buffer.from(parts[0], "base64url").toString("utf8");
    return stillValid(identity) ? identity : null;
  }

  function fromBasicAuth(req) {
    const match = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (!match) return null;
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const index = decoded.indexOf(":");
    if (index < 0) return null;
    return checkLogin(decoded.slice(0, index), decoded.slice(index + 1));
  }

  function fromCookie(req) {
    return readSession(parseCookies(req.headers.cookie)[COOKIE]);
  }

  // Express middleware for pages and assets.
  function middleware(req, res, next) {
    if (!enabled) return next();
    const fromHeader = fromBasicAuth(req);
    if (fromHeader) {
      res.cookie(COOKIE, makeSession(fromHeader), {
        httpOnly: true,
        secure: req.secure || req.headers["x-forwarded-proto"] === "https",
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_MS,
      });
      return next();
    }
    if (fromCookie(req)) return next();
    res
      .set("WWW-Authenticate", 'Basic realm="bark", charset="UTF-8"')
      .status(401)
      .type("text/plain")
      .send(codes || users.size ? "Sign in with any username and your bark access code." : "The access list couldn't be loaded yet. Try again in a minute.");
  }

  // Check for the Wisp WebSocket upgrade.
  function allowsUpgrade(req) {
    if (!enabled) return true;
    return Boolean(fromCookie(req) || fromBasicAuth(req));
  }

  return { enabled, start, stop, middleware, allowsUpgrade, checkLogin, hasCodes: () => Boolean(codes) };
}
