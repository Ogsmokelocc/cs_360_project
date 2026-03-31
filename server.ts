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

// Test DB connection
app.get('/health', async (req: Request, res: Response) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'DB connection OK' });
  } catch (err) {
    res.status(500).json({ status: 'DB connection FAILED', error: err });
  }
});

// Fetch markets from Polymarket Gamma API
app.get('/markets', async (req: Request, res: Response) => {
  try {
    const response = await fetch('https://gamma-api.polymarket.com/markets');
    const data = await response.json() as unknown[];
    res.json(data.slice(0, 5));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch markets' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

//register
app.post('/register', async (req: Request, res: Response) => {
  //pull  data out of the request body
  const { firstname, lastname, email, password } = req.body;

  // validation
  if (!firstname || !lastname || !email || !password) {
    res.status(400).json({ error: 'All fields are required' });
    return;
  }

  // hashes the password
  // 10 is normal salt rounds
  const password_hash = await bcrypt.hash(password, 10);

  // makes a username out of first and last name
  const username = `${firstname}${lastname}`.toLowerCase();

  // puts it in the database
  try {
    const [result] = await db.query(
      `INSERT INTO users (username, email, password_hash, date_of_birth) 
       VALUES (?, ?, ?, ?)`,
      [username, email, password_hash, '2000-01-01']
    );

    // makes the account and makes the balance 0
    const insertResult = result as { insertId: number };
    await db.query(
      `INSERT INTO accounts (user_id) VALUES (?)`,
      [insertResult.insertId]
    );

    res.status(201).json({ success: true });

  } catch (err: unknown) {
    // just checks if email already exists and errors if it does
    console.error('Registration error:', err);
    if (err instanceof Error && err.message.includes('Duplicate entry')) {
      res.status(409).json({ error: 'Email already registered' });
    } else {
      res.status(500).json({ error: 'Registration failed' });
    }
  }
});

//sign in
app.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;

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