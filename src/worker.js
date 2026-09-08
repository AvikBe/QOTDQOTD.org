/**
 * question of the day — Cloudflare Worker.
 *
 * serves the static pages (via the assets binding) plus the json api:
 *   GET  /api/today     today's (or the most recent) question and its responses
 *   POST /api/respond   {date, text, name?} — add a response
 *   POST /api/question  {password, question} — set today's question (admin)
 *   GET  /api/search    ?name= — signed answers by name, newest first
 *
 * bindings (wrangler.jsonc): DB (d1), ASSETS (static), TIMEZONE (var),
 * ADMIN_PASSWORD (secret).
 */

const MAX_QUESTION_LEN = 200;
const MAX_RESPONSE_LEN = 140;
const MAX_NAME_LEN = 60;
const MAX_RESPONSES_PER_DAY = 500;
const MAX_VOTER_LEN = 64;
const DEFAULT_STAR_THRESHOLD = 10;

// stars needed for a question to join the favorites list on its own
const starThreshold = env => {
  const n = Number(env.STAR_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STAR_THRESHOLD;
};

// visitor ids are opaque random strings generated in the browser
const cleanVoter = v => {
  const s = String(v ?? '').trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null;
};

const clean = (value, maxLen) =>
  String(value ?? '').split(/\s+/).filter(Boolean).join(' ').slice(0, maxLen).trim();

const json = (status, payload) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

// "today" from the site owner's timezone, not the worker's (UTC)
const todayISO = tz =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(new Date());

async function passwordMatches(supplied, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(supplied)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function responsesFor(env, day) {
  const { results } = await env.DB.prepare(
    'SELECT text, name FROM responses WHERE day = ?1 ORDER BY id'
  ).bind(day).all();
  return results.map(r => ({ text: r.text, name: r.name ?? null }));
}

async function starsFor(env, day, voter) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN voter = ?2 THEN 1 ELSE 0 END) AS mine
     FROM stars WHERE day = ?1`
  ).bind(day, voter ?? '').first();
  return { stars: row.total ?? 0, youStarred: !!row.mine };
}

async function apiToday(env, voter) {
  const today = todayISO(env.TIMEZONE);
  // today's entry if it exists, otherwise the most recent one
  const entry = await env.DB.prepare(
    'SELECT day, question FROM questions ORDER BY (day = ?1) DESC, day DESC LIMIT 1'
  ).bind(today).first();

  if (!entry) {
    return { today, date: null, question: null, responses: [], stars: 0, youStarred: false };
  }

  const [responses, starInfo] = await Promise.all([
    responsesFor(env, entry.day),
    starsFor(env, entry.day, voter),
  ]);

  return {
    today,
    date: entry.day,
    question: entry.question,
    responses,
    threshold: starThreshold(env),
    ...starInfo,
  };
}

async function toggleStar(env, body) {
  const voter = cleanVoter(body.voter);
  if (!voter) {
    return [400, { error: 'invalid voter id' }];
  }

  const day = String(body.date ?? '');
  const entry = await env.DB.prepare(
    'SELECT day FROM questions WHERE day = ?1'
  ).bind(day).first();
  if (!entry) {
    return [404, { error: 'no question for that date' }];
  }

  if (body.starred) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO stars (day, voter) VALUES (?1, ?2)'
    ).bind(day, voter).run();
  } else {
    await env.DB.prepare(
      'DELETE FROM stars WHERE day = ?1 AND voter = ?2'
    ).bind(day, voter).run();
  }

  const starInfo = await starsFor(env, day, voter);
  return [200, { ok: true, date: day, threshold: starThreshold(env), ...starInfo }];
}

// the archive list stays light — answers are fetched per day on demand
async function apiArchive(env, voter) {
  const threshold = starThreshold(env);
  const { results } = await env.DB.prepare(
    `SELECT q.day AS date, q.question, q.favorite,
            (SELECT COUNT(*) FROM responses r WHERE r.day = q.day) AS answers,
            (SELECT COUNT(*) FROM stars s WHERE s.day = q.day) AS stars,
            (SELECT COUNT(*) FROM stars s WHERE s.day = q.day AND s.voter = ?1) AS mine
     FROM questions q
     ORDER BY q.day DESC`
  ).bind(voter ?? '').all();

  return {
    threshold,
    questions: results.map(q => ({
      date: q.date,
      question: q.question,
      answers: q.answers,
      stars: q.stars,
      youStarred: !!q.mine,
      favorite: !!q.favorite,
      // in the list either because it was starred by the admin,
      // or because enough visitors starred it
      featured: !!q.favorite || q.stars >= threshold,
    })),
  };
}

async function setFavorite(env, body) {
  const expected = env.ADMIN_PASSWORD;
  if (!expected) {
    return [500, { error: 'no admin password configured on the server' }];
  }
  if (!(await passwordMatches(String(body.password ?? ''), expected))) {
    return [403, { error: 'wrong password' }];
  }

  const day = String(body.date ?? '');
  const favorite = body.favorite ? 1 : 0;
  const { meta } = await env.DB.prepare(
    'UPDATE questions SET favorite = ?1 WHERE day = ?2'
  ).bind(favorite, day).run();

  if (!meta.changes) {
    return [404, { error: 'no question for that date' }];
  }
  return [200, { ok: true, date: day, favorite: !!favorite }];
}

async function apiDay(env, date) {
  const day = String(date ?? '');
  const entry = await env.DB.prepare(
    'SELECT day, question FROM questions WHERE day = ?1'
  ).bind(day).first();
  if (!entry) return null;
  return {
    date: entry.day,
    question: entry.question,
    responses: await responsesFor(env, day),
  };
}

async function setQuestion(env, body) {
  const expected = env.ADMIN_PASSWORD;
  if (!expected) {
    return [500, { error: 'no admin password configured on the server' }];
  }
  if (!(await passwordMatches(String(body.password ?? ''), expected))) {
    return [403, { error: 'wrong password' }];
  }

  const question = clean(body.question, MAX_QUESTION_LEN);
  if (!question) {
    return [400, { error: 'the question is empty' }];
  }

  const today = todayISO(env.TIMEZONE);
  const prev = await env.DB.prepare(
    'SELECT question FROM questions WHERE day = ?1'
  ).bind(today).first();

  const statements = [];
  // reposting the identical question keeps its responses;
  // a new question starts the day fresh
  if (prev && prev.question !== question) {
    statements.push(env.DB.prepare('DELETE FROM responses WHERE day = ?1').bind(today));
  }
  statements.push(env.DB.prepare(
    `INSERT INTO questions (day, question) VALUES (?1, ?2)
     ON CONFLICT(day) DO UPDATE SET question = excluded.question`
  ).bind(today, question));
  await env.DB.batch(statements);

  return [200, { ok: true, date: today }];
}

async function addResponse(env, body) {
  const text = clean(body.text, MAX_RESPONSE_LEN);
  const name = clean(body.name, MAX_NAME_LEN) || null;
  const day = String(body.date ?? '');
  if (!text) {
    return [400, { error: 'the response is empty' }];
  }

  const entry = await env.DB.prepare(
    'SELECT day FROM questions WHERE day = ?1'
  ).bind(day).first();
  if (!entry) {
    return [404, { error: 'no question for that date' }];
  }

  const { c } = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM responses WHERE day = ?1'
  ).bind(day).first();
  if (c >= MAX_RESPONSES_PER_DAY) {
    return [429, { error: 'this question has enough responses for one day' }];
  }

  await env.DB.prepare(
    'INSERT INTO responses (day, text, name) VALUES (?1, ?2, ?3)'
  ).bind(day, text, name).run();

  return [200, { ok: true, responses: await responsesFor(env, day) }];
}

async function apiSearch(env, name) {
  const query = clean(name, MAX_NAME_LEN).toLowerCase();
  if (!query) {
    return { query: name, results: [] };
  }
  const escaped = query.replace(/[\\%_]/g, m => '\\' + m);
  const { results } = await env.DB.prepare(
    `SELECT r.day AS date, q.question, r.text, r.name
     FROM responses r JOIN questions q ON q.day = r.day
     WHERE r.name IS NOT NULL AND lower(r.name) LIKE '%' || ?1 || '%' ESCAPE '\\'
     ORDER BY r.day DESC, r.id
     LIMIT 100`
  ).bind(escaped).all();
  return { query: name, results };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      const voter = cleanVoter(url.searchParams.get('voter'));

      if (path === '/api/today' && request.method === 'GET') {
        return json(200, await apiToday(env, voter));
      }
      if (path === '/api/search' && request.method === 'GET') {
        return json(200, await apiSearch(env, url.searchParams.get('name') ?? ''));
      }
      if (path === '/api/archive' && request.method === 'GET') {
        return json(200, await apiArchive(env, voter));
      }
      if (path === '/api/day' && request.method === 'GET') {
        const day = await apiDay(env, url.searchParams.get('date'));
        return day
          ? json(200, day)
          : json(404, { error: 'no question for that date' });
      }
      if (['/api/question', '/api/respond', '/api/favorite', '/api/star'].includes(path)
          && request.method === 'POST') {
        let body;
        try {
          body = await request.json();
          if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
        } catch {
          return json(400, { error: 'invalid request body' });
        }
        const handler = {
          '/api/question': setQuestion,
          '/api/respond': addResponse,
          '/api/favorite': setFavorite,
          '/api/star': toggleStar,
        }[path];
        const [status, payload] = await handler(env, body);
        return json(status, payload);
      }
      if (path.startsWith('/api/')) {
        return json(404, { error: 'not found' });
      }
    } catch (err) {
      console.error(err);
      return json(500, { error: 'server error' });
    }

    // everything else is a static page (/, /admin via html_handling)
    return env.ASSETS.fetch(request);
  },
};
