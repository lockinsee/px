// Tiny settings store kept in localStorage as plain JSON.
(() => {
  const KEY = "settings";
  let data = {};

  function load() {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) || "{}");
      data = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      data = {};
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {}
  }

  load();
  window.addEventListener("storage", event => {
    if (event.key === KEY || event.key === null) load();
  });

  window.store = {
    get(field) {
      return Object.hasOwn(data, field) ? data[field] : null;
    },
    set(field, value) {
      load();
      data[field] = String(value);
      save();
    },
    remove(field) {
      load();
      delete data[field];
      save();
    },
    clear() {
      data = {};
      save();
    },
  };
})();
