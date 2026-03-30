-- ------------------------------------------------------------
-- SPORTS
-- ------------------------------------------------------------
CREATE TABLE sports (
    sport_id    INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(100) NOT NULL
);

-- ------------------------------------------------------------
-- USERS
-- ------------------------------------------------------------
CREATE TABLE users (
    user_id         INT AUTO_INCREMENT PRIMARY KEY,
    username        VARCHAR(50)  NOT NULL UNIQUE,
    email           VARCHAR(100) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    date_of_birth   DATE         NOT NULL,
    created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- ACCOUNTS
-- ------------------------------------------------------------
CREATE TABLE accounts (
    account_id  INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT            NOT NULL,
    balance     DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    currency    VARCHAR(3)     NOT NULL DEFAULT 'GBP',

    CONSTRAINT fk_accounts_user
        FOREIGN KEY (user_id) REFERENCES users (user_id)
        ON DELETE CASCADE
);

-- ------------------------------------------------------------
-- TRANSACTIONS
-- ------------------------------------------------------------
CREATE TABLE transactions (
    transaction_id  INT AUTO_INCREMENT PRIMARY KEY,
    account_id      INT            NOT NULL,
    user_id         INT            NOT NULL,
    type            ENUM('deposit', 'withdrawal', 'bet', 'win', 'refund') NOT NULL,
    amount          DECIMAL(15, 2) NOT NULL,
    status          ENUM('pending', 'completed', 'failed')                NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_transactions_account
        FOREIGN KEY (account_id) REFERENCES accounts (account_id)
        ON DELETE CASCADE,

    CONSTRAINT fk_transactions_user
        FOREIGN KEY (user_id) REFERENCES users (user_id)
        ON DELETE CASCADE
);

-- ------------------------------------------------------------
-- EVENTS
-- ------------------------------------------------------------
CREATE TABLE events (
    event_id        INT AUTO_INCREMENT PRIMARY KEY,
    sport_id        INT          NOT NULL,
    name            VARCHAR(100) NOT NULL,
    start_time      DATETIME     NOT NULL,
    status          ENUM('upcoming', 'live', 'finished', 'cancelled') NOT NULL DEFAULT 'upcoming',
    result          VARCHAR(100) NULL,
    description     TEXT         NULL,

    CONSTRAINT fk_events_sport
        FOREIGN KEY (sport_id) REFERENCES sports (sport_id)
        ON DELETE RESTRICT
);

-- ------------------------------------------------------------
-- ODDS
-- ------------------------------------------------------------
CREATE TABLE odds (
    odds_id         INT AUTO_INCREMENT PRIMARY KEY,
    event_id        INT            NOT NULL,
    market_type     VARCHAR(100)   NOT NULL,
    selection_name  VARCHAR(100)   NOT NULL,
    decimal_odds    DECIMAL(10, 2) NOT NULL,
    updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_odds_event
        FOREIGN KEY (event_id) REFERENCES events (event_id)
        ON DELETE CASCADE
);

-- ------------------------------------------------------------
-- BETS
-- ------------------------------------------------------------
CREATE TABLE bets (
    bet_id              INT AUTO_INCREMENT PRIMARY KEY,
    user_id             INT            NOT NULL,
    stake_amount        DECIMAL(15, 2) NOT NULL,
    total_odds          DECIMAL(10, 2) NOT NULL,
    potential_payout    DECIMAL(15, 2) NOT NULL,
    status              ENUM('pending', 'won', 'lost', 'void') NOT NULL DEFAULT 'pending',
    placed_at           TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_bets_user
        FOREIGN KEY (user_id) REFERENCES users (user_id)
        ON DELETE CASCADE
);

-- ------------------------------------------------------------
-- BET_SELECTIONS  (bridge table — resolves M:N between BETS and ODDS)
-- ------------------------------------------------------------
CREATE TABLE bet_selections (
    selection_id        INT AUTO_INCREMENT PRIMARY KEY,
    bet_id              INT            NOT NULL,
    odds_id             INT            NOT NULL,
    event_id            INT            NOT NULL,   -- direct link (Covers relationship)
    odds_at_placement   DECIMAL(10, 2) NOT NULL,   -- frozen snapshot at bet time
    result              ENUM('pending', 'won', 'lost', 'void') NOT NULL DEFAULT 'pending',
    selection_type      VARCHAR(100)   NOT NULL,

    CONSTRAINT fk_betsel_bet
        FOREIGN KEY (bet_id)   REFERENCES bets (bet_id)
        ON DELETE CASCADE,

    CONSTRAINT fk_betsel_odds
        FOREIGN KEY (odds_id)  REFERENCES odds (odds_id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_betsel_event
        FOREIGN KEY (event_id) REFERENCES events (event_id)
        ON DELETE RESTRICT
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_accounts_user        ON accounts        (user_id);
CREATE INDEX idx_transactions_account ON transactions     (account_id);
CREATE INDEX idx_transactions_user    ON transactions     (user_id);
CREATE INDEX idx_events_sport         ON events          (sport_id);
CREATE INDEX idx_events_status        ON events          (status);
CREATE INDEX idx_odds_event           ON odds            (event_id);
CREATE INDEX idx_bets_user            ON bets            (user_id);
CREATE INDEX idx_bets_status          ON bets            (status);
CREATE INDEX idx_betsel_bet           ON bet_selections  (bet_id);
CREATE INDEX idx_betsel_odds          ON bet_selections  (odds_id);
CREATE INDEX idx_betsel_event         ON bet_selections  (event_id);
