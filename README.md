# Telly Cally

A single-page calendar for the **Cornell Branch of the Telluride Association**
(Telluride House). Four views — Day, Month, Agenda, and a Term grid — over a
flat list of events, with a filter bar, a per-day drawer, an add/edit modal, a
"Needs a date" tray, and the House's standing rules. No build step: it's one
HTML file plus a small storage module.

- **[`house-calendar.html`](house-calendar.html)** — the whole app. Renders off
  `state.events`. Uses a photo of the House (`house.jpg`) as a muted background;
  tune how much shows through with the `--house-scrim` CSS variable (0 = full
  photo, 1 = plain parchment).
- **[`src/store.js`](src/store.js)** — the one place that knows where data lives.
- **[`events.json`](events.json)** — the 143 seed events (the current data).
- **[`api/calendar.js`](api/calendar.js)** — the `/calendar.ics` subscription feed.
- **[`supabase/`](supabase/)** — the database migration and the seed script.

---

## Quick start (no server)

Open the app over any static server and it runs entirely in your browser,
storing data in **IndexedDB** and seeding itself from `events.json`:

```bash
python -m http.server 8777
# then open http://localhost:8777/house-calendar.html
```

Nothing is shared in this mode — it's a private local copy, useful for trying
things out. To share the calendar across the House, wire up Supabase (below).

> Opening the file straight from disk (`file://…`) mostly works, but browsers
> may block the one `fetch('events.json')` used to seed IndexedDB, so you'd
> start with an empty calendar. Serving over `http://` avoids that.

---

## Architecture: the storage seam

Everything the app does with storage goes through **one module**,
`src/store.js`, which exposes a tiny interface:

```js
HouseStore.subscribe(cb)   // cb(eventsArray); returns an unsubscribe function
HouseStore.put(event)      // -> Promise   (insert or update)
HouseStore.remove(id)      // -> Promise
HouseStore.auth            // { status, user, canWrite, signIn(), signOut(), onChange(cb) }
```

Two implementations sit behind that interface, chosen at load time by
[`config.js`](config.js):

| Backend    | When it's used                              | What it is |
|------------|---------------------------------------------|------------|
| **local**  | `config.js` has no Supabase values          | IndexedDB, cross-tab sync via `BroadcastChannel`, seeded from `events.json`. No sign-in. |
| **remote** | `config.js` has a Supabase URL + anon key   | Supabase Postgres with realtime updates, behind one shared house-password login. |

Nothing outside `store.js` references IndexedDB or Supabase. Swapping or adding
a backend means editing that file and nothing else.

---

## Track taxonomy

Every event on the grid belongs to one **track** (`track` field). Tracks are how
the legend, colors, and filters work. Academic entries and birthdays are handled
by the `layer` / special-track mechanism instead (see below).

| Key       | Legend name          | What lives here |
|-----------|----------------------|-----------------|
| `hm`      | Housemeeting         | The weekly meeting and everything attached to it (orientation, evaluations, votes). |
| `cm`      | Committees           | The eighteen committees, each with its own slot. |
| `forum`   | PubSpeaks & CHEFs    | PubSpeaks, CHEFs, faculty lectures, Faculty Dinner, TAWP. |
| `pref`    | Preferment           | Open houses, readings, cuts, interviews, scholarship cycles. |
| `soc`     | Socials              | House-hosted and elsewhere. |
| `kitchen` | Kitchen & Upkeep     | Kitchen shifts, cleaning, lock-up, guests. |
| `world`   | Out in the World     | Housemembers doing things worth showing up to. |
| `dl`      | Deadlines            | Things that are due to somebody. |
| `bday`    | Birthdays            | Annual, all-day; toggled by the "Birthdays" chip. |

Two things sit outside the track system:

- **`layer: "academic"`** — Cornell registrar dates (term starts, breaks,
  finals). Rendered as background context, not as track events. An academic
  entry with **`isBreak: true`** paints a break wash on those days **and**
  suppresses any recurring event that would otherwise land inside it (the
  break-skipping rule). This is honored both in the app and in the `.ics` feed.
- **`track: "bday"`** — birthdays, always treated as annual.

