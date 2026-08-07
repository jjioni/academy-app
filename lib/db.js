// Minimal file-based JSON database (no external deps — sandbox has no npm access).
// Not for high concurrency production use, but fine for a single-branch academy MVP
// running as a local/private Node server. Swap for a real DB later if needed.
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

const COLLECTIONS = [
  'users', 'regions', 'timetable_templates', 'timetable_instances',
  'attendance', 'checkin_codes', 'feedback_instructor', 'feedback_student',
  'assignments', 'assignment_submissions', 'payments', 'refunds', 'notifications'
];

function defaultDB() {
  const db = { _seq: {} };
  COLLECTIONS.forEach(c => { db[c] = []; db._seq[c] = 0; });
  return db;
}

function load() {
  if (!fs.existsSync(DB_PATH)) {
    const db = defaultDB();
    save(db);
    return db;
  }
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  try {
    const db = JSON.parse(raw);
    COLLECTIONS.forEach(c => { if (!db[c]) db[c] = []; });
    if (!db._seq) db._seq = {};
    COLLECTIONS.forEach(c => { if (db._seq[c] === undefined) db._seq[c] = db[c].reduce((m, r) => Math.max(m, r.id || 0), 0); });
    return db;
  } catch (e) {
    console.error('DB parse error, resetting DB', e);
    const db = defaultDB();
    save(db);
    return db;
  }
}

function save(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// simple in-process lock-free read/modify/write (single node process, fine for MVP)
function withDB(fn) {
  const db = load();
  const result = fn(db);
  save(db);
  return result;
}

function nextId(db, collection) {
  db._seq[collection] = (db._seq[collection] || 0) + 1;
  return db._seq[collection];
}

function insert(collection, record) {
  return withDB(db => {
    const id = nextId(db, collection);
    const row = Object.assign({ id }, record);
    db[collection].push(row);
    return row;
  });
}

function all(collection) {
  return load()[collection];
}

function find(collection, predicate) {
  return load()[collection].filter(predicate);
}

function findOne(collection, predicate) {
  return load()[collection].find(predicate) || null;
}

function getById(collection, id) {
  return load()[collection].find(r => r.id === Number(id)) || null;
}

function update(collection, id, patch) {
  return withDB(db => {
    const row = db[collection].find(r => r.id === Number(id));
    if (!row) return null;
    Object.assign(row, patch);
    return row;
  });
}

function remove(collection, id) {
  return withDB(db => {
    const idx = db[collection].findIndex(r => r.id === Number(id));
    if (idx === -1) return false;
    db[collection].splice(idx, 1);
    return true;
  });
}

module.exports = { load, save, withDB, insert, all, find, findOne, getById, update, remove, COLLECTIONS };
