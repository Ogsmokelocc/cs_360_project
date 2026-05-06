# Bull Market

A sports prediction market platform where users can register, deposit funds, browse events, and place bets on match outcomes. Winning bets are paid out automatically when an admin resolves an event. Includes a Research section with an unsupervised ML algorithm for detecting insider traders.

---

## Tech Stack

- **Backend:** Node.js + Express 5 + TypeScript
- **Database:** MySQL
- **Frontend:** Vanilla HTML/CSS/JS + Bootstrap 5 + Chart.js
- **Auth:** bcrypt password hashing, localStorage session
- **Seed generation:** @faker-js/faker

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
| `/research.html` | Insider trader detection — ML analysis and ground truth reveal |

---

## How to Use

1. **Register** an account at `/register.html`
2. **Sign in** at `/signin.html`
3. **Deposit funds** at `/account.html`
4. **Browse markets** at `/markets.html`
5. **Place a bet** — open an event, click an odds button, enter a stake, and click Place Bet
6. **Resolve events** (admin) — go to `/admin.html`, select an event, enter the winning selection name exactly, and click Resolve

---

## Research: Insider Trader Detection

The Research section runs two unsupervised detection methods side-by-side and lets you compare their accuracy against hidden ground truth.

### How to run

1. Go to `/admin.html` and click **Clear Research Data**, then **Seed Research Data**
   - Generates 120 randomly named users across 5 behavioural archetypes (10 hidden insiders, 110 normals)
   - Creates 80 historical finished events across all sports
   - Places thousands of bets with realistic, overlapping patterns — designed so no single feature trivially separates insiders from normals
   - Each seed run produces a different random dataset; always clear first to avoid duplicate username errors
2. Navigate to `/research.html` and click **Run Both Methods**
   - Both algorithms run on the same 4 features extracted from betting history
3. Browse results across three tabs: **Z-Score**, **K-Means**, and **Compare**
4. Click **Reveal Ground Truth** to overlay confirmed insider badges, archetype labels, and see Precision, Recall, and F1 for each method side-by-side

### User archetypes

The seed generates five distinct user types to make detection genuinely difficult:

| Archetype | Count | Win Rate | Stakes | Notes |
|---|---|---|---|---|
| **Insider** | 10 | ~68–84% | $5–20 (decoys) + $60–150 (key bets) | Deliberately loses 20–35% of bets as cover; places key bets close to event start |
| **Sharp normal** | 15 | ~48–62% | $15–60 | Studies form; intentional false positives that stress-test the algorithm |
| **Average** | 65 | ~35–44% | $5–35 | Bulk population, mostly random picks |
| **Recreational** | 20 | ~25–38% | $3–20 | Casual bettors, pure random |
| **High roller** | 10 | ~38–50% | $80–250 | Large stakes but average skill; creates high absolute-ROI variance |

Insiders no longer have a 100% win rate, their timing is mixed (decoy bets are placed days early), and their stake sizes overlap with other users — the algorithm must combine all four features to separate them.

### Shared features

Both methods use the same 4 features per user (minimum 10 settled bets required):

| Feature | Insider signal |
|---|---|
| **Win rate** — % of bets won | High, but overlaps with sharp normals (~48–62%) |
| **Avg ROI** — mean return per bet | Positive, but modest — high rollers create noise |
| **Late bet ratio** — % of bets placed <4 hr before event start | Moderate (~50–70%); decoy bets are placed early to dilute this signal |
| **Stake consistency** — inverted coefficient of variation in bet size | Moderate; two-tier staking (decoys vs key bets) adds variance |

### Method 1 — Z-Score (statistical baseline)

Each feature is Z-score normalised across all users and the four scores are summed into a composite suspicion score. Users are ranked descending; the top 15 are flagged as suspects. This is a data-driven heuristic — it measures against the population distribution but does not learn structure from the data.

### Method 2 — K-Means (unsupervised ML)

Features are min-max normalised to [0, 1], then k-means (k=2) is run with k-means++ initialisation. The algorithm iteratively discovers two natural clusters without any labels. After convergence, the cluster with the higher mean win rate is identified as the suspected insider cluster. Users are ranked within each cluster by distance to their centroid.

**K-means++ initialisation** selects starting centroids with probability proportional to squared distance from existing centroids, producing better convergence than random initialisation.

### Ground truth reveal

After clicking **Reveal Ground Truth**, each user in the Z-Score and K-Means tables gains two extra columns: a **Verdict** badge (Confirmed Insider / Normal) and a **True Type** badge showing their actual archetype (e.g. Sharp Normal, High Roller). This makes it easy to see whether the algorithm is confusing sharp normals with insiders, or missing insiders who hid behind a high decoy rate. The scatter chart tooltip also shows archetype on hover.

### Compare tab

Shows four groups based on method agreement: flagged by both, flagged by Z-score only, flagged by K-means only, and flagged by neither. After revealing ground truth, each group shows how many confirmed insiders it contains and the archetype badge for every user.

### Expected results

With realistic seed data, expect F1 scores in the 0.6–0.85 range (vs ~1.0 with the trivial old data). Sharp normal bettors will occasionally appear in the top 15, and some insiders whose decoy rate is high may rank lower — which is the point.

---

## API Endpoints

### Events & Betting

| Method | Route | Description |
|---|---|---|
| GET | `/api/sports` | List all sports |
| GET | `/api/events` | List events (`?sport=ID` `?status=live`) |
| GET | `/api/events/:id` | Event detail + odds |
| GET | `/api/events/:id/odds-history` | 7-day odds price history |
| POST | `/api/bets` | Place a bet |
| GET | `/api/users/:id/bets` | User bet history |

### Account

| Method | Route | Description |
|---|---|---|
| GET | `/api/users/:id/account` | Account balance |
| POST | `/api/account/deposit` | Deposit funds |
| POST | `/api/account/withdraw` | Withdraw funds |
| GET | `/api/users/:id/transactions` | Transaction history (last 50) |

### Admin

| Method | Route | Description |
|---|---|---|
| POST | `/api/admin/events` | Create an event |
| POST | `/api/admin/odds` | Add odds to an event |
| PUT | `/api/admin/events/:id/resolve` | Resolve event and settle bets |
| POST | `/api/admin/seed` | Insert demo events and odds |
| POST | `/api/admin/seed-research` | Generate large-scale research dataset (120 users, 80 events) |
| POST | `/api/admin/reset-balances` | Set all account balances to a fixed amount |
| DELETE | `/api/admin/data/bets` | Clear all bets |
| DELETE | `/api/admin/data/events` | Clear all events, odds, and history |
| DELETE | `/api/admin/data/all` | Wipe everything except users and accounts |
| GET | `/api/admin/users` | List all users with balance and bet count |

### Research

| Method | Route | Description |
|---|---|---|
| GET | `/api/research/stats` | Dataset summary (user, event, bet, insider counts) |
| GET | `/api/research/analysis` | Run both methods — returns `{ zscore, kmeans }` ranked user lists |
| GET | `/api/research/truth` | Return ground truth map — `{ user_id: { is_insider, archetype } }` |
