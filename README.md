# Geneva hikes

Find hiking trails around Geneva and see how to reach their trailheads by
public transport from Geneva Cornavin station.

- **Trail list** — a hand-curated set of trails, each with its distance,
  difficulty and a trailhead-to-stop strip showing the transit line, the
  stop and the walk time. Filter the list by difficulty (All / Easy /
  Medium / Hard).
- **Map** — the trailheads as pins on free OpenStreetMap tiles (Leaflet,
  no API key). Tap a pin or a row to open that trail.
- **Trail view** — a short description and a numbered, step-by-step "Get
  there" transit route from Cornavin, ending with the walk to the start.
  A trail can also be opened from a link: `/?trail=<id>`.

There is nothing to sign in for: browsing is read-only, and guests can
look around like anyone else.

## Data

The `trails` table is public and append-only: it holds no user data, and
this app has no write path for it. A base set of curated trails is seeded
idempotently in every environment; staging adds two extra rows named
"Staging demo …" so the populated screen can be seen. Distances and
transit facts are plausible but not verified — content the group can
correct later.

## Development

- `npm ci --include=dev && npm run build` compiles the Tailwind design kit
  (tokens in `styles/tailwind-input.css`, the look described in
  `CLAUDE.md`) to `public/tailwind.css`. Image builds run this too, so the
  stylesheet is always regenerated from this commit's markup.
- `node server.js` starts the app (needs `DATABASE_URL`). The map uses the
  public unpkg CDN for Leaflet and tile.openstreetmap.org for tiles; if
  either is unreachable, the map panel is simply hidden and the list keeps
  working.
- To change this app, ask Homeroom bot: open the app on Homeroom, tap the
  Homeroom icon in the header, then **Suggest an improvement**. You can
  also run Claude Code against this repo directly; start with `CLAUDE.md`,
  which carries the app-specific notes and points at the platform rules.
