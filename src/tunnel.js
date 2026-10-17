// The bark tunnel: a small HTTP CONNECT proxy for the bark Mac app.
//
// The Mac app (macOS 14 or later) sends all traffic of its sidebar apps (TikTok, Instagram, …)
// through here. Sites run exactly as in Safari, so sign-ins, cookies and age checks work, but
// they only ever see this server's address. The connection to each site stays encrypted end to
// end (HTTPS inside the tunnel), so this server only relays bytes and can't read them.
//
// Only signed-in bark users can use it (a per-person key, see /auth/tunnel), only web ports
// 80 and 443 are allowed, and it never connects to private or internal addresses.
import dns from "node:dns/promises";
import net from "node:net";

const ALLOWED_PORTS = new Set([80, 443]);
const HEADER_LIMIT = 16 * 1024;
const HANDSHAKE_MS = 15_000;
const IDLE_MS = 10 * 60_000;
// Caps so one person (or a runaway page) can't exhaust the server's connections.
const MAX_PER_PERSON = 300;
const MAX_TOTAL = 4000;

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

function reply(socket, status, extra = "") {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
}

export function startTunnel({ port, readKey, allowPrivate = false, log = console.log }) {
  let open = 0;
  const perPerson = new Map();

  const server = net.createServer(client => {
    client.setNoDelay(true);
    client.setTimeout(HANDSHAKE_MS, () => client.destroy());
    client.on("error", () => {});

    let head = Buffer.alloc(0);
    const onData = chunk => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > HEADER_LIMIT) {
          client.off("data", onData);
          reply(client, "431 Request Header Fields Too Large");
        }
        return;
      }
      client.off("data", onData);
      client.pause();
      handle(client, head.subarray(0, end).toString("latin1"), head.subarray(end + 4)).catch(() => client.destroy());
    };
    client.on("data", onData);
  });

  async function handle(client, header, rest) {
    const [requestLine, ...lines] = header.split("\r\n");
    const [method, target] = requestLine.split(" ");
    if (method !== "CONNECT") return reply(client, "405 Method Not Allowed", "Allow: CONNECT\r\n");

    // Sign-in: Basic auth whose password is the person's tunnel key.
    const auth = lines.find(l => /^proxy-authorization:/i.test(l))?.split(":").slice(1).join(":").trim() ?? "";
    const basic = /^basic\s+(.+)$/i.exec(auth)?.[1];
    const password = basic ? Buffer.from(basic, "base64").toString("utf8").split(":").slice(1).join(":") : "";
    const identity = password ? readKey(password) : null;
    if (!identity) return reply(client, "407 Proxy Authentication Required", 'Proxy-Authenticate: Basic realm="bark"\r\n');
    if (open >= MAX_TOTAL || (perPerson.get(identity) ?? 0) >= MAX_PER_PERSON) return reply(client, "503 Service Unavailable", "Retry-After: 5\r\n");

    const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target ?? "");
    const host = match?.[1]?.toLowerCase();
    const targetPort = Number(match?.[2]);
    if (!host || !ALLOWED_PORTS.has(targetPort)) return reply(client, "403 Forbidden");

    // Resolve once and connect to that exact address, so a name can't be pointed at an
    // internal address between the check and the connection.
    let address;
    try {
      address = net.isIP(host) ? host : (await dns.lookup(host, { verbatim: true })).address;
    } catch {
      return reply(client, "502 Bad Gateway");
    }
    if (!allowPrivate && isPrivateAddress(address)) return reply(client, "403 Forbidden");

    const upstream = net.connect({ host: address, port: targetPort });
    upstream.setNoDelay(true);
    const fail = () => {
      if (!client.headersSent) reply(client, "502 Bad Gateway");
      upstream.destroy();
    };
    upstream.once("error", fail);
    upstream.setTimeout(HANDSHAKE_MS, fail);

    upstream.once("connect", () => {
      upstream.off("error", fail);
      upstream.setTimeout(IDLE_MS, () => upstream.destroy());
      client.setTimeout(IDLE_MS, () => client.destroy());
      client.headersSent = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length) upstream.write(rest);
      open++;
      perPerson.set(identity, (perPerson.get(identity) ?? 0) + 1);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
      const done = () => {
        client.destroy();
        upstream.destroy();
      };
      client.once("close", done);
      upstream.once("close", () => {
        open = Math.max(0, open - 1);
        const left = (perPerson.get(identity) ?? 1) - 1;
        if (left > 0) perPerson.set(identity, left);
        else perPerson.delete(identity);
        done();
      });
      upstream.on("error", done);
    });
  }

  server.on("error", error => log(`Tunnel error: ${error.message}`));
  server.listen(port, () => log(`Tunnel for the Mac app listening on port ${port}`));
  return { server, connections: () => open, close: () => server.close() };
}
