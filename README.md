# bark server

The server behind the bark Mac app:

- **Messages** (`/chat`): channels, private one-on-one DMs, and voice/video calls.
- **Browser** (`/browse`): a web proxy. It loads websites on the server and streams them back.

Sign-in uses **bark access codes**: the server reads `access.txt` from your bark website, the same
list the Mac app uses. Remove someone's line and they lose the Browser within 5 minutes too. The
Mac app signs in for you, and in a normal web browser you can sign in with any username and your
access code as the password.

## Run it

Needs a host that runs Node.js 18+ **and WebSockets**: Render, Koyeb, Fly.io, Railway, a VPS, or
your own computer. Shared/static web hosting (like the plan your bark website is on) can't run it.

```bash
cp .env.example .env      # then set BARK_SITE to your bark website
pnpm install              # or: npm install
pnpm start                # http://localhost:8080
```

With Docker: `docker build -t bark-proxy . && docker run -p 8080:8080 --env-file .env bark-proxy`

On Render, the included `render.yaml` sets it up; just fill in `BARK_SITE`.

Then tell the Mac app where it is: put the server's address in `website/proxy.txt` and upload it
(see the main bark README).

## Messages and calls

- Everyone with a bark access code can sign in. Their name is the one next to their code in
  `access.txt` (e.g. `sam: …` shows up as "sam"). Remove the line and they're signed out within
  5 minutes.
- Channels are listed in `config.js` (`chat.channels`). Everyone with a code can read them.
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

Environment: `BARK_SITE`, `SESSION_SECRET`, optional `AUTH_USERS` (`user:password,…`), `PORT`,
`DATA_DIR`, and for calls on strict networks `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL`.

## Credits and license

Based on [Interstellar](https://github.com/UseInterstellar/Interstellar) by the Interstellar
Network, with games, ads, analytics and filter-evasion features removed. Proxying is done by
[Scramjet](https://github.com/MercuryWorkshop/scramjet),
[Ultraviolet](https://github.com/titaniumnetwork-dev/Ultraviolet) and
[wisp-js](https://github.com/MercuryWorkshop/wisp-js).

Licensed under the GNU Affero GPL v3 (see `LICENSE`), like the project it's based on. Because
people use it over the internet, the AGPL requires that they can get this source code, e.g. by
keeping the GitHub repo public or linking to it.
