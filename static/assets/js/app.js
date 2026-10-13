// Shared page setup: default settings and the app name.
(() => {
  // Safari / the bark Mac app (WebKit) works best with Ultraviolet; Chrome and Firefox with Scramjet.
  const isWebKit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent);
  const DEFAULTS = {
    proxy: isWebKit ? "uv" : "sj", // "sj" = Scramjet, "uv" = Ultraviolet
    transport: "epoxy", // "epoxy" or "libcurl"
    engine: "https://duckduckgo.com/?q=",
  };

  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (store.get(key) === null) store.set(key, value);
  }
  if (!["sj", "uv"].includes(store.get("proxy"))) store.set("proxy", DEFAULTS.proxy);

  window.SETTINGS_DEFAULTS = DEFAULTS;

  const appName = window.APP_CONFIG?.name || "bark";
  window.APP_NAME = appName;

  document.addEventListener("DOMContentLoaded", () => {
    for (const el of document.querySelectorAll("[data-app-name]")) el.textContent = appName;
    const pageTitle = document.body.dataset.title;
    document.title = pageTitle ? `${pageTitle} · ${appName}` : appName;
  });
})();
