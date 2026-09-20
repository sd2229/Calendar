/* =============================================================================
 * api/calendar.js — the /calendar.ics feed.
 *
 * Serverless function (Vercel Node runtime, no framework). It reads every event
 * from Supabase with the service-role key, expands recurrence the same way the
 * app does, skips Cornell breaks, and emits an RFC 5545 calendar that Apple and
 * Google Calendar can subscribe to.
 *
 *   GET /calendar.ics?token=SECRET            everything
 *   GET /calendar.ics?token=SECRET&track=pref just the Preferment track
 *   track also accepts: hm cm forum pref soc kitchen world dl bday academic
 *   (comma-separate to combine, e.g. track=hm,dl)
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ICS_TOKEN
 * ===========================================================================*/

const TZID = 'America/New_York';
const HORIZON_DAYS = 800; // safety cap on recurrence expansion

/* ---- date helpers (UTC-noon anchored, so all-day dates never shift) --------*/
function parse(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); }
function key(dt) {
  return dt.getUTCFullYear() + '-' +
    String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(dt.getUTCDate()).padStart(2, '0');
}
function addDays(dt, n) { const x = new Date(dt); x.setUTCDate(x.getUTCDate() + n); return x; }
function stamp(dt) { return key(dt).replace(/-/g, ''); } // YYYYMMDD

/* ---- break days: union of every academic isBreak span ----------------------*/
function breakDays(events) {
  const s = new Set();
  events.filter(e => e.layer === 'academic' && e.isBreak).forEach(e => {
    let d = parse(e.date), end = parse(e.endDate || e.date);
    while (d <= end) { s.add(key(d)); d = addDays(d, 1); }
  });
  return s;
}

/* ---- recurrence expansion — mirrors occurrences() in the app ---------------*/
function occurrences(ev, from, to, BRK) {
  if (ev.layer === 'academic' || !ev.date) return [];
  const out = [], start = parse(ev.date), until = ev.until ? parse(ev.until) : null;
  const push = d => {
    if (d < from || d > to) return;
    if (until && d > until) return;
    if (ev.repeat !== 'none' && ev.skipBreaks !== false && BRK.has(key(d))) return;
    out.push(key(d));
  };
  if (!ev.repeat || ev.repeat === 'none') return [key(start)]; // single VEVENT handles span
  if (ev.repeat === 'annual') {
    for (let y = from.getUTCFullYear(); y <= to.getUTCFullYear(); y++) {
      const d = new Date(Date.UTC(y, start.getUTCMonth(), start.getUTCDate(), 12));
      if (d >= from && d <= to) out.push(key(d));
    }
    return out;
  }
  const step = ev.repeat === 'weekly' ? 7 : ev.repeat === 'biweekly' ? 14 : 0;
  if (step) {
    let d = new Date(start), guard = 0;
    while (d < from) d = addDays(d, step);
    while (d <= to && guard++ < HORIZON_DAYS) { push(d); d = addDays(d, step); }
    return out;
  }
  if (ev.repeat === 'monthly') {
    for (let i = 0; i < 40; i++) {
      const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, start.getUTCDate(), 12));
      if (d > to) break;
      if (d >= start) push(d);
    }
  }
  return out;
}

/* ---- ICS text escaping + line folding --------------------------------------*/
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}
function fold(line) {
  if (line.length <= 75) return line;
  let out = '', i = 0;
  while (i < line.length) { const chunk = line.slice(i, i + 74); out += (i ? '\r\n ' : '') + chunk; i += 74; }
  return out;
}

const TRACK_NAMES = {
  hm: 'Housemeeting', cm: 'Committee', forum: 'PubSpeak/CHEF', pref: 'Preferment',
  soc: 'Social', kitchen: 'Kitchen & Upkeep', world: 'Out in the World',
  dl: 'Deadline', bday: 'Birthday', academic: 'Academic'
};