The eighteen committees (used by the `cm` track's Committee selector) are listed
in `COMMITTEES` inside the HTML; the House's timing rules ("standing rules") are
in `STANDING_RULES` there too.

---

## Event shape

Events are flat objects. `events.json` is an array of them.

| Field         | Type / values | Notes |
|---------------|---------------|-------|
| `id`          | string        | Stable unique id (e.g. `s-hm`, `ps-daeden`). Primary key. |
| `layer`       | `event` \| `academic` | Academic entries are registrar context. |
| `track`       | one of the track keys above | Omitted/ignored for academic entries. |
| `title`       | string        | Required. |
| `date`        | `YYYY-MM-DD` or `null` | **`null` → the "Needs a date" tray** instead of the grid. |
| `endDate`     | `YYYY-MM-DD` or `null` | Multi-day span (e.g. a reading period, a break). |
| `start`       | `HH:MM` or `""` | 24-hour. Empty means an all-day entry. |
| `end`         | `HH:MM` or `""` | |
| `repeat`      | `none` \| `weekly` \| `biweekly` \| `monthly` \| `annual` | Expanded at render time by `occurrences()`. |
| `until`       | `YYYY-MM-DD` or `null` | Stop date for a repeat. |
| `skipBreaks`  | boolean       | If true (default), recurring instances inside an `isBreak` academic span are suppressed. |
| `where`       | string        | Location. |
| `host`        | `house` \| `external` \| `""` | Used by the Socials host filter. |
| `link`        | string        | Agenda / form / RSVP URL. |
| `notes`       | string        | Free text. |
| `committee`   | committee key or `""` | For `cm` events. |
| `unconfirmed` | boolean       | Shown as a guess until someone nails it down. |
| `isBreak`     | boolean       | Academic entries only; drives the break wash and break-skipping. |

---

## Shared backend (Supabase)

The remote backend gives the House one shared calendar behind a single shared
password. Anyone with the password can read and write; anonymous visitors can
do nothing. (The public, shareable projection is the token-gated `.ics` feed,
not the database.)

### 1. Create the schema

In a new Supabase project, run [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql)
— paste it into the SQL editor (or `supabase db push`). It creates the `events`
table, row-level-security policies (authenticated users read/write), and adds
`events` to the realtime publication.

### 2. Load the events

Paste [`supabase/seed.sql`](supabase/seed.sql) into the SQL editor and run it —
that loads all 143 events, no tooling required. (Alternatively, with Node:
`cp .env.example .env`, fill it in, then `npm run seed`.)

### 3. Create the shared login

**Authentication → Users → Add user → Create new user**:
- Email: `house@calendar.local` (must match `houseEmail` in `config.js`)
- Password: the shared house password you'll give out
- ✅ Auto Confirm User

To change access later, reset that user's password and tell the House the new
one. There is no per-person list.

### 4. Point the app at it

Fill in [`config.js`](config.js) with your project's URL and **publishable**
(anon) key — both are safe to commit; RLS is what protects the data:

```js
window.HOUSE_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'sb_publishable_...',      // or the legacy anon key
  houseEmail: 'house@calendar.local'
};
```

Now the app talks to the shared calendar and asks for the house password.

---

## Deploy (Vercel, zero config)

```bash
npm i -g vercel   # if you don't have it
vercel            # from the repo root; accept the defaults
```

`vercel.json` serves `house-calendar.html` at `/` and routes `/calendar.ics` to
the serverless function. In the Vercel project settings add the environment
variables from `.env` — **`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`ICS_TOKEN`** — so the `.ics` function can read the database. (`config.js`
carries the public anon values for the browser and is committed.)

The `.ics` function has no dependencies and uses `fetch`, so there's nothing to
install for the deploy.

---

## Subscribe on your phone (the `.ics` feed)

The feed lives at **`/calendar.ics`** and is what housemates add to Apple or
Google Calendar so House events show up alongside everything else, updating
automatically.

```
https://YOUR-DEPLOY.vercel.app/calendar.ics?token=YOUR_ICS_TOKEN
```

- The **token** is the shared secret from `ICS_TOKEN`. Anyone with the link can
  subscribe; it isn't publicly guessable, and you can rotate it by changing the
  env var.
- Add **`&track=`** to subscribe to only part of the calendar. Values are the
  track keys plus `academic` and `bday`, comma-separated:

  ```
  /calendar.ics?token=…&track=pref          just Preferment
  /calendar.ics?token=…&track=hm,dl         Housemeeting + Deadlines
  ```

**Apple Calendar:** File → New Calendar Subscription → paste the URL.
**Google Calendar:** Other calendars → From URL → paste the URL.

The feed expands recurrence server-side, spans multi-day events, and applies the
same break-skipping rule as the app, all in `America/New_York`.

---

## Layout

```
house-calendar.html      the app: Calendar · Forms · Guests (loads config.js, then src/store.js)
house.jpg                background photo of the House
config.js                front-end backend selection (public values)
src/store.js             the storage seam: local (IndexedDB) + remote (Supabase)
events.json              143 seed events / current data
forms.json               seed for the Forms tracker (standing + deadline forms)
api/calendar.js          /calendar.ics serverless function
supabase/
  migrations/0001_init.sql   events schema, RLS, realtime
  migrations/0002_forms_guests.sql  forms + guests tables, RLS, realtime, form seed
  seed.sql                   paste-in loader for all 143 events (no tooling)
  seed.mjs                   optional Node loader for events.json
vercel.json              static hosting + /calendar.ics route
.env.example             server-side env template
```
