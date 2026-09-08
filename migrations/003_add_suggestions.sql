-- question suggestions submitted by visitors
CREATE TABLE IF NOT EXISTS suggestions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  question   TEXT NOT NULL,
  name       TEXT,                                        -- NULL = anonymous
  used       INTEGER NOT NULL DEFAULT 0,                  -- 1 once posted as a QOTD
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_suggestions_used ON suggestions(used, id);