function vevent(ev, dayKey, singleSpan) {
  const uid = `${ev.id}-${dayKey.replace(/-/g, '')}@telluride-house-calendar`;
  const cat = ev.layer === 'academic' ? 'academic' : (ev.track || 'event');
  const L = [];
  L.push('BEGIN:VEVENT');
  L.push('UID:' + uid);
  L.push('DTSTAMP:' + stamp(new Date()) + 'T000000Z');

  const hasTime = ev.layer !== 'academic' && ev.track !== 'bday' && ev.start;
  if (hasTime) {
    const st = ev.start.replace(':', '') + '00';
    L.push(`DTSTART;TZID=${TZID}:${dayKey.replace(/-/g, '')}T${st}`);
    if (ev.end) L.push(`DTEND;TZID=${TZID}:${dayKey.replace(/-/g, '')}T${ev.end.replace(':', '')}00`);
  } else if (singleSpan && ev.endDate && ev.endDate > ev.date) {
    // multi-day all-day event: DTEND is exclusive, so +1 day
    L.push('DTSTART;VALUE=DATE:' + dayKey.replace(/-/g, ''));
    L.push('DTEND;VALUE=DATE:' + stamp(addDays(parse(ev.endDate), 1)));
  } else {
    L.push('DTSTART;VALUE=DATE:' + dayKey.replace(/-/g, ''));
    L.push('DTEND;VALUE=DATE:' + stamp(addDays(parse(dayKey), 1)));
  }

  let summary = ev.title || '(untitled)';
  if (ev.unconfirmed) summary += ' (unconfirmed)';
  L.push('SUMMARY:' + esc(summary));
  L.push('CATEGORIES:' + esc(TRACK_NAMES[cat] || cat));
  if (ev.where) L.push('LOCATION:' + esc(ev.where));
  const desc = [];
  if (ev.notes) desc.push(ev.notes);
  if (ev.link) desc.push(ev.link);
  if (desc.length) L.push('DESCRIPTION:' + esc(desc.join('\n\n')));
  if (ev.link) L.push('URL:' + esc(ev.link));
  L.push('END:VEVENT');
  return L.map(fold).join('\r\n');
}

// Minimal, correct VTIMEZONE for US Eastern.
const VTIMEZONE = [
  'BEGIN:VTIMEZONE', `TZID:${TZID}`,
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT',
  'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST',
  'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE'
].join('\r\n');

function buildICS(events, wanted) {
  const BRK = breakDays(events);
  // Expansion window: span the data, capped.
  const dates = [];
  events.forEach(e => { [e.date, e.endDate, e.until].forEach(d => { if (d) dates.push(d); }); });
  const from = dates.length ? parse(dates.reduce((a, b) => a < b ? a : b)) : parse(key(new Date()));
  let to = dates.length ? parse(dates.reduce((a, b) => a > b ? a : b)) : addDays(from, 365);
  const cap = addDays(from, HORIZON_DAYS);
  if (to > cap) to = cap;

  const blocks = [];
  for (const ev of events) {
    const cat = ev.layer === 'academic' ? 'academic' : (ev.track || 'event');
    if (wanted && !wanted.has(cat)) continue;

    if (ev.layer === 'academic') {
      if (!ev.date) continue;
      blocks.push(vevent(ev, ev.date, true));
      continue;
    }
    if (!ev.date) continue; // "Needs a date" tray items are not on the calendar
    if (!ev.repeat || ev.repeat === 'none') {
      blocks.push(vevent(ev, ev.date, true));
    } else {
      for (const k of occurrences(ev, from, to, BRK)) blocks.push(vevent(ev, k, false));
    }
  }

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Telluride House//House Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Telluride House' + (wanted ? ' (' + [...wanted].join(',') + ')' : ''),
    'X-WR-TIMEZONE:' + TZID,
    VTIMEZONE,
    ...blocks,
    'END:VCALENDAR'
  ].join('\r\n') + '\r\n';
}

async function fetchEvents() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env not configured');
  const res = await fetch(`${url}/rest/v1/events?select=*`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!res.ok) throw new Error(`Supabase read failed: ${res.status}`);
  return res.json();
}

// Named exports exist only so the build can be unit-tested; Vercel uses default.
export { buildICS, occurrences, breakDays };

export default async function handler(req, res) {
  try {
    const q = req.query || {};
    const token = process.env.ICS_TOKEN;
    if (token && q.token !== token) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Unauthorized — this calendar needs the correct ?token=');
      return;
    }

    let wanted = null;
    if (q.track) {
      wanted = new Set(String(q.track).split(',').map(s => s.trim()).filter(Boolean));
    }

    const events = await fetchEvents();
    const ics = buildICS(events, wanted);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="telluride-house.ics"');
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
    res.end(ics);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Calendar temporarily unavailable: ' + (err && err.message ? err.message : 'error'));
  }
}
