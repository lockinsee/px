# bark server

The server behind the bark Mac app:

- **Messages** (`/chat`): channels, private one-on-one DMs, and voice/video calls.
- **Browser** (`/browse`): a web proxy. It loads websites on the server and streams them back.

People **sign in with Google**, and any Google account can get in. The Mac app signs in through
Apple's secure sign-in window and keeps the session; on the web it's a cookie. Optional:
`INVITE_ONLY=true` limits it to the invite list in `BARK_SITE/access.txt`, and
`REQUIRE_SIGN_IN=false` turns sign-in off entirely (anonymous guests pick a name).

## Run it

Needs a host that runs Node.js 18+ **and WebSockets**: Render, Koyeb, Fly.io, Railway, a VPS, or
your own computer. Shared/static web hosting (like the plan your bark website is on) can't run it.

```bash
cp .env.example .env      # then fill in the Google client ID/secret
pnpm install              # or: npm install
pnpm start                # http://localhost:8080
```

With Docker: `docker build -t bark-proxy . && docker run -p 8080:8080 --env-file .env bark-proxy`

Google sign-in setup (client ID and secret, redirect URI) is in the main bark README, step 2.
The redirect URI is this server's address + `/auth/google/callback`.

## Messages and calls

- People show up under their Google name. Everyone who signed in during the last month is in
  the people list, so you can DM them.
- Channels are listed in `config.js` (`chat.channels`). Everyone signed in can read them.
  DMs can only be read by the two people in them.
- Messages are saved in `DATA_DIR/chat.json` (default `./data`). **On Railway, add a Volume** to
  the service with mount path `/app/data`, or history is lost every time it redeploys.
- Messages are stored on your server and sent over HTTPS, but they are *not* end-to-end
  encrypted: whoever runs the server can read the saved file.
- Calls go directly between people (WebRTC, encrypted end to end). The server only helps them find
  each other. Up to 8 people per call; with that many, each person's upload is the limit.
- Some strict networks (some schools, offices and mobile carriers) block direct calls. If a call
  says "couldn't connect", add a TURN relay: set `TURN_URLS`, `TURN_USERNAME` and
  `TURN_CREDENTIAL` (from a TURN provider such as Cloudflare Calls, Twilio or a self-hosted coturn).

## Settings

`config.js`:

- `blockedSites`: domains the Browser refuses to open.
- `allowPrivateNetwork`: leave `false`. When true, people could use the Browser to reach the
  server's own network (localhost, 192.168.x.x, cloud metadata services).
- `filtering`: optional ad / tracker blocking (AdGuard DNS list) and Cloudflare's malware and
  adult-content filter.

Environment: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, optional `INVITE_ONLY`
(+ `BARK_SITE`, `ALLOWED_EMAILS`), `REQUIRE_SIGN_IN`, `PUBLIC_URL`, `PORT`, `DATA_DIR`, and for
calls on strict networks `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL`.

## Credits and license

Based on [Interstellar](https://github.com/UseInterstellar/Interstellar) by the Interstellar
Network, with games, ads, analytics and filter-evasion features removed. Proxying is done by
[Scramjet](https://github.com/MercuryWorkshop/scramjet),
[Ultraviolet](https://github.com/titaniumnetwork-dev/Ultraviolet) and
[wisp-js](https://github.com/MercuryWorkshop/wisp-js).

Licensed under the GNU Affero GPL v3 (see `LICENSE`), like the project it's based on. Because
people use it over the internet, the AGPL requires that they can get this source code, e.g. by
keeping the GitHub repo public or linking to it.
