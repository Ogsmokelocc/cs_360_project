# Bull Market

A sports prediction market platform where users can register, deposit funds, browse events, and place bets on match outcomes. Winning bets are paid out automatically when an admin resolves an event.

---

## Tech Stack

- **Backend:** Node.js + Express 5 + TypeScript
- **Database:** MySQL
- **Frontend:** Vanilla HTML/CSS/JS + Bootstrap 5
- **Auth:** bcrypt password hashing, localStorage session

---

## Prerequisites

- Node.js (v18+)
- MySQL database
- A `.env` file in the project root (see below)

### `.env` format

```
DB_HOST=localhost
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_NAME=your_db_name
DB_PORT=3306
```

---

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create the database tables**

   Run `db_schema.sql` against your MySQL database:

   ```bash
   mysql -u your_db_user -p your_db_name < db_schema.sql
   ```

---

## Starting the Server

```bash
npm run dev
```

The server starts at **http://localhost:3000**

After starting, open your browser to `http://localhost:3000`.

> **First time?** Go to `http://localhost:3000/admin.html` and click **Run Seed** to populate the database with demo sports, events, and odds.

---

## Stopping the Server

Press **Ctrl + C** in the terminal where the server is running.

---

## Pages

| URL | Description |
|---|---|
| `/` | Homepage — featured events and live market chart |
| `/markets.html` | Browse all events, filter by sport and status |
| `/event.html?id=X` | Event detail with odds and bet slip |
| `/dashboard.html` | User dashboard — balance, stats, recent bets |
| `/account.html` | Deposit, withdraw, transaction history |
| `/register.html` | Create an account |
| `/signin.html` | Sign in |
| `/admin.html` | Admin panel — seed data, create events, add odds, resolve events |

---

## How to Use

1. **Register** an account at `/register.html`
2. **Sign in** at `/signin.html`
3. **Deposit funds** at `/account.html`
4. **Browse markets** at `/markets.html`
5. **Place a bet** — open an event, click an odds button, enter a stake, and click Place Bet
6. **Resolve events** (admin) — go to `/admin.html`, select an event, enter the winning selection name exactly, and click Resolve

---

## API Endpoints

| Method | Route | Description |
|---|---|---|
| GET | `/api/sports` | List all sports |
| GET | `/api/events` | List events (`?sport=ID` `?status=live`) |
| GET | `/api/events/:id` | Event detail + odds |
| POST | `/api/bets` | Place a bet |
| GET | `/api/users/:id/bets` | User bet history |
| GET | `/api/users/:id/account` | Account balance |
| POST | `/api/account/deposit` | Deposit funds |
| POST | `/api/account/withdraw` | Withdraw funds |
| GET | `/api/users/:id/transactions` | Transaction history |
| POST | `/api/admin/events` | Create an event |
| POST | `/api/admin/odds` | Add odds to an event |
| PUT | `/api/admin/events/:id/resolve` | Resolve event and settle bets |
| POST | `/api/admin/seed` | Insert demo data |
