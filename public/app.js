(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
  };

  const NAME_RE = /^[a-z0-9_-]{1,32}$/;
  const user = decodeURIComponent(location.pathname).replace(/^\/+|\/+$/g, '').toLowerCase();
  const tz = new Date().getTimezoneOffset();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  // ---------------------------------------------------------------- welcome (no user in the URL)
  if (!NAME_RE.test(user)) {
    $('#welcome').hidden = false;
    const input = $('#welcomename');
    input.value = store.get('todo:last') || '';
    $('#welcomeform').onsubmit = (e) => {
      e.preventDefault();
      const name = input.value.trim().toLowerCase();
      if (!NAME_RE.test(name)) {
        $('#welcomeerr').textContent = 'Use 1-32 letters, digits, - or _';
        return;
      }
      location.href = `/${name}`;
    };
    input.focus();
    return;
  }

  store.set('todo:last', user);
  document.title = `Todo · ${user}`;
  $('#uname').textContent = user;
  $('#app').hidden = false;

  // ---------------------------------------------------------------- rating tiers
  const TIERS = [
    { min: 90, emoji: '🚀', label: 'Unstoppable', c1: '#7c4dff', c2: '#00d4ff', line: 'Nothing slows you down. Tasks get done before they are even due.' },
    { min: 75, emoji: '🔥', label: 'On fire', c1: '#ff6a00', c2: '#ffc233', line: 'You are crushing it. Keep the streak going.' },
    { min: 55, emoji: '⚡', label: 'Steady', c1: '#1a73e8', c2: '#37c8ff', line: 'A solid rhythm. A few more on-time finishes will light you up.' },
    { min: 35, emoji: '🌤️', label: 'Warming up', c1: '#f0a30a', c2: '#ffd86b', line: 'Things are moving. Pick one small task and finish it now.' },
    { min: 0, emoji: '🐢', label: 'Time to catch up', c1: '#7f88a0', c2: '#b3bccd', line: 'Slow and steady. Tackle the overdue ones first.' },
  ];
  const NO_TIER = { emoji: '🌱', label: 'Just getting started', c1: '#3ec46d', c2: '#a6f0c1', line: 'Finish a few tasks, or let some come due, and your rating shows up here.' };
  const tierOf = (score) => (score == null ? NO_TIER : TIERS.find((t) => score >= t.min));

  // ---------------------------------------------------------------- state
  let state = null; // what is on screen, including changes the server has not confirmed yet
  let confirmed = null; // the last answer from the server
  let tab = 'tasks';
  let listId = store.get(`todo:${user}:list`);
  let dueMs = null; // due date chosen in the add bar
  const seen = new Set(); // item ids already shown, so only new ones animate in
  const pendingDeletes = new Map(); // itemId -> { timer, listId, item, index }

  const curList = () => state.lists.find((l) => l.id === listId) || state.lists[0] || null;
  const selectList = (id) => { listId = id; store.set(`todo:${user}:list`, id); };

  // ---------------------------------------------------------------- server calls
  async function request(method, path, body, keepalive = false) {
    const res = await fetch(`/api/u/${user}${path}`, {
      method,
      keepalive,
      headers: { 'Content-Type': 'application/json', 'X-TZ-Offset': String(tz) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // Changes are applied on screen straight away and sent one at a time, in order. When the
  // queue is empty the server's answer replaces the screen (which also rolls back a failure).
  let inflight = 0;
  let chain = Promise.resolve();
  let failure = null;
  function send(method, path, body) {
    inflight++;
    chain = chain
      .then(async () => {
        try { confirmed = await request(method, path, body); } catch (err) { failure = err; }
      })
      .then(() => { if (--inflight === 0) settle(); });
  }
  function settle() {
    if (failure) {
      const offline = failure instanceof TypeError; // fetch() rejects with TypeError when the network is down
      toast(offline ? "You're offline. That change was not saved." : failure.message, { error: true });
      failure = null;
    }
    adopt(confirmed);
    render();
  }
  function adopt(data) {
    state = JSON.parse(JSON.stringify(data));
    for (const { listId: lid, item } of pendingDeletes.values()) {
      const l = state.lists.find((x) => x.id === lid);
      if (l) l.items = l.items.filter((i) => i.id !== item.id);
    }
  }

  // ---------------------------------------------------------------- formatting
  const DAY = 86400000;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  function fmtDue(ms) {
    const d = new Date(ms);
    const diff = Math.round((startOfDay(d) - startOfDay(new Date())) / DAY);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (diff === 0) return `Today, ${time}`;
    if (diff === 1) return `Tomorrow, ${time}`;
    if (diff === -1) return `Yesterday, ${time}`;
    return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
  }
  function fmtDuration(ms) {
    if (ms == null) return '–';
    const min = ms / 60000;
    if (min < 60) return `${Math.max(1, Math.round(min))} min`;
    if (min < 48 * 60) return `${Math.round(min / 60)} h`;
    return `${Math.round(min / 1440)} days`;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const toLocalInput = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const fromLocalInput = (v) => (v ? new Date(v).getTime() : null);

  // ---------------------------------------------------------------- render
  const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function itemHtml(it) {
    const isNew = !seen.has(it.id);
    seen.add(it.id);
    let due = '';
    if (it.dueAt != null) {
      const late = !it.done && it.dueAt < Date.now();
      const soon = !it.done && !late && it.dueAt - Date.now() < DAY;
      due = `<span class="due${late ? ' late' : soon ? ' soon' : ''}">${late ? '⚠ Overdue · ' : '🕒 '}${esc(fmtDue(it.dueAt))}</span>`;
    }
    return `<li class="item${it.done ? ' done' : ''}${isNew ? ' new' : ''}" data-id="${it.id}">
      <button class="check" data-toggle="${it.id}" role="checkbox" aria-checked="${it.done}" aria-label="${it.done ? 'Mark not done' : 'Mark done'}: ${esc(it.text)}"><i>${CHECK}</i></button>
      <button class="body" data-edit="${it.id}"><span class="txt">${esc(it.text)}</span>${due}</button>
    </li>`;
  }

  function tasksHtml() {
    const chips = state.lists.map((l) => {
      const open = l.items.filter((i) => !i.done).length;
      return `<button class="chip${l.id === curList().id ? ' on' : ''}" data-list="${l.id}"><span aria-hidden="true">${esc(l.emoji)}</span>${esc(l.name)}<span class="n">${open}</span></button>`;
    });
    const chipRow = `<div class="chips" id="chips">${state.lists.length ? chips.join('') : ''}<button class="chip new" data-newlist>＋ New list</button></div>`;

    const list = curList();
    if (!list) {
      return `${chipRow}<div class="empty"><span class="em">🗂️</span><b>No lists yet</b>Create one to start adding tasks.</div>`;
    }

    const open = list.items.filter((i) => !i.done).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.createdAt - b.createdAt);
    const done = list.items.filter((i) => i.done).sort((a, b) => b.completedAt - a.completedAt);
    const pct = list.items.length ? Math.round((done.length / list.items.length) * 100) : 0;
    const summary = !list.items.length ? 'Nothing here yet' : open.length ? `${open.length} to do · ${done.length} done` : 'All done 🎉';

    let body = '';
    if (!list.items.length) {
      body = `<div class="empty"><span class="em">${esc(list.emoji)}</span><b>${esc(list.name)} is empty</b>Add your first task below.</div>`;
    } else {
      if (open.length) body += `<ul class="items">${open.map(itemHtml).join('')}</ul>`;
      else body += `<div class="empty"><span class="em">🎉</span><b>Everything is done</b>Nice work. Add another task below.</div>`;
      if (done.length) body += `<div class="sep">Completed · ${done.length}</div><ul class="items">${done.map(itemHtml).join('')}</ul>`;
    }

    return `${chipRow}
      <div class="listhead"><span class="big" aria-hidden="true">${esc(list.emoji)}</span><h2>${esc(list.name)}</h2>
        <button class="iconbtn" data-editlist aria-label="Edit list">✏️</button></div>
      <div class="sub">${summary}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>${body}`;
  }

  function insightsHtml() {
    const s = state.stats;
    const t = tierOf(s.score);
    const message = s.score == null ? t.line : `${s.onTime} of ${s.due} tasks finished on time in the last 30 days.`;
    const target = s.score == null ? 0 : s.score;
    const R = 52;
    const C = 2 * Math.PI * R;
    let trend = '';
    if (s.trend != null && Math.abs(s.trend) >= 3) {
      trend = `<div class="trend ${s.trend > 0 ? 'up' : 'down'}">${s.trend > 0 ? '▲ Up' : '▼ Down'} from last week</div>`;
    }

    const rows = s.perList.map((l) => {
      const lt = tierOf(l.score);
      return `<div class="lrow" style="--c1:${lt.c1};--c2:${lt.c2}">
        <span class="nm">${esc(l.emoji)} ${esc(l.name)}</span>
        <span class="track"><i style="width:0" data-w="${l.score == null ? 0 : Math.max(4, l.score)}"></i></span>
        <span class="tg" title="${esc(lt.label)}">${lt.emoji}</span></div>`;
    }).join('');

    const install = installHtml();
    return `<section class="hero" style="--c1:${t.c1};--c2:${t.c2}">
        <div class="ringwrap">
          <svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
            <defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.c1}"/><stop offset="1" stop-color="${t.c2}"/></linearGradient></defs>
            <circle class="ring-bg" cx="60" cy="60" r="${R}"/>
            <circle class="ring-fg" cx="60" cy="60" r="${R}" stroke="url(#rg)" transform="rotate(-90 60 60)"
              stroke-dasharray="${C}" stroke-dashoffset="${C}" data-target="${C * (1 - target / 100)}"/>
          </svg>
          <div class="ringmid"><span>${t.emoji}</span></div>
        </div>
        <div class="tier">${esc(t.label)}</div>
        <p class="tier-line">${esc(message)}</p>${trend}
      </section>
      <div class="tiles">
        <div class="tile"><div class="v">${s.streak ? `🔥 ${s.streak}` : '0'}</div><div class="l">Day streak</div></div>
        <div class="tile"><div class="v">${esc(fmtDuration(s.medianMs))}</div><div class="l">Typical time to finish</div></div>
        <div class="tile"><div class="v">${s.openCount}</div><div class="l">Open tasks</div></div>
        <div class="tile${s.overdueCount ? ' warn' : ''}"><div class="v">${s.overdueCount}</div><div class="l">Overdue</div></div>
      </div>
      <div class="card"><h3>By list</h3>${rows || '<p class="fine">No lists yet.</p>'}
        <p class="fine">Your rating looks at the last 30 days: tasks finished vs. tasks that came due, how close to the deadline you finished them, and how many of the last 7 days you finished something. Tasks without a due time are judged against 3 days.</p></div>
      ${install}`;
  }

  // "Add to Home Screen": Chrome/Android can prompt directly, iOS needs the Share menu
  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; if (tab === 'insights') render(); });
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function installHtml() {
    if (standalone()) return '';
    if (installEvent) return `<div class="card" style="margin-top:12px"><h3>Install</h3><button class="primary" data-install style="width:100%">Add to Home Screen</button></div>`;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    return `<div class="card" style="margin-top:12px"><h3>Install</h3><p class="fine" style="margin:0">${ios
      ? 'Tap the Share button in Safari, then <b>Add to Home Screen</b>.'
      : 'Open your browser menu and choose <b>Install app</b> or <b>Add to Home screen</b>.'} It will open straight to your list.</p></div>`;
  }

  function render() {
    if (!state) return;
    const onTasks = tab === 'tasks';
    $('#app').classList.toggle('no-add', !onTasks);
    $('#addbar').hidden = !onTasks;
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));

    const t = tierOf(state.stats.score);
    $('#chip').innerHTML = `<span class="em">${t.emoji}</span>${esc(state.stats.score == null ? 'New' : t.label)}`;

    const view = $('#view');
    const chipScroll = $('#chips')?.scrollLeft || 0;
    view.innerHTML = onTasks ? tasksHtml() : insightsHtml();

    if (onTasks) {
      const chips = $('#chips');
      chips.scrollLeft = chipScroll;
      if (scrollToChip) { $('.chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest' }); scrollToChip = false; }
    } else {
      // start the ring and bars empty, force a layout so that state is really applied, then set the
      // target: the CSS transition animates between the two. (requestAnimationFrame is not used
      // because browsers pause it in background tabs, which would leave the ring empty.)
      const ring = $('.ring-fg');
      void view.offsetWidth;
      if (ring) ring.style.strokeDashoffset = ring.dataset.target;
      document.querySelectorAll('.track i').forEach((el) => { el.style.width = `${el.dataset.w}%`; });
    }
  }
  let scrollToChip = true;
  let renderTimer;
  const renderSoon = (ms = 420) => { clearTimeout(renderTimer); renderTimer = setTimeout(render, ms); }; // lets the tick animation finish

  // ---------------------------------------------------------------- toast
  let toastTimer;
  function toast(msg, { action, onAction, error = false, ms = 3500 } = {}) {
    const el = $('#toast');
    el.className = `toast${error ? ' err' : ''}`;
    el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
    el.hidden = false;
    if (action) el.querySelector('button').onclick = () => { el.hidden = true; onAction(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---------------------------------------------------------------- sheets
  const sheet = $('#sheet');
  const panel = sheet.querySelector('.sheet-panel');
  function openSheet(html) {
    panel.innerHTML = html;
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
    return panel;
  }
  function closeSheet() {
    sheet.hidden = true;
    panel.innerHTML = '';
    document.body.style.overflow = '';
  }
  sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });

  const EMOJIS = ['🏠', '💼', '👨‍👩‍👧', '🎉', '🛒', '💪', '📚', '✈️', '💡', '💰', '🎯', '🧹', '🍳', '🐶', '🎮', '❤️'];

  function listSheet(list) {
    let icon = list ? list.emoji : EMOJIS[0];
    const p = openSheet(`<form>
      <h3>${list ? 'Edit list' : 'New list'}</h3>
      <label class="field"><span>Name</span><input name="name" maxlength="40" placeholder="e.g. Groceries" value="${list ? esc(list.name) : ''}" autocomplete="off" required></label>
      <div class="emojis">${EMOJIS.map((e) => `<button type="button" class="${e === icon ? 'on' : ''}" data-emoji="${e}" aria-label="Icon ${e}">${e}</button>`).join('')}</div>
      <div class="btns">${list ? '<button type="button" class="danger" data-del>Delete</button>' : '<button type="button" data-close>Cancel</button>'}<button class="primary" type="submit">Save</button></div>
    </form>`);
    const input = p.querySelector('input');
    if (!list) setTimeout(() => input.focus(), 50);

    p.querySelector('.emojis').onclick = (e) => {
      const b = e.target.closest('[data-emoji]');
      if (!b) return;
      icon = b.dataset.emoji;
      p.querySelectorAll('.emojis button').forEach((x) => x.classList.toggle('on', x === b));
    };
    p.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      if (list) {
        const patch = {};
        if (name !== list.name) patch.name = list.name = name;
        if (icon !== list.emoji) patch.emoji = list.emoji = icon;
        if (Object.keys(patch).length) send('PATCH', `/lists/${list.id}`, patch);
      } else {
        const fresh = { id: uid(), name, emoji: icon, createdAt: Date.now(), items: [] };
        state.lists.push(fresh);
        selectList(fresh.id);
        scrollToChip = true;
        send('POST', '/lists', { id: fresh.id, name, emoji: icon });
      }
      closeSheet();
      render();
    };
    const del = p.querySelector('[data-del]');
    if (del) {
      del.onclick = () => {
        if (!del.classList.contains('sure')) { // two taps: the first one asks
          del.classList.add('sure');
          del.textContent = list.items.length ? `Delete list and ${list.items.length} task${list.items.length > 1 ? 's' : ''}?` : 'Tap again to delete';
          return;
        }
        state.lists = state.lists.filter((l) => l.id !== list.id);
        for (const [id, rec] of pendingDeletes) if (rec.listId === list.id) { clearTimeout(rec.timer); pendingDeletes.delete(id); }
        if (listId === list.id) selectList(state.lists[0]?.id ?? null);
        scrollToChip = true;
        send('DELETE', `/lists/${list.id}`);
        closeSheet();
        render();
      };
    }
  }

  function itemSheet(list, item) {
    const p = openSheet(`<form>
      <h3>Edit task</h3>
      <label class="field"><span>Task</span><input name="text" maxlength="200" value="${esc(item.text)}" autocomplete="off" required></label>
      <label class="field"><span>Due date and time</span><input name="due" type="datetime-local" value="${item.dueAt != null ? toLocalInput(item.dueAt) : ''}"></label>
      <div class="btns"><button type="button" data-cleardue>Clear due date</button></div>
      <div class="btns"><button type="button" class="danger" data-del>Delete</button><button class="primary" type="submit">Save</button></div>
    </form>`);
    const due = p.querySelector('[name=due]');
    p.querySelector('[data-cleardue]').onclick = () => { due.value = ''; };
    p.querySelector('[data-del]').onclick = () => { closeSheet(); deleteItem(list, item); };
    p.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const text = p.querySelector('[name=text]').value.trim();
      if (!text) return;
      const dueAt = fromLocalInput(due.value);
      const patch = {};
      if (text !== item.text) patch.text = item.text = text;
      if (dueAt !== item.dueAt) patch.dueAt = item.dueAt = dueAt;
      if (Object.keys(patch).length) send('PATCH', `/lists/${list.id}/items/${item.id}`, patch);
      closeSheet();
      render();
    };
  }

  // ---------------------------------------------------------------- actions
  function toggleItem(id, li) {
    const list = curList();
    const item = list.items.find((i) => i.id === id);
    if (!item) return;
    item.done = !item.done;
    item.completedAt = item.done ? Date.now() : null;
    send('PATCH', `/lists/${list.id}/items/${id}`, { done: item.done });
    navigator.vibrate?.(item.done ? 12 : 6);
    if (li) { // animate in place; the re-sort happens once the animation has played
      li.classList.toggle('done', item.done);
      li.querySelector('.check').setAttribute('aria-checked', String(item.done));
      renderSoon();
    } else render();
  }

  // Deleting an item is undoable for 5 seconds; the request is only sent once that has passed.
  function deleteItem(list, item) {
    const index = list.items.indexOf(item);
    if (index < 0) return;
    list.items.splice(index, 1);
    const rec = { listId: list.id, item, index, timer: setTimeout(() => flushDelete(item.id), 5000) };
    pendingDeletes.set(item.id, rec);
    render();
    toast('Task deleted', {
      action: 'Undo',
      ms: 5000,
      onAction: () => {
        clearTimeout(rec.timer);
        pendingDeletes.delete(item.id);
        const l = state.lists.find((x) => x.id === rec.listId);
        if (l) l.items.splice(Math.min(rec.index, l.items.length), 0, item);
        render();
      },
    });
  }
  function flushDelete(id) {
    const rec = pendingDeletes.get(id);
    if (!rec) return;
    clearTimeout(rec.timer);
    pendingDeletes.delete(id);
    if (state.lists.some((l) => l.id === rec.listId)) send('DELETE', `/lists/${rec.listId}/items/${id}`);
  }
  // closing the tab must not silently cancel a delete the user already saw happen
  addEventListener('pagehide', () => {
    for (const [id, rec] of pendingDeletes) request('DELETE', `/lists/${rec.listId}/items/${id}`, undefined, true).catch(() => {});
    pendingDeletes.clear();
  });

  // ---------------------------------------------------------------- events
  document.addEventListener('click', (e) => {
    const t = e.target;
    const tabBtn = t.closest('[data-tab]');
    if (tabBtn) { tab = tabBtn.dataset.tab; scrollToChip = true; render(); scrollTo(0, 0); return; }
    if (!state) return;

    const toggle = t.closest('[data-toggle]');
    if (toggle) return toggleItem(toggle.dataset.toggle, toggle.closest('.item'));

    const edit = t.closest('[data-edit]');
    if (edit) {
      const list = curList();
      const item = list.items.find((i) => i.id === edit.dataset.edit);
      if (item) itemSheet(list, item);
      return;
    }
    const chip = t.closest('[data-list]');
    if (chip) { selectList(chip.dataset.list); scrollToChip = true; render(); return; }
    if (t.closest('[data-newlist]')) return listSheet(null);
    if (t.closest('[data-editlist]')) return listSheet(curList());
    if (t.closest('[data-install]') && installEvent) {
      installEvent.prompt();
      installEvent = null;
    }
  });

  // add bar
  const dueInput = $('#due');
  const syncDue = () => {
    $('#duepill').hidden = dueMs == null;
    if (dueMs != null) $('#duetext').textContent = `🕒 ${fmtDue(dueMs)}`;
  };
  dueInput.addEventListener('click', () => { try { dueInput.showPicker(); } catch { /* not supported: the tap opens the native picker itself */ } });
  dueInput.addEventListener('change', () => { dueMs = fromLocalInput(dueInput.value); syncDue(); });
  $('#dueclear').onclick = () => { dueMs = null; dueInput.value = ''; syncDue(); };

  $('#addbar').onsubmit = (e) => {
    e.preventDefault();
    const field = $('#newtext');
    const text = field.value.trim();
    if (!text || !state) return;
    const list = curList();
    if (!list) return toast('Create a list first', {});
    const item = { id: uid(), text, done: false, createdAt: Date.now(), dueAt: dueMs, completedAt: null };
    list.items.push(item);
    send('POST', `/lists/${list.id}/items`, { id: item.id, text, dueAt: item.dueAt });
    field.value = '';
    dueMs = null;
    dueInput.value = '';
    syncDue();
    render();
    document.querySelector(`[data-id="${item.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    field.focus(); // keep the keyboard up for the next task
  };

  // ---------------------------------------------------------------- start
  async function load() {
    $('#view').innerHTML = '<div class="empty"><span class="em">⏳</span>Loading…</div>';
    try {
      confirmed = await request('GET', '');
      adopt(confirmed);
      if (!state.lists.some((l) => l.id === listId)) selectList(state.lists[0]?.id ?? null);
      render();
    } catch (err) {
      $('#view').innerHTML = `<div class="empty"><span class="em">📡</span><b>Couldn't load your lists</b>${esc(err.message)}<br><br><button class="primary" id="retry" style="width:auto">Try again</button></div>`;
      $('#retry').onclick = load;
    }
  }
  load();

  // refresh when the app comes back to the foreground (e.g. edited on another device)
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !state || inflight || pendingDeletes.size || !sheet.hidden) return;
    try {
      const data = await request('GET', '');
      if (!inflight) { confirmed = data; adopt(data); render(); }
    } catch { /* offline: keep what is on screen */ }
  });
})();
