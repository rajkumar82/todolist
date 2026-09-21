const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { computeStats } = require('./score');

const PORT = process.env.PORT || 8080;
const BUCKET = process.env.BUCKET; // if unset, data is stored in ./data
const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const ID_RE = /^[a-z0-9]{6,24}$/;
const RESERVED = new Set(['api', 'manifest', 'manifest-root']);
const MAX_LISTS = 50;
const MAX_ITEMS = 500; // per list; keeps a user's file small
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
// user:  { user, createdAt, lists: [list] }
// list:  { id, name, emoji, createdAt, items: [item] }
// item:  { id, text, done, createdAt, dueAt|null, completedAt|null }   (times are epoch ms)

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
  };
}

const allIds = (doc) => new Set(doc.lists.flatMap((l) => [l.id, ...l.items.map((i) => i.id)]));
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

// Load the user (creating them on first visit) or apply a change to them.
// `change(doc, events)` mutates doc and pushes history events; return false to skip saving.
function mutate(name, change) {
  return withLock(name, async () => {
    const events = [];
    const doc = await update(userKey(name), () => newUser(name), (d, created) => {
      events.length = 0; // a retry starts from a fresh copy of the document
      if (created) events.push({ action: 'user.create' });
      if (change(d, events) === false && !created) return false;
    });
    const t = Date.now();
    // awaited (not fire-and-forget): Cloud Run may throttle the CPU once the response is sent
    await appendHistory(name, events.map((e) => ({ t, ...e })));
    return doc;
  });
}

async function load(name) {
  const cur = await store.read(userKey(name));
  return cur ? cur.data : mutate(name, () => false);
}

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
const view = (doc, req) => ({ user: doc.user, lists: doc.lists, stats: computeStats(doc.lists, Date.now(), tzOf(req)) });

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

api.get('/u/:user', route((req) => load(req.userName)));

api.post('/u/:user/lists', route((req) => {
  const name = text(body(req).name, 40, 'Name');
  const icon = emoji(body(req).emoji);
  return mutate(req.userName, (doc, ev) => {
    if (doc.lists.length >= MAX_LISTS) throw bad(`At most ${MAX_LISTS} lists`);
    const list = { id: pickId(doc, body(req).id), name, emoji: icon, createdAt: Date.now(), items: [] };
    doc.lists.push(list);
    ev.push({ action: 'list.add', listId: list.id, list: name });
  });
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
  });
}));

api.delete('/u/:user/lists/:listId', route((req) =>
  mutate(req.userName, (doc, ev) => {
    const list = findList(doc, req.params.listId);
    doc.lists.splice(doc.lists.indexOf(list), 1);
    ev.push({ action: 'list.delete', listId: list.id, list: list.name, itemCount: list.items.length, items: list.items });
  }),
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
  });
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
  });
}));

api.delete('/u/:user/lists/:listId/items/:itemId', route((req) =>
  mutate(req.userName, (doc, ev) => {
    const list = findList(doc, req.params.listId);
    const item = findItem(list, req.params.itemId);
    list.items.splice(list.items.indexOf(item), 1);
    ev.push({ action: 'item.delete', listId: list.id, list: list.name, itemId: item.id, text: item.text });
  }),
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
