// Efficiency rating, computed from item timestamps (never from the history log, so edits and
// deletions can't skew it). Everything here is pure: same items + same `now` => same result.
//
//   completion  (40%)  items finished vs. items that came due, over the last 30 days
//   timeliness  (40%)  how close to (or before) the deadline finished items were
//   consistency (20%)  days with at least one completion in the last 7
//
// An item's deadline is its due date/time, or createdAt + 3 days when it has none.
// Open items that are not yet due are ignored, so planning ahead never hurts the rating.

const HOUR = 3600000;
const DAY = 24 * HOUR;
const WINDOW_DAYS = 30;
const DEFAULT_ALLOWANCE = 3 * DAY;

const deadline = (i) => (i.dueAt != null ? i.dueAt : i.createdAt + DEFAULT_ALLOWANCE);

// Local calendar day number. tz is Date.getTimezoneOffset() from the browser (minutes behind UTC).
const dayOf = (ts, tz) => Math.floor((ts - tz * 60000) / DAY);

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Evaluate `items` as they stood at time `asOf`.
function evaluate(items, asOf, tz) {
  const from = asOf - WINDOW_DAYS * DAY;
  const done = [];
  const overdue = [];
  const doneDays = new Set();

  for (const i of items) {
    if (i.createdAt > asOf) continue;
    if (i.completedAt != null && i.completedAt <= asOf) {
      doneDays.add(dayOf(i.completedAt, tz));
      if (i.completedAt > from) done.push(i);
    } else {
      const dl = deadline(i);
      if (dl < asOf && dl >= from) overdue.push(i); // came due in the window and is still open
    }
  }

  const today = dayOf(asOf, tz);
  let streak = 0;
  for (let d = doneDays.has(today) ? today : today - 1; doneDays.has(d); d--) streak++;
  let activeDays = 0;
  for (let d = today - 6; d <= today; d++) if (doneDays.has(d)) activeDays++;

  const due = done.length + overdue.length;
  let onTime = 0;
  let timelySum = 0;
  for (const i of done) {
    const late = i.completedAt - deadline(i);
    if (late <= 0) {
      onTime++;
      timelySum += 1;
    } else {
      const allowance = Math.max(deadline(i) - i.createdAt, DAY);
      timelySum += Math.max(0, 1 - late / (2 * allowance));
    }
  }

  let score = null;
  if (due > 0) {
    const completion = done.length / due;
    const timeliness = done.length ? timelySum / done.length : 0;
    const consistency = activeDays / 7;
    score = Math.round(100 * (0.4 * completion + 0.4 * timeliness + 0.2 * consistency));
  }

  return {
    score,
    done: done.length,
    due,
    onTime,
    streak,
    activeDays,
    medianMs: median(done.map((i) => i.completedAt - i.createdAt)),
  };
}

function computeStats(lists, now, tz = 0) {
  const all = lists.flatMap((l) => l.items);
  const cur = evaluate(all, now, tz);
  const weekAgo = evaluate(all, now - 7 * DAY, tz);
  return {
    score: cur.score,
    trend: cur.score != null && weekAgo.score != null ? cur.score - weekAgo.score : null,
    done: cur.done,
    due: cur.due,
    onTime: cur.onTime,
    streak: cur.streak,
    medianMs: cur.medianMs,
    openCount: all.filter((i) => !i.done).length,
    overdueCount: all.filter((i) => !i.done && i.dueAt != null && i.dueAt < now).length,
    perList: lists.map((l) => ({
      id: l.id,
      name: l.name,
      emoji: l.emoji,
      score: evaluate(l.items, now, tz).score,
      open: l.items.filter((i) => !i.done).length,
      done: l.items.filter((i) => i.done).length,
    })),
  };
}

module.exports = { computeStats, evaluate, deadline, HOUR, DAY };
