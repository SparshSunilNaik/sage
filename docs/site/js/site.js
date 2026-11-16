/* SAGE site: theme toggle (remembered) and copy-to-clipboard buttons. No dependencies. */
(() => {
  const KEY = "sage-theme";
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  const store = {
    get() {
      try {
        return localStorage.getItem(KEY);
      } catch {
        return null;
      }
    },
    set(v) {
      try {
        localStorage.setItem(KEY, v);
      } catch {
        /* storage unavailable (private mode): the choice lasts for this page only */
      }
    },
  };

  const current = () => root.getAttribute("data-theme") || (media.matches ? "dark" : "light");

  const toggle = document.querySelector("[data-theme-toggle]");
  const label = () => {
    if (!toggle) return;
    const next = current() === "dark" ? "light" : "dark";
    toggle.textContent = `theme: ${current()}`;
    toggle.setAttribute("aria-label", `Switch to ${next} theme`);
  };
  if (toggle) {
    toggle.addEventListener("click", () => {
      const next = current() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      store.set(next);
      label();
    });
    media.addEventListener("change", label);
    label();
  }

  // Copy buttons on every code block marked data-copy.
  for (const block of document.querySelectorAll("[data-copy]")) {
    const pre = block.querySelector("pre");
    if (!pre) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = "copy";
    btn.setAttribute("aria-label", "Copy command to clipboard");
    btn.addEventListener("click", async () => {
      const text = pre.innerText.replace(/\n$/, "");
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "absolute";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
        area.remove();
      }
      btn.textContent = ok ? "copied" : "press ctrl+c";
      setTimeout(() => {
        btn.textContent = "copy";
      }, 1600);
    });
    block.appendChild(btn);
  }
})();
