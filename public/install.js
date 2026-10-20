// Drop-in "install as app" support. Include with <script src="/install.js" defer></script> on every page.
// Registers the service worker and adds a small ⋮ menu (top-right) with an "Install app" entry:
//  - Android/desktop Chrome/Edge: opens the browser's install prompt.
//  - iOS Safari: shows the "Share → Add to Home Screen" steps (iOS has no install API).
//  - Already installed: no install entry is shown at all (nothing to do from the menu).
// Pages can add their own menu entries by setting window.pwaMenuItems before this runs, as a list of
// either { label, onClick, icon? } (a clickable action; icon is an optional inline SVG string) or
// { html } (non-interactive rich content, e.g. a profile summary — rendered first, above the
// install/action entries).
// The page's own header can reserve space for the button with a rule like
// `html.pwa-btn-visible .my-header { padding-right: 46px; }` — that class is only present while the
// button is actually shown.
(() => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let deferred = null;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; render(); });
  addEventListener('appinstalled', () => { deferred = null; render(); });

  const css = `
  .pwa-btn{position:fixed;z-index:20;top:calc(env(safe-area-inset-top) + 10px);right:10px;width:38px;height:38px;border-radius:50%;border:0;
    background:var(--line,rgba(127,127,127,.25));color:var(--text,#fff);font:700 20px/1 system-ui,sans-serif;cursor:pointer}
  .pwa-menu{position:fixed;z-index:21;top:calc(env(safe-area-inset-top) + 54px);right:10px;min-width:220px;max-width:calc(100vw - 20px);padding:6px;
    border-radius:14px;background:var(--card,#181c2f);color:var(--text,#eceffa);border:1px solid var(--line,#2a3050);box-shadow:0 10px 30px rgba(0,0,0,.4);
    font:500 .95rem system-ui,sans-serif}
  .pwa-menu[hidden]{display:none}
  .pwa-item{display:flex;align-items:center;gap:10px;width:100%;padding:12px 14px;border:0;border-radius:10px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
  .pwa-item:hover,.pwa-item:focus-visible{background:rgba(127,127,127,.18)}
  .pwa-item[disabled]{opacity:.6;cursor:default}
  .pwa-item-icon{flex:none;width:20px;height:20px;display:flex}
  .pwa-item-icon svg{width:100%;height:100%}
  .pwa-item.pwa-custom{cursor:default;border-bottom:1px solid var(--line,#2a3050);border-radius:0;margin-bottom:4px;padding-bottom:10px}
  .pwa-item.pwa-custom:hover{background:none}
  .pwa-note{padding:8px 14px 10px;font-size:.85rem;line-height:1.45;opacity:.85}`;

  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  const btn = document.createElement('button'); btn.className = 'pwa-btn'; btn.type = 'button';
  btn.textContent = '⋮'; btn.setAttribute('aria-label', 'Menu'); btn.setAttribute('aria-haspopup', 'true');
  const menu = document.createElement('div'); menu.className = 'pwa-menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
  document.body.append(btn, menu);

  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
  addEventListener('click', (e) => { if (!menu.contains(e.target) && e.target !== btn) close(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  function item(label, onClick, disabled, icon) {
    const b = document.createElement('button'); b.className = 'pwa-item'; b.type = 'button'; b.setAttribute('role', 'menuitem');
    if (icon) b.innerHTML = `<span class="pwa-item-icon">${icon}</span><span>${label}</span>`;
    else b.textContent = label;
    b.disabled = !!disabled; if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function note(text) {
    const n = document.createElement('div'); n.className = 'pwa-note'; n.textContent = text;
    return n;
  }

  const INSTALL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/></svg>';

  function render() {
    const extra = Array.isArray(window.pwaMenuItems) ? window.pwaMenuItems : [];
    const custom = extra.filter((x) => x.html);
    const actions = extra.filter((x) => !x.html);
    const hide = standalone && !extra.length;
    btn.hidden = hide;
    // lets the page reserve header space for the button only while it's actually shown
    document.documentElement.classList.toggle('pwa-btn-visible', !hide);
    if (hide) { close(); return; }

    menu.replaceChildren();
    for (const x of custom) {
      const div = document.createElement('div'); div.className = 'pwa-item pwa-custom'; div.setAttribute('role', 'presentation');
      div.innerHTML = x.html;
      menu.append(div);
    }

    if (!standalone) {
      if (deferred) {
        menu.append(item('Install app', async () => {
          close(); deferred.prompt(); await deferred.userChoice.catch(() => {}); deferred = null; render();
        }, false, INSTALL_ICON));
      } else if (ios) {
        const installBtn = item('Install app', () => {
          installBtn.disabled = true;
          installBtn.after(note('In Safari, tap the Share button, then “Add to Home Screen”.'));
        }, false, INSTALL_ICON);
        menu.append(installBtn);
      } else {
        menu.append(item('Install app', null, true, INSTALL_ICON),
          note('To install, open this page in Chrome (Android) or Safari (iPhone), then use this menu again.'));
      }
    }

    for (const x of actions) menu.append(item(x.label, () => { close(); x.onClick(); }, false, x.icon));
  }
  window.pwaRenderMenu = render;
  render();
})();
