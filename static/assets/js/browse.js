// Tabbed browser. Each tab is an iframe that loads a proxied URL.
(() => {
  const HOME = "/";
  const INTERNAL = {
    "/": { title: "New tab", display: "" },
    "/settings": { title: "Settings", display: "about:settings" },
  };

  const tabList = document.getElementById("tabs");
  const frames = document.getElementById("frames");
  const form = document.getElementById("address-form");
  const address = document.getElementById("address");
  let nextId = 1;

  const activeFrame = () => frames.querySelector("iframe.active");
  const tabFor = frame => tabList.querySelector(`[data-id="${frame.dataset.id}"]`);
  const frameFor = tab => frames.querySelector(`iframe[data-id="${tab.dataset.id}"]`);

  function frameHref(frame) {
    try {
      return frame.contentWindow.location.href;
    } catch {
      return null;
    }
  }

  function internalPage(href) {
    try {
      const url = new URL(href, location.origin);
      return url.origin === location.origin ? (INTERNAL[url.pathname] ?? null) : null;
    } catch {
      return null;
    }
  }

  // What the address bar should show for a frame: the real site URL, not the proxied one.
  function displayUrl(frame) {
    if (frame.dataset.blockedUrl) return frame.dataset.blockedUrl;
    const href = frameHref(frame);
    if (!href || href === "about:blank") return frame.dataset.target || "";
    const page = internalPage(href);
    if (page) return page.display;
    const url = new URL(href);
    if (url.pathname === "/block.html" || url.pathname === "/not-found.html") {
      const info = decodeURIComponent(url.hash.slice(1));
      return info.slice(info.indexOf("|") + 1);
    }
    try {
      return window.proxy.decode(href) ?? href;
    } catch {
      return href;
    }
  }

  function refreshAddress() {
    const frame = activeFrame();
    if (!frame || document.activeElement === address) return;
    address.value = displayUrl(frame);
  }

  function setTitle(frame) {
    const tab = tabFor(frame);
    if (!tab) return;
    const href = frameHref(frame);
    const page = href ? internalPage(href) : null;
    let title = page?.title;
    if (!title) {
      try {
        title = frame.contentDocument?.title;
      } catch {}
    }
    title = title?.trim() || displayUrl(frame) || "New tab";
    tab.querySelector(".tab-title").textContent = title;
    tab.title = title;
  }

  async function navigate(frame, target) {
    if (!target) return;
    frame.dataset.target = target;
    if (frame === activeFrame()) address.value = target;
    const { src, blocked } = await window.proxy.resolve(target);
    if (blocked) frame.dataset.blockedUrl = target;
    else delete frame.dataset.blockedUrl;
    frame.src = src;
  }

  function activate(frame) {
    for (const el of tabList.querySelectorAll(".tab")) el.classList.remove("active");
    for (const el of frames.querySelectorAll("iframe")) el.classList.remove("active");
    frame.classList.add("active");
    tabFor(frame)?.classList.add("active");
    refreshAddress();
  }

  // Pages often open links with target="_top" or window.open; send those to a new tab instead
  // of letting them replace the whole browser.
  function hookFrame(frame) {
    let win;
    let doc;
    try {
      win = frame.contentWindow;
      doc = frame.contentDocument;
      if (!win || !doc) return;
    } catch {
      return;
    }

    win.open = url => {
      const target = url && url !== "about:blank" ? new URL(url, doc.baseURI).href : null;
      openTab(target ? (window.proxy.decode(target) ?? target) : null);
      return null;
    };

    const onTopNavigation = event => {
      const isSubmit = event.type === "submit";
      const source = isSubmit ? event.target : event.target?.closest?.("a[target], area[target]");
      if (source?.target?.toLowerCase() !== "_top") return;
      let destination;
      if (isSubmit) {
        if ((source.method || "get").toLowerCase() !== "get") {
          source.target = "_self";
          return;
        }
        const action = new URL(source.action, source.ownerDocument.baseURI);
        action.search = new URLSearchParams(new FormData(source)).toString();
        destination = action.href;
      } else {
        destination = source.href;
      }
      if (!destination) return;
      event.preventDefault();
      openTab(window.proxy.decode(destination) ?? destination);
    };
    doc.addEventListener("click", onTopNavigation, true);
    doc.addEventListener("submit", onTopNavigation, true);
  }

  function openTab(target = null) {
    const id = String(nextId++);

    const tab = document.createElement("li");
    tab.className = "tab";
    tab.dataset.id = id;
    tab.innerHTML = '<span class="tab-title">New tab</span><button class="tab-close" type="button" aria-label="Close tab">&times;</button>';
    tab.addEventListener("click", () => activate(frameFor(tab)));
    tab.addEventListener("auxclick", event => {
      if (event.button === 1) closeTab(tab);
    });
    tab.querySelector(".tab-close").addEventListener("click", event => {
      event.stopPropagation();
      closeTab(tab);
    });
    tabList.appendChild(tab);

    const frame = document.createElement("iframe");
    frame.dataset.id = id;
    frame.setAttribute("allow", "fullscreen; clipboard-read; clipboard-write; autoplay; encrypted-media; picture-in-picture");
    frame.sandbox = "allow-same-origin allow-scripts allow-forms allow-popups allow-pointer-lock allow-modals allow-orientation-lock allow-presentation allow-downloads allow-storage-access-by-user-activation";
    frame.addEventListener("load", () => {
      hookFrame(frame);
      setTitle(frame);
      if (frame === activeFrame()) refreshAddress();
    });
    frames.appendChild(frame);
    activate(frame);

    if (target) navigate(frame, target);
    else {
      frame.src = HOME;
      address.value = "";
      address.focus();
    }
    return frame;
  }

  function closeTab(tab) {
    const frame = frameFor(tab);
    const wasActive = tab.classList.contains("active");
    const neighbour = tab.nextElementSibling || tab.previousElementSibling;
    tab.remove();
    frame?.remove();
    if (!tabList.children.length) {
      openTab();
      return;
    }
    if (wasActive && neighbour) activate(frameFor(neighbour));
  }

  // Toolbar

  function withActive(fn) {
    const frame = activeFrame();
    if (!frame) return;
    try {
      fn(frame);
    } catch (error) {
      console.error(error);
    }
  }

  const actions = {
    back: () => withActive(frame => frame.contentWindow.history.back()),
    forward: () => withActive(frame => frame.contentWindow.history.forward()),
    reload: () => withActive(frame => frame.contentWindow.location.reload()),
    home: () =>
      withActive(frame => {
        delete frame.dataset.blockedUrl;
        delete frame.dataset.target;
        frame.src = HOME;
      }),
    "new-tab": () => openTab(),
    popout: () => withActive(frame => window.open(frame.src, "_blank", "noopener")),
    fullscreen: () => withActive(frame => frame.requestFullscreen()),
    devtools: () =>
      withActive(frame => {
        const win = frame.contentWindow;
        if (win.eruda) {
          win.eruda._isInit ? win.eruda.destroy() : win.eruda.init();
          return;
        }
        const script = frame.contentDocument.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/eruda@3.4.1/eruda.min.js";
        script.onload = () => {
          win.eruda.init();
          win.eruda.show();
        };
        frame.contentDocument.head.appendChild(script);
      }),
    settings: () => withActive(frame => navigateInternal(frame, "/settings")),
  };

  function navigateInternal(frame, path) {
    delete frame.dataset.blockedUrl;
    delete frame.dataset.target;
    frame.src = path;
  }

  for (const button of document.querySelectorAll("[data-action]")) {
    button.addEventListener("click", () => actions[button.dataset.action]?.());
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    const value = address.value.trim();
    if (!value) return;
    if (value === "about:settings") return actions.settings();
    const frame = activeFrame();
    if (frame) navigate(frame, window.proxy.toTarget(value));
    address.blur();
  });

  address.addEventListener("focus", () => address.select());
  address.addEventListener("blur", refreshAddress);

  // The home page inside a tab asks us to navigate that tab.
  window.addEventListener("message", event => {
    const data = event.data;
    if (event.origin !== location.origin || data?.type !== "proxy:navigate") return;
    const frame = [...frames.querySelectorAll("iframe")].find(f => f.contentWindow === event.source);
    if (frame) navigate(frame, window.proxy.toTarget(data.value));
  });

  // Keyboard shortcuts (work while focus is on the browser chrome).
  document.addEventListener("keydown", event => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.altKey && event.key.toLowerCase() === "t") {
      event.preventDefault();
      openTab();
    } else if (mod && event.key.toLowerCase() === "l") {
      event.preventDefault();
      address.focus();
    }
  });

  // SPA navigations inside a page don't fire "load", so poll the active tab's URL and title.
  setInterval(() => {
    const frame = activeFrame();
    if (!frame) return;
    refreshAddress();
    setTitle(frame);
  }, 1000);

  const initial = sessionStorage.getItem("open-url");
  sessionStorage.removeItem("open-url");
  openTab(initial);
})();
