(() => {
  const REASONS = {
    families: "Cloudflare's family filter lists this site for malware or adult content.",
    ads: "This site is on the AdGuard ad filter.",
    trackers: "This site is on the AdGuard tracking filter.",
    blocklist: "This site is on this server's blocklist.",
  };

  function fill() {
    const info = decodeURIComponent(location.hash.slice(1));
    const split = info.indexOf("|");
    const source = split === -1 ? "" : info.slice(0, split);
    let host = split === -1 ? "" : info.slice(split + 1);
    try {
      host = new URL(host).hostname || host;
    } catch {}
    document.getElementById("what").textContent = `${host || "This site"} can't be opened through this server.`;
    document.getElementById("why").textContent = REASONS[source] ?? "This site is blocked on this server.";
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fill);
  else fill();
  window.addEventListener("hashchange", fill);
})();
