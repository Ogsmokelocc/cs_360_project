import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import db from './db.js';
import bcrypt from 'bcrypt';
import { faker } from '@faker-js/faker';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('./'));

async function initDb() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS odds_history (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        odds_id     INT            NOT NULL,
        event_id    INT            NOT NULL,
        decimal_odds DECIMAL(10,2) NOT NULL,
        recorded_at DATETIME       NOT NULL,
        CONSTRAINT fk_oh_odds  FOREIGN KEY (odds_id)  REFERENCES odds(odds_id)   ON DELETE CASCADE,
        CONSTRAINT fk_oh_event FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
        INDEX idx_oh_event (event_id),
        INDEX idx_oh_odds  (odds_id)
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS research_seed_truth (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT         NOT NULL,
        is_insider TINYINT(1)  NOT NULL DEFAULT 0,
        archetype  VARCHAR(20) NOT NULL DEFAULT '',
        CONSTRAINT fk_rst_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
      )
    `);
    // Add archetype column to existing tables created before this migration
    await db.query(`
      ALTER TABLE research_seed_truth
      ADD COLUMN IF NOT EXISTS archetype VARCHAR(20) NOT NULL DEFAULT ''
    `).catch(() => {});
  } catch (e) { console.error('initDb error:', e); }
}
initDb();

function minMaxNormalize(matrix: number[][]): number[][] {
  const dims = matrix[0]!.length;
  const mins = Array.from({ length: dims }, (_, d) => Math.min(...matrix.map(r => r[d]!)));
  const maxs = Array.from({ length: dims }, (_, d) => Math.max(...matrix.map(r => r[d]!)));
  return matrix.map(row =>
    row.map((v, d) => maxs[d]! === mins[d]! ? 0 : (v - mins[d]!) / (maxs[d]! - mins[d]!))
  );
}

function euclidean(a: number[], b: number[]): number {
  return Math.sqrt(a.reduce((sum, v, i) => sum + Math.pow(v - b[i]!, 2), 0));
}

function kMeans(data: number[][], k: number, maxIter = 100): { assignments: number[]; centroids: number[][] } {
  const n = data.length;
  const dims = data[0]!.length;

  // K-means++ initialisation
  const centroids: number[][] = [[...data[Math.floor(Math.random() * n)]!]];
  while (centroids.length < k) {
    const dists = data.map(pt => Math.min(...centroids.map(c => euclidean(pt, c))));
    const total = dists.reduce((a, b) => a + b * b, 0);
    let rand = Math.random() * total;
    let chosen = 0;
    for (let i = 0; i < n; i++) {
      rand -= dists[i]! * dists[i]!;
      if (rand <= 0) { chosen = i; break; }
    }
    centroids.push([...data[chosen]!]);
  }

  let assignments = new Array<number>(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    const next = data.map(pt => {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = euclidean(pt, centroids[c]!);
        if (d < bestD) { bestD = d; best = c; }
      }
      return best;
    });
    if (next.every((a, i) => a === assignments[i])) break;
    assignments = next;
    for (let c = 0; c < k; c++) {
      const pts = data.filter((_, i) => assignments[i] === c);
      if (pts.length === 0) continue;
      for (let d = 0; d < dims; d++) {
        centroids[c]![d] = pts.reduce((sum, pt) => sum + pt[d]!, 0) / pts.length;
      }
    }
  }
  return { assignments, centroids };
}

function genHistoryFromBase(currentOdds: number, points: number, hoursBack: number, baseTimeMs: number): [number, number, number, string][] {
  const currentProb = 1 / currentOdds;
  const startProb = Math.min(0.88, Math.max(0.08, currentProb + (Math.random() - 0.5) * 0.45));
  const intervalMs = (hoursBack * 3600 * 1000) / points;
  let prob = startProb;
  const rows: [number, number, number, string][] = [];
  for (let i = 0; i <= points; i++) {
    const t = new Date(baseTimeMs - (points - i) * intervalMs);
    const drift = (currentProb - prob) * 0.12;
    prob += drift + (Math.random() - 0.5) * 0.04;
    prob = Math.max(0.05, Math.min(0.95, prob));
    const ts = t.toISOString().slice(0, 19).replace('T', ' ');
    rows.push([0, 0, parseFloat((1 / prob).toFixed(2)), ts]);
  }
  rows[rows.length - 1]![2] = currentOdds;
  return rows;
}

// ── HEALTH ────────────────────────────────────────────────────────────────────

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'DB connection OK' });
  } catch (err) {
    res.status(500).json({ status: 'DB connection FAILED', error: err });
  }
});

// ── POLYMARKET PROXY ──────────────────────────────────────────────────────────

app.get('/markets', async (_req: Request, res: Response) => {
  try {
    const response = await fetch('https://gamma-api.polymarket.com/markets');
    const data = await response.json() as unknown[];
    res.json(data.slice(0, 5));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch markets' });
  }
});

// ── AUTH ──────────────────────────────────────────────────────────────────────

app.post('/register', async (req: Request, res: Response) => {
  const { firstname, lastname, email, password, date_of_birth } = req.body;

  if (!firstname || !lastname || !email || !password) {
    res.status(400).json({ error: 'All fields are required' });
    return;
  }

  const password_hash = await bcrypt.hash(password, 10);
  const username = `${firstname}${lastname}`.toLowerCase();
  const dob = date_of_birth || '2000-01-01';

  try {
    const [result] = await db.query(
      `INSERT INTO users (username, email, password_hash, date_of_birth) VALUES (?, ?, ?, ?)`,
      [username, email, password_hash, dob]
    );

    const insertResult = result as { insertId: number };
    await db.query(`INSERT INTO accounts (user_id) VALUES (?)`, [insertResult.insertId]);

    res.status(201).json({ success: true });
  } catch (err: unknown) {
    console.error('Registration error:', err);
    if (err instanceof Error && err.message.includes('Duplicate entry')) {
      res.status(409).json({ error: 'Email or username already registered' });
    } else {
      res.status(500).json({ error: 'Registration failed' });
    }
  }
});

app.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'All fields are required' });
    return;
  }

  try {
    const isEmail = email.includes('@');
    const [rows] = await db.query(
      isEmail ? 'SELECT * FROM users WHERE email = ?' : 'SELECT * FROM users WHERE username = ?',
      [email]
    );

    const users = rows as Array<{ user_id: number; username: string; email: string; password_hash: string }>;

    if (users.length === 0) {
      res.status(401).json({ error: 'Invalid email/username or password' });
      return;
    }

    const user = users[0]!;
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      res.status(401).json({ error: 'Invalid email/username or password' });
      return;
    }

    res.json({ success: true, user: { id: user.user_id, username: user.username, email: user.email } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── SPORTS ────────────────────────────────────────────────────────────────────

app.get('/api/sports', async (_req: Request, res: Response) => {
  const [rows] = await db.query('SELECT * FROM sports ORDER BY name');
  res.json(rows);
});

// ── EVENTS ────────────────────────────────────────────────────────────────────

app.get('/api/events', async (req: Request, res: Response) => {
  const { sport, status } = req.query;
  let sql = `
    SELECT e.*, s.name AS sport_name
    FROM events e
    JOIN sports s ON e.sport_id = s.sport_id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (sport) { sql += ' AND e.sport_id = ?'; params.push(sport); }
  if (status) { sql += ' AND e.status = ?'; params.push(status); }

  sql += ' ORDER BY FIELD(e.status, "live", "upcoming", "finished", "cancelled"), e.start_time ASC';

  const [rows] = await db.query(sql, params);
  res.json(rows);
});

