const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { computeStats } = require('./score');
const { runHousekeeping } = require('./recurring');

const PORT = process.env.PORT || 8080;
const BUCKET = process.env.BUCKET; // if unset, data is stored in ./data
const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const ID_RE = /^[a-z0-9]{6,24}$/;
const RESERVED = new Set(['api', 'manifest', 'manifest-root']);
const MAX_LISTS = 50;
const MAX_ITEMS = 500; // per list; keeps a user's file small
const MAX_RECURRING = 50; // per user
const MIN_DATE = Date.UTC(2000, 0, 1);
const MAX_DATE = Date.UTC(2100, 0, 1);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

// ---- storage: JSON documents, in GCS or in ./data ----
// Both backends expose:
//   read(key)              -> { data, gen } | null
//   write(key, data, gen)  -> throws Conflict if the document changed since `gen` was read
//                             (gen === null means "must not exist yet")

class Conflict extends Error {}

function gcsStorage(bucketName) {
  const { Storage } = require('@google-cloud/storage');
  const bucket = new Storage().bucket(bucketName);
  return {
    async read(key) {
      try {
        const [meta] = await bucket.file(key).getMetadata();
        // pin the download to the generation we just saw, so data and gen always agree
        const [buf] = await bucket.file(key, { generation: meta.generation }).download();
        return { data: JSON.parse(buf.toString('utf8')), gen: meta.generation };
      } catch (err) {
        if (err.code === 404) return null;
        throw err;
      }
    },
    async write(key, data, gen) {
      try {
        await bucket.file(key).save(JSON.stringify(data), {
          resumable: false,
          contentType: 'application/json',
          metadata: { cacheControl: 'no-store' },
          preconditionOpts: { ifGenerationMatch: gen == null ? 0 : gen },
        });
      } catch (err) {
        if (err.code === 412) throw new Conflict();
        throw err;
      }
    },
  };
}

