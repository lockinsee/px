const config = {
  // Shown in the page title and header.
  name: "bark",

  // Sign in with Google (default). Set REQUIRE_SIGN_IN=false for no sign-in at all
  // (anonymous guests who pick a name in Messages).
  requireSignIn: process.env.REQUIRE_SIGN_IN !== "false",

  // false (default): any Google account can sign in.
  // true (INVITE_ONLY=true): only accounts on the invite list in BARK_SITE/access.txt.
  inviteOnly: process.env.INVITE_ONLY === "true",

  // Only used with INVITE_ONLY.
  // Your bark website. Its access.txt is the invite list: one "name: email@gmail.com" per line.
  // Remove a line and that person is signed out within 5 minutes.
  barkSite: process.env.BARK_SITE ?? "",

  // Google sign-in (from Google Cloud Console → APIs & Services → Credentials → OAuth client ID).
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  },

  // This server's public address, e.g. https://bark-proxy-production.up.railway.app. Google sends
  // people back to PUBLIC_URL/auth/google/callback. Worked out automatically if left empty.
  publicUrl: process.env.PUBLIC_URL ?? "",

  // Only used with INVITE_ONLY: extra invited emails besides access.txt, comma-separated
  // (e.g. your own, so you can't lock yourself out).
  allowedEmails: process.env.ALLOWED_EMAILS ?? "",

  // Signs sessions. Set it so people stay signed in when the server restarts.
  sessionSecret: process.env.SESSION_SECRET ?? "",

  // Domains the proxy refuses to open. Each entry also blocks its subdomains,
  // so "example.com" blocks example.com and www.example.com. Plain hostnames only.
  blockedSites: ["googletagmanager.com", "amazon-adsystem.com", "doubleclick.net", "analytics.google.com"],

  // Let proxied pages reach localhost and private network addresses (192.168.x.x, 10.x.x.x,
  // cloud metadata services, etc.) on the machine running the server. Keep this false unless you
  // are deliberately proxying to your own internal services and the instance is password protected.
  allowPrivateNetwork: false,

  // Messages. Channels everyone with an access code can see; DMs are always private to the two
  // people in them. History is saved in DATA_DIR (default ./data) - on Railway, attach a Volume
  // at /app/data so it survives redeploys.
  chat: {
    channels: ["general", "random"],
  },

  // Optional DNS filtering for the Browser.
  filtering: {
    enabled: false,
    cloudflareFamilies: false, // Block malware and adult sites via Cloudflare's family resolver.
    adblock: true, // AdGuard DNS ad list.
    blockTrackers: true, // AdGuard DNS tracker list.
  },
};

export default config;