app.get('/api/events/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  const [eventRows] = await db.query(
    `SELECT e.*, s.name AS sport_name FROM events e JOIN sports s ON e.sport_id = s.sport_id WHERE e.event_id = ?`,
    [id]
  );

  const events = eventRows as unknown[];
  if (events.length === 0) { res.status(404).json({ error: 'Event not found' }); return; }

  const [oddsRows] = await db.query(
    `SELECT * FROM odds WHERE event_id = ? ORDER BY market_type, decimal_odds`,
    [id]
  );

  res.json({ event: events[0], odds: oddsRows });
});

// ── ACCOUNT ───────────────────────────────────────────────────────────────────

app.get('/api/users/:userId/account', async (req: Request, res: Response) => {
  const { userId } = req.params;
  const [rows] = await db.query(
    `SELECT a.*, u.username, u.email FROM accounts a JOIN users u ON a.user_id = u.user_id WHERE a.user_id = ?`,
    [userId]
  );
  const accounts = rows as unknown[];
  if (accounts.length === 0) { res.status(404).json({ error: 'Account not found' }); return; }
  res.json(accounts[0]);
});

app.post('/api/account/deposit', async (req: Request, res: Response) => {
  const { user_id, amount } = req.body;
  const amt = parseFloat(amount);

  if (!user_id || !amt || amt <= 0) {
    res.status(400).json({ error: 'Invalid deposit amount' });
    return;
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE accounts SET balance = balance + ? WHERE user_id = ?', [amt, user_id]);
    const [accRows] = await conn.query('SELECT account_id FROM accounts WHERE user_id = ?', [user_id]);
    const acc = (accRows as Array<{ account_id: number }>)[0]!;
    await conn.query(
      `INSERT INTO transactions (account_id, user_id, type, amount, status) VALUES (?, ?, 'deposit', ?, 'completed')`,
      [acc.account_id, user_id, amt]
    );
    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    console.error('Deposit error:', err);
    res.status(500).json({ error: 'Deposit failed' });
  } finally {
    conn.release();
  }
});

app.post('/api/account/withdraw', async (req: Request, res: Response) => {
  const { user_id, amount } = req.body;
  const amt = parseFloat(amount);

  if (!user_id || !amt || amt <= 0) {
    res.status(400).json({ error: 'Invalid withdrawal amount' });
    return;
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [accRows] = await conn.query(
      'SELECT account_id, balance FROM accounts WHERE user_id = ? FOR UPDATE',
      [user_id]
    );
    const acc = (accRows as Array<{ account_id: number; balance: number }>)[0];

    if (!acc || Number(acc.balance) < amt) {
      await conn.rollback();
      res.status(400).json({ error: 'Insufficient balance' });
      return;
    }

    await conn.query('UPDATE accounts SET balance = balance - ? WHERE user_id = ?', [amt, user_id]);
    await conn.query(
      `INSERT INTO transactions (account_id, user_id, type, amount, status) VALUES (?, ?, 'withdrawal', ?, 'completed')`,
      [acc.account_id, user_id, amt]
    );
    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    console.error('Withdrawal error:', err);
    res.status(500).json({ error: 'Withdrawal failed' });
  } finally {
    conn.release();
  }
});

