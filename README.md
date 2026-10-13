# bark proxy

The server behind the **Browser** in the bark Mac app. It loads websites for you on the server and
streams them back, so the Browser can open any site from inside bark.

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

## Settings

`config.js`:

- `blockedSites`: domains the Browser refuses to open.
- `allowPrivateNetwork`: leave `false`. When true, people could use the Browser to reach the
  server's own network (localhost, 192.168.x.x, cloud metadata services).
- `filtering`: optional ad / tracker blocking (AdGuard DNS list) and Cloudflare's malware and
  adult-content filter.

Environment: `BARK_SITE`, `SESSION_SECRET`, optional `AUTH_USERS` (`user:password,…`), `PORT`.

## Credits and license

Based on [Interstellar](https://github.com/UseInterstellar/Interstellar) by the Interstellar
Network, with games, ads, analytics and filter-evasion features removed. Proxying is done by
[Scramjet](https://github.com/MercuryWorkshop/scramjet),
[Ultraviolet](https://github.com/titaniumnetwork-dev/Ultraviolet) and
[wisp-js](https://github.com/MercuryWorkshop/wisp-js).

Licensed under GPL-3.0-or-later (see `LICENSE`), like the project it's based on. If you give the
proxy to other people, the GPL requires you to offer them this source code too.
