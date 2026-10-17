// Who may use bark.
//
// By default people sign in with Google, and any Google account can get in.
//
// Optional settings:
//   INVITE_ONLY=true      only accounts on the invite list (access.txt, below) can sign in
//   REQUIRE_SIGN_IN=false no sign-in at all: everyone gets an anonymous guest session
//                         automatically and picks a display name in Messages
//
// The invite list is access.txt on the bark website, one person per line:
//     sam: 3f5a…            (scrambled email, made by add-person.sh, so the public file doesn't
//                            reveal anyone's address: SHA-256 of "bark:" + the email)
//     sam: sam@gmail.com    (a plain email works too)
// A line with only "*" lets anyone with a Google account in.
// Remove someone's line and they're signed out within 5 minutes.
//
// Signing in: /auth/google/start sends you to Google; Google sends you back to
// /auth/google/callback; the server checks the invite list and gives you a signed session
// (a cookie in browsers, or a token handed to the Mac app through a bark:// link).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const REFRESH_MS = Number(process.env.ACCESS_REFRESH_MS) || 5 * 60 * 1000;
const SESSION_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const GUEST_MS = 365 * 24 * 60 * 60 * 1000; // guests keep their identity for a year
const STATE_MS = 10 * 60 * 1000;
export const COOKIE = "bark_session";
const STATE_COOKIE = "bark_oauth";
const APP_CALLBACK = "bark://signed-in";

const GOOGLE_AUTH_URL = process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com", ...(process.env.GOOGLE_ISSUER ? [process.env.GOOGLE_ISSUER] : [])]);

const sha256hex = value => createHash("sha256").update(value).digest("hex");
const b64url = value => Buffer.from(value).toString("base64url");

function normalizeEmail(email) {
  return String(email ?? "")
    .trim()
    .toLowerCase();
}

/** Scrambles an email the same way add-person.sh does. */
export function hashEmail(email) {
  return sha256hex(`bark:${normalizeEmail(email)}`);
}

/** Parses access.txt: "name: email", "name: <sha256>", "email", or "*" (anyone). */
export function parseInviteList(text) {
  const people = new Map(); // email -> name
  const hashed = new Map(); // sha256("bark:" + email) -> name
  let anyone = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    if (line === "*") {
      anyone = true;
      continue;
    }
    const colon = line.lastIndexOf(":");
    const name = colon >= 0 ? line.slice(0, colon).trim() : "";
    const value = normalizeEmail(colon >= 0 ? line.slice(colon + 1) : line);
    // An empty name means "use their Google name".
    if (/^[0-9a-f]{64}$/.test(value)) hashed.set(value, name);
    else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) people.set(value, name);
  }
  return { people, hashed, anyone };
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Only allow returning to a page on this site. */
function safeReturn(value) {
  const text = String(value ?? "");
  return text.startsWith("/") && !text.startsWith("//") && !text.startsWith("/\\") ? text : "/chat";
}

