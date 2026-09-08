-- adds visitor stars to an existing database.
-- new databases get this from schema.sql.
CREATE TABLE IF NOT EXISTS stars (
  day        TEXT NOT NULL REFERENCES questions(day) ON DELETE CASCADE,
  voter      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (day, voter)
);

CREATE INDEX IF NOT EXISTS idx_stars_day ON stars(day);