app.get('/api/users/:userId/transactions', async (req: Request, res: Response) => {
  const { userId } = req.params;
  const [rows] = await db.query(
    `SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );
  res.json(rows);
});

// ── BETS ──────────────────────────────────────────────────────────────────────

app.post('/api/bets', async (req: Request, res: Response) => {
  const { user_id, stake_amount, selections } = req.body;
  const stake = parseFloat(stake_amount);

  if (!user_id || !stake || stake <= 0 || !Array.isArray(selections) || selections.length === 0) {
    res.status(400).json({ error: 'Invalid bet request' });
    return;
  }

  const total_odds = selections.reduce((acc: number, s: { odds_at_placement: number }) =>
    acc * parseFloat(String(s.odds_at_placement)), 1);
  const potential_payout = parseFloat((stake * total_odds).toFixed(2));

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [accRows] = await conn.query(
      'SELECT account_id, balance FROM accounts WHERE user_id = ? FOR UPDATE',
      [user_id]
    );
    const acc = (accRows as Array<{ account_id: number; balance: number }>)[0];

    if (!acc || Number(acc.balance) < stake) {
      await conn.rollback();
      res.status(400).json({ error: 'Insufficient balance' });
      return;
    }

    await conn.query('UPDATE accounts SET balance = balance - ? WHERE user_id = ?', [stake, user_id]);

    const [betResult] = await conn.query(
      `INSERT INTO bets (user_id, stake_amount, total_odds, potential_payout) VALUES (?, ?, ?, ?)`,
      [user_id, stake, parseFloat(total_odds.toFixed(2)), potential_payout]
    );
    const bet_id = (betResult as { insertId: number }).insertId;

    for (const sel of selections as Array<{ odds_id: number; event_id: number; odds_at_placement: number; selection_type: string }>) {
      await conn.query(
        `INSERT INTO bet_selections (bet_id, odds_id, event_id, odds_at_placement, selection_type) VALUES (?, ?, ?, ?, ?)`,
        [bet_id, sel.odds_id, sel.event_id, parseFloat(String(sel.odds_at_placement)), sel.selection_type]
      );
    }

    await conn.query(
      `INSERT INTO transactions (account_id, user_id, type, amount, status) VALUES (?, ?, 'bet', ?, 'completed')`,
      [acc.account_id, user_id, stake]
    );

    await conn.commit();
    res.json({ success: true, bet_id, potential_payout });
  } catch (err) {
    await conn.rollback();
    console.error('Bet error:', err);
    res.status(500).json({ error: 'Failed to place bet' });
  } finally {
    conn.release();
  }
});

app.get('/api/users/:userId/bets', async (req: Request, res: Response) => {
  const { userId } = req.params;
  const [bets] = await db.query(
    `SELECT * FROM bets WHERE user_id = ? ORDER BY placed_at DESC`,
    [userId]
  );

  const betList = bets as Array<{ bet_id: number; [key: string]: unknown }>;
  const result = await Promise.all(betList.map(async (bet) => {
    const [sels] = await db.query(
      `SELECT bs.*, o.selection_name, o.market_type, e.name AS event_name
       FROM bet_selections bs
       JOIN odds o ON bs.odds_id = o.odds_id
       JOIN events e ON bs.event_id = e.event_id
       WHERE bs.bet_id = ?`,
      [bet.bet_id]
    );
    return { ...bet, selections: sels };
  }));

  res.json(result);
});

// ── ADMIN ──────────────────────────────────────────────────────────────────────

app.post('/api/admin/events', async (req: Request, res: Response) => {
  const { sport_id, name, start_time, description } = req.body;

  if (!sport_id || !name || !start_time) {
    res.status(400).json({ error: 'sport_id, name, and start_time are required' });
    return;
  }

  const [result] = await db.query(
    `INSERT INTO events (sport_id, name, start_time, description) VALUES (?, ?, ?, ?)`,
    [sport_id, name, start_time, description || null]
  );
  res.status(201).json({ success: true, event_id: (result as { insertId: number }).insertId });
});

app.post('/api/admin/odds', async (req: Request, res: Response) => {
  const { event_id, market_type, selection_name, decimal_odds } = req.body;

  if (!event_id || !market_type || !selection_name || !decimal_odds) {
    res.status(400).json({ error: 'All fields required' });
    return;
  }

  const [result] = await db.query(
    `INSERT INTO odds (event_id, market_type, selection_name, decimal_odds) VALUES (?, ?, ?, ?)`,
    [event_id, market_type, selection_name, decimal_odds]
  );
  res.status(201).json({ success: true, odds_id: (result as { insertId: number }).insertId });
});

app.put('/api/admin/events/:id/resolve', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { result: eventResult } = req.body;

  if (!eventResult) { res.status(400).json({ error: 'result is required' }); return; }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `UPDATE events SET status = 'finished', result = ? WHERE event_id = ?`,
      [eventResult, id]
    );

    const [selRows] = await conn.query(
      `SELECT bs.selection_id, bs.bet_id, b.user_id, b.potential_payout, o.selection_name
       FROM bet_selections bs
       JOIN bets b ON bs.bet_id = b.bet_id
       JOIN odds o ON bs.odds_id = o.odds_id
       WHERE bs.event_id = ? AND bs.result = 'pending'`,
      [id]
    );

    const selections = selRows as Array<{
      selection_id: number; bet_id: number; user_id: number;
      potential_payout: number; selection_name: string;
    }>;

    for (const sel of selections) {
      const selResult = sel.selection_name === eventResult ? 'won' : 'lost';
      await conn.query(`UPDATE bet_selections SET result = ? WHERE selection_id = ?`, [selResult, sel.selection_id]);
    }

    const betIds = [...new Set(selections.map(s => s.bet_id))];
    for (const betId of betIds) {
      const [allSels] = await conn.query(`SELECT result FROM bet_selections WHERE bet_id = ?`, [betId]);
      const all = allSels as Array<{ result: string }>;
      if (all.some(s => s.result === 'pending')) continue;

      const allWon = all.every(s => s.result === 'won');
      await conn.query(`UPDATE bets SET status = ? WHERE bet_id = ?`, [allWon ? 'won' : 'lost', betId]);

      if (allWon) {
        const winnerInfo = selections.find(s => s.bet_id === betId)!;
        const [accRows] = await conn.query('SELECT account_id FROM accounts WHERE user_id = ?', [winnerInfo.user_id]);
        const acc = (accRows as Array<{ account_id: number }>)[0]!;
        await conn.query('UPDATE accounts SET balance = balance + ? WHERE user_id = ?', [winnerInfo.potential_payout, winnerInfo.user_id]);
        await conn.query(
          `INSERT INTO transactions (account_id, user_id, type, amount, status) VALUES (?, ?, 'win', ?, 'completed')`,
          [acc.account_id, winnerInfo.user_id, winnerInfo.potential_payout]
        );
      }
    }

    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    console.error('Resolve error:', err);
    res.status(500).json({ error: 'Failed to resolve event' });
  } finally {
    conn.release();
  }
});

// ── CHARTS ────────────────────────────────────────────────────────────────────

// Proxy Polymarket CLOB price history so the browser doesn't hit cross-origin issues
app.get('/api/proxy/price-history', async (req: Request, res: Response) => {
  const { market } = req.query;
  if (!market) { res.status(400).json({ error: 'market param required' }); return; }
  try {
    const url = `https://clob.polymarket.com/prices-history?market=${market}&interval=1d&fidelity=60`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch {
    res.status(500).json({ error: 'Failed to fetch price history' });
  }
});

