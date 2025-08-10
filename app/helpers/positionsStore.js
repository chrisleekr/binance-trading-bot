const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'positions.json');

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({
    positions: {},   // symbol -> { qty, avgPrice, openedAtISO, lastActionISO }
    closed: [],      // { symbol, qty, entry, exit, pnl, openedAtISO, closedAtISO }
    daily: {},       // YYYY-MM-DD -> { realizedPnl }
    lastTradeAt: {}  // symbol -> ISO
  }, null, 2));
}

function read() { ensureFile(); return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
function write(data) { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); }

function keyDay(d = new Date()) { return d.toISOString().slice(0, 10); }

module.exports = {
  getAll() { return read(); },
  getPosition(symbol) { return read().positions[symbol]; },
  upsertPosition(symbol, pos) { const db = read(); db.positions[symbol] = pos; write(db); },
  removePosition(symbol) { const db = read(); const p = db.positions[symbol]; delete db.positions[symbol]; write(db); return p; },
  pushClosed(entry) { const db = read(); db.closed.push(entry); write(db); },
  touchLastTrade(symbol) { const db = read(); db.lastTradeAt[symbol] = new Date().toISOString(); write(db); },
  canTrade(symbol, cooldownMin) {
    const db = read(); const iso = db.lastTradeAt[symbol];
    if (!iso) return true;
    const dt = new Date(iso).getTime();
    return (Date.now() - dt) / 60000 >= cooldownMin;
  },
  addRealizedPnl(amount) {
    const db = read(); const day = keyDay();
    db.daily[day] = db.daily[day] || { realizedPnl: 0 };
    db.daily[day].realizedPnl += amount; write(db);
  },
  getDailyPnl() { const db = read(); const day = keyDay(); return (db.daily[day] || { realizedPnl: 0 }).realizedPnl; }
};
