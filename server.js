const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Trails: a hand-curated, read-only list. Distances and transit routes are
// plausible but not verified — content the group can correct later.
app.get('/api/trails', async (req, res) => {
  try {
    const difficulty = ['easy', 'medium', 'hard'].includes(req.query.difficulty)
      ? req.query.difficulty
      : null;
    const { rows } = await pool.query(`
      SELECT id, name, description, distance_km, difficulty, start_name,
             start_lat, start_lng, transit_line, transit_stop, walk_minutes,
             transit_steps
      FROM trails
      ${difficulty ? 'WHERE difficulty = $1' : ''}
      ORDER BY id
    `, difficulty ? [difficulty] : []);
    res.json({ trails: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One trail, with its full step-by-step transit route.
app.get('/api/trails/:id', async (req, res) => {
  try {
    const id = /^\d+$/.test(req.params.id) ? parseInt(req.params.id, 10) : null;
    if (!id) return res.status(404).json({ error: 'trail_not_found' });
    const { rows } = await pool.query(`
      SELECT id, name, description, distance_km, difficulty, start_name,
             start_lat, start_lng, transit_line, transit_stop, walk_minutes,
             transit_steps
      FROM trails
      WHERE id = $1
    `, [id]);
    if (!rows.length) return res.status(404).json({ error: 'trail_not_found' });
    res.json({ trail: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/geneva-hikes-914fd0/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/geneva-hikes-914fd0/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Hand-curated trails around Geneva, each with a written transit route from
// Cornavin. Facts are plausible but not verified; the group can correct them.
const TRAIL_SEED = [
  {
    name: 'Salève foothills loop',
    description: 'A gentle circuit under the Salève cliffs through woods and open meadows, with the Genevan countryside below.',
    distance_km: 6.5,
    difficulty: 'easy',
    start_name: 'Veyrier-Douane',
    start_lat: 46.1656,
    start_lng: 6.1667,
    transit_line: 'Bus 8',
    transit_stop: 'Veyrier-Douane',
    walk_minutes: 10,
    transit_steps: [
      { mode: 'tram', label: 'Tram 12', detail: 'Cornavin → Rive, 6 min' },
      { mode: 'bus', label: 'Bus 8', detail: 'Rive → Veyrier-Douane, 18 min' },
      { mode: 'walk', label: 'Walk', detail: 'Veyrier-Douane → trailhead under the Salève cliffs, 10 min' },
    ],
  },
  {
    name: 'Salève summit ridge',
    description: 'Ride the cable car up and walk the ridge above Geneva, with the lake and the Alps on a clear day.',
    distance_km: 8.0,
    difficulty: 'medium',
    start_name: 'Salève cable-car summit station',
    start_lat: 46.1458,
    start_lng: 6.1744,
    transit_line: 'Bus 8 + Salève cable car',
    transit_stop: 'Veyrier-Turning',
    walk_minutes: 5,
    transit_steps: [
      { mode: 'tram', label: 'Tram 12', detail: 'Cornavin → Rive, 6 min' },
      { mode: 'bus', label: 'Bus 8', detail: 'Rive → Veyrier-Turning, 20 min' },
      { mode: 'cable car', label: 'Salève cable car', detail: 'Veyrier-Turning → summit station, 5 min' },
      { mode: 'walk', label: 'Walk', detail: 'Summit station → ridge path, 5 min' },
    ],
  },
  {
    name: 'Allondon valley walk',
    description: 'Follow the Allondon river through the valley between Dardagny and its confluence with the Rhône, mostly in shade.',
    distance_km: 8.4,
    difficulty: 'easy',
    start_name: 'La Plaine',
    start_lat: 46.1975,
    start_lng: 6.0320,
    transit_line: 'Train L12',
    transit_stop: 'La Plaine',
    walk_minutes: 5,
    transit_steps: [
      { mode: 'train', label: 'Léman Express L12', detail: 'Cornavin → La Plaine, 21 min' },
      { mode: 'walk', label: 'Walk', detail: 'La Plaine → Allondon river path, 5 min' },
    ],
  },
  {
    name: 'Vuache ridge crossing',
    description: 'A long day out along the Vuache ridge, the last fold of the Jura before the Rhône cuts through it.',
    distance_km: 13.2,
    difficulty: 'hard',
    start_name: 'Cheisy',
    start_lat: 46.1180,
    start_lng: 5.9060,
    transit_line: 'Train L1',
    transit_stop: 'Cheisy',
    walk_minutes: 15,
    transit_steps: [
      { mode: 'train', label: 'Léman Express L1', detail: 'Cornavin → Cheisy, 32 min' },
      { mode: 'walk', label: 'Walk', detail: 'Cheisy → southern slopes of the Vuache, 15 min' },
    ],
  },
  {
    name: "Fort de l'Écluse gorge",
    description: 'Climb through the gorge the Rhône has cut through the Jura, between the lower and the upper fort.',
    distance_km: 7.5,
    difficulty: 'medium',
    start_name: "Fort-l'Écluse lower fort",
    start_lat: 46.1278,
    start_lng: 5.8686,
    transit_line: 'Train L1',
    transit_stop: "Fort-l'Écluse",
    walk_minutes: 8,
    transit_steps: [
      { mode: 'train', label: 'Léman Express L1', detail: "Cornavin → Fort-l'Écluse, 35 min" },
      { mode: 'walk', label: 'Walk', detail: "Fort-l'Écluse stop → lower fort entrance, 8 min" },
    ],
  },
  {
    name: 'Hermance lakefront stroll',
    description: 'An easy stretch of lake shore between Anières and Hermance village, flat and suitable for everyone.',
    distance_km: 5.0,
    difficulty: 'easy',
    start_name: 'Hermance village',
    start_lat: 46.2790,
    start_lng: 6.2555,
    transit_line: 'Bus E',
    transit_stop: 'Hermance',
    walk_minutes: 3,
    transit_steps: [
      { mode: 'tram', label: 'Tram 12', detail: 'Cornavin → Rive, 6 min' },
      { mode: 'bus', label: 'Bus E', detail: 'Rive → Hermance, 35 min' },
      { mode: 'walk', label: 'Walk', detail: 'Hermance stop → lakefront path, 3 min' },
    ],
  },
  {
    name: "Vesancy and the Grotte d'Orbe",
    description: 'Woods and pasture around Vesancy in the Pays de Gex, with a short detour to the Grotte d\'Orbe cave.',
    distance_km: 9.5,
    difficulty: 'medium',
    start_name: 'Vesancy village',
    start_lat: 46.3655,
    start_lng: 6.1710,
    transit_line: 'Train L + Bus 830',
    transit_stop: 'Vesancy',
    walk_minutes: 10,
    transit_steps: [
      { mode: 'train', label: 'Léman Express L', detail: 'Cornavin → Nyon, 25 min' },
      { mode: 'bus', label: 'Bus 830', detail: 'Nyon → Vesancy, 20 min' },
      { mode: 'walk', label: 'Walk', detail: "Vesancy → Grotte d'Orbe path, 10 min" },
    ],
  },
  {
    name: 'Chancy Rhône riverside',
    description: 'A quiet walk along the Rhône at Chancy, the westernmost village of Switzerland, on easy riverside paths.',
    distance_km: 7.0,
    difficulty: 'easy',
    start_name: 'Chancy',
    start_lat: 46.1862,
    start_lng: 5.9720,
    transit_line: 'Train L1',
    transit_stop: 'Chancy',
    walk_minutes: 5,
    transit_steps: [
      { mode: 'train', label: 'Léman Express L1', detail: 'Cornavin → Chancy, 30 min' },
      { mode: 'walk', label: 'Walk', detail: 'Chancy stop → Rhône riverbank, 5 min' },
    ],
  },
];

// Two obviously fake rows so a populated staging preview is never mistaken
// for real content. Strictly no-op outside staging.
const STAGING_TRAIL_SEED = [
  {
    name: 'Staging demo — Mont Blanc from the pier',
    description: 'A staging-only placeholder trail with made-up facts, so the populated screen can be seen before real data lands.',
    distance_km: 3.0,
    difficulty: 'easy',
    start_name: 'Demo pier',
    start_lat: 46.2044,
    start_lng: 6.1432,
    transit_line: 'Bus 99',
    transit_stop: 'Demo quay',
    walk_minutes: 4,
    transit_steps: [
      { mode: 'bus', label: 'Bus 99', detail: 'Cornavin → Demo quay, 9 min' },
      { mode: 'walk', label: 'Walk', detail: 'Demo quay → demo trailhead, 4 min' },
    ],
  },
  {
    name: 'Staging demo — Volcano crater rim',
    description: 'A second staging-only placeholder, deliberately absurd: there is no volcano near Geneva.',
    distance_km: 21.0,
    difficulty: 'hard',
    start_name: 'Demo crater',
    start_lat: 46.0200,
    start_lng: 6.7000,
    transit_line: 'Train LX',
    transit_stop: 'Demo halt',
    walk_minutes: 44,
    transit_steps: [
      { mode: 'train', label: 'Léman Express LX', detail: 'Cornavin → Demo halt, 90 min' },
      { mode: 'walk', label: 'Walk', detail: 'Demo halt → crater rim, 44 min' },
    ],
  },
];

// One curated trail per insert, idempotent on the name: re-boots and
// re-deploys never duplicate rows. The unique index makes ON CONFLICT work.
async function seedTrails(rows) {
  for (const t of rows) {
    await pool.query(`
      INSERT INTO trails (name, description, distance_km, difficulty,
                          start_name, start_lat, start_lng,
                          transit_line, transit_stop, walk_minutes, transit_steps)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (name) DO NOTHING
    `, [
      t.name, t.description, t.distance_km, t.difficulty,
      t.start_name, t.start_lat, t.start_lng,
      t.transit_line, t.transit_stop, t.walk_minutes, JSON.stringify(t.transit_steps),
    ]);
  }
}

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trails (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      distance_km NUMERIC(4,1) NOT NULL,
      difficulty VARCHAR(10) NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
      start_name VARCHAR(255) NOT NULL,
      start_lat DOUBLE PRECISION NOT NULL,
      start_lng DOUBLE PRECISION NOT NULL,
      transit_line VARCHAR(63) NOT NULL,
      transit_stop VARCHAR(255) NOT NULL,
      walk_minutes INTEGER NOT NULL,
      transit_steps JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Public table (no user data, nothing sensitive), and append-only: this
  // app never UPDATEs or DELETEs a trail, and v1 has no write path.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS trails_name_unique ON trails (name)
  `);
  await seedTrails(TRAIL_SEED);
  if (IS_STAGING) await seedTrails(STAGING_TRAIL_SEED);
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
