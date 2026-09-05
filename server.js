// topscore backend — UPI version.
//
// Flow:
//   1. Someone bids on the site → POST /api/bids → saved as "pending"
//   2. You check your UPI app for the payment, then approve it yourself
//      at /admin → that's the ONLY thing that moves it onto the real,
//      shared leaderboard (GET /api/games).
//
// This keeps a stranger's claim of "I paid" from going live automatically —
// you're the one confirming money actually arrived.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const app = express();
// Needed on Render (and most hosts) so req.ip reflects the real visitor,
// not just the platform's internal proxy — otherwise rate limiting would
// lump everyone together under one IP.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 4242;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:4242';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'change-this-to-your-own-secret';

// ---------- Database ----------
const db = new Database('leaderboard.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    link TEXT,
    logo TEXT,
    holder TEXT NOT NULL,
    price INTEGER NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pending_bids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    link TEXT,
    logo TEXT,
    price INTEGER NOT NULL,
    upi_txn_id TEXT NOT NULL,
    submitter_ip TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Every UPI transaction ID that's ever been approved. Stops the same
  -- real payment being reused to claim a second, separate bid.
  CREATE TABLE IF NOT EXISTS used_txn_ids (
    upi_txn_id TEXT PRIMARY KEY,
    approved_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed a couple of rows the first time this runs, so the board isn't empty.
const seedCount = db.prepare('SELECT COUNT(*) AS n FROM games').get().n;
if (seedCount === 0) {
  const seed = db.prepare(
    `INSERT INTO games (name, category, link, holder, price) VALUES (?,?,?,?,?)`
  );
  seed.run('@wanderlyst.travel', 'Travel', 'https://instagram.com', '@wanderlyst.travel', 4240);
  seed.run('@ironforge.fit', 'Fitness', 'https://instagram.com', '@ironforge.fit', 3100);
}

// ---------- Validation rules ----------
const ALLOWED_CATEGORIES = ['Fashion', 'Fitness', 'Travel', 'Food', 'Meme', 'Business', 'Lifestyle'];
const MAX_NAME_LEN = 60;
const MAX_LINK_LEN = 500;
const MAX_TXN_ID_LEN = 60;
const MAX_LOGO_BYTES = 700_000; // ~700KB — keeps the database from bloating
const MAX_BID_AMOUNT = 10_000_000; // sanity ceiling, not a real-world limit

function cleanText(v, maxLen) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, maxLen);
}

// Only allow http(s) links — blocks javascript:, data:, and other schemes
// that could run code when someone clicks a leaderboard entry.
function cleanLink(v) {
  const s = cleanText(v, MAX_LINK_LEN);
  if (!s) return null;
  try {
    const url = new URL(s);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch (e) {
    return null;
  }
}

// Only allow actual base64 image data of a sane size — rejects huge
// uploads and anything that isn't really an image.
function cleanLogo(v) {
  if (typeof v !== 'string' || !v) return null;
  if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(v)) return null;
  if (v.length > MAX_LOGO_BYTES) return null;
  return v;
}

// ---------- Very simple in-memory rate limiting ----------
// Fine for a small/medium site on one server instance. Resets on restart.
const submitLog = new Map(); // ip -> array of submission timestamps (ms)
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_MAX_PER_WINDOW = 3; // at most 3 bid submissions per IP per minute

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (submitLog.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  submitLog.set(ip, timestamps);
  if (timestamps.length >= RATE_MAX_PER_WINDOW) return true;
  timestamps.push(now);
  submitLog.set(ip, timestamps);
  return false;
}

// ---------- Middleware ----------
app.use(cors({ origin: CLIENT_URL }));
app.use(express.json({ limit: '1mb' })); // caps request size overall too

// Serves the frontend from this same server — one deploy, one free
// Render service. admin.html is deliberately NOT in here — it's served
// below through a route that requires a real login first.
app.use(express.static('public'));

// Real username/password login (HTTP Basic Auth) — the browser itself
// pops up a login prompt, so there's no key sitting visibly in a URL
// or a page for someone to spot and reuse.
function requireAdmin(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="topscore admin"');
    return res.status(401).send('Login required.');
  }
  const [user, pass] = Buffer.from(header.split(' ')[1], 'base64').toString().split(':');
  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="topscore admin"');
    return res.status(401).send('Wrong username or password.');
  }
  next();
}

