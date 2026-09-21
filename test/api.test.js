// End-to-end API checks against a real server process with a throwaway data folder.
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-test-'));
const BASE = `http://localhost:${PORT}`;
const call = async (method, p, body) => {
  const r = await fetch(`${BASE}/api/u/${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { s: r.status, j: await r.json() };
};
let n = 0;
const ok = (name) => console.log('ok -', name, ++n && '');

async function main() {
  const u = 'tester';
  let r = await call('GET', u);
  assert.equal(r.j.lists.length, 4); ok('a new user is created with 4 starter lists');

  r = await call('POST', `${u}/lists`, { name: 'Groceries', emoji: '🛒', id: 'abc123def456' });
  assert.equal(r.j.lists.at(-1).id, 'abc123def456'); ok('list accepts a client-proposed id');
  r = await call('POST', `${u}/lists`, { name: 'Other' });
  const generated = r.j.lists.at(-1).id;
  assert(/^[a-z0-9]{12}$/.test(generated), `generated id ${generated}`); ok('list gets a generated id when none is given');
  r = await call('POST', `${u}/lists`, { name: 'Numeric', id: 123456789 });
  assert(/^[a-z0-9]{12}$/.test(r.j.lists.at(-1).id)); ok('a non-string id is ignored');
  r = await call('POST', `${u}/lists`, { name: '  ' });
  assert.equal(r.s, 400); ok('blank list name is rejected');
  r = await call('PATCH', `${u}/lists/abc123def456`, { name: 'Shopping' });
  assert.equal(r.j.lists.find((l) => l.id === 'abc123def456').name, 'Shopping'); ok('rename a list');

  // items: every item must get a real, unique id even when the client does not send one
  const L = 'abc123def456';
  for (let i = 0; i < 3; i++) await call('POST', `${u}/lists/${L}/items`, { text: `plain ${i}` });
  r = await call('GET', u);
  const ids = r.j.lists.find((l) => l.id === L).items.map((i) => i.id);
  assert(ids.every((id) => /^[a-z0-9]{12}$/.test(id)) && new Set(ids).size === 3, `ids ${ids}`); ok('items without a proposed id get unique generated ids');

  const due = Date.now() - 3600000;
  r = await call('POST', `${u}/lists/${L}/items`, { text: 'Milk', dueAt: due, id: 'item00000001' });
  assert.equal(r.j.lists.find((l) => l.id === L).items.at(-1).dueAt, due); ok('add an item with a due time');
  r = await call('POST', `${u}/lists/${L}/items`, { text: 'x', dueAt: 'garbage' });
  assert.equal(r.s, 400); ok('an invalid due date is rejected');
  r = await call('PATCH', `${u}/lists/${L}/items/item00000001`, { done: true });
  let it = r.j.lists.find((l) => l.id === L).items.find((i) => i.id === 'item00000001');
  assert(it.done && it.completedAt); assert.notEqual(r.j.stats.score, null); ok('completing sets completedAt and produces a rating');
  r = await call('PATCH', `${u}/lists/${L}/items/item00000001`, { done: false });
  it = r.j.lists.find((l) => l.id === L).items.find((i) => i.id === 'item00000001');
  assert(!it.done && it.completedAt === null); ok('unchecking clears completedAt');
  r = await call('PATCH', `${u}/lists/${L}/items/item00000001`, { text: 'Oat milk', dueAt: null });
  it = r.j.lists.find((l) => l.id === L).items.find((i) => i.id === 'item00000001');
  assert.equal(it.text, 'Oat milk'); assert.equal(it.dueAt, null); ok('edit the text and clear the due time');
  r = await call('PATCH', `${u}/lists/nope/items/x`, { done: true });
  assert.equal(r.s, 404); ok('an unknown list gives 404');
  r = await call('PATCH', `${u}/lists/${L}/items/undefined`, { done: true });
  assert.equal(r.s, 404); ok('an unknown item gives 404');

  await Promise.all(Array.from({ length: 20 }, (_, i) => call('POST', `${u}/lists/${L}/items`, { text: `c${i}` })));
  r = await call('GET', u);
  assert.equal(r.j.lists.find((l) => l.id === L).items.length, 24); ok('20 concurrent adds are all kept');

  r = await call('DELETE', `${u}/lists/${L}/items/item00000001`);
  assert.equal(r.j.lists.find((l) => l.id === L).items.length, 23); ok('delete an item');
  r = await call('DELETE', `${u}/lists/${L}`);
  assert(!r.j.lists.some((l) => l.id === L)); ok('delete a list');

  assert.equal((await call('GET', 'Bad.Name')).s, 400); ok('an invalid user name is rejected');
  assert.equal((await call('GET', 'api')).s, 400); ok('a reserved user name is rejected');
  assert.equal((await call('GET', 'TESTER')).j.user, u); ok('user names are case-insensitive');

  const hist = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'users', `${u}.history.json`), 'utf8'));
  const actions = new Set(hist.entries.map((e) => e.action));
  for (const a of ['user.create', 'list.add', 'list.update', 'list.delete', 'item.add', 'item.update', 'item.complete', 'item.reopen', 'item.delete']) {
    assert(actions.has(a), `history is missing ${a}`);
  }
  ok('every kind of change is written to the history log');
  console.log(`\n${n} API tests passed`);
}

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR }, stdio: 'ignore' });
(async () => {
  for (let i = 0; i < 50; i++) { // wait for the server to accept connections
    try { await fetch(BASE + '/robots.txt'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  await main();
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; })
  .finally(() => { server.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });
