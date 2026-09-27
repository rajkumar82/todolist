const assert = require('assert');
const { generateRecurring, archiveCompleted, runHousekeeping, DAY } = require('../recurring');

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0); // Monday, same fixed "now" as score.test.js
const TZ = 0; // UTC, so calendar dates below can be written directly with Date.UTC

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

const list = (items = []) => ({ id: 'L', name: 'List', emoji: '📝', items });
let idc = 0;
const newId = () => `id${idc++}`;

const weeklyTemplate = (over) => ({
  id: 'R', listId: 'L', text: 'Pull ups', createdAt: NOW - 9 * DAY, active: true,
  freq: 'weekly', daysOfWeek: [1, 3, 6], dayOfMonth: null, time: null,
  lastGeneratedDay: null, lastGeneratedMonth: null, ...over,
});
const monthlyTemplate = (over) => ({
  id: 'R', listId: 'L', text: 'Pay bills', createdAt: NOW - 200 * DAY, active: true,
  freq: 'monthly', daysOfWeek: null, dayOfMonth: 7, time: null,
  lastGeneratedDay: null, lastGeneratedMonth: null, ...over,
});

test('weekly habit generates one occurrence per matching weekday since it was created', () => {
  const L = list();
  const doc = { lists: [L], recurring: [weeklyTemplate()] };
  generateRecurring(doc, [], NOW, TZ, newId);
  // created Sat 12 Sep 2026; Mon/Wed/Sat through Mon 21 Sep 2026 => 12th, 14th, 16th, 19th, 21st
  const due = L.items.map((i) => i.dueAt).sort();
  const expect = [12, 14, 16, 19, 21].map((d) => Date.UTC(2026, 8, d, 23, 59)).sort();
  assert.deepStrictEqual(due, expect);
  assert(L.items.every((i) => i.recurringId === 'R' && i.done === false));
});

test('weekly generation is idempotent: running it again creates nothing new', () => {
  const L = list();
  const doc = { lists: [L], recurring: [weeklyTemplate()] };
  generateRecurring(doc, [], NOW, TZ, newId);
  const first = L.items.length;
  generateRecurring(doc, [], NOW, TZ, newId);
  assert.strictEqual(L.items.length, first);
});

test('a habit paused for a long time only backfills the last 30 days, not its whole history', () => {
  const L = list();
  const doc = { lists: [L], recurring: [weeklyTemplate({ createdAt: NOW - 400 * DAY })] };
  generateRecurring(doc, [], NOW, TZ, newId);
  const oldest = Math.min(...L.items.map((i) => i.dueAt));
  assert(NOW - oldest <= 30 * DAY, `oldest occurrence should be within the 30-day lookback, got ${(NOW - oldest) / DAY} days`);
});

test('an inactive habit generates nothing', () => {
  const L = list();
  const doc = { lists: [L], recurring: [weeklyTemplate({ active: false })] };
  generateRecurring(doc, [], NOW, TZ, newId);
  assert.strictEqual(L.items.length, 0);
});

test('a habit whose list was deleted is skipped without error', () => {
  const doc = { lists: [], recurring: [weeklyTemplate()] };
  assert.doesNotThrow(() => generateRecurring(doc, [], NOW, TZ, newId));
});

test('monthly habit generates one occurrence per month, due on the chosen day', () => {
  const L = list();
  const doc = { lists: [L], recurring: [monthlyTemplate()] };
  generateRecurring(doc, [], NOW, TZ, newId);
  const due = L.items.map((i) => i.dueAt).sort();
  const expect = [Date.UTC(2026, 7, 7, 23, 59), Date.UTC(2026, 8, 7, 23, 59)].sort(); // Aug 7 and Sep 7
  assert.deepStrictEqual(due, expect);
});

test('monthly dayOfMonth is clamped to the length of a shorter month', () => {
  const L = list();
  const doc = {
    lists: [L],
    recurring: [monthlyTemplate({ dayOfMonth: 31, createdAt: Date.UTC(2026, 1, 1) })], // created Feb 2026 (28 days)
  };
  generateRecurring(doc, [], Date.UTC(2026, 1, 20), TZ, newId);
  assert.strictEqual(L.items.length, 1);
  assert.strictEqual(L.items[0].dueAt, Date.UTC(2026, 1, 28, 23, 59));
});

test('a "time" on the template sets the due time instead of end of day', () => {
  const L = list();
  const doc = { lists: [L], recurring: [weeklyTemplate({ createdAt: NOW, daysOfWeek: [1], time: '07:30' })] };
  generateRecurring(doc, [], NOW, TZ, newId);
  assert.strictEqual(L.items.length, 1);
  assert.strictEqual(L.items[0].dueAt, Date.UTC(2026, 8, 21, 7, 30));
});

test('archiveCompleted drops completed items older than 7 days, keeps the rest', () => {
  const old = { id: 'a', done: true, completedAt: NOW - 8 * DAY };
  const recent = { id: 'b', done: true, completedAt: NOW - 6 * DAY };
  const openOld = { id: 'c', done: false, completedAt: null, dueAt: NOW - 30 * DAY };
  const doc = { lists: [list([old, recent, openOld])] };
  const changed = archiveCompleted(doc, NOW);
  assert.strictEqual(changed, true);
  const ids = doc.lists[0].items.map((i) => i.id);
  assert.deepStrictEqual(ids, ['b', 'c']);
});

test('archiveCompleted reports no change when nothing is old enough to drop', () => {
  const doc = { lists: [list([{ id: 'a', done: true, completedAt: NOW - DAY }])] };
  assert.strictEqual(archiveCompleted(doc, NOW), false);
});

test('runHousekeeping generates and archives together, and only reports a change when it did something', () => {
  const L = list([{ id: 'old', done: true, completedAt: NOW - 8 * DAY }]);
  const doc = { lists: [L], recurring: [weeklyTemplate({ createdAt: NOW, daysOfWeek: [1] })] };
  const changed = runHousekeeping(doc, [], NOW, TZ, newId);
  assert.strictEqual(changed, true);
  assert(!L.items.some((i) => i.id === 'old'));
  assert(L.items.some((i) => i.recurringId === 'R'));

  const untouched = { lists: [list()], recurring: [] };
  assert.strictEqual(runHousekeeping(untouched, [], NOW, TZ, newId), false);
});

console.log(`\n${n} recurring tests passed`);
