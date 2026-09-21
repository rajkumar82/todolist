const assert = require('assert');
const { computeStats, DAY, HOUR } = require('../score');

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0); // fixed "now" so results are deterministic
const item = (over) => ({ id: 'x', text: 't', done: false, createdAt: NOW - 5 * DAY, dueAt: null, completedAt: null, ...over });
const done = (over) => item({ done: true, completedAt: NOW - DAY, ...over });
const stats = (items) => computeStats([{ id: 'l', name: 'L', emoji: '📝', items }], NOW, 0);
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

test('no data => no rating', () => {
  assert.strictEqual(stats([]).score, null);
});
test('only future-due open items => no rating (planning ahead is not penalised)', () => {
  assert.strictEqual(stats([item({ dueAt: NOW + 2 * DAY }), item({ createdAt: NOW - HOUR })]).score, null);
});
test('everything done on time, active every day => top tier', () => {
  const items = [];
  for (let d = 0; d < 7; d++) items.push(done({ createdAt: NOW - (d + 2) * DAY, completedAt: NOW - d * DAY, dueAt: NOW - d * DAY + HOUR }));
  const s = stats(items);
  assert.strictEqual(s.score, 100);
  assert.strictEqual(s.onTime, 7);
  assert.strictEqual(s.streak, 7);
});
test('overdue open item with nothing done => bottom tier', () => {
  const s = stats([item({ dueAt: NOW - 2 * DAY })]);
  assert.strictEqual(s.score, 0);
  assert.strictEqual(s.overdueCount, 1);
});
test('lateness lowers the rating but is not a cliff', () => {
  const onTime = stats([done({ dueAt: NOW - DAY + HOUR })]).score;
  const slightlyLate = stats([done({ dueAt: NOW - DAY - 2 * HOUR })]).score;
  const veryLate = stats([done({ dueAt: NOW - 20 * DAY, createdAt: NOW - 21 * DAY })]).score;
  assert(onTime > slightlyLate, `${onTime} > ${slightlyLate}`);
  assert(slightlyLate > veryLate, `${slightlyLate} > ${veryLate}`);
  assert(slightlyLate > 40);
});
test('an item with no due date is judged against a 3 day allowance', () => {
  const quick = stats([done({ createdAt: NOW - 2 * DAY, completedAt: NOW - DAY })]);
  assert.strictEqual(quick.onTime, 1);
  const slow = stats([done({ createdAt: NOW - 20 * DAY, completedAt: NOW - DAY })]);
  assert.strictEqual(slow.onTime, 0);
});
test('unchecking an item removes it from the rating', () => {
  const s = stats([item({ done: false, completedAt: null, createdAt: NOW - 1 * DAY })]);
  assert.strictEqual(s.done, 0);
  assert.strictEqual(s.score, null);
});
test('streak counts back from yesterday if nothing is done yet today', () => {
  const s = stats([done({ completedAt: NOW - DAY }), done({ completedAt: NOW - 2 * DAY })]);
  assert.strictEqual(s.streak, 2);
});
test('old overdue items stop counting after 30 days', () => {
  const s = stats([item({ createdAt: NOW - 90 * DAY, dueAt: NOW - 60 * DAY })]);
  assert.strictEqual(s.score, null);
});
test('trend compares with a week ago', () => {
  const items = [
    done({ createdAt: NOW - 20 * DAY, completedAt: NOW - 15 * DAY, dueAt: NOW - 15 * DAY + HOUR }),
    item({ createdAt: NOW - 10 * DAY, dueAt: NOW - 3 * DAY }), // came due after the week-ago snapshot
  ];
  const s = stats(items);
  assert(s.trend < 0, `trend ${s.trend}`);
});
test('per-list breakdown', () => {
  const s = computeStats([
    { id: 'a', name: 'A', emoji: '1', items: [done()] },
    { id: 'b', name: 'B', emoji: '2', items: [] },
  ], NOW, 0);
  assert.strictEqual(s.perList.length, 2);
  assert.notStrictEqual(s.perList[0].score, null);
  assert.strictEqual(s.perList[1].score, null);
});
test('timezone shifts the day boundary used for streaks', () => {
  // 20:00 UTC on the 20th is already the 21st in India (UTC+5:30 => offset -330)
  const late = { ...done({ completedAt: Date.UTC(2026, 8, 20, 20, 0) }) };
  const utc = computeStats([{ id: 'l', name: 'L', emoji: '', items: [late] }], NOW, 0);
  const ist = computeStats([{ id: 'l', name: 'L', emoji: '', items: [late] }], NOW, -330);
  assert.strictEqual(utc.streak, 1); // yesterday
  assert.strictEqual(ist.streak, 1); // today
});
console.log(`\n${n} tests passed`);
