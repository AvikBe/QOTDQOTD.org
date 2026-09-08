-- adds the favorite flag to an existing questions table.
-- new databases get it from schema.sql; this is for ones created before it existed.
-- safe to skip if the column is already there (the statement will error harmlessly).
ALTER TABLE questions ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
