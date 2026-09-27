// Turns recurring habit templates (doc.recurring) into individual occurrence items, and drops
// completed items out of the live list once they are old enough that they no longer need to be
// shown. Both are pure functions of (doc, now, tz) so they can be unit tested without a server;
// the caller (server.js) persists whatever they mutate and logs the events they push.

const DAY = 86400000;
const LOOKBACK_DAYS = 30; // never backfill a habit further back than this, even after a long pause
const ARCHIVE_AFTER_DAYS = 7; // a completed item drops out of the live list this many days after completion

// Local calendar day number: an integer that increases by 1 each local day, independent of the
// server's own timezone. `tz` is Date.getTimezoneOffset()-style minutes behind UTC (the same
// convention score.js already uses for the efficiency rating's streaks).
const dayNumOf = (ms, tz) => Math.floor((ms - tz * 60000) / DAY);
function partsFromDayNum(n) {
  const d = new Date(n * DAY);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate(), wd: ((d.getUTCDay() + 6) % 7) + 1 }; // wd: Mon=1..Sun=7
}
const dayNumForYMD = (y, m, day) => Math.floor(Date.UTC(y, m - 1, day) / DAY);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (p) => `${p.y}-${pad(p.m)}-${pad(p.day)}`;

// Epoch ms for a given local day number at an optional "HH:MM" local time (default: end of day).
function msAt(dayNum, time, tz) {
  const [hh, mm] = time ? time.split(':').map(Number) : [23, 59];
  return dayNum * DAY + hh * 3600000 + mm * 60000 + tz * 60000;
}

function addOccurrence(list, r, dueAtMs, period, events, newId) {
  const item = { id: newId(), text: r.text, done: false, createdAt: Date.now(), dueAt: dueAtMs, completedAt: null, recurringId: r.id, period };
  list.items.push(item);
  events.push({ action: 'item.add', listId: list.id, list: list.name, itemId: item.id, text: item.text, dueAt: dueAtMs, recurringId: r.id });
}

// Create any occurrence items that should exist by `now` but don't yet, for every active template.
// Idempotent: each template tracks its own generation cursor (lastGeneratedDay / lastGeneratedMonth),
// so this never depends on which occurrence items are still present (older ones may have been archived).
function generateRecurring(doc, events, now, tz, newId) {
  let changed = false;
  const todayNum = dayNumOf(now, tz);
  const floorNum = todayNum - LOOKBACK_DAYS;

  for (const r of doc.recurring || []) {
    if (!r.active) continue;
    const list = doc.lists.find((l) => l.id === r.listId);
    if (!list) continue; // its list was deleted; list.delete already removes the template itself

    if (r.freq === 'weekly') {
      const createdNum = dayNumOf(r.createdAt, tz);
      const cursor = Math.max(r.lastGeneratedDay != null ? r.lastGeneratedDay + 1 : createdNum, floorNum);
      for (let n = cursor; n <= todayNum; n++) {
        const p = partsFromDayNum(n);
        if (!r.daysOfWeek.includes(p.wd)) continue;
        addOccurrence(list, r, msAt(n, r.time, tz), dateKey(p), events, newId);
        r.lastGeneratedDay = n;
        changed = true;
      }
    } else { // monthly
      const ymOf = (n) => { const p = partsFromDayNum(n); return p.y * 12 + (p.m - 1); };
      const createdYM = ymOf(dayNumOf(r.createdAt, tz));
      const floorYM = ymOf(floorNum);
      const todayYM = ymOf(todayNum);
      const startYM = Math.max(r.lastGeneratedMonth != null ? r.lastGeneratedMonth + 1 : createdYM, floorYM, createdYM);
      for (let ym = startYM; ym <= todayYM; ym++) {
        const y = Math.floor(ym / 12);
        const m = (ym % 12) + 1;
        const dom = Math.min(r.dayOfMonth, daysInMonth(y, m));
        addOccurrence(list, r, msAt(dayNumForYMD(y, m, dom), r.time, tz), `${y}-${pad(m)}`, events, newId);
        r.lastGeneratedMonth = ym;
        changed = true;
      }
    }
  }
  return changed;
}

// Drop completed items that have aged out of the visible window. They are already permanently
// recorded in the history log at the time they were completed, so nothing is lost.
function archiveCompleted(doc, now) {
  let changed = false;
  const cutoff = now - ARCHIVE_AFTER_DAYS * DAY;
  for (const list of doc.lists) {
    const before = list.items.length;
    list.items = list.items.filter((i) => !(i.done && i.completedAt != null && i.completedAt <= cutoff));
    if (list.items.length !== before) changed = true;
  }
  return changed;
}

function runHousekeeping(doc, events, now, tz, newId) {
  const generated = generateRecurring(doc, events, now, tz, newId);
  const archived = archiveCompleted(doc, now);
  return generated || archived;
}

module.exports = {
  runHousekeeping, generateRecurring, archiveCompleted,
  DAY, LOOKBACK_DAYS, ARCHIVE_AFTER_DAYS, dayNumOf, partsFromDayNum,
};