function localStorage(dir) {
  const file = (key) => path.join(dir, key);
  const stamp = async (key) => {
    try {
      return String((await fsp.stat(file(key))).mtimeMs);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  };
  return {
    async read(key) {
      try {
        const gen = await stamp(key);
        if (gen == null) return null;
        return { data: JSON.parse(await fsp.readFile(file(key), 'utf8')), gen };
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async write(key, data, gen) {
      if ((await stamp(key)) !== (gen == null ? null : gen)) throw new Conflict();
      await fsp.mkdir(path.dirname(file(key)), { recursive: true });
      const tmp = `${file(key)}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
      await fsp.rename(tmp, file(key)); // atomic, so a crash never leaves a half-written file
    },
  };
}

const store = BUCKET ? gcsStorage(BUCKET) : localStorage(process.env.DATA_DIR || path.join(__dirname, 'data'));
const userKey = (name) => `users/${name}.json`;
const historyKey = (name) => `users/${name}.history.json`;

// One request at a time per key within this process. Across Cloud Run instances the
// generation check in store.write() is what protects against lost updates.
const locks = new Map();
function withLock(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => locks.get(key) === tail && locks.delete(key));
  return run;
}

// read-modify-write with retry when another instance got in first
async function update(key, fallback, change) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await store.read(key);
    const doc = cur ? cur.data : fallback();
    if (change(doc, !cur) === false) return doc; // nothing to save
    try {
      await store.write(key, doc, cur ? cur.gen : null);
      return doc;
    } catch (err) {
      if (!(err instanceof Conflict)) throw err;
    }
  }
  throw new HttpError(503, 'Busy, please try again');
}

// ---- data model ----
// user:      { user, createdAt, lists: [list], recurring: [recurring] }
// list:      { id, name, emoji, createdAt, items: [item] }
// item:      { id, text, done, createdAt, dueAt|null, completedAt|null, recurringId|undefined, period|undefined }
//            (times are epoch ms; recurringId/period are only set on items generated from a
//            recurring template, and period is bookkeeping only - not shown in the UI)
// recurring: { id, listId, text, createdAt, active,
//              freq: 'weekly'|'monthly',
//              daysOfWeek|null (weekly: 1-7, Mon-Sun), dayOfMonth|null (monthly: 1-31, clamped to
//              the month's length), time|null ("HH:MM", defaults to end of day),
//              lastGeneratedDay|null (weekly cursor), lastGeneratedMonth|null (monthly cursor) }
// Completed items are dropped from `items` a week after completion by recurring.js's housekeeping
// (they stay permanently in the history log); recurring occurrences are generated by the same step.

const newId = () => crypto.randomBytes(6).toString('hex');

function newUser(name) {
  const now = Date.now();
  const starter = [
    ['Personal', '🏠'],
    ['Office', '💼'],
    ['Family', '👨‍👩‍👧'],
    ['Friends', '🎉'],
  ];
  return {
    user: name,
    createdAt: now,
    lists: starter.map(([n, emoji]) => ({ id: newId(), name: n, emoji, createdAt: now, items: [] })),
    recurring: [],
  };
}

const allIds = (doc) => new Set([
  ...doc.lists.flatMap((l) => [l.id, ...l.items.map((i) => i.id)]),
  ...(doc.recurring || []).map((r) => r.id),
]);
// the client may propose an id (so it can update the screen before the server answers)
const pickId = (doc, proposed) => (typeof proposed === 'string' && ID_RE.test(proposed) && !allIds(doc).has(proposed) ? proposed : newId());

function findList(doc, id) {
  const list = doc.lists.find((l) => l.id === id);
  if (!list) throw new HttpError(404, 'List not found');
  return list;
}
function findItem(list, id) {
  const item = list.items.find((i) => i.id === id);
  if (!item) throw new HttpError(404, 'Item not found');
  return item;
}
function findRecurring(doc, id) {
  const r = (doc.recurring || []).find((x) => x.id === id);
  if (!r) throw new HttpError(404, 'Recurring habit not found');
  return r;
}

// ---- validation ----

function text(v, max, label) {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${label} is required`);
  const s = v.trim();
  if (s.length > max) throw bad(`${label} must be at most ${max} characters`);
  return s;
}
function emoji(v) {
  if (v == null || v === '') return '📝';
  if (typeof v !== 'string' || v.length > 16) throw bad('Invalid emoji');
  return v;
}
function dueAt(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(n) || n < MIN_DATE || n > MAX_DATE) throw bad('Invalid due date');
  return Math.round(n);
}
function freq(v) {
  if (v !== 'weekly' && v !== 'monthly') throw bad('freq must be "weekly" or "monthly"');
  return v;
}
function daysOfWeek(v) {
  if (!Array.isArray(v) || !v.length || v.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw bad('daysOfWeek must be a non-empty array of numbers 1-7 (Mon-Sun)');
  }
  return [...new Set(v)].sort((a, b) => a - b);
}
function dayOfMonth(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 31) throw bad('dayOfMonth must be 1-31');
  return n;
}
function time(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw bad('time must be "HH:MM"');
  return v;
}

// ---- history: an append-only log per user, kept in storage only ----

async function appendHistory(name, events) {
  if (!events.length) return;
  try {
    await withLock(`${name}:history`, () =>
      update(
        historyKey(name),
        () => ({ user: name, entries: [] }),
        (doc) => void doc.entries.push(...events),
      ),
    );
  } catch (err) {
    // the change itself is already saved; don't fail the request over the log
    console.error('history append failed', err);
  }
}

// Load the user (creating them on first visit) or apply a change to them. Either way, recurring
// habits are generated and old completed items are archived first (see recurring.js), so every
// request self-heals the document rather than needing a cron job.
// `change(doc, events)` mutates doc and pushes history events; return false to skip saving.
function mutate(name, change, tz = 0) {
  return withLock(name, async () => {
    const events = [];
    const doc = await update(userKey(name), () => newUser(name), (d, created) => {
      events.length = 0; // a retry starts from a fresh copy of the document
      if (!Array.isArray(d.recurring)) d.recurring = []; // self-heal documents from before this field existed
      if (created) events.push({ action: 'user.create' });
      const housekept = runHousekeeping(d, events, Date.now(), tz, newId);
      const result = change ? change(d, events) : false;
      if (result === false && !housekept && !created) return false;
    });
    const t = Date.now();
    // awaited (not fire-and-forget): Cloud Run may throttle the CPU once the response is sent
    await appendHistory(name, events.map((e) => ({ t, ...e })));
    return doc;
  });
}

const load = (name, tz = 0) => mutate(name, null, tz);

// ---- api ----

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow'); // a user's name is their only "password"
  next();
});

const tzOf = (req) => {
  const n = parseInt(req.get('x-tz-offset'), 10);
  return Number.isFinite(n) && Math.abs(n) <= 840 ? n : 0;
};
const view = (doc, req) => ({ user: doc.user, lists: doc.lists, recurring: doc.recurring || [], stats: computeStats(doc.lists, Date.now(), tzOf(req)) });

const api = express.Router();
api.use(express.json({ limit: '32kb' }));
api.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
api.param('user', (req, res, next, raw) => {
  const name = String(raw).trim().toLowerCase();
  if (!NAME_RE.test(name) || RESERVED.has(name)) {
    return next(bad('Name must be 1-32 characters: letters, digits, - or _'));
  }
  req.userName = name;
  next();
});

const route = (fn) => async (req, res, next) => {
  try {
    res.json(view(await fn(req), req));
  } catch (err) {
    next(err);
  }
};
const body = (req) => req.body || {};

