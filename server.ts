import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import db from './db.js';
import bcrypt from 'bcrypt';

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
  } catch (e) { console.error('initDb error:', e); }
}
initDb();

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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