export function createAccess({ requireSignIn = true, inviteOnly = false, barkSite, allowedEmails, googleClientId, googleClientSecret, publicUrl, sessionSecret, dataDir, log = console.log, warn = console.warn, fetchText }) {
  const site = barkSite ? String(barkSite).replace(/\/+$/, "") : "";
  const secret = sessionSecret || randomBytes(32).toString("hex");
  const enabled = Boolean(googleClientId && googleClientSecret);
  const open = !requireSignIn;
  const extraEmails = new Set(
    String(allowedEmails || "")
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean),
  );
  let invites = null; // { people, anyone } once access.txt has loaded

  // People who have signed in before, so their Google name shows in Messages.
  const usersFile = path.join(dataDir, "users.json");
  let known = {};
  try {
    if (existsSync(usersFile)) known = JSON.parse(readFileSync(usersFile, "utf8")) || {};
  } catch (error) {
    warn(`Couldn't read ${usersFile}: ${error.message}`);
  }
  let saveTimer = null;
  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(`${usersFile}.tmp`, JSON.stringify(known));
        renameSync(`${usersFile}.tmp`, usersFile);
      } catch (error) {
        warn(`Couldn't save ${usersFile}: ${error.message}`);
      }
    }, 1000);
  }
  function remember(email, name) {
    known[email] = { ...known[email], name, lastSignIn: Date.now() };
    persist();
  }

  const download =
    fetchText ??
    (async url => {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    });

  const refreshListeners = new Set();
  async function refresh() {
    if (!site) return;
    try {
      invites = parseInviteList(await download(`${site}/access.txt?t=${Date.now()}`));
      const count = invites.people.size + invites.hashed.size;
      log(`Invite list loaded: ${invites.anyone ? "anyone with a Google account" : `${count} ${count === 1 ? "person" : "people"}`}`);
      for (const listener of refreshListeners) listener();
    } catch (error) {
      warn(`Couldn't download ${site}/access.txt: ${error.message}${invites ? " (keeping the previous list)" : ""}`);
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

  function isInvited(email) {
    const e = normalizeEmail(email);
    if (!e) return false;
    if (!inviteOnly) return true; // any Google account
    if (extraEmails.has(e) || extraEmails.has("*")) return true;
    return Boolean(invites && (invites.anyone || invites.people.has(e) || invites.hashed.has(hashEmail(e))));
  }

  // --- sessions -----------------------------------------------------------------------

  const sign = payload => createHmac("sha256", secret).update(payload).digest("base64url");

  function makeSession(email, identity = `google:${email}`, ms = SESSION_MS) {
    const payload = `${b64url(identity)}.${Date.now() + ms}`;
    return `${payload}.${sign(payload)}`;
  }

  function verifySigned(value) {
    const parts = String(value ?? "").split(".");
    if (parts.length !== 3) return null;
    const payload = `${parts[0]}.${parts[1]}`;
    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(parts[2]);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    if (Number(parts[1]) < Date.now()) return null;
    return Buffer.from(parts[0], "base64url").toString("utf8");
  }

  function stillValid(identity) {
    if (identity?.startsWith("guest:")) return open;
    return Boolean(!open && identity?.startsWith("google:") && isInvited(identity.slice(7)));
  }

  function readSession(value) {
    const identity = verifySigned(value);
    return identity && stillValid(identity) ? identity : null;
  }

  // Keys for the Mac app's tunnel (src/tunnel.js). They're signed like sessions but marked
  // "tunnel:", so a tunnel key can never be used to sign in to Messages.
  const TUNNEL_MS = 30 * 24 * 60 * 60 * 1000;
  function tunnelKey(identity) {
    return makeSession(null, `tunnel:${identity}`, TUNNEL_MS);
  }
  function readTunnelKey(value) {
    const marked = verifySigned(value);
    if (!marked?.startsWith("tunnel:")) return null;
    const identity = marked.slice(7);
    return stillValid(identity) ? identity : null;
  }

  /** The signed-in identity ("google:<email>") for a request, from the cookie or a Bearer token. */
  function identify(req) {
    if (!open && !enabled) return null;
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    return readSession(bearer) || readSession(parseCookies(req.headers.cookie)[COOKIE]);
  }

  /** Where someone's saved profile data lives: their email, or the guest identity. */
  const keyFor = identity => (identity?.startsWith("guest:") ? identity : identity?.startsWith("google:") ? identity.slice(7) : null);
  const avatarUrl = key => (known[key]?.avatar ? `/chat/avatars/${known[key].avatar}` : null);

  function profileFor(identity) {
    if (identity?.startsWith("guest:")) {
      const id = `u${sha256hex(identity).slice(0, 16)}`;
      const name = known[identity]?.name;
      return { id, name: name || `Guest ${id.slice(1, 5)}`, named: Boolean(name), avatar: avatarUrl(identity) };
    }
    if (!identity?.startsWith("google:")) return null;
    const email = identity.slice(7);
    // A name the person picked themselves wins, then the invite list's, then their Google name.
    const custom = known[email]?.displayName;
    const name = custom || invites?.people.get(email) || invites?.hashed.get(hashEmail(email)) || known[email]?.name || email.split("@")[0];
    return { id: `g${sha256hex(email).slice(0, 16)}`, name, custom: Boolean(custom), googleName: known[email]?.name || "", avatar: avatarUrl(email) };
  }

  function members() {
    if (open) {
      // Everyone who's been around in the last two weeks (most recent first).
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      return Object.entries(known)
        .filter(([key, v]) => key.startsWith("guest:") && v.name && (v.lastSeen ?? 0) > cutoff)
        .sort((a, b) => (b[1].lastSeen ?? 0) - (a[1].lastSeen ?? 0))
        .slice(0, 150)
        .map(([key]) => profileFor(key));
    }
    if (!inviteOnly) {
      // Everyone who has ever signed in.
      return Object.keys(known)
        .filter(key => key.includes("@"))
        .slice(0, 2000)
        .map(email => profileFor(`google:${email}`));
    }
    const emails = new Set([...(invites?.people.keys() ?? []), ...extraEmails].filter(e => e !== "*"));
    for (const email of Object.keys(known)) if (isInvited(email)) emails.add(email);
    return [...emails].map(email => profileFor(`google:${email}`));
  }

  // --- Google sign-in ----------------------------------------------------------------

  function baseUrl(req) {
    return (publicUrl || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
  }

  const secureCookies = req => req.secure;

  function page(res, status, title, body) {
    res
      .status(status)
      .type("html")
      .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · bark</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08080a;color:#f4f4f6;font-family:-apple-system,BlinkMacSystemFont,"Inter Tight",sans-serif;text-align:center;padding:24px}
h1{font-size:26px;letter-spacing:-.03em;margin:0 0 10px}p{color:#a9a9b2;max-width:28rem;margin:6px auto;line-height:1.5}a{color:#f4f4f6}</style></head>
<body><div>${body}</div></body></html>`);
  }

  function mountRoutes(app) {
    app.get("/auth/google/start", (req, res) => {
      if (!enabled) return page(res, 503, "Not set up", "<h1>Sign-in isn't set up yet</h1><p>Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server.</p>");
      const nonce = randomBytes(16).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const statePayload = b64url(JSON.stringify({ n: nonce, r: safeReturn(req.query.return), a: req.query.app === "1", e: Date.now() + STATE_MS }));
      const state = `${statePayload}.${sign(statePayload)}`;
      res.cookie(STATE_COOKIE, `${nonce}.${verifier}`, { httpOnly: true, secure: secureCookies(req), sameSite: "lax", path: "/auth/google", maxAge: STATE_MS });
      const url = new URL(GOOGLE_AUTH_URL);
      url.search = new URLSearchParams({
        client_id: googleClientId,
        redirect_uri: `${baseUrl(req)}/auth/google/callback`,
        response_type: "code",
        scope: "openid email profile",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();
      res.redirect(302, url.toString());
    });

    app.get("/auth/google/callback", async (req, res) => {
      const fail = message => page(res, 400, "Sign-in failed", `<h1>Couldn't sign you in</h1><p>${escapeHtml(message)}</p><p><a href="/signin">Try again</a></p>`);
      if (!enabled) return fail("Sign-in isn't set up on this server.");
      if (req.query.error) return fail(req.query.error === "access_denied" ? "You cancelled the Google sign-in." : `Google said: ${req.query.error}`);

      // The state proves this sign-in started here, in this browser.
      const [statePayload, stateSig] = String(req.query.state ?? "").split(".");
      let state = null;
      try {
        if (statePayload && stateSig && timingSafeEqual(Buffer.from(sign(statePayload)), Buffer.from(stateSig))) {
          state = JSON.parse(Buffer.from(statePayload, "base64url").toString("utf8"));
        }
      } catch {}
      const [nonce, verifier] = String(parseCookies(req.headers.cookie)[STATE_COOKIE] ?? "").split(".");
      res.clearCookie(STATE_COOKIE, { path: "/auth/google" });
      if (!state || state.e < Date.now() || !nonce || state.n !== nonce || !verifier) {
        return fail("The sign-in link expired or was opened in a different browser. Please start again.");
      }

      let claims;
      try {
        const response = await fetch(GOOGLE_TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code: String(req.query.code ?? ""),
            client_id: googleClientId,
            client_secret: googleClientSecret,
            redirect_uri: `${baseUrl(req)}/auth/google/callback`,
            grant_type: "authorization_code",
            code_verifier: verifier,
          }),
          signal: AbortSignal.timeout(15000),
        });
        const body = await response.json();
        if (!response.ok || !body.id_token) throw new Error(body.error_description || body.error || `HTTP ${response.status}`);
        // Received straight from Google over HTTPS, so its contents can be trusted as-is.
        claims = JSON.parse(Buffer.from(body.id_token.split(".")[1], "base64url").toString("utf8"));
      } catch (error) {
        warn(`Google sign-in failed: ${error.message}`);
        return fail("Google didn't confirm the sign-in. Please try again.");
      }

      const email = normalizeEmail(claims.email);
      if (claims.aud !== googleClientId || !GOOGLE_ISSUERS.has(claims.iss) || claims.exp * 1000 < Date.now() || !email || claims.email_verified === false) {
        return fail("That Google account couldn't be verified.");
      }
      if (!isInvited(email)) {
        log(`Sign-in refused (not invited): ${email}`);
        return page(res, 403, "Not invited", `<h1>You're not on the list yet</h1><p><b>${escapeHtml(email)}</b> isn't invited to bark.</p><p>Ask the person who invited you to add this Google account, then try again.</p><p><a href="/auth/google/start${state.a ? "?app=1" : ""}">Use a different account</a></p>`);
      }

      remember(email, claims.name || email.split("@")[0]);
      const token = makeSession(email);
      log(`Signed in: ${email}${state.a ? " (Mac app)" : ""}`);
      if (state.a) {
        // Hand the session to the Mac app (it's waiting for this bark:// link).
        return res.redirect(302, `${APP_CALLBACK}?token=${encodeURIComponent(token)}`);
      }
      res.cookie(COOKIE, token, { httpOnly: true, secure: secureCookies(req), sameSite: "lax", path: "/", maxAge: SESSION_MS });
      res.redirect(302, state.r);
    });

    // Lets the Mac app check that its sign-in is still valid (and who it is).
    app.get("/auth/me", (req, res) => {
      res.set("Cache-Control", "no-store");
      const identity = identify(req);
      if (!identity) return res.status(401).json({ signedIn: false });
      const profile = profileFor(identity);
      res.json({ signedIn: true, id: profile.id, name: profile.name, email: identity.slice(7) });
    });

    app.all("/auth/signout", (req, res) => {
      res.clearCookie(COOKIE, { path: "/" });
      res.redirect(302, "/signin");
    });
  }

  /** Everyone can choose the name others see in Messages. Signed-in people can clear it to go
   *  back to their Google name. */
  function setName(identity, raw) {
    const name = String(raw ?? "")
      .replace(/[\u0000-\u001f<>]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 32);
    if (identity?.startsWith("guest:")) {
      if (!name) return false;
      known[identity] = { ...known[identity], name, lastSeen: Date.now() };
    } else if (identity?.startsWith("google:")) {
      const email = identity.slice(7);
      const { displayName, ...rest } = known[email] ?? {};
      known[email] = name ? { ...rest, displayName: name } : rest;
    } else {
      return false;
    }
    persist();
    return true;
  }

  /** Sets (or with null, removes) someone's profile picture file. Returns the old file name. */
  function setAvatar(identity, file) {
    const key = keyFor(identity);
    if (!key) return null;
    const old = known[key]?.avatar ?? null;
    const { avatar, ...rest } = known[key] ?? {};
    known[key] = file ? { ...rest, avatar: file } : rest;
    persist();
    return old;
  }

  function touch(identity) {
    const key = identity?.startsWith("guest:") ? identity : identity?.startsWith("google:") ? identity.slice(7) : null;
    if (!key) return;
    known[key] = { ...known[key], lastSeen: Date.now() };
    persist();
  }

  // Everything else needs a session. Open mode hands one out automatically.
  function middleware(req, res, next) {
    if (identify(req)) return next();
    if (open) {
      const token = makeSession(null, `guest:${randomBytes(12).toString("base64url")}`, GUEST_MS);
      res.cookie(COOKIE, token, { httpOnly: true, secure: secureCookies(req), sameSite: "lax", path: "/", maxAge: GUEST_MS });
      // Make this same request count as signed in too.
      req.headers.cookie = `${req.headers.cookie ? `${req.headers.cookie}; ` : ""}${COOKIE}=${token}`;
      return next();
    }
    if (!enabled) {
      return page(res, 503, "Not set up", "<h1>Sign-in isn't set up yet</h1><p>The owner needs to add Google sign-in to this server (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).</p>");
    }
    const wantsPage = req.method === "GET" && (req.headers.accept ?? "").includes("text/html");
    if (wantsPage) return res.redirect(302, `/signin?return=${encodeURIComponent(req.originalUrl)}`);
    res.status(401).type("text/plain").send("Sign in first.");
  }

  function allowsUpgrade(req) {
    return Boolean(identify(req));
  }

  return {
    enabled: open || enabled,
    open,
    setName,
    touch,
    start,
    stop: () => timer && clearInterval(timer),
    mountRoutes,
    middleware,
    allowsUpgrade,
    identify,
    tunnelKey,
    readTunnelKey,
    setAvatar,
    profileFor,
    members,
    stillValid,
    isInvited,
    onRefresh: listener => refreshListeners.add(listener),
  };
}