api.get('/u/:user', route((req) => load(req.userName, tzOf(req))));

api.post('/u/:user/lists', route((req) => {
  const name = text(body(req).name, 40, 'Name');
  const icon = emoji(body(req).emoji);
  return mutate(req.userName, (doc, ev) => {
    if (doc.lists.length >= MAX_LISTS) throw bad(`At most ${MAX_LISTS} lists`);
    const list = { id: pickId(doc, body(req).id), name, emoji: icon, createdAt: Date.now(), items: [] };
    doc.lists.push(list);
    ev.push({ action: 'list.add', listId: list.id, list: name });
  }, tzOf(req));
}));

api.patch('/u/:user/lists/:listId', route((req) => {
  const b = body(req);
  const name = b.name === undefined ? undefined : text(b.name, 40, 'Name');
  const icon = b.emoji === undefined ? undefined : emoji(b.emoji);
  return mutate(req.userName, (doc, ev) => {
    const list = findList(doc, req.params.listId);
    const changes = {};
    if (name !== undefined && name !== list.name) {
      changes.name = { from: list.name, to: name };
      list.name = name;
    }
    if (icon !== undefined && icon !== list.emoji) {
      changes.emoji = { from: list.emoji, to: icon };
      list.emoji = icon;
    }
    if (!Object.keys(changes).length) return false;
    ev.push({ action: 'list.update', listId: list.id, list: list.name, changes });
  }, tzOf(req));
}));

api.delete('/u/:user/lists/:listId', route((req) =>
  mutate(req.userName, (doc, ev) => {
    const list = findList(doc, req.params.listId);
    doc.lists.splice(doc.lists.indexOf(list), 1);
    ev.push({ action: 'list.delete', listId: list.id, list: list.name, itemCount: list.items.length, items: list.items });
    const orphaned = (doc.recurring || []).filter((r) => r.listId === list.id);
    if (orphaned.length) {
      doc.recurring = doc.recurring.filter((r) => r.listId !== list.id);
      ev.push({ action: 'recurring.delete', reason: 'list.delete', recurringIds: orphaned.map((r) => r.id) });
    }
  }, tzOf(req)),
));

api.post('/u/:user/lists/:listId/items', route((req) => {
  const t = text(body(req).text, 200, 'Text');
  const due = dueAt(body(req).dueAt);
  return mutate(req.userName, (doc, ev) => {
    const list = findList(doc, req.params.listId);
    if (list.items.length >= MAX_ITEMS) throw bad(`At most ${MAX_ITEMS} items per list`);
    const item = { id: pickId(doc, body(req).id), text: t, done: false, createdAt: Date.now(), dueAt: due, completedAt: null };
    list.items.push(item);
    ev.push({ action: 'item.add', listId: list.id, list: list.name, itemId: item.id, text: t, dueAt: due });
  }, tzOf(req));
}));

api.patch('/u/:user/lists/:listId/items/:itemId', route((req) => {
  const b = body(req);
  const t = b.text === undefined ? undefined : text(b.text, 200, 'Text');
  const due = b.dueAt === undefined ? undefined : dueAt(b.dueAt);
  if (b.done !== undefined && typeof b.done !== 'boolean') throw bad('done must be true or false');
  return mutate(req.userName, (doc, ev) => {
    const list = findList(doc, req.params.listId);
    const item = findItem(list, req.params.itemId);
    const at = { listId: list.id, list: list.name, itemId: item.id };
    const changes = {};
    if (t !== undefined && t !== item.text) {
      changes.text = { from: item.text, to: t };
      item.text = t;
    }
    if (due !== undefined && due !== item.dueAt) {
      changes.dueAt = { from: item.dueAt, to: due };
      item.dueAt = due;
    }
    if (Object.keys(changes).length) ev.push({ action: 'item.update', ...at, text: item.text, changes });
    if (b.done !== undefined && b.done !== item.done) {
      item.done = b.done;
      item.completedAt = b.done ? Date.now() : null;
      ev.push({ action: b.done ? 'item.complete' : 'item.reopen', ...at, text: item.text });
    }
    if (!ev.length) return false;
  }, tzOf(req));
}));

api.delete('/u/:user/lists/:listId/items/:itemId', route((req) =>
  mutate(req.userName, (doc, ev) => {
    const list = findList(doc, req.params.listId);
    const item = findItem(list, req.params.itemId);
    list.items.splice(list.items.indexOf(item), 1);
    ev.push({ action: 'item.delete', listId: list.id, list: list.name, itemId: item.id, text: item.text });
  }, tzOf(req)),
));

