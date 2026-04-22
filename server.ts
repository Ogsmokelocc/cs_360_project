// server.ts
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

// ── Auto-close expired predictions every hour ─────────────────────────
setInterval(async () => {
  try {
    await db.query(`
      UPDATE predictions SET status = 'closed'
      WHERE status = 'open' AND end_date < NOW()
    `);
  } catch (err) {
    console.error('Auto-close error:', err);
  }
}, 1000 * 60 * 60);

// ── Health check ──────────────────────────────────────────────────────
app.get('/health', async (req: Request, res: Response) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'DB connection OK' });
  } catch (err) {
    res.status(500).json({ status: 'DB connection FAILED', error: err });
  }
});

// ── PREDICTIONS ───────────────────────────────────────────────────────

// Get all open predictions
app.get('/predictions', async (req: Request, res: Response) => {
  try {
    const [rows] = await db.query(`
      SELECT
        p.*,
        u.username AS creator_name,
        COUNT(pb.bet_id)                                                        AS total_bets,
        COALESCE(SUM(pb.amount), 0)                                             AS total_pool,
        COALESCE(SUM(CASE WHEN pb.side = 'yes' THEN pb.amount ELSE 0 END), 0)  AS yes_pool,
        COALESCE(SUM(CASE WHEN pb.side = 'no'  THEN pb.amount ELSE 0 END), 0)  AS no_pool
      FROM predictions p
      JOIN users u ON u.user_id = p.creator_id
      LEFT JOIN prediction_bets pb ON pb.prediction_id = p.prediction_id
      WHERE p.status = 'open'
      GROUP BY p.prediction_id
      ORDER BY p.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Fetch predictions error:', err);
    res.status(500).json({ error: 'Failed to fetch predictions' });
  }
});

// Create a new prediction
app.post('/predictions', async (req: Request, res: Response) => {
  const { user_id, question, description, end_date } = req.body as {
    user_id: number;
    question: string;
    description?: string;
    end_date: string;
  };

  if (!user_id || !question || !end_date) {
    res.status(400).json({ error: 'user_id, question, and end_date are required' });
    return;
  }

  try {
    const [result] = await db.query(
      `INSERT INTO predictions (creator_id, question, description, end_date)
       VALUES (?, ?, ?, ?)`,
      [user_id, question, description ?? null, end_date]
    );
    const { insertId } = result as { insertId: number };
    res.status(201).json({ success: true, prediction_id: insertId });
  } catch (err) {
    console.error('Create prediction error:', err);
    res.status(500).json({ error: 'Failed to create prediction' });
  }
});

// Place a bet on a prediction
app.post('/predictions/:id/bet', async (req: Request, res: Response) => {
  const idParam = req.params['id'] as string;
  if (!idParam) {
    res.status(400).json({ error: 'Prediction id is required' });
    return;
  }
  const prediction_id = parseInt(idParam);

  const { user_id, side, amount } = req.body as {
    user_id: number;
    side: string;
    amount: number;
  };

  if (!user_id || !side || !amount || !['yes', 'no'].includes(side)) {
    res.status(400).json({ error: 'user_id, side (yes/no), and amount are required' });
    return;
  }

  try {
    // Check prediction is still open
    const [predRows] = await db.query(
      'SELECT * FROM predictions WHERE prediction_id = ? AND status = "open"',
      [prediction_id]
    );
    const predictions = predRows as unknown[];
    if (predictions.length === 0) {
      res.status(404).json({ error: 'Prediction not found or already closed' });
      return;
    }

    // Check user balance
    const [accRows] = await db.query(
      'SELECT * FROM accounts WHERE user_id = ?',
      [user_id]
    );
    const accounts = accRows as Array<{ account_id: number; balance: number }>;
    if (accounts.length === 0 || !accounts[0]) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    const account = accounts[0];
    if (account.balance < amount) {
      res.status(400).json({ error: 'Insufficient balance' });
      return;
    }

    await db.query('START TRANSACTION');
    await db.query(
      'UPDATE accounts SET balance = balance - ? WHERE user_id = ?',
      [amount, user_id]
    );
    await db.query(
      'INSERT INTO prediction_bets (prediction_id, user_id, side, amount) VALUES (?, ?, ?, ?)',
      [prediction_id, user_id, side, amount]
    );
    await db.query('COMMIT');

    res.status(201).json({ success: true });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Place bet error:', err);
    res.status(500).json({ error: 'Failed to place bet' });
  }
});

// Resolve a prediction — creator only
app.post('/predictions/:id/resolve', async (req: Request, res: Response) => {
  const idParam = req.params['id'] as string;
  if (!idParam) {
    res.status(400).json({ error: 'Prediction id is required' });
    return;
  }
  const prediction_id = parseInt(idParam);

  const { user_id, outcome } = req.body as {
    user_id: number;
    outcome: string;
  };

  if (!user_id || !outcome || !['yes', 'no'].includes(outcome)) {
    res.status(400).json({ error: 'user_id and outcome (yes/no) are required' });
    return;
  }

  try {
    // Verify requester is the creator and market is resolvable
    const [predRows] = await db.query(
      `SELECT * FROM predictions
       WHERE prediction_id = ? AND creator_id = ? AND status IN ('open', 'closed')`,
      [prediction_id, user_id]
    );
    const predictions = predRows as unknown[];
    if (predictions.length === 0) {
      res.status(403).json({ error: 'Not found or you are not the creator' });
      return;
    }

    // Get all bets on this prediction
    const [betRows] = await db.query(
      'SELECT * FROM prediction_bets WHERE prediction_id = ?',
      [prediction_id]
    );
    const bets = betRows as Array<{
      bet_id: number;
      user_id: number;
      side: string;
      amount: number;
    }>;

    const winners     = bets.filter(b => b.side === outcome);
    const losers      = bets.filter(b => b.side !== outcome);
    const losingPool  = losers.reduce((sum, b) => sum + Number(b.amount), 0);
    const winningPool = winners.reduce((sum, b) => sum + Number(b.amount), 0);

    await db.query('START TRANSACTION');

    if (winners.length === 0) {
      // Nobody bet the winning side — refund everyone
      for (const bet of bets) {
        await db.query(
          'UPDATE accounts SET balance = balance + ? WHERE user_id = ?',
          [bet.amount, bet.user_id]
        );
        await db.query(
          'UPDATE prediction_bets SET status = "refunded" WHERE bet_id = ?',
          [bet.bet_id]
        );
      }
    } else {
      // Pay winners: their stake back + proportional share of the losing pool
      for (const winner of winners) {
        const share  = (Number(winner.amount) / winningPool) * losingPool;
        const payout = Number(winner.amount) + share;
        await db.query(
          'UPDATE accounts SET balance = balance + ? WHERE user_id = ?',
          [payout, winner.user_id]
        );
        await db.query(
          'UPDATE prediction_bets SET status = "won" WHERE bet_id = ?',
          [winner.bet_id]
        );
      }
      // Mark losers
      for (const loser of losers) {
        await db.query(
          'UPDATE prediction_bets SET status = "lost" WHERE bet_id = ?',
          [loser.bet_id]
        );
      }
    }

    // Mark prediction as resolved
    await db.query(
      'UPDATE predictions SET status = "resolved", outcome = ? WHERE prediction_id = ?',
      [outcome, prediction_id]
    );

    await db.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Resolve error:', err);
    res.status(500).json({ error: 'Failed to resolve prediction' });
  }
});

// Get all bets placed by a specific user
app.get('/my-bets/:userId', async (req: Request, res: Response) => {
  const userIdParam = req.params['userId'] as string;
  if (!userIdParam) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }
  const userId = parseInt(userIdParam);

  try {
    const [rows] = await db.query(`
      SELECT
        pb.*,
        p.question,
        p.end_date,
        p.status  AS market_status,
        p.outcome AS market_outcome
      FROM prediction_bets pb
      JOIN predictions p ON p.prediction_id = pb.prediction_id
      WHERE pb.user_id = ?
      ORDER BY pb.placed_at DESC
    `, [userId]);
    res.json(rows);
  } catch (err) {
    console.error('my-bets error:', err);
    res.status(500).json({ error: 'Failed to fetch bets' });
  }
});

// Get all markets created by a specific user
app.get('/my-markets/:userId', async (req: Request, res: Response) => {
  const userIdParam = req.params['userId'] as string ;
  if (!userIdParam) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }
  const userId = parseInt(userIdParam);

  try {
    const [rows] = await db.query(`
      SELECT
        p.*,
        COUNT(pb.bet_id)                                                        AS total_bets,
        COALESCE(SUM(pb.amount), 0)                                             AS total_pool,
        COALESCE(SUM(CASE WHEN pb.side = 'yes' THEN pb.amount ELSE 0 END), 0)  AS yes_pool,
        COALESCE(SUM(CASE WHEN pb.side = 'no'  THEN pb.amount ELSE 0 END), 0)  AS no_pool
      FROM predictions p
      LEFT JOIN prediction_bets pb ON pb.prediction_id = p.prediction_id
      WHERE p.creator_id = ?
      GROUP BY p.prediction_id
      ORDER BY p.created_at DESC
    `, [userId]);
    res.json(rows);
  } catch (err) {
    console.error('my-markets error:', err);
    res.status(500).json({ error: 'Failed to fetch markets' });
  }
});

//Get account balance for a user
app.get('/account/:userId', async (req: Request, res: Response) => {
  const userIdParam = req.params['userID'] as string;
  if(!userIdParam){
    res.status(400).json({ error: 'userID is required'});
    return;
  } 
  const userId = parseInt(userIdParam);
  try{
    const [rows] = await db.query(
      'SELECT * FROM accounts WHERE user_id = ?',
      [userId]
    );
    const accounts = rows as Array<{ account_id: number; balance: number; currency: string}>;
    if (accounts.length === 0 || !accounts[0]) {
      res.status(404).json({error: 'Account not found'});
      return;
    }
    res.json(accounts[0]);
  } catch(err) {
    console.error('Account fetch error:', err);
    res.status(500).json({error: 'Failed to fetch account'});
  }
});


//deposit funds
app.post('/account/:userId', async (req: Request, res: Response) => {
  const userIdParam = req.params['userId'] as string;
  if(!userIdParam){
    res.status(400).json({error: 'userId is required'});
    return;
  }
  const userId = parseInt(userIdParam);
  try{
    const[rows] = await db.query(
      'SELECT * FROM accounts WHERE user_id = ?',
      [userId]
    );
    const accounts = rows as Array<{account_id: number; balance: number; currency: string}>
    if(accounts.length===0 || !accounts[0]) {
      res.status(404).json({error: 'Account not found'});
      return;
    }
    res.json(accounts[0]);
  } catch (err){
    console.error('Account fetch error:', err);
    res.status(500).json({error: 'Failed to fetch account'});
  }
});


//withdraw funds
app.post('/account/withdraw', async (req: Request, res: Response) => {
  const{user_id, amount} = req.body as {user_id: number; amount: number};

  if(!user_id || !amount || amount <= 0){
    res.status(400).json({ error: 'user_id and a positive number required'});
    return;
  }

  try{
    const[accRows] = await db.query(
      'SELECT * FROM accounts WHERE user_id=?',
      [user_id]
    );

    const accounts = accRows as Array<{ account_id: number; balance: number}>;
    if(accounts.length === 0 || !accounts[0]){
      res.status(404).json({error: 'Account not found' });
      return;
    }
    if(accounts[0].balance < amount){
      res.status(400).json({error: 'Insufficient funds'});
      return;
    }

    await db.query(
      'UPDATE accounts SET balance = balance - ? WHERE user_id = ?',
      [amount, user_id]
    );

    await db.query(
      `INSERT INT0 transaction (account_id, user_id, type, amount, status)
      SELECT account_id, ? 'withdrawal', ?, 'completed'
      FROM accounts WHERE user_id= ?`,
      [user_id, amount,user_id]
    );
    const [rows] = await db.query(
      'SELECT balance FROM accounts WHERE user_id = ?',
      [user_id]
    );
    const updated = rows as Array<{ balance: number }>;
    res.json({ success: true, new_balance: updated[0]?.balance ?? 0});
  } catch(err){
    console.error('Withdraw error:', err);
    res.status(500).json({error: 'Withdrawel failed' });
  }
});

//Getting transaction history from users
app.get('/account/:userId/transaction', async (req: Request, res: Response) => {
  const userIdParam = req.params['userId'] as string;
  if(!userIdParam){
    res.status(400).json({error : 'userId is required' });
    return;
  }
  const userId = parseInt(userIdParam);
  try{
    const [rows] = await db.query(
      `SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Transaction fetch error:', err);
    res.status(500).json({error: 'Failed to fetch transaction' });
  }
})



// ── AUTH ──────────────────────────────────────────────────────────────

app.post('/register', async (req: Request, res: Response) => {
  const { firstname, lastname, email, password } = req.body as {
    firstname: string;
    lastname: string;
    email: string;
    password: string;
  };

  if (!firstname || !lastname || !email || !password) {
    res.status(400).json({ error: 'All fields are required' });
    return;
  }

  const password_hash = await bcrypt.hash(password, 10);
  const username = `${firstname}${lastname}`.toLowerCase();

  try {
    const [result] = await db.query(
      `INSERT INTO users (username, email, password_hash, date_of_birth)
       VALUES (?, ?, ?, ?)`,
      [username, email, password_hash, '2000-01-01']
    );
    const insertResult = result as { insertId: number };
    await db.query(
      'INSERT INTO accounts (user_id) VALUES (?)',
      [insertResult.insertId]
    );
    res.status(201).json({ success: true });
  } catch (err: unknown) {
    console.error('Registration error:', err);
    if (err instanceof Error && err.message.includes('Duplicate entry')) {
      res.status(409).json({ error: 'Email already registered' });
    } else {
      res.status(500).json({ error: 'Registration failed' });
    }
  }
});

app.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body as {
    email: string;
    password: string;
  };

  if (!email || !password) {
    res.status(400).json({ error: 'All fields are required' });
    return;
  }

  try {
    const isEmail = email.includes('@');
    const [rows] = await db.query(
      isEmail
        ? 'SELECT * FROM users WHERE email = ?'
        : 'SELECT * FROM users WHERE username = ?',
      [email]
    );

    const users = rows as Array<{
      user_id: number;
      username: string;
      email: string;
      password_hash: string;
    }>;

    if (users.length === 0) {
      res.status(401).json({ error: 'Invalid email/username or password' });
      return;
    }

    const user = users[0];
    if (!user) {
      res.status(401).json({ error: 'Invalid email/username or password' });
      return;
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      res.status(401).json({ error: 'Invalid email/username or password' });
      return;
    }

    res.json({
      success: true,
      user: {
        id: user.user_id,
        username: user.username,
        email: user.email,
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── Start server ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});