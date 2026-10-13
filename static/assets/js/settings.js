(() => {
  const saved = document.getElementById("saved");
  let timer;

  function flash(text) {
    saved.textContent = text;
    clearTimeout(timer);
    timer = setTimeout(() => {
      saved.textContent = "";
    }, 2500);
  }

  function load() {
    for (const el of document.querySelectorAll("[data-setting]")) {
      el.value = store.get(el.dataset.setting) ?? "";
    }
  }

  for (const el of document.querySelectorAll("[data-setting]")) {
    el.addEventListener("change", () => {
      const key = el.dataset.setting;
      const value = el.value.trim();
      if (key === "wisp-url" && value && !/^wss?:\/\//i.test(value)) {
        flash("The Wisp server must start with wss:// or ws://");
        return;
      }
      if (value) store.set(key, value);
      else store.remove(key);
      // Proxy, transport and Wisp changes take effect on the next page load.
      flash(["proxy", "transport", "wisp-url"].includes(key) ? "Saved. Applies to pages you open from now on." : "Saved.");
    });
  }

  document.getElementById("reset").addEventListener("click", () => {
    store.clear();
    for (const [key, value] of Object.entries(window.SETTINGS_DEFAULTS)) store.set(key, value);
    load();
    flash("Settings reset.");
  });

  load();
})();