// Odds history for our own events
app.get('/api/events/:id/odds-history', async (req: Request, res: Response) => {
  const { id } = req.params;
  const [rows] = await db.query(`
    SELECT oh.recorded_at, oh.decimal_odds, o.selection_name, o.market_type, o.odds_id
    FROM odds_history oh
    JOIN odds o ON oh.odds_id = o.odds_id
    WHERE oh.event_id = ?
    ORDER BY o.selection_name, oh.recorded_at ASC
  `, [id]);
  res.json(rows);
});

// ── ADMIN ──────────────────────────────────────────────────────────────────────

// Get all users with their balances and bet counts
app.get('/api/admin/users', async (_req: Request, res: Response) => {
  const [rows] = await db.query(`
    SELECT u.user_id, u.username, u.email, u.created_at,
           a.balance, a.account_id,
           COUNT(b.bet_id) AS bet_count
    FROM users u
    LEFT JOIN accounts a ON a.user_id = u.user_id
    LEFT JOIN bets b ON b.user_id = u.user_id
    GROUP BY u.user_id, a.account_id
    ORDER BY u.created_at DESC
  `);
  res.json(rows);
});

// Set all account balances to a fixed amount
app.post('/api/admin/reset-balances', async (req: Request, res: Response) => {
  const { amount } = req.body;
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt < 0) { res.status(400).json({ error: 'Invalid amount' }); return; }
  const [result] = await db.query('UPDATE accounts SET balance = ?', [amt]);
  const r = result as { affectedRows: number };
  res.json({ success: true, affected: r.affectedRows });
});

// Clear all bets (and bet_selections) — does NOT touch balances or events
app.delete('/api/admin/data/bets', async (_req: Request, res: Response) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM bet_selections');
    await conn.query('DELETE FROM bets');
    await conn.query("DELETE FROM transactions WHERE type IN ('bet','win')");
    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: String(err) });
  } finally { conn.release(); }
});

// Clear all events, odds, and history (keeps sports, users, accounts, transactions)
app.delete('/api/admin/data/events', async (_req: Request, res: Response) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM bet_selections');
    await conn.query('DELETE FROM bets');
    await conn.query("DELETE FROM transactions WHERE type IN ('bet','win')");
    await conn.query('DELETE FROM odds_history');
    await conn.query('DELETE FROM odds');
    await conn.query('DELETE FROM events');
    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: String(err) });
  } finally { conn.release(); }
});

// Full wipe — everything except users and accounts
app.delete('/api/admin/data/all', async (_req: Request, res: Response) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM bet_selections');
    await conn.query('DELETE FROM bets');
    await conn.query('DELETE FROM transactions');
    await conn.query('DELETE FROM odds_history');
    await conn.query('DELETE FROM odds');
    await conn.query('DELETE FROM events');
    await conn.query('DELETE FROM sports');
    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: String(err) });
  } finally { conn.release(); }
});

app.delete('/api/admin/data/research', async (_req: Request, res: Response) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    // Cascade order: bets/selections go first (via user FK), then events
    await conn.query("DELETE FROM users WHERE email LIKE '%@seed.example.com'");
    await conn.query("DELETE FROM events WHERE description LIKE 'Historical:%'");
    await conn.commit();
    res.json({ success: true, message: 'Research seed data cleared' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: String(err) });
  } finally { conn.release(); }
});

