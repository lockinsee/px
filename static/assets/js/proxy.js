// Proxy core: registers the service worker, connects the transport to the Wisp server, and turns
// what the user typed into a proxied URL. Needs storage.js, app.js, vendor.js and the Ultraviolet
// and Scramjet scripts loaded first.
(() => {
  const vendor = self.__deps;

  // Service worker

  let resolveSw;
  const swReady = new Promise(resolve => {
    resolveSw = resolve;
  });

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      console.error("Service workers are not available (the page must be served over HTTPS or from localhost).");
      return resolveSw();
    }
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/uv/" });
      const worker = registration.installing || registration.waiting;
      if (registration.active || !worker) return resolveSw();
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolveSw();
      });
    } catch (error) {
      console.error("Service worker registration failed:", error);
      resolveSw();
    }
  }

  // Transport (how the browser talks to the Wisp server)

  function wispUrl() {
    const custom = store.get("wisp-url")?.trim();
    if (custom && /^wss?:\/\//i.test(custom)) return custom;
    return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wisp/`;
  }

  // Wraps epoxy so Wisp "blocked" / "unreachable" closes become a header the service worker
  // turns into the blocked / not-found pages.
  function blockAwareEpoxy(transportPath) {
    return `
      const { default: EpoxyTransport } = await import(${JSON.stringify(transportPath)});
      class BlockAwareEpoxy extends EpoxyTransport {
        async request(...args) {
          try {
            return await super.request(...args);
          } catch (error) {
            const message = String(error?.message ?? error);
            const kind = message.includes("WispCloseReason(ServerStreamBlockedAddress") ? "blocked"
              : message.includes("WispCloseReason(ServerStreamUnreachable") ? "not-found" : null;
            if (!kind) throw error;
            return { status: 451, statusText: "Unavailable", headers: { "x-proxy-block": kind }, body: null };
          }
        }
      }
      return [BlockAwareEpoxy, ${JSON.stringify(transportPath)}];
    `;
  }

  async function ensureTransport(connection, transportPath, options, signature, manualCode) {
    let current = "";
    try {
      current = await connection.getTransport();
    } catch {}
    if (current === transportPath && sessionStorage.getItem("transport-signature") === signature) return;
    if (manualCode) await connection.setManualTransport(manualCode, options);
    else await connection.setTransport(transportPath, options);
    sessionStorage.setItem("transport-signature", signature);
  }

  let scramjet = null;

  async function initScramjet() {
    try {
      const { ScramjetController } = await window.$scramjetLoadController();
      const controller = new ScramjetController(self.__scramjet$config);
      await controller.init();
      scramjet = controller;
    } catch (error) {
      // Not fatal: encode() falls back to Ultraviolet.
      console.warn("Scramjet unavailable in this browser, using Ultraviolet:", error);
    }
  }

  async function init() {
    const { BareMuxConnection } = await import(vendor.baremux);
    await initScramjet();

    const wisp = wispUrl();
    const connection = new BareMuxConnection(vendor.baremuxWorker);
    if (store.get("transport") === "libcurl") {
      await ensureTransport(connection, vendor.libcurl, [{ websocket: wisp }], `${vendor.libcurl}|${wisp}`);
    } else {
      await ensureTransport(connection, vendor.epoxy, [{ wisp }], `${vendor.epoxy}|${wisp}|block-aware`, blockAwareEpoxy(vendor.epoxy));
    }
  }

  const domReady = document.readyState === "loading" ? new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, { once: true })) : Promise.resolve();

  const ready = domReady
    .then(() => Promise.all([registerServiceWorker(), swReady, init()]))
    .catch(error => console.error("Proxy failed to start:", error));

  // Waits for startup, but never longer than the timeout, so a slow transport can't hang the UI.
  function settled(timeout = 8000) {
    return Promise.race([ready, new Promise(resolve => setTimeout(resolve, timeout))]);
  }

  // URLs

  function looksLikeUrl(value) {
    return /^https?:\/\//i.test(value) || (/^[^\s]+\.[^\s]+$/.test(value) && !value.startsWith("."));
  }

  // Turns address-bar input into a full URL, or a search if it isn't one.
  function toTarget(raw) {
    const value = String(raw ?? "").trim();
    if (!value) return "";
    if (looksLikeUrl(value)) return /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return (store.get("engine") || window.SETTINGS_DEFAULTS.engine) + encodeURIComponent(value);
  }

  function useScramjet() {
    return store.get("proxy") === "sj" && scramjet;
  }

  function encode(url) {
    if (useScramjet()) return scramjet.encodeUrl(url);
    return `${__uv$config.prefix}${__uv$config.encodeUrl(url)}`;
  }

  // Reverses encode() for a URL loaded in a tab. Returns null for non-proxied URLs.
  function decode(href) {
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin) return null;
    const path = url.pathname + url.search + url.hash;
    if (path.startsWith(self.__scramjet$config.prefix)) return scramjet ? scramjet.decodeUrl(href) : null;
    if (path.startsWith(__uv$config.prefix)) return __uv$config.decodeUrl(path.slice(__uv$config.prefix.length));
    return null;
  }

  // Blocklist / filtering check done before loading a site, so we can show a friendly page.
  async function checkBlocked(url) {
    let host;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      host = parsed.hostname;
    } catch {
      return null;
    }
    try {
      const response = await fetch("/filter/verdict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host }),
      });
      if (!response.ok) return null;
      const verdict = await response.json();
      return verdict.blocked ? verdict : null;
    } catch {
      return null;
    }
  }

  function blockPageUrl(url, verdict) {
    return `/block.html#${encodeURIComponent(`${verdict.source}|${url}`)}`;
  }

  // Resolves a target URL to what a tab should load: the proxied URL, or the blocked page.
  async function resolve(target) {
    await settled();
    const verdict = await checkBlocked(target);
    if (verdict) return { src: blockPageUrl(target, verdict), blocked: true };
    return { src: encode(target), blocked: false };
  }

  window.proxy = { ready, settled, toTarget, encode, decode, resolve };
})();