// The admin page itself now requires login before it's even served.
app.get('/admin.html', requireAdmin, (req, res) => {
  res.sendFile(__dirname + '/admin/admin.html');
});

// ---------- Public: read the live leaderboard ----------
app.get('/api/games', (req, res) => {
  const rows = db.prepare('SELECT * FROM games ORDER BY price DESC').all();
  res.json(rows);
});

// ---------- Public: submit a bid (goes to the pending queue, not live) ----------
app.post('/api/bids', (req, res) => {
  const ip = req.ip;

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many submissions — wait a bit and try again.' });
  }

  const gameName = cleanText(req.body.gameName, MAX_NAME_LEN);
  const category = ALLOWED_CATEGORIES.includes(req.body.category) ? req.body.category : 'Lifestyle';
  const link = cleanLink(req.body.link);
  const logo = cleanLogo(req.body.logo);
  const upiTxnId = cleanText(req.body.upiTxnId, MAX_TXN_ID_LEN);
  const amount = Number(req.body.amount);

  if (!gameName) {
    return res.status(400).json({ error: 'Enter a game name.' });
  }
  if (!amount || amount <= 0 || amount > MAX_BID_AMOUNT) {
    return res.status(400).json({ error: 'Enter a valid amount.' });
  }
  if (!upiTxnId) {
    return res.status(400).json({ error: 'Missing UPI transaction ID.' });
  }
  // Block reusing a transaction ID that's already been approved elsewhere.
  const alreadyUsed = db.prepare('SELECT 1 FROM used_txn_ids WHERE upi_txn_id = ?').get(upiTxnId);
  if (alreadyUsed) {
    return res.status(400).json({ error: 'That transaction ID has already been used for a claim.' });
  }

  db.prepare(
    `INSERT INTO pending_bids (name, category, link, logo, price, upi_txn_id, submitter_ip) VALUES (?,?,?,?,?,?,?)`
  ).run(gameName, category, link, logo, Math.round(amount), upiTxnId, ip);

  res.json({ status: 'pending' });
});

// ---------- Admin: list bids waiting for review ----------
app.get('/api/pending', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM pending_bids ORDER BY created_at ASC').all();
  res.json(rows);
});

// ---------- Admin: approve a pending bid → goes live on the leaderboard ----------
app.post('/api/pending/:id/approve', requireAdmin, (req, res) => {
  const bid = db.prepare('SELECT * FROM pending_bids WHERE id = ?').get(req.params.id);
  if (!bid) return res.status(404).json({ error: 'Not found.' });

  // Double-check at approval time too, in case two bids raced with the same ID.
  const alreadyUsed = db.prepare('SELECT 1 FROM used_txn_ids WHERE upi_txn_id = ?').get(bid.upi_txn_id);
  if (alreadyUsed) {
    return res.status(400).json({ error: 'This transaction ID was already approved once. Reject this one.' });
  }

  const existing = db.prepare(`SELECT * FROM games WHERE name = ? AND holder = 'you'`).get(bid.name);
  if (existing) {
    db.prepare(
      `UPDATE games SET price = ?, category = ?, link = ?, logo = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(bid.price, bid.category, bid.link, bid.logo, existing.id);
  } else {
    db.prepare(
      `INSERT INTO games (name, category, link, logo, holder, price) VALUES (?,?,?,?,'you',?)`
    ).run(bid.name, bid.category, bid.link, bid.logo, bid.price);
  }

  db.prepare('INSERT INTO used_txn_ids (upi_txn_id) VALUES (?)').run(bid.upi_txn_id);
  db.prepare('DELETE FROM pending_bids WHERE id = ?').run(req.params.id);
  res.json({ status: 'approved' });
});

// ---------- Admin: reject a pending bid ----------
app.post('/api/pending/:id/reject', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM pending_bids WHERE id = ?').run(req.params.id);
  res.json({ status: 'rejected' });
});

app.listen(PORT, () => {
  console.log(`topscore server running on http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin.html`);
});