api.post('/u/:user/recurring', route((req) => {
  const b = body(req);
  const t = text(b.text, 200, 'Text');
  const f = freq(b.freq);
  const dow = f === 'weekly' ? daysOfWeek(b.daysOfWeek) : null;
  const dom = f === 'monthly' ? dayOfMonth(b.dayOfMonth) : null;
  const tm = time(b.time);
  return mutate(req.userName, (doc, ev) => {
    const list = findList(doc, b.listId);
    if (doc.recurring.length >= MAX_RECURRING) throw bad(`At most ${MAX_RECURRING} recurring habits`);
    const r = {
      id: pickId(doc, b.id), listId: list.id, text: t, createdAt: Date.now(), active: true,
      freq: f, daysOfWeek: dow, dayOfMonth: dom, time: tm,
      lastGeneratedDay: null, lastGeneratedMonth: null,
    };
    doc.recurring.push(r);
    ev.push({ action: 'recurring.add', recurringId: r.id, listId: list.id, list: list.name, text: t, freq: f });
  }, tzOf(req));
}));

api.patch('/u/:user/recurring/:recurringId', route((req) => {
  const b = body(req);
  const t = b.text === undefined ? undefined : text(b.text, 200, 'Text');
  const active = b.active === undefined ? undefined : Boolean(b.active);
  const dow = b.daysOfWeek === undefined ? undefined : daysOfWeek(b.daysOfWeek);
  const dom = b.dayOfMonth === undefined ? undefined : dayOfMonth(b.dayOfMonth);
  const tm = b.time === undefined ? undefined : time(b.time);
  return mutate(req.userName, (doc, ev) => {
    const r = findRecurring(doc, req.params.recurringId);
    const changes = {};
    if (t !== undefined && t !== r.text) { changes.text = { from: r.text, to: t }; r.text = t; }
    if (active !== undefined && active !== r.active) { changes.active = { from: r.active, to: active }; r.active = active; }
    if (dow !== undefined && r.freq === 'weekly' && JSON.stringify(dow) !== JSON.stringify(r.daysOfWeek)) {
      changes.daysOfWeek = { from: r.daysOfWeek, to: dow }; r.daysOfWeek = dow;
    }
    if (dom !== undefined && r.freq === 'monthly' && dom !== r.dayOfMonth) {
      changes.dayOfMonth = { from: r.dayOfMonth, to: dom }; r.dayOfMonth = dom;
    }
    if (tm !== undefined && tm !== r.time) { changes.time = { from: r.time, to: tm }; r.time = tm; }
    if (!Object.keys(changes).length) return false;
    ev.push({ action: 'recurring.update', recurringId: r.id, changes });
  }, tzOf(req));
}));

api.delete('/u/:user/recurring/:recurringId', route((req) =>
  mutate(req.userName, (doc, ev) => {
    const r = findRecurring(doc, req.params.recurringId);
    doc.recurring.splice(doc.recurring.indexOf(r), 1);
    ev.push({ action: 'recurring.delete', recurringId: r.id, text: r.text });
  }, tzOf(req)),
));

app.use('/api', api);

// ---- pages ----
// Every user gets the same page at /<name>; the server only injects the right manifest so that
// "Add to Home Screen" installs a shortcut that opens that user's space.

const PUBLIC = path.join(__dirname, 'public');
const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const sendPage = (res, name) => {
  const manifest = name ? `/manifest/${name}.webmanifest` : '/manifest-root.webmanifest';
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(indexHtml.replace('<!--MANIFEST-->', `<link rel="manifest" href="${manifest}">`));
};

const manifestFor = (name) => ({
  id: name ? `/${name}` : '/',
  name: name ? `Todo · ${name}` : 'Todo',
  short_name: 'Todo',
  description: 'Todo lists with an efficiency rating',
  start_url: name ? `/${name}` : '/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#0f1220',
  theme_color: '#1a73e8',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});
const sendManifest = (res, name) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/manifest+json').send(JSON.stringify(manifestFor(name)));
};

app.get('/manifest-root.webmanifest', (req, res) => sendManifest(res, ''));
app.get('/manifest/:user.webmanifest', (req, res, next) => {
  const name = req.params.user.toLowerCase();
  if (!NAME_RE.test(name)) return next();
  sendManifest(res, name);
});

app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
app.use(express.static(PUBLIC, { index: false, maxAge: 0 })); // always revalidated, so updates show up

app.get('/', (req, res) => sendPage(res, ''));
app.get('/:user', (req, res, next) => {
  const raw = req.params.user;
  const name = raw.toLowerCase();
  if (!NAME_RE.test(name) || RESERVED.has(name)) return next();
  if (raw !== name) return res.redirect(301, `/${name}`);
  sendPage(res, name);
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).type('text/plain').send('Not found');
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') err = bad('Invalid JSON');
  if (err.type === 'entity.too.large') err = new HttpError(413, 'Request too large');
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Todo listening on :${PORT} (storage: ${BUCKET ? `gcs://${BUCKET}` : './data'})`);
});