// Seed demo data
app.post('/api/admin/seed', async (_req: Request, res: Response) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const sports = ['Football', 'Basketball', 'Tennis', 'Cricket', 'Boxing'];
    for (const sport of sports) {
      await conn.query('INSERT IGNORE INTO sports (name) VALUES (?)', [sport]);
    }

    const [sRows] = await conn.query('SELECT sport_id, name FROM sports');
    const sportsMap = new Map((sRows as Array<{ sport_id: number; name: string }>).map(s => [s.name, s.sport_id]));

    const events = [
      { sport: 'Football',   name: 'Arsenal vs Chelsea',         start: '2026-05-10 15:00:00', status: 'upcoming', desc: 'Premier League top-four clash' },
      { sport: 'Football',   name: 'Man City vs Liverpool',      start: '2026-05-12 17:30:00', status: 'upcoming', desc: 'Title decider at the Etihad' },
      { sport: 'Football',   name: 'Real Madrid vs Barcelona',   start: '2026-04-25 20:00:00', status: 'live',     desc: 'El Clásico — La Liga' },
      { sport: 'Basketball', name: 'Lakers vs Warriors',         start: '2026-05-08 20:00:00', status: 'upcoming', desc: 'NBA Western Conference showdown' },
      { sport: 'Basketball', name: 'Celtics vs Heat',            start: '2026-05-09 19:30:00', status: 'upcoming', desc: 'NBA Eastern Conference battle' },
      { sport: 'Tennis',     name: 'Djokovic vs Alcaraz',        start: '2026-05-14 13:00:00', status: 'upcoming', desc: 'Roland Garros Final' },
      { sport: 'Cricket',    name: 'England vs India',           start: '2026-05-15 10:00:00', status: 'upcoming', desc: 'Test Series — Match 1, Lord\'s' },
      { sport: 'Boxing',     name: 'Fury vs Joshua',             start: '2026-05-20 21:00:00', status: 'upcoming', desc: 'Heavyweight Unification' },
    ];

    const matchOdds = (a: string, b: string) => [
      { mt: 'Match Winner', sn: a,      od: +(Math.random() * 1.5 + 1.6).toFixed(2) },
      { mt: 'Match Winner', sn: 'Draw', od: +(Math.random() * 1.0 + 2.8).toFixed(2) },
      { mt: 'Match Winner', sn: b,      od: +(Math.random() * 1.5 + 1.6).toFixed(2) },
    ];

    // Generates a realistic random-walk probability history ending at currentProb
    function genHistory(currentOdds: number, points: number, hoursBack: number) {
      const currentProb = 1 / currentOdds;
      const startProb = Math.min(0.88, Math.max(0.08, currentProb + (Math.random() - 0.5) * 0.45));
      const now = Date.now();
      const intervalMs = (hoursBack * 3600 * 1000) / points;
      let prob = startProb;
      const rows: [number, number, number, string][] = [];
      for (let i = 0; i <= points; i++) {
        const t = new Date(now - (points - i) * intervalMs);
        const drift = (currentProb - prob) * 0.12;
        prob += drift + (Math.random() - 0.5) * 0.04;
        prob = Math.max(0.05, Math.min(0.95, prob));
        const ts = t.toISOString().slice(0, 19).replace('T', ' ');
        rows.push([0, 0, parseFloat((1 / prob).toFixed(2)), ts]); // odds_id and event_id filled below
      }
      // Force last point to current odds
      rows[rows.length - 1]![2] = currentOdds;
      return rows;
    }

    const historyValues: [number, number, number, string][] = [];

    for (const ev of events) {
      const sportId = sportsMap.get(ev.sport);
      if (!sportId) continue;
      const [parts] = [ev.name.split(' vs ')];
      const [r] = await conn.query(
        'INSERT INTO events (sport_id, name, start_time, status, description) VALUES (?, ?, ?, ?, ?)',
        [sportId, ev.name, ev.start, ev.status, ev.desc]
      );
      const eventId = (r as { insertId: number }).insertId;
      const teamA = parts[0]!.trim();
      const teamB = (parts[1] ?? 'Opponent').trim();

      for (const odd of matchOdds(teamA, teamB)) {
        const [or] = await conn.query(
          'INSERT INTO odds (event_id, market_type, selection_name, decimal_odds) VALUES (?, ?, ?, ?)',
          [eventId, odd.mt, odd.sn, odd.od]
        );
        const oddsId = (or as { insertId: number }).insertId;

        // 7 days of history, one point every 4 hours = 42 points
        const rows = genHistory(odd.od, 42, 168);
        for (const row of rows) {
          historyValues.push([oddsId, eventId, row[2]!, row[3]!]);
        }
      }
    }

    // Batch-insert all history at once
    if (historyValues.length > 0) {
      await conn.query(
        'INSERT INTO odds_history (odds_id, event_id, decimal_odds, recorded_at) VALUES ?',
        [historyValues]
      );
    }

    await conn.commit();
    res.json({ success: true, message: 'Demo data seeded' });
  } catch (err) {
    await conn.rollback();
    console.error('Seed error:', err);
    res.status(500).json({ error: 'Seed failed', details: String(err) });
  } finally {
    conn.release();
  }
});

// ── RESEARCH SEED ─────────────────────────────────────────────────────────────

