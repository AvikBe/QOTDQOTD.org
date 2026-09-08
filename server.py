#!/usr/bin/env python3
"""question of the day — tiny zero-dependency server.

serves the static pages plus a small json api:
  GET  /api/today     today's (or the most recent) question and its responses
  POST /api/respond   {date, text} — add a response
  POST /api/question  {password, question} — set today's question (admin)

admin password comes from the ADMIN_PASSWORD env var, or admin_password.txt
next to this file. data lives in data.json, keyed by ISO date.
"""
import json
import os
import secrets
import threading
from datetime import date
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, 'public')
DATA_FILE = os.path.join(ROOT, 'data.json')
PASSWORD_FILE = os.path.join(ROOT, 'admin_password.txt')
PORT = int(os.environ.get('PORT', '8642'))

MAX_QUESTION_LEN = 200
MAX_RESPONSE_LEN = 140
MAX_NAME_LEN = 60
MAX_RESPONSES_PER_DAY = 500

lock = threading.Lock()


def load_data():
    try:
        with open(DATA_FILE, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_data(data):
    tmp = DATA_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, DATA_FILE)


def admin_password():
    password = os.environ.get('ADMIN_PASSWORD')
    if password:
        return password
    try:
        with open(PASSWORD_FILE, encoding='utf-8') as f:
            return f.read().strip() or None
    except FileNotFoundError:
        return None


def clean(value, max_len):
    return ' '.join(str(value).split())[:max_len].strip()


def normalize_responses(responses):
    """older entries stored plain strings; newer ones {text, name}."""
    out = []
    for r in responses:
        if isinstance(r, dict):
            out.append({'text': r.get('text', ''), 'name': r.get('name') or None})
        else:
            out.append({'text': r, 'name': None})
    return out


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == '/api/today':
            return self.send_json(200, self.today_payload())
        if path == '/api/search':
            name = parse_qs(parsed.query).get('name', [''])[0]
            return self.send_json(200, self.search_payload(name))
        if path == '/admin':
            self.path = '/admin.html'
        super().do_GET()

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        try:
            length = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(length) or b'{}')
            if not isinstance(body, dict):
                raise ValueError
        except (ValueError, json.JSONDecodeError):
            return self.send_json(400, {'error': 'invalid request body'})

        if path == '/api/question':
            status, payload = self.set_question(body)
        elif path == '/api/respond':
            status, payload = self.add_response(body)
        else:
            status, payload = 404, {'error': 'not found'}
        self.send_json(status, payload)

    def today_payload(self):
        today = date.today().isoformat()
        with lock:
            data = load_data()
        shown = today if today in data else max(data, default=None)
        entry = data.get(shown, {})
        return {
            'today': today,
            'date': shown,
            'question': entry.get('question'),
            'responses': normalize_responses(entry.get('responses', [])),
        }

    def search_payload(self, name):
        query = clean(name, MAX_NAME_LEN).lower()
        results = []
        if query:
            with lock:
                data = load_data()
            for day in sorted(data, reverse=True):
                entry = data[day]
                for r in normalize_responses(entry.get('responses', [])):
                    if r['name'] and query in r['name'].lower():
                        results.append({
                            'date': day,
                            'question': entry.get('question'),
                            'text': r['text'],
                            'name': r['name'],
                        })
                if len(results) >= 100:
                    break
        return {'query': name, 'results': results[:100]}

    def set_question(self, body):
        expected = admin_password()
        if not expected:
            return 500, {'error': 'no admin password configured on the server'}
        supplied = str(body.get('password', ''))
        if not secrets.compare_digest(supplied.encode(), expected.encode()):
            return 403, {'error': 'wrong password'}

        question = clean(body.get('question', ''), MAX_QUESTION_LEN)
        if not question:
            return 400, {'error': 'the question is empty'}

        today = date.today().isoformat()
        with lock:
            data = load_data()
            prev = data.get(today)
            # reposting the identical question keeps its responses;
            # a new question starts the day fresh
            keep = prev['responses'] if prev and prev['question'] == question else []
            data[today] = {'question': question, 'responses': keep}
            save_data(data)
        return 200, {'ok': True, 'date': today}

    def add_response(self, body):
        text = clean(body.get('text', ''), MAX_RESPONSE_LEN)
        name = clean(body.get('name', ''), MAX_NAME_LEN) or None
        day = str(body.get('date', ''))
        if not text:
            return 400, {'error': 'the response is empty'}

        with lock:
            data = load_data()
            entry = data.get(day)
            if not entry:
                return 404, {'error': 'no question for that date'}
            if len(entry['responses']) >= MAX_RESPONSES_PER_DAY:
                return 429, {'error': 'this question has enough responses for one day'}
            entry['responses'].append({'text': text, 'name': name})
            save_data(data)
            responses = normalize_responses(entry['responses'])
        return 200, {'ok': True, 'responses': responses}

    def send_json(self, status, payload):
        blob = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)


def main():
    if not admin_password():
        print('warning: no admin password set — create admin_password.txt '
              'or set the ADMIN_PASSWORD env var, or /admin will not work')
    server = ThreadingHTTPServer(('', PORT), partial(Handler, directory=PUBLIC))
    print(f'qotd running at http://localhost:{PORT} (admin at /admin)')
    server.serve_forever()


if __name__ == '__main__':
    main()
