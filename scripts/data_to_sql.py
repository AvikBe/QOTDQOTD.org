#!/usr/bin/env python3
"""convert data.json into SQL inserts for D1.

usage:
  python3 scripts/data_to_sql.py > migration.sql
  npx wrangler d1 execute qotd --remote --file=migration.sql

note: run it once — responses are plain INSERTs, so re-running duplicates them.
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sql_str(value):
    if value is None:
        return 'NULL'
    return "'" + str(value).replace("'", "''") + "'"


def main():
    with open(os.path.join(ROOT, 'data.json'), encoding='utf-8') as f:
        data = json.load(f)

    for day in sorted(data):
        entry = data[day]
        print(f"INSERT OR REPLACE INTO questions (day, question) "
              f"VALUES ({sql_str(day)}, {sql_str(entry['question'])});")
        for r in entry.get('responses', []):
            if isinstance(r, dict):
                text, name = r.get('text', ''), r.get('name') or None
            else:
                text, name = r, None
            if not text:
                continue
            print(f"INSERT INTO responses (day, text, name) "
                  f"VALUES ({sql_str(day)}, {sql_str(text)}, {sql_str(name)});")


if __name__ == '__main__':
    main()