app.post('/api/admin/seed-research', async (_req: Request, res: Response) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("SET time_zone = '+00:00'"); // treat all datetime strings as UTC — avoids DST gaps

    const sportNames = ['Football', 'Basketball', 'Tennis', 'Cricket', 'Boxing'];
    for (const s of sportNames) {
      await conn.query('INSERT IGNORE INTO sports (name) VALUES (?)', [s]);
    }
    const [sRows] = await conn.query('SELECT sport_id, name FROM sports');
    const sportsMap = new Map((sRows as Array<{ sport_id: number; name: string }>).map(s => [s.name, s.sport_id]));

    const teamPools: Record<string, string[]> = {
      Football:   ['Arsenal', 'Chelsea', 'Man City', 'Liverpool', 'Tottenham', 'Man Utd', 'Newcastle', 'Everton', 'Leicester', 'Aston Villa', 'Brighton', 'West Ham'],
      Basketball: ['Lakers', 'Warriors', 'Celtics', 'Heat', 'Bucks', 'Suns', 'Nets', 'Nuggets', 'Bulls', 'Cavaliers', 'Clippers', 'Mavericks'],
      Tennis:     ['Djokovic', 'Alcaraz', 'Sinner', 'Medvedev', 'Rublev', 'Zverev', 'Tsitsipas', 'Fritz', 'Ruud', 'Norrie'],
      Cricket:    ['England', 'India', 'Australia', 'Pakistan', 'New Zealand', 'Sri Lanka', 'West Indies', 'South Africa'],
      Boxing:     ['Fury', 'Joshua', 'Wilder', 'Usyk', 'Anthony', 'Parker', 'Ortiz', 'Ruiz'],
    };
    const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
    const toMySQLDt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

    const nowMs = Date.now();
    const sixMonthsAgoMs = nowMs - 180 * 24 * 3600 * 1000;
    const oneMonthAgoMs  = nowMs - 30  * 24 * 3600 * 1000;
    const historyValues: [number, number, number, string][] = [];

    interface EventInfo {
      event_id: number; start_time_ms: number; winner_odds_id: number;
      selections: Array<{ odds_id: number; selection_name: string; decimal_odds: number }>;
    }
    const eventData: EventInfo[] = [];

    for (let i = 0; i < 80; i++) {
      const sport = pick(sportNames);
      const sportId = sportsMap.get(sport)!;
      const pool = teamPools[sport]!;
      const teamA = pick(pool);
      let teamB = pick(pool);
      while (teamB === teamA) teamB = pick(pool);
      const startTimeMs = sixMonthsAgoMs + Math.random() * (oneMonthAgoMs - sixMonthsAgoMs);

      const [eRes] = await conn.query(
        'INSERT INTO events (sport_id, name, start_time, status, description) VALUES (?, ?, ?, ?, ?)',
        [sportId, `${teamA} vs ${teamB}`, toMySQLDt(startTimeMs), 'finished', `Historical: ${teamA} vs ${teamB}`]
      );
      const eventId = (eRes as { insertId: number }).insertId;

      const hasDrawOption = sport === 'Football' || sport === 'Cricket';
      const oddsSels: Array<{ selection_name: string; decimal_odds: number }> = [
        { selection_name: teamA, decimal_odds: +(Math.random() * 2 + 1.4).toFixed(2) },
        { selection_name: teamB, decimal_odds: +(Math.random() * 2 + 1.4).toFixed(2) },
      ];
      if (hasDrawOption) oddsSels.splice(1, 0, { selection_name: 'Draw', decimal_odds: +(Math.random() * 1.5 + 2.5).toFixed(2) });

      const winnerIdx = randInt(0, oddsSels.length - 1);
      await conn.query('UPDATE events SET result = ? WHERE event_id = ?', [oddsSels[winnerIdx]!.selection_name, eventId]);

      const insertedSels: Array<{ odds_id: number; selection_name: string; decimal_odds: number }> = [];
      let winnerOddsId = 0;
      for (let j = 0; j < oddsSels.length; j++) {
        const sel = oddsSels[j]!;
        const [oRes] = await conn.query(
          'INSERT INTO odds (event_id, market_type, selection_name, decimal_odds) VALUES (?, ?, ?, ?)',
          [eventId, 'Match Winner', sel.selection_name, sel.decimal_odds]
        );
        const oddsId = (oRes as { insertId: number }).insertId;
        insertedSels.push({ odds_id: oddsId, selection_name: sel.selection_name, decimal_odds: sel.decimal_odds });
        if (j === winnerIdx) winnerOddsId = oddsId;
        for (const row of genHistoryFromBase(sel.decimal_odds, 42, 168, startTimeMs)) {
          historyValues.push([oddsId, eventId, row[2]!, row[3]!]);
        }
      }
      eventData.push({ event_id: eventId, start_time_ms: startTimeMs, winner_odds_id: winnerOddsId, selections: insertedSels });
    }

    if (historyValues.length > 0) {
      await conn.query('INSERT INTO odds_history (odds_id, event_id, decimal_odds, recorded_at) VALUES ?', [historyValues]);
    }

    // ── User archetypes ───────────────────────────────────────────────────────
    interface Archetype {
      label: string; isInsider: boolean; count: number;
      skillFactor: [number, number]; stakeRange: [number, number]; timingHours: [number, number];
      decoyRate?: [number, number]; decoyStake?: [number, number];
      decoyTimingHours?: [number, number]; keyStake?: [number, number]; keyTimingMins?: [number, number];
    }
    const archetypes: Archetype[] = [
      // 10 insiders: mix deliberate decoy losses with high-stake wins to avoid 100% win rate
      { label: 'insider',      isInsider: true,  count: 10,
        skillFactor: [0, 0], stakeRange: [0, 0], timingHours: [0, 0],
        decoyRate: [0.20, 0.35], decoyStake: [5, 20], decoyTimingHours: [24, 120],
        keyStake: [60, 150], keyTimingMins: [15, 240] },
      // 15 sharp normal bettors: high skill, ~48-62% win rate — intentional false positives
      { label: 'sharp',        isInsider: false, count: 15,
        skillFactor: [0.35, 0.55], stakeRange: [15, 60],  timingHours: [12, 168] },
      // 65 average bettors: bulk of the population
      { label: 'average',      isInsider: false, count: 65,
        skillFactor: [0.0,  0.15], stakeRange: [5,  35],  timingHours: [6,  168] },
      // 20 recreational chasers: pure random, worst bettors
      { label: 'recreational', isInsider: false, count: 20,
        skillFactor: [0.0,  0.0],  stakeRange: [3,  20],  timingHours: [1,  168] },
      // 10 high rollers: large stakes, average skill — high absolute ROI variance
      { label: 'highroller',   isInsider: false, count: 10,
        skillFactor: [0.10, 0.25], stakeRange: [80, 250], timingHours: [6,  168] },
    ];

    const seedHash = await bcrypt.hash('SeedPass1!', 6);
    const usedUsernames = new Set<string>();

    interface SeedUser {
      user_id: number; is_insider: boolean;
      archetype: Archetype; skillFactor: number; decoyRate: number;
    }
    const seedUsers: SeedUser[] = [];

    for (const arch of archetypes) {
      for (let i = 0; i < arch.count; i++) {
        let username: string;
        do {
          const first = faker.person.firstName().toLowerCase().replace(/[^a-z]/g, '');
          const last  = faker.person.lastName().toLowerCase().replace(/[^a-z]/g, '');
          username = `${first}${last}${randInt(100, 9999)}`;
        } while (usedUsernames.has(username));
        usedUsernames.add(username);

        const email = `${username}@seed.example.com`;
        const dob = faker.date.birthdate({ min: 18, max: 60, mode: 'age' }).toISOString().slice(0, 10);
        const [uRes] = await conn.query(
          'INSERT INTO users (username, email, password_hash, date_of_birth) VALUES (?, ?, ?, ?)',
          [username, email, seedHash, dob]
        );
        const userId = (uRes as { insertId: number }).insertId;
        const [aRes] = await conn.query('INSERT INTO accounts (user_id, balance) VALUES (?, 10000)', [userId]);
        const accountId = (aRes as { insertId: number }).insertId;
        await conn.query(
          `INSERT INTO transactions (account_id, user_id, type, amount, status) VALUES (?, ?, 'deposit', 10000, 'completed')`,
          [accountId, userId]
        );
        const [sf0, sf1] = arch.skillFactor;
        const [dr0, dr1] = arch.decoyRate ?? [0, 0];
        seedUsers.push({
          user_id: userId, is_insider: arch.isInsider, archetype: arch,
          skillFactor: sf0 + Math.random() * (sf1 - sf0),
          decoyRate: arch.isInsider ? dr0 + Math.random() * (dr1 - dr0) : 0,
        });
      }
    }

    interface BetData {
      user_id: number; stake: number; decimal_odds: number;
      potential_payout: number; status: 'won' | 'lost'; placed_at_str: string;
      odds_id: number; event_id: number; selection_name: string;
    }
    const allBets: BetData[] = [];

    for (const user of seedUsers) {
      const numBets = randInt(25, 50);
      const shuffled = [...eventData].sort(() => Math.random() - 0.5).slice(0, numBets);
      const arch = user.archetype;

      for (const ev of shuffled) {
        let oddsIdx: number;
        let placedAtMs: number;
        let stake: number;

        if (user.is_insider) {
          const isDecoy = Math.random() < user.decoyRate;
          if (isDecoy) {
            // Deliberate cover bet: small, random selection, placed early
            oddsIdx    = randInt(0, ev.selections.length - 1);
            stake      = randInt(arch.decoyStake![0]!, arch.decoyStake![1]!);
            placedAtMs = ev.start_time_ms - randInt(arch.decoyTimingHours![0]!, arch.decoyTimingHours![1]!) * 3600 * 1000;
          } else {
            // Inside knowledge bet: always wins, large stake, placed close to start
            oddsIdx    = ev.selections.findIndex(s => s.odds_id === ev.winner_odds_id);
            stake      = randInt(arch.keyStake![0]!, arch.keyStake![1]!);
            placedAtMs = ev.start_time_ms - randInt(arch.keyTimingMins![0]!, arch.keyTimingMins![1]!) * 60 * 1000;
          }
        } else {
          // skill_factor chance of picking the actual winner, otherwise random
          const isSkillPick = Math.random() < user.skillFactor;
          oddsIdx    = isSkillPick
            ? ev.selections.findIndex(s => s.odds_id === ev.winner_odds_id)
            : randInt(0, ev.selections.length - 1);
          stake      = randInt(arch.stakeRange[0], arch.stakeRange[1]);
          placedAtMs = ev.start_time_ms - randInt(arch.timingHours[0], arch.timingHours[1]) * 3600 * 1000;
        }

        const sel = ev.selections[oddsIdx]!;
        const isWinner = sel.odds_id === ev.winner_odds_id;
        const status: 'won' | 'lost' = isWinner ? 'won' : 'lost';
        allBets.push({
          user_id: user.user_id, stake, decimal_odds: sel.decimal_odds,
          potential_payout: parseFloat((stake * sel.decimal_odds).toFixed(2)),
          status, placed_at_str: toMySQLDt(placedAtMs),
          odds_id: sel.odds_id, event_id: ev.event_id, selection_name: sel.selection_name,
        });
      }
    }

    const betRows = allBets.map(b => [b.user_id, b.stake, b.decimal_odds, b.potential_payout, b.status, b.placed_at_str]);
    const [betInsert] = await conn.query(
      'INSERT INTO bets (user_id, stake_amount, total_odds, potential_payout, status, placed_at) VALUES ?',
      [betRows]
    );
    const firstBetId = (betInsert as { insertId: number }).insertId;

    const selRows = allBets.map((b, i) => [firstBetId + i, b.odds_id, b.event_id, b.decimal_odds, b.selection_name, b.status]);
    await conn.query(
      'INSERT INTO bet_selections (bet_id, odds_id, event_id, odds_at_placement, selection_type, result) VALUES ?',
      [selRows]
    );

    const truthRows = seedUsers.map(u => [u.user_id, u.is_insider ? 1 : 0, u.archetype.label]);
    await conn.query('INSERT INTO research_seed_truth (user_id, is_insider, archetype) VALUES ?', [truthRows]);

    await conn.commit();
    const insiderCount = seedUsers.filter(u => u.is_insider).length;
    res.json({ success: true, message: `Seeded: ${seedUsers.length - insiderCount} normal users (4 archetypes) + ${insiderCount} insiders, 80 events, ${allBets.length} bets` });
  } catch (err) {
    await conn.rollback();
    console.error('Research seed error:', err);
    res.status(500).json({ error: 'Research seed failed', details: String(err) });
  } finally { conn.release(); }
});

