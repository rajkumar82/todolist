// Drop-in "install as app" support. Include with <script src="/install.js" defer></script> on every page.
// Registers the service worker and adds a small ⋮ menu (top-right) with an "Install app" entry:
//  - Android/desktop Chrome/Edge: opens the browser's install prompt.
//  - iOS Safari: shows the "Share → Add to Home Screen" steps (iOS has no install API).
//  - Already installed: the entry says so, unless there are no other menu items, in which case the
//    whole button hides itself (nothing left to do from the menu). Menu styling uses the page's
//    --card/--text/--line vars when defined.
// Pages can add their own menu entries by setting window.pwaMenuItems = [{ label, onClick }] before this runs.
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
    background:rgba(15,18,32,.72);color:#fff;font:700 20px/1 system-ui,sans-serif;backdrop-filter:blur(6px);cursor:pointer}
  .pwa-menu{position:fixed;z-index:21;top:calc(env(safe-area-inset-top) + 54px);right:10px;min-width:220px;max-width:calc(100vw - 20px);padding:6px;
    border-radius:14px;background:var(--card,#181c2f);color:var(--text,#eceffa);border:1px solid var(--line,#2a3050);box-shadow:0 10px 30px rgba(0,0,0,.4);
    font:500 .95rem system-ui,sans-serif}
  .pwa-menu[hidden]{display:none}
  .pwa-item{display:block;width:100%;padding:12px 14px;border:0;border-radius:10px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
  .pwa-item:hover,.pwa-item:focus-visible{background:rgba(127,127,127,.18)}
  .pwa-item[disabled]{opacity:.6;cursor:default}
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

  function item(label, onClick, disabled) {
    const b = document.createElement('button'); b.className = 'pwa-item'; b.type = 'button'; b.setAttribute('role', 'menuitem');
    b.textContent = label; b.disabled = !!disabled; if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function note(text) {
    const n = document.createElement('div'); n.className = 'pwa-note'; n.textContent = text;
    return n;
  }

  function render() {
    const extra = Array.isArray(window.pwaMenuItems) ? window.pwaMenuItems : [];
    const hide = standalone && !extra.length;
    btn.hidden = hide;
    // lets the page reserve header space for the button only while it's actually shown
    document.documentElement.classList.toggle('pwa-btn-visible', !hide);
    if (hide) { close(); return; }

    menu.replaceChildren();
    if (standalone) {
      menu.append(item('✓ Installed as an app', null, true));
    } else if (deferred) {
      menu.append(item('📲 Install app', async () => {
        close(); deferred.prompt(); await deferred.userChoice.catch(() => {}); deferred = null; render();
      }));
    } else if (ios) {
      menu.append(item('📲 Install app', () => {
        menu.replaceChildren(item('📲 Install app', null, true), note('In Safari, tap the Share button, then “Add to Home Screen”.'));
      }));
    } else {
      menu.append(item('📲 Install app', null, true),
        note('To install, open this page in Chrome (Android) or Safari (iPhone), then use this menu again.'));
    }
    for (const x of extra) menu.append(item(x.label, () => { close(); x.onClick(); }));
  }
  window.pwaRenderMenu = render;
  render();
})();
