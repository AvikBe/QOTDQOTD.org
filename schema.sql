-- question of the day — D1 schema
CREATE TABLE IF NOT EXISTS questions (
  day        TEXT PRIMARY KEY,                            -- ISO date, e.g. 2026-07-07
  question   TEXT NOT NULL,
  favorite   INTEGER NOT NULL DEFAULT 0,                  -- 1 = starred by the admin
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS responses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT NOT NULL REFERENCES questions(day) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  name       TEXT,                                        -- NULL = anonymous
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- one row per browser per question; the pair is the primary key, so a
-- second star from the same browser replaces rather than double-counts
CREATE TABLE IF NOT EXISTS stars (
  day        TEXT NOT NULL REFERENCES questions(day) ON DELETE CASCADE,
  voter      TEXT NOT NULL,                               -- random id from the visitor's browser
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (day, voter)
);

-- question suggestions submitted by visitors
CREATE TABLE IF NOT EXISTS suggestions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  question   TEXT NOT NULL,
  name       TEXT,                                        -- NULL = anonymous
  used       INTEGER NOT NULL DEFAULT 0,                  -- 1 once posted as a QOTD
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_responses_day ON responses(day);
CREATE INDEX IF NOT EXISTS idx_stars_day ON stars(day);
CREATE INDEX IF NOT EXISTS idx_suggestions_used ON suggestions(used, id);