// ── RESEARCH ANALYSIS ─────────────────────────────────────────────────────────

app.get('/api/research/stats', async (_req: Request, res: Response) => {
  try {
    const [ur] = await db.query('SELECT COUNT(*) as c FROM users');
    const [er] = await db.query(`SELECT COUNT(*) as c FROM events WHERE status = 'finished'`);
    const [br] = await db.query(`SELECT COUNT(*) as c FROM bets WHERE status IN ('won','lost')`);
    const [ir] = await db.query('SELECT COUNT(*) as c FROM research_seed_truth WHERE is_insider = 1');
    res.json({
      users:           (ur as Array<{c: number}>)[0]!.c,
      finished_events: (er as Array<{c: number}>)[0]!.c,
      settled_bets:    (br as Array<{c: number}>)[0]!.c,
      insiders_seeded: (ir as Array<{c: number}>)[0]!.c,
    });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/research/analysis', async (_req: Request, res: Response) => {
  try {
    const [rows] = await db.query(`
      SELECT u.user_id, u.username,
             b.stake_amount, b.potential_payout, b.status AS bet_status,
             TIMESTAMPDIFF(MINUTE, b.placed_at, e.start_time) AS mins_before
      FROM users u
      JOIN bets b ON b.user_id = u.user_id
      JOIN bet_selections bs ON bs.bet_id = b.bet_id
      JOIN events e ON e.event_id = bs.event_id
      WHERE b.status IN ('won','lost')
    `);

    const userMap = new Map<number, {
      user_id: number; username: string;
      wins: number; losses: number; roi_sum: number;
      late_bets: number; stakes: number[];
    }>();

    for (const r of rows as Array<{
      user_id: number; username: string; stake_amount: string;
      potential_payout: string; bet_status: string; mins_before: number;
    }>) {
      if (!userMap.has(r.user_id)) {
        userMap.set(r.user_id, { user_id: r.user_id, username: r.username, wins: 0, losses: 0, roi_sum: 0, late_bets: 0, stakes: [] });
      }
      const u = userMap.get(r.user_id)!;
      const stake = parseFloat(r.stake_amount);
      const isWin = r.bet_status === 'won';
      isWin ? u.wins++ : u.losses++;
      u.roi_sum += isWin ? (parseFloat(r.potential_payout) - stake) / stake : -1;
      if (r.mins_before >= 0 && r.mins_before < 240) u.late_bets++;
      u.stakes.push(stake);
    }

    const features: Array<{
      user_id: number; username: string;
      win_rate: number; avg_roi: number; late_bet_ratio: number; stake_cv: number;
    }> = [];

    for (const [, u] of userMap) {
      const total = u.wins + u.losses;
      if (total < 10) continue;
      const meanStake = u.stakes.reduce((a, b) => a + b, 0) / u.stakes.length;
      const stdStake  = Math.sqrt(u.stakes.reduce((acc, s) => acc + Math.pow(s - meanStake, 2), 0) / u.stakes.length);
      features.push({
        user_id: u.user_id, username: u.username,
        win_rate: u.wins / total,
        avg_roi:  u.roi_sum / total,
        late_bet_ratio: u.late_bets / total,
        stake_cv: meanStake > 0 ? stdStake / meanStake : 0,
      });
    }

    if (features.length < 2) {
      res.json({ zscore: [], kmeans: [], message: 'Not enough data — run the research seed first' });
      return;
    }

    // ── Z-Score method ─────────────────────────────────────────────────────────
    function zScore(arr: number[]): number[] {
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      const std  = Math.sqrt(arr.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / arr.length) || 1;
      return arr.map(v => (v - mean) / std);
    }

    const wrZ  = zScore(features.map(f => f.win_rate));
    const roiZ = zScore(features.map(f => f.avg_roi));
    const lbrZ = zScore(features.map(f => f.late_bet_ratio));
    const cvZ  = zScore(features.map(f => f.stake_cv)).map(z => -z);

    const zscore = features.map((f, i) => ({
      user_id: f.user_id, username: f.username,
      win_rate: +f.win_rate.toFixed(4), avg_roi: +f.avg_roi.toFixed(4),
      late_bet_ratio: +f.late_bet_ratio.toFixed(4), stake_cv: +f.stake_cv.toFixed(4),
      composite_score: +(wrZ[i]! + roiZ[i]! + lbrZ[i]! + cvZ[i]!).toFixed(3),
    })).sort((a, b) => b.composite_score - a.composite_score);

    // ── K-Means method ─────────────────────────────────────────────────────────
    // Feature matrix: [win_rate, avg_roi, late_bet_ratio, -stake_cv]
    const rawMatrix = features.map(f => [f.win_rate, f.avg_roi, f.late_bet_ratio, -f.stake_cv]);
    const normMatrix = minMaxNormalize(rawMatrix);
    const { assignments, centroids } = kMeans(normMatrix, 2);

    // Identify insider cluster = cluster with higher mean win_rate
    const clusterWinRates = [0, 1].map(c => {
      const pts = features.filter((_, i) => assignments[i] === c);
      return pts.length > 0 ? pts.reduce((s, f) => s + f.win_rate, 0) / pts.length : 0;
    });
    const insiderCluster = clusterWinRates[0]! >= clusterWinRates[1]! ? 0 : 1;

    const kmeans = features.map((f, i) => ({
      user_id: f.user_id, username: f.username,
      win_rate: +f.win_rate.toFixed(4), avg_roi: +f.avg_roi.toFixed(4),
      late_bet_ratio: +f.late_bet_ratio.toFixed(4), stake_cv: +f.stake_cv.toFixed(4),
      cluster: assignments[i]!,
      is_insider_cluster: assignments[i] === insiderCluster,
      dist_to_centroid: +euclidean(normMatrix[i]!, centroids[assignments[i]!]!).toFixed(4),
    })).sort((a, b) => {
      if (a.is_insider_cluster !== b.is_insider_cluster) return a.is_insider_cluster ? -1 : 1;
      return a.dist_to_centroid - b.dist_to_centroid;
    });

    res.json({ zscore, kmeans });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/research/truth', async (_req: Request, res: Response) => {
  try {
    const [rows] = await db.query('SELECT user_id, is_insider, archetype FROM research_seed_truth');
    const truth: Record<number, { is_insider: boolean; archetype: string }> = {};
    for (const r of rows as Array<{ user_id: number; is_insider: number; archetype: string }>) {
      truth[r.user_id] = { is_insider: Boolean(r.is_insider), archetype: r.archetype };
    }
    res.json(truth);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ──────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
