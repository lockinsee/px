// Home page search box. Opens the browser, or, when this page is a tab inside the browser,
// asks the browser to load the address in this same tab.
(() => {
  const form = document.getElementById("search-form");
  const input = document.getElementById("input");

  function owningBrowser() {
    try {
      const container = window.parent?.document?.getElementById("frames");
      return window.frameElement && container && window.frameElement.parentElement === container ? window.parent : null;
    } catch {
      return null;
    }
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;

    const browser = owningBrowser();
    if (browser) {
      browser.postMessage({ type: "proxy:navigate", value }, location.origin);
      return;
    }
    sessionStorage.setItem("open-url", window.proxy.toTarget(value));
    location.href = "/browse";
  });

  if (!owningBrowser()) input.focus();
})();
