const config = {
  // Shown in the page title and header.
  name: "bark",

  // Your bark website (where access.txt lives). Anyone with a valid bark access code can sign in;
  // remove their line from access.txt and they're locked out within 5 minutes.
  barkSite: process.env.BARK_SITE ?? "",

  // Optional extra logins as "user:password,otheruser:otherpassword".
  authUsers: process.env.AUTH_USERS ?? "",

  // Signs session cookies. Set it so sign-ins survive restarts; otherwise a random one is used.
  sessionSecret: process.env.SESSION_SECRET ?? "",

  // Domains the proxy refuses to open. Each entry also blocks its subdomains,
  // so "example.com" blocks example.com and www.example.com. Plain hostnames only.
  blockedSites: ["googletagmanager.com", "amazon-adsystem.com", "doubleclick.net", "analytics.google.com"],

  // Let proxied pages reach localhost and private network addresses (192.168.x.x, 10.x.x.x,
  // cloud metadata services, etc.) on the machine running the server. Keep this false unless you
  // are deliberately proxying to your own internal services and the instance is password protected.
  allowPrivateNetwork: false,

  // Optional DNS filtering for proxied traffic.
  filtering: {
    enabled: false,
    cloudflareFamilies: false, // Block malware and adult sites via Cloudflare's family resolver.
    adblock: true, // AdGuard DNS ad list.
    blockTrackers: true, // AdGuard DNS tracker list.
  },
};

export default config;
